import { describe, expect, expectTypeOf, it } from 'vitest';
import { Value } from 'typebox/value';
import { ClientEnvelopeSchema, ConfigValuesSchema, LIMITS, OPERATION_CATALOG, OperationSchemas, ProtocolValidationError, ResultSchemas, SessionCommandSchema, SessionSummarySchema, canonicalRequestPayload,
  parseClientEnvelope, parseOperationResult, parseSchema, parseServerEnvelope, parseStoredRequestRecord, requestRetainUntil,
  validateBase64, type ClientEnvelope, type OperationResult } from '../src/index.js';
import { commandParams, now, request, results } from './fixtures.js';

describe('complete operation inventory', () => {
  it.each(Object.keys(commandParams) as (keyof typeof commandParams)[])('%s has a validated request and result', op => {
    const value = request(op);
    expect(Value.Check(ClientEnvelopeSchema, value)).toBe(true);
    expect(parseClientEnvelope(value).params).toEqual(commandParams[op]);
    expect(parseOperationResult(op, results[op])).toEqual(results[op]);
    if (OPERATION_CATALOG[op].scope !== 'host') expect(Value.Check(SessionCommandSchema, { op, params: commandParams[op] })).toBe(true);
    expect(() => parseClientEnvelope({ ...value, params: null })).toThrow();
  });

  it('rejects unknown operations and arbitrary config paths', () => {
    expect(() => parseClientEnvelope({ ...request('prompt'), op: 'execute.anything' })).toThrow();
    expect(() => parseClientEnvelope(request('config.set', { scope: 'session', values: { password: 'synthetic' } }))).toThrow();
    expect(() => parseClientEnvelope(request('config.set', { scope: 'session', values: { 'web-access-searxng-headers': { Authorization: 'synthetic' } } }))).toThrow();
    expect(() => parseClientEnvelope(request('config.set', { scope: 'session', values: {} }))).toThrow();
  });

  it('carries no extension-specific or presentation keys', () => {
    const names = Object.keys(ConfigValuesSchema.properties);
    expect(names.some(name => name.includes('-'))).toBe(false);
    expect(names).toContain('extensionConfig');
    expect(OperationSchemas).not.toHaveProperty('tui.preferences.get');
    expect(OperationSchemas).not.toHaveProperty('tui.preferences.set');
    for (const values of [{ 'codex-fast': true }, { 'powerline-style': 'capsule' }, { hideThinking: true }]) {
      expect(() => parseSchema(ConfigValuesSchema, values)).toThrow();
    }
  });

  it('bounds classifier and built-in extension configuration', () => {
    const values = { classifierModel: 'offline/classifier', builtinExtensions: { memory: false, contextView: true } };
    expect(parseClientEnvelope(request('config.set', { scope: 'global', values })).params).toEqual({ scope: 'global', values });
    expect(parseOperationResult('config.get', { writable: true, values })).toEqual({ writable: true, values });
    for (const invalid of [{ classifierModel: '' }, { builtinExtensions: { memory: 'false' } }, { builtinExtensions: { '../memory': true } }]) {
      expect(() => parseSchema(ConfigValuesSchema, invalid)).toThrow();
    }
  });

  it('strips additive fields before payload comparison without mutating input', () => {
    const input = { ...request('prompt'), ignored: 'outer', params: { ...commandParams.prompt, ignored: 'inner' } };
    expect(parseClientEnvelope(input)).toEqual(request('prompt'));
    expect(input.ignored).toBe('outer');
    expect(canonicalRequestPayload(input)).toEqual(canonicalRequestPayload(request('prompt')));
  });

  it('never accepts a hello claim as owner or local-console authority', () => {
    for (const localConsole of [true, false]) {
      const parsed = parseClientEnvelope(request('hello', { ...commandParams.hello, localConsole, owner: true, principal: 'claimed-owner' }));
      expect(parsed.params).toEqual(commandParams.hello);
    }
  });

  it('keeps session IDs opaque while bounding UTF-8 and absolute paths', () => {
    expect(parseClientEnvelope({ ...request('prompt'), session: 'old Pi session / not a new UUID' }).session).toContain('old Pi');
    expect(() => parseClientEnvelope({ ...request('prompt'), session: '😀'.repeat(33) })).toThrow();
    expect(() => parseClientEnvelope({ ...request('prompt'), session: '' })).toThrow();
    for (const cwd of ['/fixture', 'C:\\fixture', '\\\\server\\share']) expect(() => parseClientEnvelope(request('sessions.create', { ...commandParams['sessions.create'], cwd }))).not.toThrow();
    for (const cwd of ['relative', '/fixture\0escape', '/' + '😀'.repeat(1024)]) expect(() => parseClientEnvelope(request('sessions.create', { ...commandParams['sessions.create'], cwd }))).toThrow();
  });

  it('keeps host/session targeting and explicit extension loading boundaries', () => {
    expect(() => parseClientEnvelope({ ...request('host.status'), session: 'wrong' })).toThrow();
    const { session: _session, ...missing } = request('prompt');
    expect(() => parseClientEnvelope(missing)).toThrow();
    const params = { cwd: '/fixture', requirePolicy: 'acp-strict', extensions: ['/fixture/ext.js'] };
    expect(parseClientEnvelope(request('sessions.create', params)).params).toEqual(params);
    expect(() => parseClientEnvelope(request('sessions.create', { cwd: '/fixture', extensions: ['relative'] }))).toThrow();
  });

  it('requires identity, explicit export destinations and authorized resource IDs', () => {
    for (const op of ['host.stop', 'host.restart', 'session.export'] as const) expect(() => parseClientEnvelope(request(op, {}))).toThrow();
    expect(() => parseClientEnvelope(request('processes.stop', { pid: 123, signal: 'SIGTERM' }))).toThrow();
    expect(() => parseClientEnvelope(request('processes.stop', { ...commandParams['processes.stop'], signal: 'SIGINT' }))).toThrow();
    expect(() => parseClientEnvelope(request('queue.update', { ...commandParams['queue.update'], edits: [{ op: 'remove', id: 'a' }, { op: 'remove', id: 'a' }] }))).toThrow();
    expect(() => parseClientEnvelope(request('interaction.answer', { interactionId: 'q', answer: { cancelled: true, reason: 'restart' } }))).toThrow();
    expect(() => parseClientEnvelope(request('interaction.answer', { interactionId: 'q', answer: { cancelled: true, reason: 'user' } }))).not.toThrow();
  });
});

describe('queued and handled input results', () => {
  it.each(['steer', 'follow_up'] as const)('accepts either native disposition for %s through the public correlated parser', op => {
    for (const result of [{ itemId: 'actual-item' }, { status: 'handled' }] as const) {
      const response = { v: 1, re: request(op).id, outcome: 'accepted', result };
      expect(Value.Check(ResultSchemas[op], result)).toBe(true);
      expect(parseOperationResult(op, result)).toEqual(result);
      expect(parseServerEnvelope(response, op)).toEqual(response);
      expect(() => parseServerEnvelope(response)).toThrowError(/outstanding request operation/);
      expect(() => parseServerEnvelope(response, 'prompt')).toThrowError(ProtocolValidationError);
    }
  });

  it.each(['steer', 'follow_up'] as const)('rejects missing, invalid and contradictory %s dispositions', op => {
    for (const result of [{}, { itemId: '' }, { status: false }, { status: 'queued' }, { handled: true },
      { itemId: 'invented', status: 'handled' }, { itemId: 'actual', status: 'queued' }]) {
      const response = { v: 1, re: request(op).id, outcome: 'accepted', result };
      expect(Value.Check(ResultSchemas[op], result)).toBe(false);
      expect(() => parseOperationResult(op, result)).toThrowError(ProtocolValidationError);
      expect(() => parseServerEnvelope(response, op)).toThrowError(ProtocolValidationError);
    }
  });

  it.each(['steer', 'follow_up'] as const)('retains a handled %s outcome with its original request identity', op => {
    const input = request(op);
    const response = { v: 1, re: input.id, outcome: 'accepted', result: { status: 'handled' } };
    const record = { schemaVersion: 1, id: input.id, owner: 'principal', session: input.session, admittedAt: now,
      retainUntil: requestRetainUntil(input.id, now), payload: canonicalRequestPayload(input), state: { phase: 'terminal', response } };
    expect(parseStoredRequestRecord(record)).toEqual(record);
    expect(() => parseStoredRequestRecord({ ...record, payload: canonicalRequestPayload(request('prompt')) })).toThrowError(ProtocolValidationError);
    expect(() => parseStoredRequestRecord({ ...record, state: { phase: 'terminal', response: { ...response, re: 'unrelated-request' } } })).toThrowError(ProtocolValidationError);
  });

  it('preserves ordinary additive result fields without confusing the two dispositions', () => {
    expect(parseOperationResult('steer', { itemId: 'actual', futureField: true })).toEqual({ itemId: 'actual' });
    expect(parseOperationResult('follow_up', { status: 'handled', futureField: true })).toEqual({ status: 'handled' });
    expectTypeOf<OperationResult<'steer'>>().toEqualTypeOf<
      { itemId: string; status?: never } | { status: 'handled'; itemId?: never }
    >();
    expectTypeOf<OperationResult<'follow_up'>>().toEqualTypeOf<OperationResult<'steer'>>();
  });
});

describe('locked configuration field merge contract', () => {
  it('accepts updates without CAS and retains ordinary additive-field tolerance', () => {
    const value = request('config.set');
    expect(parseClientEnvelope(value)).toEqual(value);
    expect(canonicalRequestPayload({ ...value, params: { ...value.params, futureField: true } })).toBe(canonicalRequestPayload(value));
  });

  it.each([0, null, false, '7', {}, []])('rejects the own obsolete revision field with value %j before normalization or identity', expectedRevision => {
    const value = request('config.set', { ...commandParams['config.set'], expectedRevision });
    expect(() => parseClientEnvelope(value)).toThrowError(/expectedRevision is obsolete/);
    expect(() => canonicalRequestPayload(value)).toThrowError(/expectedRevision is obsolete/);
  });

  it('never reads an obsolete-field getter, including a non-enumerable property', () => {
    for (const enumerable of [true, false]) {
      let reads = 0;
      const params = Object.defineProperty({ ...commandParams['config.set'] }, 'expectedRevision', { enumerable, get() { reads++; return 7; } });
      expect(() => parseClientEnvelope(request('config.set', params))).toThrowError(ProtocolValidationError);
      expect(reads).toBe(0);
    }
  });

  it('rejects unsafe JSON and top-level getters without invoking them', () => {
    for (const key of ['v', 'op', 'params']) {
      for (const enumerable of [true, false]) {
        let reads = 0;
        const value = Object.defineProperty({ ...request('config.set') }, key, { enumerable, get() { reads++; return 1; } });
        expect(() => parseClientEnvelope(value)).toThrowError(ProtocolValidationError);
        expect(reads).toBe(0);
      }
    }
    expect(() => parseClientEnvelope(request('config.set', { scope: 'global', values: JSON.parse('{"__proto__":{}}') }))).toThrowError(/Unsafe JSON property/);
  });

  it('rejects hidden ID and nested toJSON accessors before JSON serialization can invoke them', () => {
    let reads = 0;
    const hiddenId = Object.defineProperty({ ...request('config.set') }, 'id', { get() { reads++; return 'hidden'; } });
    const values = Object.defineProperty({ 'codex-fast': true }, 'toJSON', { get() { reads++; return undefined; } });
    for (const value of [hiddenId, request('config.set', { scope: 'global', values })]) {
      expect(() => parseClientEnvelope(value)).toThrowError(ProtocolValidationError);
      expect(() => canonicalRequestPayload(value)).toThrowError(ProtocolValidationError);
    }
    expect(reads).toBe(0);
  });
});

describe('unbounded prompts and arbitrary process bytes', () => {
  it('accepts large prompts, many attachments and long command arguments but validates base64', () => {
    const large = 'a'.repeat(2 * 1024 * 1024);
    expect(() => parseClientEnvelope(request('prompt', { text: large, attachments: [{ type: 'text', text: large }] }))).not.toThrow();
    expect(() => parseClientEnvelope(request('prompt', { text: '', attachments: Array.from({ length: 40 }, () => ({ type: 'text', text: '' })) }))).not.toThrow();
    expect(() => parseClientEnvelope(request('prompt', { text: '', attachments: [{ type: 'image', mimeType: 'image/png', data: 'not base64' }] }))).toThrow();
    expect(() => parseClientEnvelope(request('command.invoke', { name: 'x', arguments: '😀'.repeat(32 * 1024) }))).not.toThrow();
    const largeImage = { type: 'image', mimeType: 'image/png', data: 'AAAA'.repeat(5 * 1024 * 1024) };
    expect(() => parseClientEnvelope(request('prompt', { text: '', attachments: [largeImage] }))).not.toThrow();
  });

  it('validates process byte limits and canonical padding, not PIDs or decoded strings', () => {
    const full = Buffer.alloc(LIMITS.processWriteBytes, 3).toString('base64');
    expect(validateBase64(full, LIMITS.processWriteBytes)).toBe(LIMITS.processWriteBytes);
    expect(() => parseClientEnvelope(request('processes.write', { ...commandParams['processes.write'], data: full }))).not.toThrow();
    expect(() => parseClientEnvelope(request('processes.write', { ...commandParams['processes.write'], data: Buffer.alloc(LIMITS.processWriteBytes + 1).toString('base64') }))).toThrow();
    for (const data of ['ab==', 'aab=', 'AA', 'AA==\n']) expect(() => validateBase64(data, 100)).toThrow();
    expect(() => parseOperationResult('processes.read', { ...results['processes.read'], nextOffset: 4 })).toThrow();
    expect(() => parseClientEnvelope(request('processes.read', { ...commandParams['processes.read'], limit: LIMITS.processReadBytes + 1 }))).toThrow();
  });

  it('exposes discriminated parameter and result types', () => {
    type PromptRequest = Extract<ClientEnvelope, { op: 'prompt' }>;
    expectTypeOf<PromptRequest['params']['text']>().toEqualTypeOf<string>();
    expectTypeOf<PromptRequest['session']>().toEqualTypeOf<string>();
    expectTypeOf<OperationResult<'prompt'>>().toEqualTypeOf<{ runId: string }>();
    expectTypeOf<Extract<ClientEnvelope, { op: 'set_thinking' }>['params']['thinking']>().toEqualTypeOf<'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'>();
    expect(Object.keys(OperationSchemas)).toEqual(Object.keys(commandParams));
  });
});

describe('stack-safe canonical base64 validation', () => {
  it.each(['', 'AA==', 'AAA=', 'AAAA', '/w==', '//8=', 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'])('accepts canonical data %j', data => {
    const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
    expect(validateBase64(data, 48)).toBe(data.length / 4 * 3 - padding);
  });

  it.each([0, 1, 2])('computes decoded bytes and honors an explicit budget minus %i bytes', difference => {
    const bytes = 1024 - difference;
    const data = 'AAAA'.repeat(Math.floor(bytes / 3)) + (bytes % 3 === 1 ? 'AA==' : bytes % 3 === 2 ? 'AAA=' : '');
    expect(validateBase64(data)).toBe(bytes);
    expect(() => validateBase64(data, bytes - 1)).toThrowError(/Decoded byte limit exceeded/);
  });

  it.each(['prompt', 'steer', 'follow_up'] as const)('accepts %s with large image attachments', op => {
    const params = { text: '', attachments: [{ type: 'image', mimeType: 'image/png', data: 'AAAA'.repeat(4 * 1024 * 1024), name: 'n' }] };
    expect(parseClientEnvelope(request(op, params)).params).toEqual(params);
  });

  it('accepts a large image when replacing a queued prompt', () => {
    const prompt = { text: '', attachments: [{ type: 'image', mimeType: 'image/png', data: 'AAAA'.repeat(2 * 1024 * 1024) }] };
    const params = { kind: 'steer', expectedRevision: 1, edits: [{ op: 'replace', id: 'queued', prompt }] };
    expect(parseClientEnvelope(request('queue.update', params)).params).toEqual(params);
  });

  it.each(['A', 'AA', 'AAA', '=AAA', 'A=AA', 'AA=A', 'A===', '====', 'AA==AAAA', 'AA==\n', 'AAA\r', 'AAA ', 'AAA\0', 'AAA-', 'AAA_', 'AAAé', 'AAA😀', 'AB==', 'AAB='])('rejects malformed or noncanonical data %j', data => {
    expect(() => validateBase64(data)).toThrowError(ProtocolValidationError);
  });

  it.each(['$AAA', 'A=AA', 'AA==AAAA', 'AAAA====', 'AAA', 'AAAA\n', 'AAA_', 'AAAé', 'AB==', 'AAB='])('rejects a large invalid tail %j without overflowing', tail => {
    const data = 'AAAA'.repeat(2 * 1024 * 1024) + tail;
    expect(() => validateBase64(data)).toThrowError(ProtocolValidationError);
    expect(() => parseClientEnvelope(request('prompt', { text: '', attachments: [{ type: 'image', mimeType: 'image/png', data }] }))).toThrowError(ProtocolValidationError);
  });
});
