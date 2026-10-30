import { afterEach, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import type { RemoteCommandOutcome, Response } from '@felan-ai/session-protocol';
import { RemoteConnector, type ConnectorPlatform, type ConnectorTokenSource, type RemoteConnectorOptions } from '../src/remote/connector.js';
import { RemoteCommandJournal } from '../src/remote/command-journal.js';
import { PlatformError, parsePlatformError, type ClaimedCommand } from '../src/remote/platform.js';
import { HostTokenExchangeError, type HostTokenInfo } from '../src/remote/token.js';
import type { RemoteClock, TimerHandle } from '../src/remote/backoff.js';
import { serverFixture, requestId, now } from './fixtures/server.js';
import { FakePairing } from './fixtures/remote-pairing.js';

const host = '019a0000-0000-7000-8000-000000000001';
const user = '019a0000-0000-7000-8000-000000000002';
const other = '019a0000-0000-7000-8000-000000000003';
const pat = 'fln_pat_test_secret';
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

class Clock implements RemoteClock {
  time = now;
  jobs = new Map<TimerHandle, { at: number; run(): void }>();
  now = () => this.time;
  setTimeout(run: () => void, delay: number): TimerHandle { const id = {}; this.jobs.set(id, { at: this.time + delay, run }); return id; }
  clearTimeout(id: TimerHandle): void { this.jobs.delete(id); }
  async tick(ms = 5): Promise<void> {
    this.time += ms;
    for (let turn = 0; turn < 30; turn++) {
      await new Promise<void>(resolve => setImmediate(resolve));
      for (const [id, job] of this.jobs) if (job.at <= this.time) { this.jobs.delete(id); job.run(); }
    }
  }
}

async function fixture(overrides: Partial<RemoteConnectorOptions> = {}, recovery = false,
  tokenHost: HostTokenInfo['host'] = { id: host, teamId: user, userId: user }) {
  const f = await serverFixture(); const clock = new Clock();
  if (recovery) Object.defineProperty(f.store.database, 'rebuilt', { configurable: true, get: () => true });
  const info: HostTokenInfo = { expiresAt: now + 100_000, refreshAt: now + 90_000,
    host: tokenHost, supabase: { url: 'https://db.example.test', publishableKey: 'public' } };
  const listeners = new Set<(token: string, info: HostTokenInfo) => void>();
  const current = vi.fn<ConnectorTokenSource['current']>(() => info);
  const token: ConnectorTokenSource = {
    token: vi.fn(async () => {
      current.mockReturnValue(info);
      for (const listener of listeners) listener('host-token', info);
      return 'host-token';
    }), cachedToken: () => current() ? 'host-token' : null, current,
    onChange: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    stop: vi.fn(() => { current.mockReturnValue(undefined); listeners.clear(); }),
    invalidate: vi.fn(() => { current.mockReturnValue(undefined); }),
  };
  let rows: ClaimedCommand[] = recovery ? [{ id: requestId(), requester: user, command: { op: 'cancel', session: f.root.sessionId, params: {} }, expiresAt: now + 60_000, state: 'claimed' }] : []; let notify = () => {};
  const platform = {
    register: vi.fn(async () => {}), heartbeat: vi.fn(async () => {}),
    publish: vi.fn<ConnectorPlatform['publish']>(async (_session, events) => events.at(-1)?.seq ?? 0),
    claim: vi.fn(async () => rows),
    complete: vi.fn(async (id: string, _outcome: RemoteCommandOutcome) => { rows = rows.filter(row => row.id !== id); }),
    close: vi.fn(async () => {}),
    realtime: { subscribeCommands: vi.fn((_host: string, listener: () => void) => { notify = listener; return () => { notify = () => {}; }; }), sendText: vi.fn() },
  } satisfies ConnectorPlatform;
  const server = { submitRemote: vi.fn<RemoteConnectorOptions['server']['submitRemote']>(async request => ({ v: 1, re: request.id, outcome: 'accepted', result: {} } as Response)), hasRemoteRequest: vi.fn(() => true) };
  const secrets = { read: vi.fn(async () => pat), write: vi.fn(async (_ns: string, _key: string, _pat: string) => {}), remove: vi.fn(async () => {}) };
  const tokenSource = vi.fn(() => token);
  const connect = vi.fn(async (source: ConnectorTokenSource) => { await source.token(); return platform; });
  const connectorOptions: RemoteConnectorOptions = { database: f.store.database, registry: f.registry, owner: f.owner,
    server, secretStorage: secrets, apiUrl: 'https://api.example.test', clock, tokenSource, connect,
    heartbeatMs: 100, shutdownTimeoutMs: 10, ...overrides };
  let connector = new RemoteConnector(connectorOptions);
  cleanups.push(async () => { await connector.stop(); await f.dispose(); });
  connector.start(); await clock.tick();
  const journal = new RemoteCommandJournal(f.store.database);
  const row = (requester = user): ClaimedCommand => ({ id: requestId(), requester, command: { op: 'cancel', session: f.root.sessionId, params: {} }, expiresAt: clock.now() + 60_000, state: 'claimed' });
  return { ...f, clock, get connector() { return connector; }, platform, token, tokenSource, connect, server, secrets, journal, row,
    async restart() { await connector.stop(); connector = new RemoteConnector(connectorOptions); connector.start(); await clock.tick(); },
    setRows(value: ClaimedCommand[]) { rows = value; }, notify: () => notify(),
  };
}

it('rejects stale claimed commands through the connector without dispatch', async () => {
  const f = await fixture(); const row = { ...f.row(), expiresAt: f.clock.now() - 5_000 };
  f.setRows([row]); f.notify(); await f.clock.tick();
  expect(f.platform.complete).toHaveBeenCalledWith(row.id, expect.objectContaining({ outcome: 'rejected', error: {
    code: 'expired', message: 'Remote command expired before admission.', retryable: false,
  } }));
  expect(f.server.submitRemote).not.toHaveBeenCalled(); expect(f.journal.get(row.id)).toBeUndefined();
});

it('rejects a non-owner requester using the host identity', async () => {
  const f = await fixture(); const row = f.row(other);
  f.setRows([row]); f.notify(); await f.clock.tick();
  expect(f.platform.complete).toHaveBeenCalledWith(row.id, expect.objectContaining({ outcome: 'rejected', error: {
    code: 'forbidden', message: 'Remote commands require the host owner.', retryable: false,
  } }));
  expect(f.server.submitRemote).not.toHaveBeenCalled();
});

it.each(['invalidate', 'stop'] as const)('rejects a foreign requester when a personal host token is cleared by %s during a claim', async clear => {
  const f = await fixture(); f.connector.setShared(f.root.sessionId, true); await f.clock.tick();
  const row = f.row(other); f.setRows([row]);
  f.platform.claim.mockImplementationOnce(async () => {
    f.token[clear](); expect(f.token.current()).toBeUndefined(); return [row];
  });
  f.notify(); await f.clock.tick();
  expect(f.platform.complete).toHaveBeenCalledWith(row.id, expect.objectContaining({ outcome: 'rejected', error: {
    code: 'forbidden', message: 'Remote commands require the host owner.', retryable: false,
  } }));
  expect(f.server.submitRemote).not.toHaveBeenCalled();
});

it.each([undefined, other])('accepts a known team host requester %s after token invalidation', async requester => {
  const f = await fixture({}, false, { id: host, teamId: user });
  f.connector.setShared(f.root.sessionId, true); await f.clock.tick();
  const row = { ...f.row(), requester }; f.setRows([row]);
  f.platform.claim.mockImplementationOnce(async () => { f.token.invalidate(); return [row]; });
  f.notify(); await f.clock.tick();
  expect(f.token.current()).toBeUndefined();
  expect(f.platform.complete).toHaveBeenCalledWith(row.id, expect.objectContaining({ outcome: 'accepted' }));
  expect(f.server.submitRemote).toHaveBeenCalledOnce();
  expect(f.server.submitRemote.mock.calls[0]![1].user).toBe(requester);
});

it('keeps the journal after transient fallback failure, continues later rows and retries without dispatching twice', async () => {
  const f = await fixture(); f.connector.setShared(f.root.sessionId, true); await f.clock.tick();
  const rows = [f.row(), f.row()].sort((a, b) => a.id.localeCompare(b.id)); const [first, second] = rows;
  f.setRows(rows); f.platform.claim.mockClear();
  f.platform.complete.mockRejectedValueOnce(new PlatformError('invalid', 'Invalid outcome.'))
    .mockImplementationOnce(async () => { f.notify(); throw new PlatformError('retry', 'Unavailable.'); });
  f.notify(); await f.clock.tick();
  expect(f.platform.claim).toHaveBeenCalledTimes(2);
  expect(f.server.submitRemote).toHaveBeenCalledTimes(2);
  expect(f.journal.get(first!.id)).toBeUndefined();
  expect(f.journal.get(second!.id)).toBeUndefined();
  expect(f.platform.complete).toHaveBeenCalledTimes(4);
  expect(f.platform.complete).toHaveBeenLastCalledWith(first!.id, expect.objectContaining({ outcome: 'accepted' }));
  f.notify(); await f.clock.tick();
  expect(f.platform.complete).toHaveBeenCalledTimes(4);
  expect(f.server.submitRemote).toHaveBeenCalledTimes(2); expect(f.journal.get(first!.id)).toBeUndefined();
  f.notify(); await f.clock.tick(); expect(f.platform.complete).toHaveBeenCalledTimes(4);
});

it.each(['conflict', 'forbidden', 'session_deleted'] as const)('forgets completed journal entries when the primary completion returns %s', async kind => {
  const f = await fixture(); const row = f.row();
  f.setRows([row]); f.platform.complete.mockRejectedValueOnce(new PlatformError(kind, 'Not applicable.'));
  f.notify(); await f.clock.tick();
  expect(f.journal.get(row.id)).toBeUndefined(); expect(f.platform.complete).toHaveBeenCalledOnce();
});

it.each(['success', 'conflict', 'forbidden', 'session_deleted', 'retry'] as const)('forgets only an acknowledged or conflicting fallback (%s)', async kind => {
  const f = await fixture(); const row = f.row();
  f.setRows([row]); f.platform.complete.mockRejectedValueOnce(new PlatformError('invalid', 'Invalid.'));
  if (kind !== 'success') f.platform.complete.mockRejectedValueOnce(new PlatformError(kind, 'Not applicable.'));
  f.notify(); await f.clock.tick();
  expect(f.platform.complete).toHaveBeenCalledTimes(2);
  expect(f.journal.get(row.id)?.state).toBe(kind === 'success' || kind === 'conflict' ? undefined : 'completed');
});

it.each([403, 502, 404])('preserves the outbox for a non-PT gateway HTTP %s publication error', async status => {
  const f = await fixture();
  f.platform.publish.mockRejectedValueOnce(parsePlatformError({ message: '<html>forbidden session_deleted sequence_gap</html>' }, status));
  f.connector.setShared(f.root.sessionId, true); await f.clock.tick(); await f.clock.tick();
  expect(f.connector.outbox.pendingCount()).toBeGreaterThan(0);
  expect(f.connector.store.session(f.root.sessionId)?.terminal).toBeUndefined();
  expect(f.connector.status()).toMatchObject(status === 404 ? { state: 'connected' } : { state: 'offline', reason: 'unavailable' });
  expect(f.token.invalidate).toHaveBeenCalledTimes(status === 403 ? 1 : 0);
});

it('reports rate_limited while offline after an RPC 429', async () => {
  const f = await fixture(); f.platform.heartbeat.mockRejectedValueOnce(parsePlatformError({}, 429));
  await f.clock.tick(100);
  expect(f.connector.status()).toMatchObject({ state: 'offline', reason: 'rate_limited' });
});

it('reports rate_limited while offline after token exchange 429', async () => {
  const f = await fixture({ connect: async () => { throw new HostTokenExchangeError('retry', 'Unavailable.', undefined, 1000, true); } });
  expect(f.connector.status()).toMatchObject({ state: 'offline', reason: 'rate_limited' });
});

it.each(['not-a-url', 'http://remote.example.test', 'https://user:secret@example.test'])('reports invalid configured URL %s and never connects', async apiUrl => {
  const f = await fixture({ apiUrl });
  expect(f.connector.status()).toMatchObject({ state: 'offline', reason: 'unavailable', apiUrl: 'https://invalid.invalid' });
  expect(f.connector.status().message).toContain('Remote API URL is invalid.');
  expect(f.tokenSource).not.toHaveBeenCalled(); expect(f.connect).not.toHaveBeenCalled();
  expect(JSON.stringify(f.connector.status())).not.toContain('user:secret');
});

it('reports an invalid environment URL without substituting the default or connecting', async () => {
  vi.stubEnv('FELAN_API_URL', 'invalid');
  const f = await fixture({ apiUrl: undefined });
  expect(f.connector.status()).toMatchObject({ state: 'offline', apiUrl: 'https://invalid.invalid', message: expect.stringContaining('Remote API URL is invalid.') });
  expect(f.tokenSource).not.toHaveBeenCalled(); expect(f.connect).not.toHaveBeenCalled();
});

it('uses invalid_request for invalid API URLs and project paths or names', async () => {
  const f = await fixture();
  for (const apiUrl of ['not-a-url', 'http://remote.example.test']) {
    await expect(f.connector.configure({ action: 'login', apiUrl })).rejects.toMatchObject({ code: 'invalid_request' });
  }
  const file = join(f.cwd, 'file'); await writeFile(file, 'not a directory');
  for (const path of ['relative', `${f.cwd}/absent`, file]) {
    await expect(f.connector.configure({ action: 'open_project', path })).rejects.toMatchObject({ code: 'invalid_request', message: expect.stringContaining('Remote project path') });
  }
  await expect(f.connector.configure({ action: 'open_project', path: f.cwd, name: '' })).rejects.toMatchObject({ code: 'invalid_request', message: expect.stringContaining('name') });
  expect(f.secrets.write).not.toHaveBeenCalled();
});

it('persists the API URL only after the browser pairing starts', async () => {
  const pairing = new FakePairing(); const f = await fixture({ pairingSource: () => pairing }); const configure = vi.spyOn(f.connector.store, 'configure');
  pairing.start.mockRejectedValueOnce(new PlatformError('retry', 'offline'));
  await expect(f.connector.configure({ action: 'login', apiUrl: 'https://new.example.test' })).rejects.toMatchObject({ code: 'unavailable' });
  expect(configure).not.toHaveBeenCalled(); expect(f.connector.store.settings().apiUrl).toBeUndefined();
  expect(f.connector.status().apiUrl).toBe('https://api.example.test');
  await f.connector.configure({ action: 'login', apiUrl: 'https://new.example.test' });
  expect(configure).toHaveBeenCalledWith({ apiUrl: 'https://new.example.test' });
  expect(f.connector.store.settings().apiUrl).toBe('https://new.example.test');
});

it('holds unrecorded commands after a rebuild until an empty claim and preserves recovery across restart', async () => {
  const f = await fixture({}, true);
  expect(f.server.submitRemote).not.toHaveBeenCalled();
  expect(f.platform.complete).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ outcome: 'indeterminate' }));
  expect(f.store.database.records('command_recovery')).toEqual([]);

  f.connector.setShared(f.root.sessionId, true);
  f.setRows([]); f.notify(); await f.clock.tick();
  expect(f.store.database.records('command_recovery')).toHaveLength(1);
  const fresh = f.row(); f.setRows([fresh]); f.notify(); await f.clock.tick();
  expect(f.server.submitRemote).toHaveBeenCalledTimes(1);
  expect(f.platform.complete).toHaveBeenCalledWith(fresh.id, expect.objectContaining({ outcome: 'accepted' }));

  const restarted = f.row(); f.setRows([restarted]); await f.restart();
  expect(f.server.submitRemote).toHaveBeenCalledTimes(2);
  expect(f.platform.complete).toHaveBeenCalledWith(restarted.id, expect.objectContaining({ outcome: 'accepted' }));
});
