import { Type } from 'typebox';
import { describe, expect, it, vi } from 'vitest';
import { JsonLineDecoder, JsonValueSchema, LIMITS, assertJson, codePointLength, encodeFrame, parseOperationResult, parseSchema, parseSessionSnapshot, utf8Bytes } from '../src/index.js';
import { interaction, origin, snapshot } from './fixtures.js';

describe('allocation-free string measurements', () => {
  const strings = ['', 'ASCII\0\n', '\u007f\u0080\u07ff\u0800\uffff', 'a😀𐀀􏿿z', '\ud800', '\udfff', '\ud800x\udfff', '\ud800\ud800\udc00\udc00'];
  it.each(strings)('matches native UTF-8 replacement and code point iteration for %j', text => {
    expect(utf8Bytes(text)).toBe(new TextEncoder().encode(text).length);
    expect(codePointLength(text)).toBe(Array.from(text).length);
  });
  it('counts lone surrogates as three UTF-8 bytes', () => {
    expect(utf8Bytes('\ud800')).toBe(3);
    expect(utf8Bytes('\udc00')).toBe(3);
    expect(utf8Bytes('😀')).toBe(4);
  });
  it('handles multibyte characters straddling the reusable byte buffer', () => {
    for (const prefix of [16 * 1024 - 3, 16 * 1024 - 2, 16 * 1024 - 1, 16 * 1024]) {
      const text = 'a'.repeat(prefix) + '😀\ud800é✓'.repeat(10000);
      expect(utf8Bytes(text)).toBe(new TextEncoder().encode(text).length);
      expect(codePointLength(text)).toBe(Array.from(text).length);
      expect(utf8Bytes('after')).toBe(5);
    }
  });
});

describe('Unicode JSON safety', () => {
  it.each(['', '😀', '\ud800\udc00', '\udbff\udfff', 'é✓\0'])('accepts well-formed values and property names %j', value => {
    expect(() => assertJson({ [value]: value })).not.toThrow();
  });
  it.each(['\ud800', '\udfff', '\ud800x', 'x\udc00', '\ud800\ud800\udc00', '\ud800\udc00\udc00'])('rejects unpaired surrogates in values and names %j', value => {
    expect(() => assertJson({ value })).toThrow(/Unicode/);
    expect(() => assertJson({ [value]: true })).toThrow(/Unsafe JSON property/);
    expect(() => encodeFrame({ value })).toThrow(/Unicode/);
    expect(() => new JsonLineDecoder().push(new TextEncoder().encode(`${JSON.stringify({ value })}\n`))).toThrow(/Unicode/);
  });
});

describe('complete and fragmented frame paths', () => {
  it('decodes complete lines in chunk subarrays without copying them', () => {
    const decoder = new JsonLineDecoder();
    const frame = encodeFrame({ text: 'é✓😀'.repeat(1000) });
    const chunk = new Uint8Array(frame.length + 10);
    chunk.set(frame, 5);
    const copy = vi.spyOn(Uint8Array.prototype, 'set');
    try {
      expect(decoder.push(chunk.subarray(5, frame.length + 5))).toEqual([{ text: 'é✓😀'.repeat(1000) }]);
      expect(copy).not.toHaveBeenCalled();
    } finally { copy.mockRestore(); }
    decoder.finish();
  });
  it('mixes buffered lines, complete lines and partial UTF-8 at every split', () => {
    const values = [{ text: '😀\nline' }, { nested: { text: 'é✓' } }, { last: true }];
    const encoded = new TextEncoder().encode(values.map(value => JSON.stringify(value)).join('\n') + '\n');
    for (let split = 0; split <= encoded.length; split++) {
      const decoder = new JsonLineDecoder();
      expect([...decoder.push(encoded.subarray(0, split)), ...decoder.push(encoded.subarray(split))]).toEqual(values);
      decoder.finish();
    }
  });
  it('owns buffered partial bytes when the caller reuses its chunk', () => {
    const decoder = new JsonLineDecoder();
    const first = new TextEncoder().encode('{"value":"😀');
    decoder.push(first);
    first.fill(0);
    expect(decoder.push(new TextEncoder().encode('"}\n'))).toEqual([{ value: '😀' }]);
  });
  it.each(['\n', '[]\n', 'null\n', '1\n', '{"n":1e999}\n', '{"__proto__":{}}\n', '{"x":"\\ud800"}\n', '\ufeff{}\n'])('closes after rejecting %j on either path', raw => {
    const encoded = new TextEncoder().encode(raw);
    for (const split of [0, 1]) {
      const decoder = new JsonLineDecoder();
      expect(() => { decoder.push(encoded.subarray(0, split)); decoder.push(encoded.subarray(split)); }).toThrow();
      expect(() => decoder.push(encodeFrame({ valid: true }))).toThrow(/closed/);
      expect(() => decoder.finish()).toThrow(/Incomplete or invalid/);
    }
  });
  it('retains fatal UTF-8 and nesting validation on complete lines', () => {
    expect(() => new JsonLineDecoder().push(new Uint8Array([123, 34, 120, 34, 58, 34, 0xed, 0xa0, 0x80, 34, 125, 10]))).toThrow(/UTF-8/);
    const raw = '{"x":'.repeat(LIMITS.depth + 1) + 'null' + '}'.repeat(LIMITS.depth + 1) + '\n';
    expect(() => new JsonLineDecoder().push(new TextEncoder().encode(raw))).toThrow(/nesting/);
    const decoder = new JsonLineDecoder();
    decoder.push(new TextEncoder().encode('{"x":'));
    expect(() => decoder.finish()).toThrow(/Incomplete/);
    expect(() => decoder.push(encodeFrame({ valid: true }))).toThrow(/closed/);
  });
  it.each([null, [], true, 'text', 1, { value: undefined }, { value: Infinity }, new Date()].map(value => [value]))('still rejects non-object or non-JSON outbound values %j', value => {
    expect(() => encodeFrame(value)).toThrow();
  });
});

describe('fresh normalized JSON data', () => {
  it('clones nested JSON and additional data while stripping unknown fields', () => {
    const schema = Type.Object({ payload: JsonValueSchema, known: Type.Object({ value: Type.String() }) }, { additionalProperties: true });
    const data = { nested: [{ constructor: { prototype: 'data' }, prototype: true, number: -0 }] };
    const input = { payload: data, extra: data, known: { value: 'yes', removed: true } };
    const result = parseSchema(schema, input);
    const expected = { nested: [{ constructor: { prototype: 'data' }, prototype: true, number: 0 }] };
    expect(result).toEqual({ payload: expected, extra: expected, known: { value: 'yes' } });
    expect(result).not.toBe(input);
    expect(result.payload).not.toBe(data);
    const extra: unknown = Reflect.get(result, 'extra');
    expect(extra).not.toBe(data);
    expect(result.payload).not.toBe(extra);
    const payload = result.payload as typeof data;
    expect(payload.nested).not.toBe(data.nested);
    expect(payload.nested[0]!.constructor).not.toBe(data.nested[0]!.constructor);
    expect(Object.is(payload.nested[0]!.number, -0)).toBe(false);
  });
  it('retains JSON normalization for sparse arrays and non-enumerable serialization hooks', () => {
    const sparse = [1, , 3];
    expect(parseSchema(JsonValueSchema, sparse)).toEqual([1, null, 3]);
    let calls = 0;
    const child = Object.defineProperty({ value: 'raw' }, 'toJSON', { value(key: string) { calls++; return { key }; } });
    expect(parseSchema(JsonValueSchema, { child })).toEqual({ child: { key: 'child' } });
    expect(calls).toBe(1);
  });
});

describe('single-pass attach snapshot validation', () => {
  const parse = (value: unknown) => parseOperationResult('attach', { attachmentId: 'attachment', snapshot: value });
  it('returns fresh normalized snapshots', () => {
    const result = parse({ ...snapshot, future: true });
    expect(result.snapshot).toEqual(snapshot);
    expect(result.snapshot.history).not.toBe(snapshot.history);
    expect(result.snapshot.history.entries[0]).not.toBe(snapshot.history.entries[0]);
  });
  it('keeps history, stream, queue and interaction invariants', () => {
    const item = { id: 'queued', kind: 'steer', prompt: { text: 'prompt' }, origin };
    for (const invalid of [
      { ...snapshot, history: { ...snapshot.history, revision: 0 } },
      { ...snapshot, history: { ...snapshot.history, branch: 'other' } },
      { ...snapshot, activeStreams: [{ ...snapshot.activeStreams[0], offset: 100 }] },
      { ...snapshot, activeStreams: [snapshot.activeStreams[0], snapshot.activeStreams[0]] },
      { ...snapshot, completionOnlyStreams: [{ message: 'message', id: snapshot.activeStreams[0]!.id, kind: 'assistant', reason: 'lost' }] },
      { ...snapshot, activeStreams: Array.from({ length: 5 }, (_, index) => ({ message: 'm', id: `s${index}`, kind: 'assistant', text: 'x'.repeat(LIMITS.activeStreamBytes), offset: LIMITS.activeStreamBytes })) },
      { ...snapshot, queue: [item, item] },
      { ...snapshot, queue: [{ ...item, prompt: { text: '', attachments: [{ type: 'image', mimeType: 'image/png', data: 'invalid' }] } }] },
      { ...snapshot, interactions: [{ ...interaction, state: 'answered' }] },
    ]) expect(() => parse(invalid)).toThrow();
  });
  it('keeps presentation fallback conversion and cross-field validation', () => {
    const fallback = parseSessionSnapshot({ ...snapshot, presentation: [{ id: 'future', kind: 'future_widget', fallback: 'Content' }] });
    expect(fallback.presentation).toEqual([{ id: 'future', kind: 'notification', level: 'info', text: 'Content' }]);
    const document = { id: 'doc', kind: 'document', revision: 1, title: 'Title', fallback: 'Document', markdown: '[unsafe](javascript:alert)', actions: [] };
    for (const presentation of [document, { id: 'widget', kind: 'widget', text: 'x'.repeat(LIMITS.structuredBytes) }]) {
      expect(() => parse({ ...snapshot, presentation: [presentation] })).toThrow();
      expect(() => parseSessionSnapshot({ ...snapshot, presentation: [presentation] })).toThrow();
    }
  });
});
