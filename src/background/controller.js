import { FLOW_MATCH } from '../shared/constants.js';

export const REGISTRATIONS = [
  { id: 'flow-problem-main-v1', js: ['content/main.js'], world: 'MAIN' },
  { id: 'flow-problem-status-v1', js: ['content/status.js'], world: 'ISOLATED' }
].map(script => ({ ...script, matches: [FLOW_MATCH], runAt: 'document_start', allFrames: false, persistAcrossSessions: true }));
const ids = REGISTRATIONS.map(script => script.id);

/** All mutations are serialized, including service-worker startup and UI input. */
export function createController(api) {
  let tail = Promise.resolve();
  let accessRestricted = false;
  function serial(operation) {
    const task = tail.then(operation);
    tail = task.catch(() => {});
    return task;
  }
  async function storedSettings() {
    try {
      const stored = await api.storage.local.get({ enabled: false });
      return { enabled: stored.enabled === true };
    } catch (cause) {
      await stopOpenPages();
      try { await reconcile({ enabled: false }); } catch {}
      throw new Error('RECOVERY_REQUIRED', { cause });
    }
  }
  async function restrictAccess() {
    if (accessRestricted) return;
    try {
      await api.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
      accessRestricted = true;
    } catch (cause) {
      await stopOpenPages();
      try { await reconcile({ enabled: false }); } catch {}
      throw new Error('RECOVERY_REQUIRED', { cause });
    }
  }
  async function reconcile({ enabled }) {
    const registered = await api.scripting.getRegisteredContentScripts({ ids });
    if (!enabled) {
      if (registered.length) await api.scripting.unregisterContentScripts({ ids: registered.map(script => script.id) });
      return;
    }
    const definitions = REGISTRATIONS;
    const present = new Set(registered.map(script => script.id));
    const missing = definitions.filter(script => !present.has(script.id));
    if (missing.length) await api.scripting.registerContentScripts(missing);
    const existing = definitions.filter(script => present.has(script.id));
    if (existing.length) await api.scripting.updateContentScripts(existing);
  }
  async function updateBadge(enabled) {
    try {
      await api.action.setBadgeText({ text: enabled ? '۱' : '' });
      await api.action.setBadgeBackgroundColor({ color: '#e4002b' });
    } catch { /* Badge failure must not undo settings. */ }
  }
  async function stopOpenPages() {
    let needsReload = false;
    try {
      const tabs = await api.tabs.query({ url: FLOW_MATCH });
      await Promise.all(tabs.filter(tab => Number.isInteger(tab.id)).map(async tab => {
        try {
          const results = await api.scripting.executeScript({
            target: { tabId: tab.id, frameIds: [0] }, world: 'MAIN',
            func: () => globalThis[Symbol.for('flow-problem.runtime.v1')]?.stop() ?? true
          });
          if (!results.length || results.some(item => item.result !== true)) needsReload = true;
        } catch { needsReload = true; }
      }));
    } catch { needsReload = true; }
    return needsReload;
  }
  function changeSettings(update) {
    return serial(async () => {
      await restrictAccess();
      const previous = await storedSettings();
      const next = { ...previous, ...update };
      // Stop existing instances before disabling, including in-flight work.
      const stopFailed = !next.enabled ? await stopOpenPages() : false;
      try {
        await reconcile(next);
        await api.storage.local.set(next);
      } catch (cause) {
        try { await reconcile(previous); }
        catch { throw new Error('RECOVERY_REQUIRED', { cause }); }
        throw new Error('SETTING_FAILED', { cause });
      }
      const needsReload = next.enabled || stopFailed;
      await updateBadge(next.enabled);
      return { ...next, needsReload };
    });
  }
  return {
    initialize({ stopExisting = false } = {}) {
      return serial(async () => {
        await restrictAccess();
        if (stopExisting) await stopOpenPages();
        let legacy;
        try { legacy = await api.storage.local.get({ mode: null }); }
        catch (cause) {
          await stopOpenPages();
          try { await reconcile({ enabled: false }); } catch {}
          throw new Error('RECOVERY_REQUIRED', { cause });
        }
        if (legacy.mode !== null) {
          await stopOpenPages();
          await api.storage.local.remove('mode');
        }
        const settings = await storedSettings();
        if (!settings.enabled) await stopOpenPages();
        try { await reconcile(settings); }
        catch (error) {
          // Remove any partial registration rather than leave a hidden half-state.
          await stopOpenPages();
          try { await reconcile({ ...settings, enabled: false }); } catch {}
          throw error;
        }
        await updateBadge(settings.enabled);
        return settings;
      });
    },
    getState() {
      return serial(async () => {
        await restrictAccess();
        const settings = await storedSettings();
        await reconcile(settings);
        const needsReload = settings.enabled ? false : await stopOpenPages();
        return { ...settings, needsReload };
      });
    },
    setEnabled(enabled) {
      if (typeof enabled !== 'boolean') return Promise.reject(new TypeError('INVALID_MESSAGE'));
      return changeSettings({ enabled });
    }
  };
}
