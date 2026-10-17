import test from 'node:test';
import assert from 'node:assert/strict';
import { rewriteConfiguration } from '../src/core/protocol.js';
import { sanitizeDiagnostic, newDiagnostic } from '../src/core/diagnostics.js';
import { isBatchRequest, isFlowPage, BODY_LIMIT, FLOW_ORIGIN, BATCH_PATH } from '../src/shared/constants.js';
import { framed, entry, payload, decoded, batchURL } from './fixtures.mjs';

test('changes only the known flag and preserves all unrelated entries and fields', () => {
  const values = payload(false); values[5] = 'متن فارسی';
  const unrelated = entry([null, 5], 'KV2T2d');
  const result = rewriteConfiguration(framed([entry(values), unrelated]));
  const output = decoded(result.text);
  const expected = [...values]; expected[30] = true;
  assert.deepEqual(JSON.parse(output[0][2]), expected);
  assert.deepEqual(output[1], unrelated);
  assert.equal(result.changed, 1);
  assert.equal(result.rejected, 0);
});

test('null target flags are supported without adding missing array fields', () => {
  assert.equal(rewriteConfiguration(framed([entry(payload(null))])).changed, 1);
  for (const length of [0, 1, 30, 31]) {
    const text = framed([entry(payload(false, length))]);
    const result = rewriteConfiguration(text);
    assert.equal(result.text, text);
    assert.equal(result.rejected, 1);
  }
});

test('an already true flag is unchanged byte-for-byte and is not counted as a patch', () => {
  const text = framed([entry(payload(true))]);
  assert.deepEqual(rewriteConfiguration(text), { text, matched: 1, changed: 0, rejected: 0 });
});

test('unknown flag types and malformed payloads are left intact', () => {
  for (const flag of [0, 1, 'false', {}, []]) {
    const text = framed([entry(payload(flag))]);
    assert.equal(rewriteConfiguration(text).text, text);
    assert.equal(rewriteConfiguration(text).rejected, 1);
  }
  const bad = ['wrb.fr', 'cPZSdc', '{invalid'];
  const text = framed([bad, entry()]);
  const result = rewriteConfiguration(text);
  assert.equal(result.changed, 1); assert.equal(result.rejected, 1);
  assert.deepEqual(decoded(result.text)[0], bad);
});

test('multiple config entries and multiple frames are handled independently', () => {
  const first = framed([entry(), entry()]);
  const second = framed([entry(payload(null))]);
  const result = rewriteConfiguration(first + second);
  assert.equal(result.changed, 3); assert.equal(result.matched, 3);
});

test('UTF-8 byte and UTF-16 character framing including CRLF remains valid', () => {
  for (const units of ['bytes', 'chars']) for (const newline of ['\n', '\r\n']) for (const extra of [0, 1, 2]) {
    const values = payload(); values[0] = 'سلام 🌍';
    const result = rewriteConfiguration(framed([entry(values)], { units, newline, extra }));
    assert.equal(result.changed, 1);
    const lines = result.text.split(newline);
    const actual = units === 'bytes' ? new TextEncoder().encode(lines[3]).length : lines[3].length;
    assert.equal(Number(lines[2]), actual + extra);
    assert(!result.text.replaceAll(newline, '').includes('\n'));
  }
});

test('unexpected numeric frame lengths fail closed instead of guessing', () => {
  const text = framed().replace(/\n\d+\n/, '\n999999\n');
  const result = rewriteConfiguration(text);
  assert.equal(result.text, text); assert.equal(result.changed, 0); assert.equal(result.rejected, 1);
});

test('unframed known responses work; unrelated or non-text data is never rewritten', () => {
  assert.equal(rewriteConfiguration(JSON.stringify([entry()])).changed, 1);
  for (const value of [null, {}, '', 'wrb.fr is not a JSON frame', '[[invalid', '[]']) assert.equal(rewriteConfiguration(value).text, value);
  const statusOnly = framed([entry([null, 4], 'cO7JOb')]);
  assert.equal(rewriteConfiguration(statusOnly).text, statusOnly);
});

test('oversized decoded input is returned untouched', () => {
  const text = framed() + ' '.repeat(BODY_LIMIT);
  assert.equal(rewriteConfiguration(text).text, text);
  const unicode = framed() + 'ش'.repeat(BODY_LIMIT / 2);
  assert.equal(rewriteConfiguration(unicode).text, unicode);
});

test('deterministic varied inputs preserve every non-target value', () => {
  for (let index = 0; index < 200; index++) {
    const values = Array.from({ length: 32 + index % 8 }, (_, field) => field % 4 ? field + index : `سلام ${index}-${field}`);
    values[30] = index % 2 === 0 ? false : null;
    const original = structuredClone(values);
    const result = rewriteConfiguration(framed([entry(values)]));
    original[30] = true;
    assert.deepEqual(JSON.parse(decoded(result.text)[0][2]), original);
    assert.equal(rewriteConfiguration(result.text).changed, 0);
  }
});

test('URL matching rejects lookalike hosts, alternate origins, suffix paths and unrelated RPCs', () => {
  assert(isBatchRequest(batchURL));
  assert(isBatchRequest(new URL(batchURL)));
  assert(isBatchRequest(new Request(batchURL)));
  assert(isBatchRequest(BATCH_PATH));
  for (const url of [`${FLOW_ORIGIN}.evil.example${BATCH_PATH}`, `http://flow.google.com${BATCH_PATH}`,
    `${FLOW_ORIGIN}${BATCH_PATH}/extra`, `${FLOW_ORIGIN}${BATCH_PATH}?rpcids=other`,
    `https://example.com${BATCH_PATH}`, `${FLOW_ORIGIN}:8443${BATCH_PATH}`, 'javascript:alert(1)', null]) assert(!isBatchRequest(url));
  assert(isFlowPage(`${FLOW_ORIGIN}/unsupported-country`));
  assert(!isFlowPage(`${FLOW_ORIGIN}.evil.example/`));
});

test('diagnostics have a bounded schema and never forward arbitrary page fields', () => {
  const clean = newDiagnostic();
  assert.deepEqual(sanitizeDiagnostic({ ...clean, token: 'not-forwarded' }), clean);
  assert.equal(sanitizeDiagnostic({ ...clean, mode: 'observe' }), null, 'Old page engines must require a reload');
  for (const value of [null, {}, { ...clean, state: 'made-up' }, { ...clean, changes: -1 }, { ...clean, responses: Infinity }, { ...clean, version: '0' }]) assert.equal(sanitizeDiagnostic(value), null);
});
