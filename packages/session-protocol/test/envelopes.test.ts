import { describe, expect, it } from 'vitest';
import { BootstrapHelloSchema, CONTROL_VERSION, ControlRequestSchema, LIMITS, PROTOCOL_VERSION, ROW_SCHEMA_VERSION,
  canonicalRequestPayload, compareRequestPayload, parseClientEnvelope, parseControlRequest, parseControlResponse, parseOperationResult, parseSchema,
  parseServerEnvelope, parseStoredRequestRecord, requestRetainUntil, requestTimestamp, validateRequestId } from '../src/index.js';
import * as protocol from '../src/index.js';
import { identity, now, request, requestId, results } from './fixtures.js';

describe('outcomes and handshake', () => {
  it('uses unrevisioned notifications only for host prompts', () => {
    const interaction = { id: 'host-prompt', scope: { kind: 'host' }, state: 'waiting',
      request: { kind: 'confirm', title: 'Trust workspace?', message: '/workspace' }, createdAt: now };
    expect(parseServerEnvelope({ v: 1, interaction })).toEqual({ v: 1, interaction });
    const session = { ...interaction, scope: { kind: 'session', session: 's', root: 's' } };
    expect(() => parseServerEnvelope({ v: 1, interaction: session })).toThrow(/revisioned/);
  });
  it('exports independent protocol, row and control versions', () => {
    expect([PROTOCOL_VERSION, ROW_SCHEMA_VERSION, CONTROL_VERSION]).toEqual([1, 1, 1]);
  });
  it.each(['rejected', 'indeterminate'] as const)('preserves %s with typed bounded errors', outcome => {
    const value = { v: 1, re: requestId(), outcome, error: { code: 'unavailable', message: 'Try again', retryable: true } };
    expect(parseServerEnvelope(value)).toEqual(value);
    expect(() => parseServerEnvelope({ ...value, error: { ...value.error, message: '\x1b[31mspoof' } })).toThrow();
    expect(() => parseServerEnvelope({ ...value, error: { ...value.error, message: 'a'.repeat(4097) } })).toThrow();
  });
  it('requires an explicit result and uses the outstanding operation for response validation', () => {
    expect(parseServerEnvelope({ v: 1, re: 'q', outcome: 'accepted', result: {} }, 'cancel')).toEqual({ v: 1, re: 'q', outcome: 'accepted', result: {} });
    expect(() => parseServerEnvelope({ v: 1, re: 'q', outcome: 'accepted' }, 'cancel')).toThrow();
    expect(() => parseServerEnvelope({ v: 1, re: 'q', outcome: 'accepted', result: {} }, 'prompt')).toThrow();
    expect(parseServerEnvelope({ v: 1, re: 'q', outcome: 'accepted', result: results.attach }, 'attach')).toMatchObject({ result: results.attach });
  });
  it('rejects breaking versions and keeps mismatch control narrowly bounded', () => {
    expect(() => parseClientEnvelope({ ...request('prompt'), v: 2 }, { now })).toThrow(/protocol version/);
    expect(() => parseServerEnvelope({ v: 2, re: 'q', outcome: 'accepted', result: {} })).toThrow(/protocol version/);
    expect(parseSchema(BootstrapHelloSchema, { v: 2, id: 'hello', op: 'hello', params: { protocol: 2, clientVersion: 'new' } })).toBeTruthy();
    expect(parseSchema(BootstrapHelloSchema, { v: 2, id: 'hello', op: 'hello', params: { protocol: 2, clientVersion: 'new', environment: {} } }))
      .toEqual({ v: 2, id: 'hello', op: 'hello', params: { protocol: 2, clientVersion: 'new' } });
    for (const op of ['host.status', 'host.stop', 'host.restart'] as const) {
      const params = op === 'host.status' ? { expected: identity } : { expected: identity, confirmed: true, mode: 'drain' };
      expect(parseControlRequest({ control: 1, id: requestId(), op, params }, now).op).toBe(op);
    }
    expect(() => parseControlRequest({ control: 1, id: requestId(), op: 'prompt', params: { text: 'no' } }, now)).toThrow();
    expect(() => parseControlRequest({ control: 1, id: requestId(), op: 'host.stop', params: { expected: identity, mode: 'force' } }, now)).toThrow();
    expect(() => parseControlRequest({ control: 1, id: requestId(), op: 'host.status', params: { expected: identity, environment: { SECRET: 'fake' } } }, now)).toThrow();
    expect(parseControlResponse({ control: 1, re: 'hello', daemonVersion: '1.0', supportedProtocol: 1, identity, state: 'ready', outcome: 'mismatch' })).toBeTruthy();
    expect(() => parseControlResponse({ control: 1, re: 'hello', daemonVersion: '1.0', supportedProtocol: 1, identity, state: 'ready', outcome: 'rejected' })).toThrow();
    expect(() => parseSchema(ControlRequestSchema, { control: 2, id: 'q', op: 'host.status', params: { expected: identity } })).toThrow();
  });
});

describe('request retry identity', () => {
  it('fixes freshness to UUIDv7 timestamp and permits the exact boundaries', () => {
    expect(requestTimestamp(requestId())).toBe(now);
    expect(validateRequestId(requestId(now - LIMITS.requestRetentionMs), now)).toBe(now - LIMITS.requestRetentionMs);
    expect(() => validateRequestId(requestId(now - LIMITS.requestRetentionMs - 1), now)).toThrow(/retry lifetime/);
    expect(validateRequestId(requestId(now + LIMITS.requestFutureSkewMs), now)).toBe(now + LIMITS.requestFutureSkewMs);
    expect(() => validateRequestId(requestId(now + LIMITS.requestFutureSkewMs + 1), now)).toThrow();
    expect(() => validateRequestId('not-v7', now)).toThrow();
    expect(() => parseClientEnvelope({ ...request('prompt'), id: requestId(now - LIMITS.requestRetentionMs - 1), timestamp: now }, { now })).toThrow();
    expect(parseClientEnvelope({ ...request('prompt'), id: requestId().toUpperCase() }, { now }).id).toBe(requestId());
  });
  it('compares normalized semantic payloads, detects conflicts and supports retained duplicate lookup', () => {
    const first = request('prompt');
    expect(compareRequestPayload(first, { ...first, extra: true, params: { ...first.params, extra: 1 } }, { now })).toBe('same');
    expect(compareRequestPayload(first, request('prompt', { text: 'changed' }), { now })).toBe('conflict');
    expect(compareRequestPayload(undefined, first, { now })).toBe('unavailable');
    expect(compareRequestPayload(first, first, { now: now + LIMITS.requestRetentionMs + 1 })).toBe('same');
    expect(() => parseClientEnvelope(first, { now: now + LIMITS.requestRetentionMs + 1 })).toThrow();
  });
});

describe('shared daemon environment boundary', () => {
  it('exposes no per-session environment API or limits', () => {
    expect(Object.keys(protocol.OperationSchemas)).toHaveLength(52);
    expect(Object.keys(protocol.OperationSchemas).some(op => op.startsWith('environment.'))).toBe(false);
    for (const name of ['EnvironmentSchema', 'parseEnvironment', 'ProvisioningReferenceSchema']) expect(protocol).not.toHaveProperty(name);
    expect(Object.keys(LIMITS).some(name => name.startsWith('environment'))).toBe(false);
    for (const op of ['environment.provision', 'environment.refresh']) {
      expect(() => parseClientEnvelope({ v: 1, id: requestId(), op, params: {} }, { now })).toThrow();
    }
  });
  it('creates and imports without handles and strips obsolete environment data from canonical requests', () => {
    for (const op of ['sessions.create', 'session.import'] as const) {
      const input = request(op, { ...request(op).params, environmentId: 'obsolete', environment: { SYNTHETIC_SECRET: 'not-real' } });
      const parsed = parseClientEnvelope(input, { now });
      expect(parsed.params).not.toHaveProperty('environmentId');
      expect(parsed.params).not.toHaveProperty('environment');
      expect(canonicalRequestPayload(input, { now })).not.toContain('SYNTHETIC_SECRET');
    }
  });
  it('preserves independent locked-credential setup references', () => {
    expect(parseOperationResult('config.get', { values: {}, credentialSetup: { provisioningId: 'private-credential-flow' } }))
      .toEqual({ values: {}, credentialSetup: { provisioningId: 'private-credential-flow' } });
  });
});
