export const VERSION = '1.0.1';
export const BRAND_NAME = 'Flow Runner';
export const FLOW_ORIGIN = 'https://flow.google.com';
export const FLOW_HOME = `${FLOW_ORIGIN}/`;
export const FLOW_MATCH = `${FLOW_ORIGIN}/*`;
export const BATCH_PATH = '/_/AiSandboxAngularFrontend/data/batchexecute';
// Keep protocol identifiers stable so existing registrations and open tabs survive rebranding.
export const STATUS_ATTRIBUTE = 'data-flow-problem-v1';
export const RUNTIME_KEY = 'flow-problem.runtime.v1';
export const STATUS_MESSAGE = 'flow-problem/status';
export const BODY_LIMIT = 2 * 1024 * 1024;

export function isFlowPage(rawUrl) {
  try { return new URL(rawUrl).origin === FLOW_ORIGIN; }
  catch { return false; }
}

export function isBatchRequest(input, base = FLOW_HOME) {
  try {
    const raw = typeof input === 'string' || input instanceof URL ? input : input?.url;
    if (!raw) return false;
    const url = new URL(raw, base);
    if (url.origin !== FLOW_ORIGIN || url.pathname !== BATCH_PATH) return false;
    // When Flow includes a list of RPCs, ignore batches without the target RPC.
    const ids = url.searchParams.get('rpcids');
    return ids === null || ids.split(',').includes('cPZSdc');
  } catch { return false; }
}
