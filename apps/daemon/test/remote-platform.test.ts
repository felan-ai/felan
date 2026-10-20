import { describe, expect, it, vi } from 'vitest';
import type { HostRegistration, PublishedEvent, PublishedSession, RemoteCommandOutcome } from '@felan-ai/session-protocol';
import { PlatformClient, PlatformError, parsePlatformError, type RemoteSupabaseClient, type SupabaseClientFactory } from '../src/remote/platform.js';
import type { HostTokenInfo, HostTokenProvider } from '../src/remote/token.js';

const parseOtherError = (error: unknown, status?: number) => parsePlatformError(error, status, 'other');

const id = '0199e5f0-0000-7000-8000-000000000001';
const other = '0199e5f0-0000-7000-8000-000000000002';
const registration: HostRegistration = { name: 'host', daemonVersion: '0.1.0', rowSchemaVersion: 1, capabilities: { operations: ['cancel'], interactionKinds: [] }, projects: [] };
const session: PublishedSession = { session: id, schemaVersion: 1, directory: 'project', shared: true, title: 'title', state: 'open', runState: 'idle' };
const event: PublishedEvent = { session: id, schemaVersion: 1, seq: 1, rev: 1, change: { type: 'metadata.updated', title: 'title', state: 'open', residency: 'warm' }, occurredAt: 0 };
const outcome: RemoteCommandOutcome = { v: 1, re: id, outcome: 'expired' };
function setup() {
  let token = 'host-token';
  const info: HostTokenInfo = { refreshAt: 10_000, expiresAt: 20_000, host: { id, teamId: id, userId: id }, supabase: { url: 'https://db.example.test', publishableKey: 'public' } };
  let observer: Parameters<HostTokenProvider['onChange']>[0] | undefined;
  const unsubscribe = vi.fn();
  const source: HostTokenProvider = {
    token: vi.fn(async () => token), cachedToken: vi.fn(() => token), current: () => info,
    onChange: listener => { observer = listener; return unsubscribe; },
  };
  const rpc = vi.fn<RemoteSupabaseClient['rpc']>().mockResolvedValue({ data: null, error: null });
  const client: RemoteSupabaseClient = {
    rpc, realtime: { setAuth: vi.fn(async () => {}) }, channel: vi.fn(() => { throw new Error('unused'); }),
  };
  const factory = vi.fn<SupabaseClientFactory>(() => client);
  return { source, client, rpc, factory, unsubscribe, renew: () => { token = 'renewed'; observer?.(token, info); } };
}

describe('PlatformClient', () => {
  it('uses cached accessToken and configures stateless auth, sets realtime auth on renewal', async () => {
    const f = setup();
    const fetcher = vi.fn<typeof fetch>();
    const platform = await PlatformClient.connect(f.source, { clientFactory: f.factory, fetch: fetcher });
    const [url, key, config] = f.factory.mock.calls[0]!;
    expect([url, key]).toEqual(['https://db.example.test', 'public']);
    expect(config.auth).toEqual({ persistSession: false, autoRefreshToken: false, detectSessionInUrl: false });
    expect(config.global?.fetch).toBe(fetcher);
    const count = vi.mocked(f.source.token).mock.calls.length;
    expect(await config.accessToken!()).toBe('host-token');
    expect(await config.accessToken!()).toBe('host-token');
    expect(f.source.token).toHaveBeenCalledTimes(count);
    expect(f.client.realtime.setAuth).toHaveBeenCalledWith('host-token');
    f.renew();
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(f.client.realtime.setAuth).toHaveBeenLastCalledWith('renewed');
    await platform.close();
    expect(f.unsubscribe).toHaveBeenCalled();
  });

  it('calls every RPC with the exact argument names', async () => {
    const f = setup();
    const platform = await PlatformClient.connect(f.source, { clientFactory: f.factory });
    await platform.register(registration);
    await platform.heartbeat();
    f.rpc.mockResolvedValueOnce({ data: '1', error: null });
    expect(await platform.publish(session, [event])).toBe(1);
    f.rpc.mockResolvedValueOnce({ data: [], error: null });
    expect(await platform.claim()).toEqual([]);
    await platform.complete(id, outcome);
    expect(f.rpc.mock.calls).toEqual([
      ['host_register', { p_registration: registration }], ['host_heartbeat', undefined],
      ['publish_session_events', { p_session: session, p_events: [event] }],
      ['claim_session_commands', undefined], ['complete_session_command', { p_id: id, p_outcome: outcome }],
    ]);
    await platform.close();
  });

  it('validates all outgoing payloads before calling RPC', async () => {
    const f = setup();
    const platform = await PlatformClient.connect(f.source, { clientFactory: f.factory });
    await expect(platform.register({ ...registration, name: '' })).rejects.toMatchObject({ kind: 'invalid' });
    await expect(platform.publish({ ...session, session: 'bad' }, [])).rejects.toMatchObject({ kind: 'invalid' });
    await expect(platform.publish(session, [{ ...event, seq: 0 }])).rejects.toMatchObject({ kind: 'invalid' });
    await expect(platform.publish(session, [{ ...event, session: other }])).rejects.toMatchObject({ kind: 'invalid' });
    await expect(platform.publish(session, Array.from({ length: 501 }, () => event))).rejects.toMatchObject({ kind: 'invalid' });
    await expect(platform.complete('bad', outcome)).rejects.toMatchObject({ kind: 'invalid' });
    await expect(platform.complete(other, outcome)).rejects.toMatchObject({ kind: 'invalid' });
    await expect(platform.complete(id, { ...outcome, outcome: 'garbage' } as unknown as RemoteCommandOutcome)).rejects.toMatchObject({ kind: 'invalid' });
    expect(f.rpc).not.toHaveBeenCalled();
    await platform.close();
  });

  it.each([0, 42, '42', String(Number.MAX_SAFE_INTEGER)])('parses last_seq %s safely', async value => {
    const f = setup();
    f.rpc.mockResolvedValue({ data: value, error: null });
    const platform = await PlatformClient.connect(f.source, { clientFactory: f.factory });
    expect(await platform.publish(session, [])).toBe(Number(value));
    await platform.close();
  });

  it.each(['9007199254740992', 9007199254740992, '1.2', -1, null])('rejects unsafe last_seq %s', async value => {
    const f = setup();
    f.rpc.mockResolvedValue({ data: value, error: null });
    const platform = await PlatformClient.connect(f.source, { clientFactory: f.factory });
    await expect(platform.publish(session, [])).rejects.toMatchObject({ kind: 'invalid' });
    await platform.close();
  });

  it('maps DB rows, leaves invalid rows in the batch and supports sessions.create', async () => {
    const f = setup();
    const row = {
      id, team_id: id, host_id: id, session_id: id, requester_user_id: other, op: 'cancel', params: {}, state: 'claimed',
      outcome: null, created_at: '2026-10-15T00:00:00Z', expires_at: '2026-10-15T00:01:00Z', claimed_at: null, completed_at: null,
    };
    f.rpc.mockResolvedValue({ data: [row, { ...row, id: other, op: 'rm -rf' }, { ...row, session_id: null, op: 'sessions.create', params: { project: 'p' } }], error: null });
    const platform = await PlatformClient.connect(f.source, { clientFactory: f.factory });
    expect(await platform.claim()).toEqual([
      { id, session: id, requester: other, command: { op: 'cancel', session: id, params: {} }, expiresAt: Date.parse(row.expires_at), state: 'claimed' },
      { id: other, invalid: 'Invalid claimed command row.' },
      { id, requester: other, command: { op: 'sessions.create', params: { project: 'p' } }, expiresAt: Date.parse(row.expires_at), state: 'claimed' },
    ]);
    await platform.close();
  });

  it('maps a channel provider from claimed rows and rejects a malformed one', async () => {
    const f = setup();
    const row = {
      id, team_id: id, host_id: id, session_id: id, requester_user_id: other, op: 'prompt', params: { text: 'hi' }, state: 'claimed',
      outcome: null, created_at: '2026-10-15T00:00:00Z', expires_at: '2026-10-15T00:01:00Z', claimed_at: null, completed_at: null,
      channel_thread_id: other, channel_payload: { sender: 'U1' },
    };
    f.rpc.mockResolvedValue({ data: [{ ...row, channel_provider: 'slack' }, { ...row, id: other, channel_provider: null }, { ...row, id: other, channel_provider: 'Slack' }], error: null });
    const platform = await PlatformClient.connect(f.source, { clientFactory: f.factory });
    const [channel, web, invalid] = await platform.claim();
    expect(channel).toMatchObject({ id, channel: { provider: 'slack' }, command: { op: 'prompt', session: id, params: { text: 'hi' } } });
    expect(web).not.toHaveProperty('channel');
    expect(invalid).toEqual({ id: other, invalid: 'Invalid claimed command row.' });
    await platform.close();
  });

  it('sanitizes RPC and thrown transport errors', async () => {
    const f = setup();
    const platform = await PlatformClient.connect(f.source, { clientFactory: f.factory });
    f.rpc.mockResolvedValueOnce({ data: null, error: { message: 'session_deleted fln_pat_secret' }, status: 400 });
    await expect(platform.heartbeat()).rejects.toMatchObject({ kind: 'retry', message: 'Platform is temporarily unavailable.' });
    f.rpc.mockRejectedValueOnce(new Error('Bearer fln_pat_secret'));
    await expect(platform.heartbeat()).rejects.toMatchObject({ kind: 'retry', message: 'Platform is temporarily unavailable.' });
    await platform.close();
  });
});

describe('parsePlatformError', () => {
  it.each([
    ['PT403', 'not_a_host', 'revoked'], ['PT403', 'host_revoked', 'revoked'], ['PT403', 'not_a_member', 'revoked'],
    ['PT403', 'forbidden', 'forbidden'], ['PT410', 'session_deleted', 'session_deleted'],
    ['PT409', 'sequence_gap', 'sequence_gap'], ['PT409', 'conflict', 'conflict'],
    ['PT426', 'unsupported_schema', 'unsupported_schema'], ['PT400', 'invalid_request', 'invalid'], ['PT413', 'limit_exceeded', 'invalid'],
  ])('reads SQLSTATE %s and exact machine message %s without trusting hints', (code, message, kind) => {
    const error = parseOtherError({ code, message, details: '{"lastSeq":"42","supported":[1,2]}', hint: 'session_deleted fln_pat_secret' }, 503);
    expect(error.kind).toBe(kind);
    expect(`${error.stack} ${JSON.stringify(error)}`).not.toContain('fln_pat_secret');
    if (kind === 'sequence_gap') expect(error.lastSeq).toBe(42);
    if (kind === 'unsupported_schema') expect(error.supported).toEqual([1, 2]);
  });
  it.each([0, 42, '42', Number.MAX_SAFE_INTEGER, String(Number.MAX_SAFE_INTEGER)])('reads camel-case bigint lastSeq %s from JSON DETAIL', value => {
    expect(parseOtherError({ code: 'PT409', message: 'sequence_gap', details: JSON.stringify({ lastSeq: value }) }, 409)).toMatchObject({ kind: 'sequence_gap', lastSeq: Number(value) });
  });
  it.each([['1'], [0], [-1], [1.5], ['fln_pat_secret'], null].map(supported => ({ supported })))('ignores malformed supported versions $supported', ({ supported }) => {
    expect(parseOtherError({ code: 'PT426', message: 'unsupported_schema', details: JSON.stringify({ supported }) }, 426).supported).toBeUndefined();
  });
  it.each(['message', 'details', 'hint', 'code'])('ignores untyped contract words in %s', field => {
    expect(parseOtherError({ [field]: 'session_deleted forbidden sequence_gap' }, 400).kind).toBe('retry');
  });
  it.each([
    [{ details: '{"last_seq":42}' }, 42],
    [{ hint: 'last_seq=43' }, undefined],
    [{ details: 'sequence_gap last_seq: 44' }, undefined],
    [{ details: { last_seq: '45' } }, 45],
    [{ details: '{"last_seq":"9007199254740992"}' }, undefined],
  ])('extracts a safe sequence from %j', (error, lastSeq) => {
    expect(parseOtherError({ ...error, code: 'PT409', message: 'sequence_gap' }, 409)).toMatchObject({ kind: 'sequence_gap', lastSeq });
  });
  it.each([
    [{ message: 'forbidden' }, 400, 'retry'], [{ message: 'host_revoked' }, 400, 'retry'],
    [{ hint: 'not_a_member' }, 400, 'retry'], [{ message: 'JWT expired' }, 400, 'retry'],
    [{ message: 'user is not a member' }, 400, 'retry'],
    [{ message: 'denied' }, 401, 'revoked'], [{ message: 'denied' }, 403, 'revoked'],
    [{ code: 'PGRST301' }, 400, 'revoked'], [{ code: 'PGRST302' }, 400, 'revoked'],
    [{ code: 'PGRST303' }, 400, 'revoked'], [{ code: '42501' }, 400, 'revoked'],
    [{ message: 'PGRST301 42501' }, 400, 'retry'], [{ message: 'unsupported_schema' }, 400, 'retry'],
    [{ code: 'PT400', message: 'session_deleted details' }, 400, 'retry'],
    [{ code: 'PT40', message: 'session_deleted' }, 400, 'retry'],
    [{ code: 'PT400suffix', message: 'forbidden' }, 400, 'retry'],
    [{ code: 'PT409', message: 'invalid_request' }, 409, 'retry'],
    [{ code: 'PT400', message: 'limit_exceeded' }, 400, 'retry'],
    [{}, 429, 'retry'], [{}, 503, 'retry'], [{}, 400, 'retry'], [{}, 404, 'retry'], [{}, 409, 'retry'],
    [{}, 0, 'retry'], [{}, undefined, 'retry'],
  ])('classifies %j HTTP %s as %s', (error, status, kind) => {
    const parsed = parseOtherError(error, status);
    expect(parsed).toBeInstanceOf(PlatformError);
    expect(parsed.kind).toBe(kind);
  });
  it.each([403, 502])('does not trust HTML or plain-text gateway bodies with HTTP %s', status => {
    for (const message of ['<html><title>403 Forbidden</title></html>', 'Forbidden', 'upstream: session_deleted? no', 'sequence_gap forbidden session_deleted']) {
      expect(parseOtherError({ message }, status).kind).toBe(status === 403 ? 'revoked' : 'retry');
    }
  });
  it('identifies rate limiting structurally from HTTP status', () => {
    expect(parseOtherError({ message: 'rate_limited' }, 429)).toMatchObject({ kind: 'retry', rateLimited: true });
    expect(parseOtherError({ message: 'rate_limited' }, 502).rateLimited).toBe(false);
  });
});

describe('publication-specific non-PT errors', () => {
  it.each([
    [{}, 400], [{}, 404], [{}, 413], [{}, 422],
    [{ code: '22P02' }, 400], [{ code: '23514' }, 400], [{ code: '22003' }, undefined],
    [{ code: '23502' }, 400], [{ code: 'PGRST100' }, 400], [{ code: 'PGRST109' }, undefined],
  ] as const)('quarantines a rejected payload %j HTTP %s without terminal meaning', (error, status) => {
    expect(parsePlatformError(error, status).kind).toBe('invalid');
    expect(parsePlatformError(error, status, 'other').kind).toBe('retry');
  });

  it.each([408, 429, 500, 502, 503])('keeps HTTP %s connection-level and retryable', status => {
    expect(parsePlatformError({ code: '23514' }, status).kind).toBe('retry');
    expect(parsePlatformError({ code: 'PGRST301' }, status).kind).toBe('retry');
  });

  it.each([401, 403])('preserves non-PT HTTP %s for token exchange without trusting the body', status => {
    expect(parsePlatformError({ message: 'forbidden session_deleted' }, status)).toMatchObject({ kind: 'revoked', httpStatus: status });
  });

  it('maps claimed_at and isolates an invalid timestamp', async () => {
    const f = setup();
    const row = { id, host_id: id, session_id: id, requester_user_id: other, op: 'cancel', params: {}, state: 'claimed',
      created_at: '2026-10-15T00:00:00Z', expires_at: '2026-10-15T00:01:00Z', claimed_at: '2026-10-15T00:00:30Z' };
    f.rpc.mockResolvedValue({ data: [row, { ...row, claimed_at: 'bad' }], error: null });
    const platform = await PlatformClient.connect(f.source, { clientFactory: f.factory });
    expect(await platform.claim()).toEqual([
      expect.objectContaining({ claimedAt: Date.parse(row.claimed_at) }), { id, invalid: 'Invalid claimed command row.' },
    ]);
    await platform.close();
  });
});
