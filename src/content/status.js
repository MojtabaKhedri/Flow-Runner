import { STATUS_ATTRIBUTE, STATUS_MESSAGE } from '../shared/constants.js';
import { sanitizeDiagnostic } from '../core/diagnostics.js';

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || sender.tab || sender.url !== chrome.runtime.getURL('ui/popup.html') || message?.type !== STATUS_MESSAGE) return;
  let status = null;
  try {
    const raw = document.documentElement?.getAttribute(STATUS_ATTRIBUTE);
    if (raw && raw.length < 512) status = sanitizeDiagnostic(JSON.parse(raw));
  } catch { /* Missing or page-controlled diagnostics are never trusted. */ }
  respond({ ok: true, status });
});
