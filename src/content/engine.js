import { BODY_LIMIT, RUNTIME_KEY, STATUS_ATTRIBUTE, isBatchRequest } from '../shared/constants.js';
import { rewriteConfiguration } from '../core/protocol.js';
import { newDiagnostic } from '../core/diagnostics.js';

/** Read a cloned response with a decoded byte limit, including chunked bodies. */
async function boundedText(response) {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  let total = 0;
  let text = '';
  let expired = false;
  const timer = setTimeout(() => {
    expired = true;
    void reader.cancel().catch(() => {});
  }, 2000);
  try {
    while (true) {
      const chunk = await reader.read();
      if (expired) return null;
      if (chunk.done) return text + decoder.decode();
      total += chunk.value.byteLength;
      if (total > BODY_LIMIT) {
        // A tee branch may wait for its sibling; never block the page on cancel.
        void reader.cancel().catch(() => {});
        return null;
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
  } finally { clearTimeout(timer); reader.releaseLock(); }
}

function preserveMetadata(response, source) {
  const metadata = { url: source.url, redirected: source.redirected, type: source.type };
  Object.defineProperties(response, {
    url: { value: metadata.url, configurable: true },
    redirected: { value: metadata.redirected, configurable: true },
    type: { value: metadata.type, configurable: true },
    clone: {
      configurable: true,
      value() { return preserveMetadata(Response.prototype.clone.call(this), metadata); }
    }
  });
  return response;
}

/** Install once in the page MAIN world. No extension APIs or remote settings. */
export function installEngine(page = window, doc = document) {
  const key = Symbol.for(RUNTIME_KEY);
  const existing = Object.getOwnPropertyDescriptor(page, key);
  if (existing) return existing.value;
  const diagnostic = newDiagnostic();
  let stopped = false;
  const restores = [];

  function publish() {
    try { doc.documentElement?.setAttribute(STATUS_ATTRIBUTE, JSON.stringify(diagnostic)); }
    catch { /* Status publication must never break a site's request. */ }
  }

  function halt(state) {
    stopped = true;
    for (const restore of [...restores].reverse()) { try { restore(); } catch {} }
    diagnostic.state = state;
    publish();
  }

  function denied(status) {
    if ([401, 403, 429].includes(status)) { halt('paused'); return true; }
    return false;
  }

  function transform(text) {
    if (stopped) return text;
    const result = rewriteConfiguration(text);
    diagnostic.responses = Math.min(diagnostic.responses + 1, 1_000_000);
    diagnostic.rejected = Math.min(diagnostic.rejected + result.rejected, 1_000_000);
    if (result.rejected || result.matched > 1) {
      diagnostic.rejected = Math.min(diagnostic.rejected + (result.matched > 1 ? result.matched : 0), 1_000_000);
      halt('schema-mismatch');
      return text;
    }
    if (result.changed && diagnostic.changes >= 1) {
      diagnostic.state = 'limited';
      publish();
      return text;
    }
    diagnostic.changes += result.changed;
    diagnostic.state = diagnostic.changes ? 'applied' : result.matched ? 'unchanged' : 'waiting';
    publish();
    return result.text;
  }

  function targets(input) { return isBatchRequest(input, page.location.href); }

  const runtime = Object.freeze({
    stop() {
      halt('disabled');
      return true;
    }
  });
  // Reserve the marker BEFORE installing hooks. A failed reservation is inert.
  try { Object.defineProperty(page, key, { value: runtime, configurable: false }); }
  catch { halt('error'); return runtime; }

  const originalFetch = page.fetch;
  if (typeof originalFetch === 'function') {
    function hookedFetch(...args) {
      // Native errors, AbortSignal and request arguments pass through unchanged.
      const pending = Reflect.apply(originalFetch, this, args);
      if (stopped || !targets(args[0])) return pending;
      return pending.then(async response => {
        if (stopped || (response.url && !targets(response.url))) return response;
        if (denied(response.status) || !response.ok) return response;
        const contentType = response.headers.get('content-type') || '';
        if (contentType && !/^(application\/(json|x-javascript)|text\/)/i.test(contentType)) return response;
        const charset = /;\s*charset\s*=\s*"?([^;"\s]+)/i.exec(contentType)?.[1];
        if (charset && !/^(utf-8|utf8|us-ascii)$/i.test(charset)) return response;
        if (response.status === 206 || response.headers.has('content-range')) return response;
        if (Number(response.headers.get('content-length')) > BODY_LIMIT) return response;
        try {
          const text = await boundedText(response.clone());
          if (text === null || stopped) return response;
          const rewritten = transform(text);
          if (rewritten === text) return response;
          const headers = new Headers(response.headers);
          for (const header of ['content-length', 'content-encoding', 'content-md5', 'digest', 'etag']) headers.delete(header);
          return preserveMetadata(new Response(rewritten, {
            status: response.status, statusText: response.statusText, headers
          }), response);
        } catch {
          if (!stopped) halt('error');
          return response;
        }
      });
    }
    try {
      page.fetch = hookedFetch;
      if (page.fetch !== hookedFetch) throw new Error('FETCH_HOOK_UNAVAILABLE');
      restores.push(() => { if (page.fetch === hookedFetch) page.fetch = originalFetch; });
    } catch { diagnostic.state = 'error'; }
  }

  const proto = page.XMLHttpRequest?.prototype;
  if (proto) {
    const requests = new WeakMap();
    const originalOpen = proto.open;
    const descriptors = new Map(['response', 'responseText'].map(name => [name, Object.getOwnPropertyDescriptor(proto, name)]));
    function hookedOpen(...args) {
      const result = Reflect.apply(originalOpen, this, args);
      // Reset on EVERY open(), including reuse for an unrelated URL.
      requests.set(this, { target: targets(args[1]), cached: false, text: undefined });
      return result;
    }
    try {
      proto.open = hookedOpen;
      if (proto.open !== hookedOpen) throw new Error('XHR_HOOK_UNAVAILABLE');
      restores.push(() => { if (proto.open === hookedOpen) proto.open = originalOpen; });
      for (const [name, descriptor] of descriptors) {
        if (!descriptor?.get || !descriptor.configurable) { diagnostic.state = 'error'; continue; }
        function readResponse() {
          const raw = Reflect.apply(descriptor.get, this, []);
          const request = requests.get(this);
          if (stopped || !request?.target || this.readyState !== 4) return raw;
          if (this.responseURL && !targets(this.responseURL)) return raw;
          if (denied(this.status)) return raw;
          if (typeof raw !== 'string' ||
              (this.responseType && this.responseType !== 'text') || this.status < 200 || this.status >= 300) return raw;
          if (!request.cached) {
            request.cached = true;
            try { request.text = transform(raw); }
            catch { request.text = raw; halt('error'); }
          }
          return request.text;
        }
        Object.defineProperty(proto, name, { ...descriptor, get: readResponse });
        restores.push(() => {
          if (Object.getOwnPropertyDescriptor(proto, name)?.get === readResponse) Object.defineProperty(proto, name, descriptor);
        });
      }
    } catch { diagnostic.state = 'error'; }
  }

  if (diagnostic.state === 'error') halt('error');
  if (doc.documentElement) publish();
  else doc.addEventListener('DOMContentLoaded', publish, { once: true });
  return runtime;
}
