import { FLOW_HOME, STATUS_MESSAGE, isFlowPage } from '../shared/constants.js';
import { sanitizeDiagnostic } from '../core/diagnostics.js';
import { copy } from './copy.js';

const find = id => document.getElementById(id);
const state = { enabled: false, busy: true, tab: null, status: 'waiting', reload: false, error: '' };
let inspecting = false;
let inspectionVersion = 0;
const noticeStates = new Set(['disabledReload', 'reload', 'paused', 'schema-mismatch', 'error']);

function render() {
  find('toggle').setAttribute('aria-checked', String(state.enabled));
  find('toggle').disabled = state.busy;
  find('enabled-label').textContent = state.enabled ? 'افزونه روشن است' : 'افزونه خاموش است';
  find('notice').hidden = !noticeStates.has(state.status) || !!state.error;
  find('notice').textContent = noticeStates.has(state.status) ? copy[state.status] : '';
  find('refresh').hidden = !isFlowPage(state.tab?.url) || !['reload', 'disabledReload'].includes(state.status);
  find('refresh').disabled = state.busy;
  find('error').textContent = state.error ? copy[state.error] : '';
}

async function request(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok) throw new Error(response?.error || 'UNAVAILABLE');
  return response;
}

async function inspectTab() {
  if (inspecting) return;
  inspecting = true;
  const version = ++inspectionVersion;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (version !== inspectionVersion) return;
    state.tab = tab;
    if (!state.enabled) { state.status = state.reload ? 'disabledReload' : 'disabled'; return; }
    if (!isFlowPage(state.tab?.url)) { state.status = 'noTab'; return; }
    try {
      const response = await chrome.tabs.sendMessage(state.tab.id, { type: STATUS_MESSAGE }, { frameId: 0 });
      if (version !== inspectionVersion) return;
      const diagnostic = sanitizeDiagnostic(response?.status);
      state.status = diagnostic && diagnostic.state !== 'disabled' ? diagnostic.state : 'reload';
    } catch { if (version === inspectionVersion) state.status = 'reload'; }
  } catch { if (version === inspectionVersion) state.status = state.enabled ? 'noTab' : 'disabled'; }
  finally { if (version === inspectionVersion) { inspecting = false; render(); } }
}

async function save(message) {
  if (state.busy) return;
  // Ignore a previous poll that finishes after this newer user action.
  inspectionVersion++; inspecting = false;
  state.busy = true; state.error = ''; render();
  try {
    const result = await request(message);
    state.enabled = result.enabled; state.reload = result.needsReload;
    await inspectTab();
  } catch (error) { state.error = error.message === 'RECOVERY_REQUIRED' ? 'recovery' : 'saveError'; }
  finally { state.busy = false; render(); }
}

find('toggle').addEventListener('click', () => { void save({ type: 'flow-problem/set-enabled', enabled: !state.enabled }); });

find('open').addEventListener('click', () => {
  void chrome.tabs.create({ url: FLOW_HOME }).catch(() => { state.error = 'unavailable'; render(); });
});

find('refresh').addEventListener('click', async () => {
  if (state.busy || !state.tab?.id) return;
  state.busy = true; state.error = ''; render();
  try {
    const tab = await chrome.tabs.get(state.tab.id);
    if (!isFlowPage(tab.url)) throw new Error('NOT_FLOW');
    const url = new URL(tab.url);
    if (url.pathname === '/unsupported-country' || url.pathname === '/unsupported-country/') {
      url.pathname = '/';
      await chrome.tabs.update(tab.id, { url: url.href });
    } else await chrome.tabs.reload(tab.id);
    state.reload = false;
    window.close();
  } catch (error) { state.error = error.message === 'NOT_FLOW' ? 'tabError' : 'unavailable'; }
  finally { state.busy = false; render(); }
});

for (const page of ['help', 'privacy']) {
  find(page).addEventListener('click', () => {
    void chrome.tabs.create({ url: chrome.runtime.getURL(`ui/${page}.html`) }).catch(() => { state.error = 'unavailable'; render(); });
  });
}

async function initialize() {
  try {
    const settings = await request({ type: 'flow-problem/get-state' });
    state.enabled = settings.enabled;
    state.reload = !!settings.needsReload;
    await inspectTab();
  } catch { state.error = 'unavailable'; }
  finally { state.busy = false; render(); }
}
render();
void initialize();
const timer = window.setInterval(() => { if (!state.busy) void inspectTab(); }, 1500);
window.addEventListener('pagehide', () => window.clearInterval(timer), { once: true });
