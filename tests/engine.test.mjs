import test from 'node:test';
import assert from 'node:assert/strict';
import { installEngine } from '../src/content/engine.js';
import { BODY_LIMIT, STATUS_ATTRIBUTE } from '../src/shared/constants.js';
import { framed, payload, entry, decoded, batchURL } from './fixtures.mjs';

function world(fetcher = async () => new Response(framed())) {
  class XHR {
    constructor() { this.readyState = 0; this.responseType = ''; this.status = 0; this.responseURL = ''; this.raw = ''; }
    open(method, url) { this.readyState = 1; this.url = String(url); this.raw = ''; this.status = 0; this.responseURL = ''; }
    finish(raw, status = 200) { this.raw = raw; this.status = status; this.responseURL = this.url; this.readyState = 4; }
    get responseText() { if (this.responseType && this.responseType !== 'text') throw new DOMException('InvalidStateError'); return this.raw; }
    get response() { return this.responseType === 'json' ? JSON.parse(this.raw) : this.raw; }
  }
  const attributes = new Map();
  const doc = { documentElement: { setAttribute(key, value) { attributes.set(key, value); } } };
  const page = { fetch: fetcher, XMLHttpRequest: XHR, location: { href: 'https://flow.google.com/' } };
  const runtime = installEngine(page, doc);
  return { page, doc, runtime, XHR, status: () => JSON.parse(attributes.get(STATUS_ATTRIBUTE)) };
}
function flag(text) { return JSON.parse(decoded(text)[0][2])[30]; }

test('fetch changes known responses and preserves native response metadata across clones', async () => {
  const source = new Response(framed(), { status: 200, statusText: 'OK', headers: { 'content-type': 'application/json', 'content-length': '10', 'content-encoding': 'gzip', etag: 'old' } });
  Object.defineProperties(source, { url: { value: batchURL }, redirected: { value: true }, type: { value: 'basic' } });
  const { page, status } = world(async () => source);
  const output = await page.fetch(new URL(batchURL));
  assert.notEqual(output, source); assert(output instanceof Response);
  assert.equal(output.url, batchURL); assert.equal(output.redirected, true); assert.equal(output.type, 'basic');
  assert.equal(output.statusText, 'OK'); assert.equal(output.headers.get('content-length'), null);
  assert.equal(output.headers.get('content-encoding'), null); assert.equal(output.headers.get('etag'), null);
  const clone = output.clone().clone(); assert.equal(clone.url, batchURL); assert.equal(clone.type, 'basic');
  assert.equal(flag(await output.text()), true); assert.equal(flag(await clone.text()), true);
  assert.equal(status().changes, 1); assert.equal(status().responses, 1);
});

test('fetch passes request arguments and native rejection through', async () => {
  const reason = new Error('Network failure');
  let args;
  const { page } = world(function (...input) { args = input; return Promise.reject(reason); });
  const options = { method: 'POST', body: 'not-inspected' };
  await assert.rejects(page.fetch(batchURL, options), error => error === reason);
  assert.equal(args[1], options);
});

test('unrelated fetch, error status, non-text and already-enabled responses keep identity', async () => {
  for (const scenario of [
    { url: 'https://example.com/', response: new Response(framed()) },
    { url: batchURL, response: new Response(framed(), { status: 403 }) },
    { url: batchURL, response: new Response(framed(), { headers: { 'content-type': 'image/png' } }) },
    { url: batchURL, response: new Response(framed([entry(payload(true))])) }
  ]) {
    const { page } = world(async () => scenario.response);
    assert.equal(await page.fetch(scenario.url), scenario.response);
  }
});

test('a redirected response outside the known endpoint is not modified', async () => {
  const source = new Response(framed());
  Object.defineProperty(source, 'url', { value: 'https://accounts.google.com/' });
  const { page, status } = world(async () => source);
  assert.equal(await page.fetch(batchURL), source); assert.equal(status().changes, 0);
});

test('large streamed decoded bodies are skipped and remain readable', async () => {
  const source = new Response(framed() + ' '.repeat(BODY_LIMIT));
  const { page, status } = world(async () => source);
  const output = await page.fetch(batchURL);
  assert.equal(output, source); assert.equal(status().changes, 0);
  assert((await output.text()).length > BODY_LIMIT);
});

test('XHR caches once, resets on reuse and applies at most one actual change', () => {
  const { XHR, status } = world();
  const xhr = new XHR(); xhr.open('POST', batchURL); xhr.finish(framed());
  assert.equal(flag(xhr.responseText), true); assert.equal(xhr.response, xhr.responseText);
  assert.equal(status().changes, 1);
  xhr.open('POST', batchURL); xhr.finish(framed());
  assert.equal(flag(xhr.response), false); assert.equal(status().changes, 1); assert.equal(status().state, 'limited');
  xhr.open('GET', 'https://example.com/'); xhr.finish('unrelated');
  assert.equal(xhr.responseText, 'unrelated'); assert.equal(status().responses, 2);
});

test('partial XHR text and native responseType exceptions are preserved', () => {
  const { XHR, status } = world();
  const xhr = new XHR(); xhr.open('POST', batchURL); xhr.readyState = 3; xhr.raw = 'partial';
  assert.equal(xhr.responseText, 'partial'); assert.equal(status().changes, 0);
  xhr.responseType = 'json'; xhr.finish('{"value":1}');
  assert.deepEqual(xhr.response, { value: 1 }); assert.throws(() => xhr.responseText, DOMException);
});

test('XHR failures and changed response URLs pass through untouched', () => {
  const { XHR } = world(); const xhr = new XHR();
  xhr.open('POST', batchURL); xhr.finish(framed(), 500); assert.equal(flag(xhr.responseText), false);
  xhr.open('POST', batchURL); xhr.finish(framed()); xhr.responseURL = 'https://example.com/'; assert.equal(flag(xhr.responseText), false);
});

test('stop restores owned hooks and prevents in-flight modification', async () => {
  let deliver;
  const originalFetch = () => new Promise(resolve => { deliver = resolve; });
  const { page, runtime, status, XHR } = world(originalFetch);
  const pending = page.fetch(batchURL);
  assert.equal(runtime.stop(), true); assert.equal(page.fetch, originalFetch);
  const source = new Response(framed()); deliver(source);
  assert.equal(await pending, source); assert.equal(status().state, 'disabled');
  const xhr = new XHR(); xhr.open('POST', batchURL); xhr.finish(framed()); assert.equal(flag(xhr.responseText), false);
});

test('stop does not overwrite a wrapper installed later by another extension', () => {
  const { page, runtime } = world();
  const later = () => Promise.resolve(new Response('later')); page.fetch = later;
  runtime.stop(); assert.equal(page.fetch, later);
});

test('duplicate installation does not wrap twice or publish response contents', async () => {
  const { page, doc, runtime, status } = world(); const first = page.fetch;
  assert.equal(installEngine(page, doc), runtime); assert.equal(page.fetch, first);
  await page.fetch(batchURL);
  assert.deepEqual(Object.keys(status()).sort(), ['changes', 'rejected', 'responses', 'state', 'version']);
});

test('the sole engine changes known responses without a mode parameter', async () => {
  const fetchWorld = world();
  assert.equal(flag(await (await fetchWorld.page.fetch(batchURL)).text()), true);
  const xhrWorld = world();
  const xhr = new xhrWorld.XHR(); xhr.open('POST', batchURL); xhr.finish(framed());
  assert.equal(flag(xhr.responseText), true);
  for (const instance of [fetchWorld, xhrWorld]) {
    assert.equal(instance.status().changes, 1); assert.equal(instance.status().state, 'applied');
    assert(!Object.hasOwn(instance.status(), 'mode'));
  }
});

test('401, 403 and 429 halt modification without retrying or changing the denial', async () => {
  for (const statusCode of [401, 403, 429]) {
    let calls = 0;
    const source = new Response('denied', { status: statusCode });
    const native = async () => { calls++; return source; };
    const { page, status } = world(native);
    assert.equal(await page.fetch(batchURL), source);
    assert.equal(page.fetch, native); assert.equal(status().state, 'paused'); assert.equal(calls, 1);
  }
});

test('XHR 429 halts hooks and returns the original response', () => {
  const { page, XHR, status } = world(); const hooked = page.fetch;
  const xhr = new XHR(); xhr.open('POST', batchURL); xhr.finish('rate limited', 429);
  assert.equal(xhr.responseText, 'rate limited'); assert.equal(status().state, 'paused'); assert.notEqual(page.fetch, hooked);
});

test('concurrent matching fetches share a one-change budget', async () => {
  const { page, status } = world();
  const responses = await Promise.all([page.fetch(batchURL), page.fetch(batchURL), page.fetch(batchURL)]);
  const flags = await Promise.all(responses.map(async response => flag(await response.text())));
  assert.equal(flags.filter(Boolean).length, 1); assert.equal(status().changes, 1);
});

test('ambiguous multi-config or unknown schemas halt instead of partially rewriting', async () => {
  for (const body of [framed([entry(), entry()]), framed([entry(payload('unknown'))])]) {
    const source = new Response(body); const { page, status } = world(async () => source);
    assert.equal(await page.fetch(batchURL), source);
    assert.equal(await source.text(), body); assert.equal(status().changes, 0); assert.equal(status().state, 'schema-mismatch');
  }
});

test('a stalled cloned body has a bounded wait and the original remains usable', async () => {
  let stream;
  const source = new Response(new ReadableStream({ start(controller) { stream = controller; } }));
  const { page, status } = world(async () => source);
  const started = Date.now();
  assert.equal(await page.fetch(batchURL), source);
  assert(Date.now() - started < 5000);
  stream.enqueue(new TextEncoder().encode(framed())); stream.close();
  assert.equal(flag(await source.text()), false); assert.equal(status().changes, 0);
});
