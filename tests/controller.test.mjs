import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createController, REGISTRATIONS } from '../src/background/controller.js';
import { fakeChrome } from './fixtures.mjs';

test('a fresh install is off, with no registered content script', async () => {
  const mock = fakeChrome(); const controller = createController(mock.api);
  assert.deepEqual(await controller.initialize(), { enabled: false });
  assert.equal(mock.scripts.size, 0);
  assert(mock.calls.some(([kind, value]) => kind === 'access' && value.accessLevel === 'TRUSTED_CONTEXTS'));
});

test('enabling registers both worlds; disabling stops open pages and survives restart', async () => {
  const mock = fakeChrome(); let controller = createController(mock.api);
  await controller.initialize();
  assert.deepEqual(await controller.setEnabled(true), { enabled: true, needsReload: true });
  assert.equal(mock.scripts.size, 2); assert.equal(mock.data.enabled, true);
  assert.deepEqual(await controller.setEnabled(false), { enabled: false, needsReload: false });
  assert.equal(mock.scripts.size, 0); assert.equal(mock.data.enabled, false);
  assert(mock.calls.some(([kind]) => kind === 'stop'));
  controller = createController(mock.api); await controller.initialize();
  assert.equal(mock.scripts.size, 0);
});

test('restart restores a saved on state and repairs partial registrations', async () => {
  const mock = fakeChrome(true); mock.scripts.set(REGISTRATIONS[0].id, REGISTRATIONS[0]);
  await createController(mock.api).initialize();
  assert.equal(mock.scripts.size, 2);
  assert([...mock.scripts.values()].every(script => script.matches[0] === 'https://flow.google.com/*'));
});

test('concurrent toggles are serialized into the last requested state', async () => {
  const mock = fakeChrome(); const controller = createController(mock.api);
  await Promise.all([controller.initialize(), controller.setEnabled(true), controller.setEnabled(false), controller.setEnabled(true)]);
  assert.equal(mock.data.enabled, true); assert.equal(mock.scripts.size, 2);
});

test('failed storage or registration rolls back the entire setting transaction', async () => {
  for (const failure of ['storage', 'register']) {
    const mock = fakeChrome(); const controller = createController(mock.api);
    await controller.initialize(); mock.fail[failure] = true;
    await assert.rejects(controller.setEnabled(true), /SETTING_FAILED/);
    assert.equal(mock.data.enabled, false); assert.equal(mock.scripts.size, 0);
    await controller.setEnabled(true); assert.equal(mock.scripts.size, 2);
  }
});

test('failure while disabling restores the previous on state', async () => {
  const mock = fakeChrome(true); const controller = createController(mock.api);
  await controller.initialize(); mock.fail.storage = true;
  await assert.rejects(controller.setEnabled(false), /SETTING_FAILED/);
  assert.equal(mock.data.enabled, true); assert.equal(mock.scripts.size, 2);
});

test('unreachable existing tabs require reload without secretly re-enabling', async () => {
  const mock = fakeChrome(true); const controller = createController(mock.api);
  await controller.initialize(); mock.fail.stop = true;
  assert.deepEqual(await controller.setEnabled(false), { enabled: false, needsReload: true });
  assert.equal(mock.scripts.size, 0); assert.equal(mock.data.enabled, false);
});

test('reopening the popup retries stopping inaccessible pages while preserving off', async () => {
  const mock = fakeChrome(false); const controller = createController(mock.api);
  await controller.initialize(); mock.fail.stop = true;
  assert.deepEqual(await controller.getState(), { enabled: false, needsReload: true });
  assert.equal(mock.data.enabled, false);
  mock.fail.stop = false;
  assert.deepEqual(await controller.getState(), { enabled: false, needsReload: false });
});

test('malformed enable values are rejected without changing state', async () => {
  const mock = fakeChrome(); const controller = createController(mock.api);
  for (const value of ['true', 1, null, undefined, {}]) await assert.rejects(controller.setEnabled(value), /INVALID_MESSAGE/);
  assert.equal(mock.calls.length, 0);
});

test('upgrading either legacy mode keeps the switch state and replaces the old engine', async () => {
  for (const enabled of [true, false]) for (const mode of ['observe', 'compatibility']) {
    const mock = fakeChrome(enabled); mock.data.mode = mode;
    mock.scripts.set(REGISTRATIONS[0].id, { ...REGISTRATIONS[0], js: ['content/observe.js'] });
    const controller = createController(mock.api);
    assert.deepEqual(await controller.initialize(), { enabled });
    assert.deepEqual(mock.data, { enabled });
    assert(mock.calls.some(([kind]) => kind === 'stop'));
    if (enabled) assert.deepEqual(mock.scripts.get(REGISTRATIONS[0].id).js, ['content/main.js']);
    else assert.equal(mock.scripts.size, 0);
    await createController(mock.api).initialize();
    assert.deepEqual(mock.data, { enabled });
  }
});

test('worker only accepts control messages from its exact packaged popup', async () => {
  const mock = fakeChrome(); let listener;
  mock.api.runtime = {
    id: 'test-extension', getURL: path => `chrome-extension://test-extension/${path}`,
    onInstalled: { addListener() {} }, onStartup: { addListener() {} },
    onMessage: { addListener(value) { listener = value; } }
  };
  const worker = await readFile(new URL('../dist/background/worker.js', import.meta.url), 'utf8');
  vm.runInNewContext(worker, { chrome: mock.api, console });
  const good = { id: 'test-extension', url: mock.api.runtime.getURL('ui/popup.html') };
  assert.equal(listener({ type: 'flow-problem/set-mode', mode: 'observe' }, good, () => assert.fail('Removed control must not respond')), undefined);
  for (const sender of [{ ...good, id: 'other' }, { ...good, tab: { id: 42 } }, { ...good, url: 'https://flow.google.com/' }]) {
    assert.equal(listener({ type: 'flow-problem/set-enabled', enabled: true }, sender, () => assert.fail('Must not respond')), undefined);
  }
  const result = await new Promise(resolve => assert.equal(listener({ type: 'flow-problem/set-enabled', enabled: true }, good, resolve), true));
  assert.equal(result.ok, true); assert.equal(mock.data.enabled, true);
});
