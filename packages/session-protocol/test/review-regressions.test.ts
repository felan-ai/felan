import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  BootstrapHelloSchema, ClientEnvelopeSchema, InteractionSchema, JsonValueSchema, LIMITS, OPERATION_CATALOG, ServerEnvelopeSchema,
  SessionSnapshotSchema, assertJson, classifyTextDelta, parseClientEnvelope, parseControlRequest, parseControlResponse,
  parseSchema, parseServerEnvelope, parseSessionSnapshot, type ClientEnvelope,
} from '../src/index.js';
import { identity, now, request, requestId, results, snapshot } from './fixtures.js';

describe('additive bootstrap and response compatibility', () => {
  it.each([1, 2, 999])('extracts full hello version %s without accepting management commands', version => {
    const input = { ...request('hello'), v: version, extra: 'future', params: { ...request('hello').params, protocol: version, futureCapability: true } };
    expect(parseSchema(BootstrapHelloSchema, input)).toEqual({ v: version, id: requestId(), op: 'hello', params: { clientVersion: '0.1.0', protocol: version } });
    expect(() => parseSchema(BootstrapHelloSchema, { ...input, op: 'host.stop' })).toThrow();
    expect(() => parseControlRequest({ control: 1, id: requestId(), op: 'host.restart', params: { expected: identity } }, now)).toThrow();
  });
  it('reads newer and older daemon protocol advertisements and strips future fields', () => {
    for (const supportedProtocol of [1, 2, 999]) {
      const response = { control: 1, re: 'hello', daemonVersion: 'new', supportedProtocol, identity, state: 'ready', outcome: 'mismatch' };
      expect(parseControlResponse({ ...response, future: { enabled: true } })).toEqual(response);
    }
    for (const supportedProtocol of [0, -1, 1.5]) {
      expect(() => parseControlResponse({ control: 1, re: 'hello', daemonVersion: 'new', supportedProtocol, identity, state: 'ready', outcome: 'mismatch' })).toThrow();
    }
  });
  it('ignores additive result data including formerly empty results', () => {
    for (const op of ['cancel', 'close', 'detach', 'set_model', 'session.reload'] as const) {
      expect(parseServerEnvelope({ v: 1, re: 'q', outcome: 'accepted', result: { futureRevision: 7 } }, op))
        .toEqual({ v: 1, re: 'q', outcome: 'accepted', result: {} });
    }
    expect(parseServerEnvelope({ v: 1, re: 'q', outcome: 'accepted', result: { runId: 'run', future: true } }, 'prompt'))
      .toEqual({ v: 1, re: 'q', outcome: 'accepted', result: { runId: 'run' } });
  });
  it('retains bounded unknown advertised operations and error names without enabling requests', () => {
    const hello = { ...results.hello, operations: ['hello', 'prompt', 'future.operation'] };
    expect(parseServerEnvelope({ v: 1, re: 'q', outcome: 'accepted', result: hello }, 'hello')).toMatchObject({ result: hello });
    const error = { code: 'future_error', message: 'Unknown condition', retryable: false };
    expect(parseServerEnvelope({ v: 1, re: 'q', outcome: 'rejected', error: { ...error, future: true } }))
      .toEqual({ v: 1, re: 'q', outcome: 'rejected', error });
    expect(() => parseClientEnvelope({ ...request('prompt'), op: 'future.operation' }, { now })).toThrow();
    for (const name of ['', 'x'.repeat(LIMITS.commandBytes + 1), '😀'.repeat(33)]) {
      expect(() => parseServerEnvelope({ v: 1, re: 'q', outcome: 'rejected', error: { ...error, code: name } })).toThrow();
      expect(() => parseServerEnvelope({ v: 1, re: 'q', outcome: 'accepted', result: { ...hello, operations: [name] } }, 'hello')).toThrow();
    }
  });
});

describe('safe data and immutable parser contracts', () => {
  it('round trips ordinary own constructor/prototype data throughout tool payloads and snapshots', () => {
    const data = JSON.parse('{"constructor":{"prototype":{"field":"value"}},"prototype":"plain data"}');
    expect(parseSchema(JsonValueSchema, data)).toEqual(data);
    const message = { id: 'm', entryId: 'e', role: 'assistant', timestamp: now, content: [{ type: 'tool_call', id: 'call', name: 'generate', arguments: data }] };
    const value = { ...snapshot, history: { ...snapshot.history, entries: [message] } };
    expect(parseSessionSnapshot(value).history.entries[0]?.content).toEqual(message.content);
    expect(parseServerEnvelope({ v: 1, session: 'session', rev: 8, change: { type: 'message.completed', message } }))
      .toMatchObject({ change: { message } });
    expect(Object.prototype).not.toHaveProperty('field');
  });
  it('rejects hostile prototype and accessor inputs without touching global prototypes or invoking accessors', () => {
    for (const json of ['{"__proto__":{"polluted":true}}', '{"constructor":{"prototype":{"__proto__":{"polluted":true}}}}']) {
      expect(() => parseSchema(JsonValueSchema, JSON.parse(json))).toThrow();
    }
    expect(() => assertJson(Object.create({ inherited: true }))).toThrow();
    let calls = 0;
    expect(() => assertJson({ get data() { calls++; return 'unsafe'; } })).toThrow();
    expect(calls).toBe(0);
    expect(Object.prototype).not.toHaveProperty('polluted');
  });
  it('keeps recursive JSON, collection and encoded limits on extension payloads', () => {
    expect(() => parseSchema(JsonValueSchema, Array.from({ length: LIMITS.catalogEntries + 1 }, () => 0))).toThrow();
    expect(() => parseSchema(JsonValueSchema, { nested: Array.from({ length: LIMITS.catalogEntries + 1 }, () => 0) })).toThrow();
    expect(() => parseSchema(JsonValueSchema, { text: 'x'.repeat(LIMITS.structuredBytes) })).toThrow();
    expect(() => parseSchema(JsonValueSchema, { nested: Infinity })).toThrow();
    let deep: unknown = null;
    for (let i = 0; i <= LIMITS.depth; i++) deep = { nested: deep };
    expect(() => parseSchema(JsonValueSchema, deep)).toThrow();
  });
  it('does not reorder or mutate schemas during successful and rejected parsing', () => {
    const schemas = [ClientEnvelopeSchema, ServerEnvelopeSchema, InteractionSchema, JsonValueSchema, SessionSnapshotSchema];
    const before = schemas.map(schema => JSON.stringify(schema));
    for (let i = 0; i < 4; i++) {
      parseClientEnvelope(request('cancel'), { now });
      parseServerEnvelope({ v: 1, re: 'q', outcome: 'accepted', result: results.attach }, 'attach');
      expect(() => parseClientEnvelope({ ...request('prompt'), params: null }, { now })).toThrow();
    }
    expect(schemas.map(schema => JSON.stringify(schema))).toEqual(before);
  });
  it('deeply freezes operation authority so freshness and eligibility cannot be disabled', () => {
    expect(Object.isFrozen(OPERATION_CATALOG)).toBe(true);
    for (const definition of Object.values(OPERATION_CATALOG)) {
      expect(Object.isFrozen(definition)).toBe(true);
      expect(Object.isFrozen(definition.clients)).toBe(true);
    }
    expect(Reflect.set(OPERATION_CATALOG.prompt, 'mutation', false)).toBe(false);
    expect(Reflect.set(OPERATION_CATALOG.prompt.clients, '0', 'acp')).toBe(false);
    expect(() => parseClientEnvelope({ ...request('prompt'), id: requestId(now - LIMITS.requestRetentionMs - 1) }, { now })).toThrow();
  });
  it('requires host envelopes to omit session targets at compile time and runtime', () => {
    expectTypeOf<Extract<ClientEnvelope, { op: 'host.status' }>['session']>().toEqualTypeOf<undefined>();
    // @ts-expect-error Host commands cannot select a session, including in a typed client.
    const invalid: ClientEnvelope = { v: 1, id: 'q', op: 'host.status', session: 's', params: {} };
    expect(() => parseClientEnvelope(invalid)).toThrow();
  });
});

describe('active stream lifecycle', () => {
  const delta = (offset: number) => ({ v: 1, session: 's', stream: { message: 'm', id: 'new', kind: 'assistant', offset }, text: 'hi' });
  it('starts new streams, recovers missed starts and ignores only explicit terminal states', () => {
    expect(classifyTextDelta(undefined, delta(0))).toBe('start');
    expect(classifyTextDelta(undefined, delta(5))).toBe('gap');
    expect(classifyTextDelta(undefined, delta(0), 'completed')).toBe('ignore');
    expect(classifyTextDelta(undefined, delta(5), 'completion_only')).toBe('ignore');
    const other = { message: 'other', id: 'old', kind: 'thinking' as const, text: '', offset: 0 };
    expect(classifyTextDelta(other, delta(0))).toBe('start');
    expect(classifyTextDelta(other, delta(5))).toBe('gap');
  });
  it('does not rescan a validated retained prefix while appending', () => {
    let textReads = 0;
    const prefix = { message: 'm', id: 'new', kind: 'assistant' as const, offset: 512 * 1024,
      get text(): string { textReads++; throw new Error('Appending must not inspect the retained prefix'); } };
    expect(classifyTextDelta(prefix, delta(prefix.offset))).toBe('append');
    expect(textReads).toBe(0);
  });
});
