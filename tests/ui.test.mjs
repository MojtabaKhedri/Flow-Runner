import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { VERSION } from '../src/shared/constants.js';

const flush = async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve)); };

test('a delayed status poll cannot overwrite the warning from a newer off action', async () => {
  const nodes = new Map();
  const get = id => {
    if (!nodes.has(id)) nodes.set(id, { textContent: '', handlers: {}, setAttribute() {}, addEventListener(type, fn) { this.handlers[type] = fn; } });
    return nodes.get(id);
  };
  let poll; let sendCount = 0; let resolveOldStatus;
  const chrome = {
    runtime: { getURL: value => `chrome-extension://test/${value}`, async sendMessage(message) {
      return message.type.endsWith('set-enabled') ? { ok: true, enabled: false, needsReload: true } : { ok: true, enabled: true, needsReload: false };
    } },
    tabs: { async query() { return [{ id: 1, url: 'https://flow.google.com/' }]; }, sendMessage() {
      if (++sendCount === 2) return new Promise(resolve => { resolveOldStatus = resolve; });
      return Promise.resolve({ status: { version: VERSION, state: 'waiting', responses: 0, changes: 0, rejected: 0 } });
    } }
  };
  const source = await readFile(new URL('../dist/ui/popup.js', import.meta.url), 'utf8');
  vm.runInNewContext(source, { document: { getElementById: get }, chrome, URL,
    window: { setInterval(fn) { poll = fn; }, clearInterval() {}, addEventListener() {} } });
  await flush(); poll(); await flush();
  assert.equal(typeof resolveOldStatus, 'function');
  get('toggle').handlers.click(); await flush();
  resolveOldStatus({ status: { version: VERSION, state: 'schema-mismatch', responses: 1, changes: 0, rejected: 1 } });
  await flush();
  assert.equal(get('enabled-label').textContent, 'افزونه خاموش است');
  assert.match(get('notice').textContent, /افزونه خاموش شد/);
  assert.equal(get('notice').hidden, false);
});
