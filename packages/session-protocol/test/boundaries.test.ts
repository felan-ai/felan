import { Type } from 'typebox';
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  ERROR_CODES, InteractionAnswerSchema, LIMITS, PresentationSchema, ToolCatalogEntrySchema,
  parseClientEnvelope, parseSchema, parseServerEnvelope, utf8Bytes, type KnownErrorCode, type ProtocolError,
} from '../src/index.js';
import { message, now, request, snapshot } from './fixtures.js';

describe('nested union boundaries', () => {
  const branch = (kind: string) => Type.Object({ kind: Type.Literal(kind), text: Type.String() });
  const inner = Type.Union([branch('inner'), branch('other-inner')], { 'x-maxEncodedBytes': 128 });
  const middle = Type.Union([inner, branch('middle')], { 'x-maxEncodedBytes': 256 });
  const outer = Type.Union([middle, branch('outer')], { 'x-maxEncodedBytes': 512 });
  const wrapped = Type.Object({ choice: outer });

  it.each([['inner', 128], ['middle', 256], ['outer', 512]] as const)('enforces the %s union limit without flattening it away', (kind, limit) => {
    const value = { kind, text: '' };
    value.text = 'x'.repeat(limit - utf8Bytes(JSON.stringify(value)));
    expect(parseSchema(outer, value)).toEqual(value);
    expect(parseSchema(wrapped, { choice: value })).toEqual({ choice: value });
    value.text += 'x';
    expect(() => parseSchema(outer, value)).toThrow(/Encoded field limit/);
    expect(() => parseSchema(wrapped, { choice: value })).toThrow(/Encoded field limit/);
  });

  it('applies the 64KiB answer limit inside a complete interaction.answer request', () => {
    const answer = { kind: 'form', actionId: 'submit', outcome: 'submit', values: { first: '', second: '' } };
    const overhead = utf8Bytes(JSON.stringify(answer));
    answer.values.first = 'a'.repeat(32768);
    answer.values.second = 'c'.repeat(LIMITS.answerBytes - overhead - 32768);
    expect(utf8Bytes(JSON.stringify(answer))).toBe(LIMITS.answerBytes);
    expect(parseClientEnvelope(request('interaction.answer', { interactionId: 'i', answer }), { now }).op).toBe('interaction.answer');
    answer.values.second += 'c';
    expect(() => parseSchema(InteractionAnswerSchema, answer)).toThrow(/Encoded field limit/);
    expect(() => parseClientEnvelope(request('interaction.answer', { interactionId: 'i', answer }), { now })).toThrow(/Encoded field limit/);
  });
});

function writeMessage(content: string) {
  return { ...message, content: [{ type: 'tool_call', id: 'write-call', name: 'write', arguments: { path: '/fixture/large.txt', content } }] };
}

function attachFrame(entry: object) {
  return { v: 1, re: 'q', outcome: 'accepted', result: { attachmentId: 'a', snapshot: {
    ...snapshot, activeStreams: [], history: { ...snapshot.history, entries: [entry] },
  } } };
}

describe('transcript-specific JSON boundaries', () => {
  it('preserves 100KB write arguments, results, message details and larger collections in attach snapshots', () => {
    const data = 'x'.repeat(100_000);
    const items = Array.from({ length: 2048 }, (_, index) => index);
    const call = { ...writeMessage(data), details: { metadata: data, items } };
    call.content[0]!.arguments = { ...call.content[0]!.arguments, ...{ items } };
    const result = { ...message, id: 'result', entryId: 'result-entry', role: 'tool',
      content: [{ type: 'tool_result', id: 'write-call', text: data, isError: false, details: { diff: data, items } }],
      details: { metadata: data, items },
    };
    const frame = attachFrame(call);
    frame.result.snapshot.history.entries.push(result);
    expect(parseServerEnvelope(frame, 'attach')).toEqual(frame);
    for (const entry of [call, result]) {
      const event = { v: 1, session: 'session', rev: 8, change: { type: 'message.completed', message: entry } };
      expect(parseServerEnvelope(event)).toEqual(event);
    }
  });

  it('accepts a message at 12MiB and rejects one encoded byte beyond it', () => {
    const entry = writeMessage('');
    entry.content[0]!.arguments.content = 'x'.repeat(LIMITS.pageBytes - utf8Bytes(JSON.stringify(entry)));
    expect(utf8Bytes(JSON.stringify(entry))).toBe(LIMITS.pageBytes);
    const event = { v: 1, session: 'session', rev: 8, change: { type: 'message.completed', message: entry } };
    expect(parseServerEnvelope(event)).toMatchObject({ change: { type: 'message.completed' } });
    entry.content[0]!.arguments.content += 'x';
    expect(() => parseServerEnvelope(event)).toThrow(/Encoded field limit/);
  }, 30000);

  it('accepts a complete attach snapshot at 12MiB and rejects one encoded byte beyond it', () => {
    const entry = writeMessage('');
    const frame = attachFrame(entry);
    entry.content[0]!.arguments.content = 'x'.repeat(LIMITS.pageBytes - utf8Bytes(JSON.stringify(frame.result.snapshot)));
    expect(utf8Bytes(JSON.stringify(frame.result.snapshot))).toBe(LIMITS.pageBytes);
    expect(parseServerEnvelope(frame, 'attach')).toMatchObject({ outcome: 'accepted' });
    entry.content[0]!.arguments.content += 'x';
    expect(() => parseServerEnvelope(frame, 'attach')).toThrow(/Encoded field limit/);
  }, 30000);

  it('retains depth and prototype safety for transcript payloads', () => {
    let nested: unknown = null;
    for (let i = 0; i <= LIMITS.depth; i++) nested = { nested };
    for (const data of [nested, JSON.parse('{"nested":{"__proto__":{"polluted":true}}}')]) {
      const entry = { ...message, content: [{ type: 'tool_call', id: 'call', name: 'write', arguments: data }] };
      expect(() => parseServerEnvelope(attachFrame(entry), 'attach')).toThrow();
    }
    expect(Object.prototype).not.toHaveProperty('polluted');
  });

  it.each([
    ['tool catalog', ToolCatalogEntrySchema, (data: string) => ({ name: 'write', label: 'Write', description: '', parameters: data, provenance: 'builtin', source: 'core', active: true })],
  ] as const)('keeps the 64KiB limit for %s data', (_name, schema, value) => {
    expect(() => parseSchema(schema, value('x'.repeat(LIMITS.structuredBytes)))).toThrow(/Encoded field limit/);
  });
});

describe('known error vocabulary and future wire codes', () => {
  it('exports all known codes while retaining future error strings', () => {
    expect(ERROR_CODES).toEqual(['invalid_request', 'unsupported_operation', 'protocol_mismatch', 'unavailable', 'authentication_required', 'busy', 'policy_pending',
      'request_conflict', 'stale_request', 'expired', 'not_found', 'forbidden', 'already_resolved', 'storage_failure',
      'ownership_lost', 'resync_required', 'indeterminate', 'configuration_recovery_required', 'request_capacity', 'target_mismatch']);
    expect(Object.isFrozen(ERROR_CODES)).toBe(true);
    expectTypeOf<KnownErrorCode>().toEqualTypeOf<(typeof ERROR_CODES)[number]>();
    expectTypeOf<ProtocolError['code']>().toEqualTypeOf<string>();
    // @ts-expect-error Future wire names are not members of the known vocabulary.
    const future: KnownErrorCode = 'future_error';
    for (const code of [...ERROR_CODES, future]) {
      const response = { v: 1, re: 'q', outcome: 'rejected', error: { code, message: 'Failure', retryable: false } };
      expect(parseServerEnvelope(response)).toEqual(response);
    }
  });
});
