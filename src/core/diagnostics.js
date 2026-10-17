import { VERSION } from '../shared/constants.js';

export const STATES = new Set(['waiting', 'unchanged', 'applied', 'limited', 'paused', 'schema-mismatch', 'error', 'disabled']);
export function newDiagnostic() {
  return { version: VERSION, state: 'waiting', responses: 0, changes: 0, rejected: 0 };
}

/** The page can alter DOM attributes. Status is informational, never authority. */
export function sanitizeDiagnostic(value) {
  if (!value || value.version !== VERSION || Object.hasOwn(value, 'mode') || !STATES.has(value.state)) return null;
  const output = { version: VERSION, state: value.state };
  for (const key of ['responses', 'changes', 'rejected']) {
    if (!Number.isSafeInteger(value[key]) || value[key] < 0 || value[key] > 1_000_000) return null;
    output[key] = value[key];
  }
  return output;
}
