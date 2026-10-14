import { describe, expect, it } from 'vitest';
import { LIMITS, classifyTextDelta, parseClientEnvelope, parseSchema, JsonValueSchema, parseServerEnvelope } from '../src/index.js';
import { now, request, snapshot } from './fixtures.js';

function medianDuration(action: () => void, runs = 3): number {
  const durations = [];
  for (let i = 0; i < runs; i++) {
    const start = performance.now();
    action();
    durations.push(performance.now() - start);
  }
  return durations.sort((a, b) => a - b)[Math.floor(runs / 2)]!;
}

describe('bounded protocol parsing cost', () => {
  it('parses near-limit structured answers with approximately linear scaling', () => {
    const data = (rows: number) => Object.fromEntries(Array.from({ length: rows }, (_, index) => [`field${index}`, 'x'.repeat(1990)]));
    const small = data(4);
    const large = data(32);
    const answer = (payload: Record<string, string>) => request('interaction.answer', { interactionId: 'q', answer: { kind: 'form', actionId: 'submit', outcome: 'submit', values: payload } });
    expect(JSON.stringify(large).length).toBeGreaterThan(64000);
    const smallMs = medianDuration(() => { parseClientEnvelope(answer(small)); });
    const largeMs = medianDuration(() => { parseClientEnvelope(answer(large)); });
    const standaloneMs = medianDuration(() => { parseSchema(JsonValueSchema, large); });
    expect(largeMs).toBeLessThan(1500);
    expect(standaloneMs).toBeLessThan(1500);
    expect(largeMs).toBeLessThan((smallMs + 20) * 16);
    console.log(JSON.stringify({ structuredSmallMs: smallMs, structured64KiBMs: largeMs, json64KiBMs: standaloneMs }));
  }, 15000);

  it('parses a maximum-entry near-limit attach snapshot without traversing unrelated result schemas', () => {
    const history = { ...snapshot.history, entries: Array.from({ length: LIMITS.pageEntries }, (_, index) => ({
      id: `m${index}`, entryId: `e${index}`, role: 'assistant', timestamp: now,
      content: [{ type: 'text', text: 'x'.repeat(45000) }, { type: 'tool_call', id: `c${index}`, name: 'read', arguments: { path: '/fixture' } }],
    })) };
    const large = { ...snapshot, history, activeStreams: [], catalog: { ...snapshot.catalog, tools: Array.from({ length: 30 }, (_, index) => ({
      name: `tool${index}`, label: 'Tool', description: 'Fixture', parameters: { type: 'object', properties: { name: { type: 'string' } } },
      provenance: 'builtin', source: 'core', active: true,
    })) } };
    const bytes = JSON.stringify(large).length;
    expect(bytes).toBeGreaterThan(11 * 1024 * 1024);
    expect(bytes).toBeLessThan(LIMITS.pageBytes);
    const duration = medianDuration(() => { parseServerEnvelope({ v: 1, re: 'q', outcome: 'accepted', result: { attachmentId: 'a', snapshot: large } }, 'attach'); });
    expect(duration).toBeLessThan(5000);
    console.log(JSON.stringify({ attachSnapshotBytes: bytes, attachSnapshotMs: duration }));
  }, 30000);

  it('keeps incremental prefix updates independent of retained prefix size', () => {
    let prefix = { message: 'm', id: 'stream', kind: 'assistant' as const, text: 'x'.repeat(512 * 1024), offset: 512 * 1024 };
    const start = performance.now();
    for (let i = 0; i < 1000; i++) {
      const delta = { v: 1, session: 's', stream: { message: 'm', id: 'stream', kind: 'assistant', offset: prefix.offset }, text: 'x' };
      expect(classifyTextDelta(prefix, delta)).toBe('append');
      prefix = { ...prefix, text: prefix.text + 'x', offset: prefix.offset + 1 };
    }
    const duration = performance.now() - start;
    expect(duration).toBeLessThan(2000);
    console.log(JSON.stringify({ thousandPrefixUpdatesMs: duration }));
  }, 15000);
});
