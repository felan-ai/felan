import { describe, expect, it } from 'vitest';
import { BootstrapHelloSchema, CONTROL_VERSION, ControlRequestSchema, LIMITS, PROTOCOL_VERSION, ROW_SCHEMA_VERSION,
  canonicalRequestPayload, compareRequestPayload, parseClientEnvelope, parseControlRequest, parseControlResponse, parseOperationResult, parseSchema,
  parseServerEnvelope, parseStoredRequestRecord, requestRetainUntil, requestTimestamp } from '../src/index.js';
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
    expect(() => parseClientEnvelope({ ...request('prompt'), v: 2 })).toThrow(/protocol version/);
    expect(() => parseServerEnvelope({ v: 2, re: 'q', outcome: 'accepted', result: {} })).toThrow(/protocol version/);
    expect(parseSchema(BootstrapHelloSchema, { v: 2, id: 'hello', op: 'hello', params: { protocol: 2, clientVersion: 'new' } })).toBeTruthy();
    expect(parseSchema(BootstrapHelloSchema, { v: 2, id: 'hello', op: 'hello', params: { protocol: 2, clientVersion: 'new', environment: {} } }))
      .toEqual({ v: 2, id: 'hello', op: 'hello', params: { protocol: 2, clientVersion: 'new' } });
    for (const op of ['host.status', 'host.stop', 'host.restart'] as const) {
      const params = op === 'host.status' ? { expected: identity } : { expected: identity, mode: 'drain' };
      expect(parseControlRequest({ control: 1, id: requestId(), op, params }).op).toBe(op);
    }
    expect(() => parseControlRequest({ control: 1, id: requestId(), op: 'prompt', params: { text: 'no' } })).toThrow();
    expect(() => parseControlRequest({ control: 1, id: requestId(), op: 'host.stop', params: { expected: identity, mode: 'immediate' } })).toThrow();
    expect(() => parseControlRequest({ control: 1, id: requestId(), op: 'host.status', params: { expected: identity, environment: { SECRET: 'fake' } } })).toThrow();
    expect(parseControlResponse({ control: 1, re: 'hello', daemonVersion: '1.0', supportedProtocol: 1, identity, state: 'ready', outcome: 'mismatch' })).toBeTruthy();
    expect(() => parseControlResponse({ control: 1, re: 'hello', daemonVersion: '1.0', supportedProtocol: 1, identity, state: 'ready', outcome: 'rejected' })).toThrow();
    expect(() => parseSchema(ControlRequestSchema, { control: 2, id: 'q', op: 'host.status', params: { expected: identity } })).toThrow();
  });

  it('reports why a blocked host refuses work and whether forcing can retry its cleanup', () => {
    const blocked = { recoverable: true, since: now, message: 'Error: service settle failed', step: 'settle-services', session: 's', pid: 4242 };
    const status = { control: 1, re: 'status', daemonVersion: '1.0', supportedProtocol: 1, identity, state: 'blocked', blocked, outcome: 'accepted' };
    expect(parseControlResponse(status).blocked).toEqual(blocked);
    expect(parseControlResponse({ ...status, blocked: { recoverable: false, since: now, message: 'Ownership was lost.' } }).blocked).toEqual({ recoverable: false, since: now, message: 'Ownership was lost.' });
    expect(() => parseControlResponse({ ...status, blocked: { ...blocked, message: 'line\nbreak' } })).toThrow();
    expect(() => parseControlResponse({ ...status, blocked: { ...blocked, pid: 0 } })).toThrow();
    expect(parseOperationResult('host.status', { state: 'blocked', identity, daemonVersion: '1.0', protocol: 1,
      active: { sessions: 0, runs: 0, work: 0, attachments: 0 }, setupNeeds: [], blocked })).toMatchObject({ blocked });
  });
});

describe('request retry identity', () => {
  it('reads UUIDv7 timestamps without imposing request freshness', () => {
    expect(requestTimestamp(requestId())).toBe(now);
    expect(() => requestTimestamp('not-v7')).toThrow();
    expect(parseClientEnvelope({ ...request('prompt'), id: requestId(now - LIMITS.requestRetentionMs - 1) }).id).toBe(requestId(now - LIMITS.requestRetentionMs - 1));
    expect(parseClientEnvelope({ ...request('prompt'), id: requestId(now + 24 * 60 * 60 * 1000) }).op).toBe('prompt');
    expect(parseClientEnvelope({ ...request('prompt'), id: requestId().toUpperCase() }).id).toBe(requestId());
  });
  it('compares normalized semantic payloads, detects conflicts and supports retained duplicate lookup', () => {
    const first = request('prompt');
    expect(compareRequestPayload(first, { ...first, extra: true, params: { ...first.params, extra: 1 } })).toBe('same');
    expect(compareRequestPayload(first, request('prompt', { text: 'changed' }))).toBe('conflict');
    expect(compareRequestPayload(undefined, first)).toBe('unavailable');
    expect(compareRequestPayload(first, first)).toBe('same');
  });
});

describe('shared daemon environment boundary', () => {
  it('exposes no per-session environment API or limits', () => {
    expect(Object.keys(protocol.OperationSchemas)).toHaveLength(53);
    expect(Object.keys(protocol.OperationSchemas).some(op => op.startsWith('environment.'))).toBe(false);
    for (const name of ['EnvironmentSchema', 'parseEnvironment', 'ProvisioningReferenceSchema']) expect(protocol).not.toHaveProperty(name);
    expect(Object.keys(LIMITS).some(name => name.startsWith('environment'))).toBe(false);
    for (const op of ['environment.provision', 'environment.refresh']) {
      expect(() => parseClientEnvelope({ v: 1, id: requestId(), op, params: {} })).toThrow();
    }
  });
  it('creates and imports without handles and strips obsolete environment data from canonical requests', () => {
    for (const op of ['sessions.create', 'session.import'] as const) {
      const input = request(op, { ...request(op).params, environmentId: 'obsolete', environment: { SYNTHETIC_SECRET: 'not-real' } });
      const parsed = parseClientEnvelope(input);
      expect(parsed.params).not.toHaveProperty('environmentId');
      expect(parsed.params).not.toHaveProperty('environment');
      expect(canonicalRequestPayload(input)).not.toContain('SYNTHETIC_SECRET');
    }
  });
  it('preserves independent locked-credential setup references', () => {
    expect(parseOperationResult('config.get', { writable: false, values: {}, credentialSetup: { provisioningId: 'private-credential-flow' } }))
      .toEqual({ writable: false, values: {}, credentialSetup: { provisioningId: 'private-credential-flow' } });
  });
});
