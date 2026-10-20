import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import { Value } from 'typebox/value';
import {
  HostProjectSchema, LIMITS, OPERATION_CATALOG, ProtocolValidationError, RemoteConfigureParamsSchema, RemoteStatusSchema, ResponseSchema,
  canonicalRequestPayload, compareRequestPayload, parseClientEnvelope, parseOperationResult, parseRemoteConfigureParams,
  parseRemoteStatus, parseSchema, parseServerEnvelope, parseStoredRequestRecord, requestRetainUntil, type HostProject, type OperationParams, type OperationResult,
  type RemoteConfigureParams, type RemoteStatus,
} from '../src/index.js';
import { now, remoteStatus, request } from './fixtures.js';

describe('remote operation schemas', () => {
  it('uses host-local connection storage for configuration and durable session sharing', () => {
    expect(OPERATION_CATALOG['remote.status']).toEqual({ scope: 'host', mutation: false, storage: 'none' });
    expect(OPERATION_CATALOG['remote.configure']).toEqual({ scope: 'host', mutation: true, storage: 'connection' });
    expect(OPERATION_CATALOG['session.remote']).toEqual({ scope: 'session', mutation: true, storage: 'durable' });
    for (const op of ['remote.status', 'remote.configure'] as const) {
      expect(() => parseClientEnvelope({ ...request(op), session: 'session' })).toThrowError(ProtocolValidationError);
    }
    expect(() => parseClientEnvelope({ ...request('remote.configure'), id: 'not-a-uuid' })).toThrow();
    expect(parseClientEnvelope({ ...request('remote.status'), id: 'read-id' }).op).toBe('remote.status');
    expect(() => parseClientEnvelope({ ...request('session.remote'), session: undefined })).toThrow();
    expect(() => parseClientEnvelope(request('session.remote', { shared: 'true' }))).toThrow();
    expect(parseOperationResult('session.remote', {})).toEqual({});
  });

  it.each<RemoteConfigureParams>([
    { action: 'login', token: 'fln_pat_Az09_-' },
    { action: 'login', token: 'fln_pat_' + 'x'.repeat(504), apiUrl: 'https://app.felan.ai' },
    { action: 'logout' }, { action: 'share', share: 'all' }, { action: 'share', share: 'on-request' },
    { action: 'open_project', path: '/fixture', name: 'Fixture' },
    { action: 'open_project', path: 'C:\\fixture' },
    { action: 'close_project', id: 'project' },
  ])('accepts configuration %j', params => {
    expect(Value.Check(RemoteConfigureParamsSchema, params)).toBe(true);
    expect(parseRemoteConfigureParams(params)).toEqual(params);
    expect(parseClientEnvelope(request('remote.configure', params)).params).toEqual(params);
  });

  it.each(['', 'fln_pat_', 'bzy_team_wrong', 'fln_pat_a.b', 'fln_pat_x x', 'fln_pat_é', 'fln_pat_x\n', 'fln_pat_' + 'x'.repeat(505)])(
    'rejects invalid PAT %j', token => {
      expect(() => parseRemoteConfigureParams({ action: 'login', token })).toThrowError(ProtocolValidationError);
      expect(() => parseClientEnvelope(request('remote.configure', { action: 'login', token }))).toThrowError(ProtocolValidationError);
    },
  );

  it.each([
    {}, { action: 'unknown' }, { action: 'login' }, { action: 'share', share: 'local' }, { action: 'open_project' },
    { action: 'open_project', path: 'relative' }, { action: 'open_project', path: '/fixture\0escape' },
    { action: 'open_project', path: '/fixture', name: '' }, { action: 'open_project', path: '/fixture', name: '😀'.repeat(65) },
    { action: 'close_project', id: '' },
  ])('rejects invalid configuration %j', params => {
    expect(() => parseRemoteConfigureParams(params)).toThrowError(ProtocolValidationError);
  });

  it.each(['https://app.felan.ai', 'http://localhost:3000', 'http://[::1]:3000', 'https://example.com/base?option=1'])('accepts an HTTP API URL %s', apiUrl => {
    expect(parseRemoteConfigureParams({ action: 'login', token: 'fln_pat_test', apiUrl })).toMatchObject({ apiUrl });
  });

  it.each(['', 'example.com', '/relative', 'ftp://example.com', 'https://', 'https://example.com:99999',
    'https://user:secret@example.com', 'https://secret@example.com', 'https://example.com/a b', 'https://example.com/\n',
    'https://example.com/\\secret', 'https://example.com/' + 'x'.repeat(2048), 'https://example.com/' + '😀'.repeat(508)])(
    'rejects an invalid or credential-bearing API URL %j', apiUrl => {
      expect(() => parseClientEnvelope(request('remote.configure', { action: 'login', token: 'fln_pat_test', apiUrl }))).toThrowError(ProtocolValidationError);
    },
  );

  it('enforces the API URL UTF-8 byte boundary', () => {
    const apiUrl = 'https://example.com/' + 'x'.repeat(2048 - 'https://example.com/'.length);
    expect(parseRemoteConfigureParams({ action: 'login', token: 'fln_pat_test', apiUrl })).toMatchObject({ apiUrl });
    expect(() => parseRemoteConfigureParams({ action: 'login', token: 'fln_pat_test', apiUrl: apiUrl + 'x' })).toThrow();
  });

  it('never accepts connection-local secrets as durable request records or leaks them in validation errors', () => {
    const token = 'fln_pat_SYNTHETIC_SECRET';
    const input = request('remote.configure', { action: 'login', token });
    const record = { schemaVersion: 1, id: input.id, owner: 'owner', admittedAt: now,
      retainUntil: requestRetainUntil(input.id, now), payload: canonicalRequestPayload(input), state: { phase: 'intent' } };
    expect(() => parseStoredRequestRecord(record)).toThrowError(/Invalid durable command identity/);
    const error = (() => {
      try { parseClientEnvelope(request('remote.configure', { action: 'login', token, apiUrl: `https://${token}@example.com` })); }
      catch (error) { return error; }
      throw new Error('Expected validation failure');
    })();
    expect(JSON.stringify(error)).not.toContain(token);
    expect(String(error)).not.toContain(token);
    expect(compareRequestPayload(input, request('remote.configure', { action: 'login', token: 'fln_pat_different' }))).toBe('conflict');
    expect(parseRemoteConfigureParams({ action: 'logout', token })).toEqual({ action: 'logout' });
  });

  it('retains durable sharing requests without configuration credentials', () => {
    const input = request('session.remote');
    const record = { schemaVersion: 1, id: input.id, owner: 'owner', session: input.session, admittedAt: now,
      retainUntil: requestRetainUntil(input.id, now), payload: canonicalRequestPayload(input),
      state: { phase: 'terminal', response: { v: 1, re: input.id, outcome: 'accepted', result: {} } } };
    expect(parseStoredRequestRecord(record)).toEqual(record);
  });

  it('exports discriminated configuration and result types', () => {
    expectTypeOf<RemoteConfigureParams>().toEqualTypeOf<OperationParams<'remote.configure'>>();
    expectTypeOf<RemoteStatus>().toEqualTypeOf<OperationResult<'remote.status'>>();
    expectTypeOf<RemoteStatus>().toEqualTypeOf<OperationResult<'remote.configure'>>();
    expectTypeOf<Extract<RemoteConfigureParams, { action: 'login' }>['token']>().toEqualTypeOf<string>();
  });
});

describe('remote status', () => {
  const status: RemoteStatus = { ...remoteStatus, configured: true, share: 'all', state: 'stopped', reason: 'unsupported_schema',
    message: 'Update required', host: { id: '12345678-1234-5678-9012-123456789012' },
    projects: [{ id: 'project', name: 'Fixture', path: '/fixture' }], pending: 12, sessions: 1,
    supported: { protocol: [1], rowSchemaVersion: [1, 2] } };

  it('keeps project schema structure and accepted values aligned with publication', () => {
    const projectSchema = RemoteStatusSchema.properties.projects.items;
    expect(projectSchema).toEqual(HostProjectSchema);
    expectTypeOf<RemoteStatus['projects'][number]>().toEqualTypeOf<HostProject>();
    for (const project of [
      { id: 'project', name: 'Fixture', path: '/fixture' },
      { id: 'p'.repeat(LIMITS.idBytes), name: '😀'.repeat(64), path: 'x'.repeat(LIMITS.pathBytes) },
    ]) {
      expect(Value.Check(HostProjectSchema, project)).toBe(true);
      expect(Value.Check(projectSchema, project)).toBe(true);
      expect(parseSchema(projectSchema, project)).toEqual(parseSchema(HostProjectSchema, project));
      expect(parseRemoteStatus({ ...remoteStatus, projects: [project] }).projects).toEqual([project]);
    }
  });

  it('validates correlated results', () => {
    expect(Value.Check(RemoteStatusSchema, status)).toBe(true);
    expect(Value.Check(ResponseSchema, { v: 1, re: 'status', outcome: 'accepted', result: null })).toBe(false);
    expect(parseRemoteStatus(status)).toEqual(status);
    for (const op of ['remote.status', 'remote.configure'] as const) {
      expect(parseOperationResult(op, status)).toEqual(status);
      expect(parseServerEnvelope({ v: 1, re: 'status', outcome: 'accepted', result: status }, op)).toMatchObject({ result: status });
    }
  });

  it('strips undeclared credential fields instead of reflecting them in status', () => {
    expect(parseRemoteStatus({ ...remoteStatus, token: 'fln_pat_SYNTHETIC_SECRET', host: {
      id: '12345678-1234-5678-9012-123456789012', token: 'synthetic-host-token',
    } })).toEqual({ ...remoteStatus, host: { id: '12345678-1234-5678-9012-123456789012' } });
  });

  it.each(['off', 'connecting', 'connected', 'offline', 'stopped'] as const)('accepts state %s', state => {
    expect(parseRemoteStatus({ ...remoteStatus, state }).state).toBe(state);
  });

  it.each(['invalid_pat', 'not_a_member', 'host_revoked', 'unsupported_schema', 'rate_limited', 'unavailable'] as const)('accepts bounded reason %s', reason => {
    expect(parseRemoteStatus({ ...remoteStatus, reason }).reason).toBe(reason);
  });

  it.each([
    { configured: 'true' }, { share: 'none' }, { state: 'starting' }, { reason: 'unknown' }, { host: { id: 'not-uuid' } },
    { pending: -1 }, { pending: 1.5 }, { sessions: Number.MAX_SAFE_INTEGER + 1 }, { message: '\u001b[31m' }, { message: '😀'.repeat(1025) },
    { projects: [{ id: 'project', name: '', path: '/fixture' }] }, { supported: { protocol: [-1], rowSchemaVersion: [1] } },
    { supported: { protocol: [1], rowSchemaVersion: [0.1] } },
    { apiUrl: 'https://user:secret@example.com' }, { apiUrl: 'https://example.com/' },
    { apiUrl: 'https://example.com/path' }, { apiUrl: 'https://example.com?secret=value' }, { apiUrl: 'https://example.com#secret' },
  ])('rejects invalid status fields %j', fields => {
    expect(() => parseRemoteStatus({ ...remoteStatus, ...fields })).toThrowError(ProtocolValidationError);
    expect(() => parseOperationResult('remote.status', { ...remoteStatus, ...fields })).toThrowError(ProtocolValidationError);
  });
});

describe('module initialization', () => {
  const modules = {
    commands: () => import('../src/commands.js'),
    envelopes: () => import('../src/envelopes.js'),
    publication: () => import('../src/publication.js'),
    remote: () => import('../src/remote.js'),
  };
  it.each(Object.keys(modules) as (keyof typeof modules)[])('initializes schemas when %s is imported first', async module => {
    vi.resetModules();
    await modules[module]();
    const protocol = await import('../src/index.js');
    expect(protocol.RemoteStatusSchema.properties.projects.items).toEqual(protocol.HostProjectSchema);
    expect(protocol.parseOperationResult('remote.status', remoteStatus)).toEqual(remoteStatus);
    expect(Value.Check(protocol.ResponseSchema, { v: 1, re: 'status', outcome: 'accepted', result: remoteStatus })).toBe(true);
    expect(Value.Check(protocol.ResponseSchema, { v: 1, re: 'status', outcome: 'accepted', result: null })).toBe(false);
  });
});
