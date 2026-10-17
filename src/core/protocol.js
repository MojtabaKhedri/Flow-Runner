import { BODY_LIMIT } from '../shared/constants.js';

const encoder = new TextEncoder();
const byteLength = value => encoder.encode(value).length;

/** Infer only known framing conventions; never guess an unfamiliar length. */
function frameMeasure(declaration, json) {
  if (!declaration.trim() || declaration.trim() === ")]}'") return null;
  if (!/^\d+$/.test(declaration.trim())) return false;
  const declared = Number(declaration);
  if (!Number.isSafeInteger(declared)) return false;
  for (const measure of [byteLength, value => value.length]) {
    const difference = declared - measure(json);
    if (difference >= 0 && difference <= 2) return { measure, declared };
  }
  return false;
}

/** Locate array values in already validated JSON without reserializing data. */
function arraySpans(json) {
  const spans = [];
  let start = json.indexOf('[') + 1;
  let depth = 0, quoted = false;
  for (let index = start; index < json.length; index++) {
    const char = json[index];
    if (quoted) {
      if (char === '\\') index++;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') { quoted = true; continue; }
    if (char === '[' || char === '{') { depth++; continue; }
    if ((char === ']' || char === '}') && depth) { depth--; continue; }
    if (!depth && (char === ',' || char === ']')) {
      let left = start, right = index;
      while (/[\t\r\n ]/.test(json[left] || '') && left < right) left++;
      while (right > left && /[\t\r\n ]/.test(json[right - 1])) right--;
      if (right > left) spans.push({ start: left, end: right });
      start = index + 1;
      if (char === ']') return spans;
    }
  }
  return spans;
}

// Map decoded UTF-16 offsets back into the original JSON string literal.
// Even unrelated Unicode escapes and large numeric identifiers stay untouched.
function stringOffset(literal, decodedOffset) {
  let index = 1;
  for (let count = 0; count < decodedOffset; count++) {
    if (literal[index] === '\\') index += literal[index + 1] === 'u' ? 6 : 2;
    else index++;
  }
  return index;
}

/**
 * Transform the single known regional configuration flag, not arbitrary status
 * codes. Input and output are plain data. Unknown schemas remain byte-for-byte
 * unchanged. No responses, tokens, or user payloads are retained.
 */
export function rewriteConfiguration(text) {
  const result = { text, changed: 0, matched: 0, rejected: 0 };
  if (typeof text !== 'string' || text.length > BODY_LIMIT || !text.includes('wrb.fr')) return result;
  if (byteLength(text) > BODY_LIMIT) return result;
  const parts = text.split(/(\r?\n)/);

  for (let lineIndex = 0; lineIndex < parts.length; lineIndex += 2) {
    const original = parts[lineIndex];
    if (!/^\s*\[\s*\[/.test(original)) continue;
    let entries;
    try { entries = JSON.parse(original); }
    catch { if (original.includes('cPZSdc')) result.rejected++; continue; }
    if (!Array.isArray(entries)) continue;

    const changes = [];
    const entrySpans = arraySpans(original);
    for (const [entryIndex, entry] of entries.entries()) {
      if (!Array.isArray(entry) || entry[0] !== 'wrb.fr' || entry[1] !== 'cPZSdc') continue;
      result.matched++;
      let payload;
      try { payload = typeof entry[2] === 'string' ? JSON.parse(entry[2]) : null; }
      catch { result.rejected++; continue; }
      if (!Array.isArray(payload) || payload.length < 32 ||
          !(payload[30] === null || typeof payload[30] === 'boolean')) {
        result.rejected++;
        continue;
      }
      if (payload[30] === true) continue;
      const entrySpan = entrySpans[entryIndex];
      const fields = arraySpans(original.slice(entrySpan.start, entrySpan.end));
      const fieldStart = entrySpan.start + fields[2].start;
      const fieldEnd = entrySpan.start + fields[2].end;
      const literal = original.slice(fieldStart, fieldEnd);
      const flag = arraySpans(entry[2])[30];
      changes.push({ start: fieldStart + stringOffset(literal, flag.start), end: fieldStart + stringOffset(literal, flag.end) });
    }

    if (!changes.length) continue;
    const prefixIndex = lineIndex - 2;
    const frame = prefixIndex >= 0 ? frameMeasure(parts[prefixIndex], original) : null;
    if (frame === false) {
      result.rejected += changes.length;
      continue;
    }
    let rewritten = original;
    for (const { start, end } of changes.reverse()) rewritten = rewritten.slice(0, start) + 'true' + rewritten.slice(end);
    if (frame) {
      parts[prefixIndex] = String(frame.declared + frame.measure(rewritten) - frame.measure(original));
    }
    parts[lineIndex] = rewritten;
    result.changed += changes.length;
  }

  if (result.changed) result.text = parts.join('');
  return result;
}
