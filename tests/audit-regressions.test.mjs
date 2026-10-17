import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { installEngine } from '../src/content/engine.js';
import { rewriteConfiguration } from '../src/core/protocol.js';
import { createController, REGISTRATIONS } from '../src/background/controller.js';
import { RUNTIME_KEY, STATUS_ATTRIBUTE, STATUS_MESSAGE } from '../src/shared/constants.js';
import { entry, payload, framed, batchURL, fakeChrome } from './fixtures.mjs';

function documentFixture() {
  const attributes = new Map();
  return { documentElement: { setAttribute(key, value) { attributes.set(key, value); } },
    status: () => JSON.parse(attributes.get(STATUS_ATTRIBUTE)) };
}

test('audit: rewriting preserves large numbers, duplicate keys and numeric spelling', () => {
  const rawPayload = `[9007199254740993,1e400,-0,1.2300,{"id":1,"id":2},${Array(25).fill('null').join(',')},false,null]`;
  const rawFrame = `[["wrb.fr","cPZSdc",${JSON.stringify(rawPayload)},9007199254740993,1e400,-0,{"x":1,"x":2}]]`;
  const result = rewriteConfiguration(rawFrame);
  const expectedPayload = rawPayload.replace('false', 'true');
  assert.equal(result.text, rawFrame.replace(JSON.stringify(rawPayload), JSON.stringify(expectedPayload)));
  assert.equal(result.changed, 1);
});

test('audit: an unavailable runtime marker cannot leave an untracked fetch hook', () => {
  const native = async () => new Response(framed());
  const page = Object.preventExtensions({ fetch: native, location: { href: 'https://flow.google.com/' } });
  const doc = documentFixture();
  assert.doesNotThrow(() => installEngine(page, doc));
  assert.equal(page.fetch, native);
  assert.equal(doc.status().state, 'error');
});

test('audit: invalid UTF-8 bytes are never replaced and delivered as modified content', async () => {
  const sourceText = framed([entry(payload())]);
  const body = new Uint8Array([...new TextEncoder().encode(sourceText), 0xff]);
  const source = new Response(body);
  const page = { fetch: async () => source, location: { href: 'https://flow.google.com/' } };
  const doc = documentFixture(); installEngine(page, doc);
  const output = await page.fetch(batchURL);
  assert.equal(output, source);
  assert.deepEqual(new Uint8Array(await output.arrayBuffer()), body);
  assert.equal(doc.status().changes, 0);
});

test('audit: failure to restrict storage access stops and unregisters existing engines', async () => {
  const mock = fakeChrome(true);
  for (const definition of REGISTRATIONS) mock.scripts.set(definition.id, definition);
  mock.api.storage.local.setAccessLevel = async () => { throw new Error('Access restriction failed'); };
  const controller = createController(mock.api);
  await assert.rejects(controller.initialize());
  assert.equal(mock.scripts.size, 0);
  assert(mock.calls.some(([kind]) => kind === 'stop'));
  await assert.rejects(controller.setEnabled(true));
  assert.equal(mock.scripts.size, 0);
});

test('audit: updating stops old in-page engines without losing the saved switch state', async () => {
  const mock = fakeChrome(true);
  const controller = createController(mock.api);
  assert.deepEqual(await controller.initialize({ stopExisting: true }), { enabled: true });
  assert(mock.calls.some(([kind]) => kind === 'stop'));
  assert.equal(mock.data.enabled, true); assert.equal(mock.scripts.size, 2);
});

test('audit: unreadable settings cannot leave previously registered engines active', async () => {
  for (const operation of ['initialize', 'getState', 'setEnabled']) {
    const mock = fakeChrome(true);
    for (const script of REGISTRATIONS) mock.scripts.set(script.id, script);
    mock.api.storage.local.get = async () => { throw new Error('Storage unavailable'); };
    const controller = createController(mock.api);
    await assert.rejects(controller[operation](true), /RECOVERY_REQUIRED/);
    assert.equal(mock.scripts.size, 0); assert(mock.calls.some(([kind]) => kind === 'stop'));
  }
});

test('audit: raw whitespace, Unicode escapes and escaped flag literals stay lossless', () => {
  const values = ['"brace [ ] , quote \\\" slash \\\\"', ...Array(29).fill('null'), 'false', 'null'];
  const raw = `[ ${values.join(',  ')} ]`;
  const outer = `  [ [ "wrb.fr", "cPZSdc", ${JSON.stringify(raw).replace('false', '\\u0066alse')}, "\\u0061" ] ]  `;
  const result = rewriteConfiguration(outer);
  assert.equal(result.changed, 1);
  assert.equal(result.text, outer.replace('\\u0066alse', 'true'));
});

test('audit: ambiguous frame declarations and truncated target JSON fail closed', () => {
  for (const prefix of ['-1', '1e4', '+200', 'bad-length']) {
    const text = framed().replace(/\n\d+\n/, `\n${prefix}\n`);
    const result = rewriteConfiguration(text);
    assert.equal(result.text, text); assert.equal(result.changed, 0); assert.equal(result.rejected, 1);
  }
  assert.equal(rewriteConfiguration('[["wrb.fr","cPZSdc",').rejected, 1);
});

test('audit: partial bodies and non-UTF-8 declared charsets keep the original response', async () => {
  for (const options of [
    { headers: { 'content-type': 'text/plain; charset=windows-1256' } },
    { status: 206 }, { headers: { 'content-range': 'bytes 0-100/500' } }
  ]) {
    const source = new Response(framed(), options);
    const doc = documentFixture();
    const page = { fetch: async () => source, location: { href: 'https://flow.google.com/' } };
    installEngine(page, doc);
    assert.equal(await page.fetch(batchURL), source); assert.equal(doc.status().changes, 0);
  }
});

test('audit: page-owned runtime accessors are not invoked and install no hooks', () => {
  let calls = 0;
  const native = async () => new Response(framed());
  const page = { fetch: native, location: { href: 'https://flow.google.com/' } };
  Object.defineProperty(page, Symbol.for(RUNTIME_KEY), { get() { calls++; throw new Error('Hostile page'); } });
  assert.doesNotThrow(() => installEngine(page, documentFixture()));
  assert.equal(calls, 0); assert.equal(page.fetch, native);
});

test('audit: status bridge only answers its packaged popup and bounds page data', async () => {
  const mock = fakeChrome(); let listener; let raw = JSON.stringify({ version: '0', state: 'applied' });
  mock.api.runtime = { id: 'audit-extension', getURL: path => `chrome-extension://audit-extension/${path}`,
    onMessage: { addListener(value) { listener = value; } } };
  const code = await readFile(new URL('../dist/content/status.js', import.meta.url), 'utf8');
  vm.runInNewContext(code, { chrome: mock.api, document: { documentElement: { getAttribute: () => raw } } });
  const good = { id: mock.api.runtime.id, url: mock.api.runtime.getURL('ui/popup.html') };
  for (const sender of [{ ...good, id: 'other' }, { ...good, tab: {} }, { ...good, url: 'https://flow.google.com/' }]) {
    assert.equal(listener({ type: STATUS_MESSAGE }, sender, () => assert.fail('Untrusted sender')), undefined);
  }
  let response;
  listener({ type: STATUS_MESSAGE }, good, value => { response = value; });
  assert.equal(response.status, null);
  raw = 'x'.repeat(513);
  listener({ type: STATUS_MESSAGE }, good, value => { response = value; });
  assert.equal(response.status, null);
});
