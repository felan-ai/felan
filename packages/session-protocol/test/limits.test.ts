import { describe, expect, it } from 'vitest';
import { JsonLineDecoder, assertJson, encodeFrame, parseClientEnvelope } from '../src/index.js';
import { request } from './fixtures.js';

describe('bounded UTF-8 JSON framing', () => {
  it('handles fragmented UTF-8, escaped newlines and multiple frames', () => {
    const first = request('prompt', { text: '😀\nline' });
    const bytes = encodeFrame(first);
    const decoder = new JsonLineDecoder();
    const frames = [];
    for (const byte of bytes) frames.push(...decoder.push(new Uint8Array([byte])));
    expect(frames).toEqual([first]);
    expect(parseClientEnvelope(frames[0])).toEqual(first);
    const multi = new Uint8Array([...encodeFrame({ n: 1 }), ...encodeFrame({ n: 2 })]);
    expect(decoder.push(multi)).toEqual([{ n: 1 }, { n: 2 }]);
    decoder.finish();
  });
  it('rejects malformed UTF-8, incomplete frames, empty frames, arrays and invalid numbers', () => {
    const malformed = new JsonLineDecoder();
    expect(() => malformed.push(new Uint8Array([123, 34, 120, 34, 58, 34, 255, 34, 125, 10]))).toThrow();
    expect(() => malformed.push(encodeFrame({ okay: true }))).toThrow(/closed/);
    const incomplete = new JsonLineDecoder();
    incomplete.push(new TextEncoder().encode('{"x":1}'));
    expect(() => incomplete.finish()).toThrow(/Incomplete/);
    for (const raw of ['\n', '[]\n', 'null\n', '{"x":1e999}\n', '{"x":NaN}\n', '{"x":"\\ud800"}\n']) {
      expect(() => new JsonLineDecoder().push(new TextEncoder().encode(raw))).toThrow();
    }
  });
  it('decodes frames larger than the initial receive buffer', () => {
    const value = { x: 'a'.repeat(20 * 1024 * 1024) };
    expect(new JsonLineDecoder().push(encodeFrame(value))).toEqual([value]);
  });
  it('rejects excessive depth, non-JSON runtime objects, cycles and prototype keys', () => {
    const nest = (depth: number) => { let value: unknown = null; for (let i = 0; i < depth; i++) value = { a: value }; return value; };
    expect(() => assertJson(nest(32))).not.toThrow();
    expect(() => assertJson(nest(33))).toThrow(/nesting/);
    const cycle: { cycle?: unknown } = {}; cycle.cycle = cycle;
    for (const value of [cycle, { n: Infinity }, { n: NaN }, { fn: () => null }, new Date(), { value: undefined }, JSON.parse('{"__proto__":{}}')]) expect(() => assertJson(value)).toThrow();
  });
});
