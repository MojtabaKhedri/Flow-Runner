import { createController } from './controller.js';

const controller = createController(chrome);
const initialize = (stopExisting = false) => controller.initialize({ stopExisting }).catch(() => console.warn('Flow Runner: initialization failed. Open the extension to retry.'));
chrome.runtime.onInstalled.addListener(() => { void initialize(true); });
chrome.runtime.onStartup.addListener(() => { void initialize(); });
void initialize();

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  // Control messages are accepted only from this exact packaged popup.
  if (sender.id !== chrome.runtime.id || sender.tab || sender.url !== chrome.runtime.getURL('ui/popup.html')) return;
  let operation;
  if (message?.type === 'flow-problem/get-state') operation = controller.getState();
  else if (message?.type === 'flow-problem/set-enabled' && typeof message.enabled === 'boolean') operation = controller.setEnabled(message.enabled);
  else return;
  operation.then(state => respond({ ok: true, ...state }), error => {
    respond({ ok: false, error: error.message === 'RECOVERY_REQUIRED' ? 'RECOVERY_REQUIRED' : 'SETTING_FAILED' });
  });
  return true;
});
