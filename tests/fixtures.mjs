import { BATCH_PATH, FLOW_ORIGIN } from '../src/shared/constants.js';

export const batchURL = `${FLOW_ORIGIN}${BATCH_PATH}?rpcids=other,cPZSdc`;
export function payload(flag = false, length = 32) {
  const values = Array(length).fill(null);
  if (length > 30) values[30] = flag;
  return values;
}
export function entry(values = payload(), rpc = 'cPZSdc') {
  return ['wrb.fr', rpc, JSON.stringify(values), null, null, null, 'generic'];
}
export function framed(entries = [entry()], { newline = '\n', units = 'bytes', extra = 0 } = {}) {
  const json = JSON.stringify(entries);
  const length = units === 'bytes' ? new TextEncoder().encode(json).length : json.length;
  return [")]}'", '', String(length + extra), json, ''].join(newline);
}
export function decoded(text) {
  return text.split(/\r?\n/).filter(line => line.startsWith('[[')).flatMap(line => JSON.parse(line));
}
export function fakeChrome(initialEnabled = false) {
  const data = { enabled: initialEnabled };
  const scripts = new Map();
  const calls = [];
  const fail = { storage: false, register: false, unregister: false, stop: false, update: false };
  const api = {
    storage: { local: {
      async get(defaults) { return { ...defaults, ...data }; },
      async remove(key) { delete data[key]; calls.push(['remove', key]); },
      async set(values) { if (fail.storage) { fail.storage = false; throw new Error('Disk unavailable'); } Object.assign(data, values); calls.push(['store', values]); },
      async setAccessLevel(value) { calls.push(['access', value]); }
    } },
    scripting: {
      async getRegisteredContentScripts({ ids }) { return [...scripts.values()].filter(script => ids.includes(script.id)); },
      async registerContentScripts(values) {
        if (fail.register) { fail.register = false; throw new Error('Registration denied'); }
        for (const value of values) { if (scripts.has(value.id)) throw new Error('Duplicate'); scripts.set(value.id, value); }
        calls.push(['register', values.length]);
      },
      async unregisterContentScripts({ ids }) {
        if (fail.unregister) { fail.unregister = false; throw new Error('Removal denied'); }
        for (const id of ids) scripts.delete(id);
        calls.push(['unregister', ids.length]);
      },
      async updateContentScripts(values) {
        if (fail.update) { fail.update = false; throw new Error('Update denied'); }
        for (const value of values) { if (!scripts.has(value.id)) throw new Error('Missing'); scripts.set(value.id, value); }
        calls.push(['update', values.length]);
      },
      async executeScript(options) { if (fail.stop) throw new Error('Tab unavailable'); calls.push(['stop', options.target.tabId]); return [{ frameId: 0, result: true }]; }
    },
    tabs: { async query() { return [{ id: 42, url: `${FLOW_ORIGIN}/` }]; } },
    action: { async setBadgeText(value) { calls.push(['badge', value.text]); }, async setBadgeBackgroundColor() {} }
  };
  return { api, data, scripts, calls, fail };
}
