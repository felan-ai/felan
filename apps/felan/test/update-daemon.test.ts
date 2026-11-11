import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ControlRequest, ControlResponse, OperationResult } from '@felan-ai/session-protocol';
import * as supervisor from '@felan-ai/daemon/client';
import { identityFor } from '../../daemon/src/daemon/target.js';
import { clientDaemonTarget } from '../src/client-application.js';
import { SessionClient, type SessionClientOptions } from '../src/client/client.js';
import { prepareDaemonForUpdate } from '../src/update-daemon.js';
import { FELAN_VERSION } from '../src/version.js';
import { FakeTransport } from './client-fixtures.js';

const clients: Array<{ client: SessionClient; close: ReturnType<typeof vi.spyOn> }> = [];
beforeEach(() => {
  vi.spyOn(supervisor, 'connectLocalIpc').mockRejectedValue(new Error('Unexpected real IPC connection'));
  vi.spyOn(supervisor, 'spawnDetachedDaemon').mockRejectedValue(new Error('Unexpected daemon launch'));
});
afterEach(() => {
  try {
    expect(supervisor.connectLocalIpc).not.toHaveBeenCalled();
    expect(supervisor.spawnDetachedDaemon).not.toHaveBeenCalled();
    for (const { close } of clients) expect(close).toHaveBeenCalled();
  } finally {
    vi.restoreAllMocks();
    for (const { client } of clients.splice(0)) client.close();
    vi.unstubAllEnvs();
  }
});

function fixture(connectionError?: Error) {
  const fake = new FakeTransport();
  const onStopping = vi.fn();
  const host = {
    state: 'ready' as OperationResult<'host.status'>['state'],
    active: { sessions: 2, work: 0, runs: 0, attachments: 0 },
    onStop: (): Partial<ControlResponse> => { host.state = 'stopped'; return { state: 'draining' }; },
    statusError: undefined as string | undefined,
  };
  const createClient = vi.fn((options: SessionClientOptions) => {
    const client = new SessionClient({ ...options,
      connector: connectionError ? async () => { throw connectionError; } : fake.connector, requestTimeoutMs: 100, retries: 0 });
    clients.push({ client, close: vi.spyOn(client, 'close') });
    const identity = identityFor(client.target, 'update-instance');
    fake.onSend = (envelope, connection) => {
      if ('control' in envelope) {
        const request = envelope as unknown as ControlRequest;
        const response = request.op === 'host.stop' ? host.onStop() : {};
        fake.frame({ control: 1, re: request.id, identity, daemonVersion: 'previous', supportedProtocol: 1,
          state: host.state, outcome: 'accepted', ...response }, connection);
      } else if (envelope.op === 'hello') {
        fake.reply(envelope, { attachmentId: `hello-${connection}`, principal: 'principal', daemonVersion: 'previous', protocol: 1,
          identity, operations: ['host.status'], interactionKinds: [] }, connection);
      } else if (envelope.op === 'host.status') {
        if (host.statusError) fake.frame({ v: 1, re: envelope.id, outcome: 'rejected',
          error: { code: 'unavailable', message: host.statusError, retryable: false } }, connection);
        else fake.reply(envelope, { identity, daemonVersion: 'previous', protocol: 1, state: host.state,
          active: host.active, setupNeeds: [] }, connection);
      } else throw new Error(`Unexpected request: ${envelope.op}`);
    };
    return client;
  });
  return { fake, host, createClient, onStopping, run: () => prepareDaemonForUpdate({ createClient, onStopping }) };
}

it.each(['ENOENT', 'stale_endpoint', 'unavailable'])('reports an absent daemon for %s without launching', async code => {
  const f = fixture(Object.assign(new Error('Missing daemon'), { code }));
  expect(await f.run()).toEqual({ kind: 'absent' });
  expect(f.onStopping).not.toHaveBeenCalled();
  expect(f.createClient.mock.calls[0]![0]).not.toHaveProperty('launch');
});

it('reports other connection errors with restart guidance', async () => {
  const f = fixture(Object.assign(new Error('Connection denied.'), { code: 'EACCES' }));
  expect(await f.run()).toEqual({ kind: 'unavailable', message: 'Connection denied. Run felan daemon restart after updating.' });
  expect(f.onStopping).not.toHaveBeenCalled();
  expect(f.fake.controls).toEqual([]);
});

it('drains an idle old daemon, waits for it to stop, and honors the production agent directory', async () => {
  const f = fixture();
  vi.stubEnv('FELAN_AGENT_DIR', join(tmpdir(), 'update-production-agent'));
  f.onStopping.mockImplementation(() => { expect(f.fake.controls).toEqual([]); });
  const stop = f.host.onStop;
  f.host.onStop = () => { expect(f.onStopping).toHaveBeenCalledExactlyOnceWith(); return stop(); };
  expect(await f.run()).toEqual({ kind: 'stopped', daemonVersion: 'previous' });
  expect(f.onStopping).toHaveBeenCalledExactlyOnceWith();
  expect(f.createClient).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    target: clientDaemonTarget({}), clientVersion: FELAN_VERSION, kind: 'tui', reconnectAttempts: 0,
  }));
  expect(f.createClient.mock.calls[0]![0]).not.toHaveProperty('launch');
  expect(f.fake.controls).toMatchObject([{ op: 'host.stop', params: { mode: 'drain' } }, { op: 'host.status' }]);
  expect(f.fake.controls).toHaveLength(2);
  expect(f.fake.closed).toEqual(new Set(f.fake.receivers.map((_, index) => index)));
});

it.each(['work', 'runs', 'attachments'] as const)('leaves a daemon with active %s running', async field => {
  const f = fixture(); f.host.active[field] = 3;
  expect(await f.run()).toEqual({ kind: 'busy', daemonVersion: 'previous', work: 0, runs: 0, attachments: 0, [field]: 3 });
  expect(f.onStopping).not.toHaveBeenCalled();
  expect(f.fake.controls).toEqual([]);
});

it.each(['starting', 'draining', 'stopped'] as const)('does not stop a daemon in %s state', async state => {
  const f = fixture(); f.host.state = state;
  expect(await f.run()).toEqual({ kind: 'busy', daemonVersion: 'previous', work: 0, runs: 0, attachments: 0 });
  expect(f.onStopping).not.toHaveBeenCalled();
  expect(f.fake.controls).toEqual([]);
});

it.each([
  ['rejected', 'work'], ['rejected', 'runs'], ['rejected', 'attachments'],
  ['abandoned', 'work'], ['abandoned', 'runs'], ['abandoned', 'attachments'],
] as const)('reports current activity when the drain is %s with active %s', async (outcome, field) => {
  const f = fixture();
  f.host.onStop = () => {
    f.host.active[field] = 1;
    return outcome === 'rejected' ? { outcome: 'rejected', error: { code: 'unavailable', message: 'Busy', retryable: false } } : { state: 'draining' };
  };
  expect(await f.run()).toEqual({ kind: 'busy', daemonVersion: 'previous', work: 0, runs: 0, attachments: 0, [field]: 1 });
  expect(f.fake.controls).toMatchObject(outcome === 'rejected'
    ? [{ op: 'host.stop', params: { mode: 'drain' } }]
    : [{ op: 'host.stop', params: { mode: 'drain' } }, { op: 'host.status' }]);
});

it.each(['rejected', 'abandoned'] as const)('reports an unavailable daemon when the drain is %s without activity', async outcome => {
  const f = fixture();
  let statusRequestsBeforeStop = 0;
  f.host.onStop = () => {
    statusRequestsBeforeStop = f.fake.requests.filter(request => request.op === 'host.status').length;
    return outcome === 'rejected'
      ? { outcome: 'rejected', error: { code: 'unavailable', message: 'Stop denied', retryable: false } }
      : { state: 'draining' };
  };
  expect(await f.run()).toEqual({
    kind: 'unavailable',
    message: `${outcome === 'rejected' ? 'The background daemon did not accept a stop request.' : 'The background daemon abandoned the stop request.'} Run felan daemon restart after updating.`,
  });
  expect(f.fake.requests.filter(request => request.op === 'host.status')).toHaveLength(statusRequestsBeforeStop + 1);
  expect(f.onStopping).toHaveBeenCalledExactlyOnceWith();
});

it.each(['incompatible', 'blocked'] as const)('reports a connection that is %s without stopping it', async status => {
  const f = fixture();
  const createClient = (options: SessionClientOptions) => {
    const client = f.createClient(options);
    vi.spyOn(client, 'status', 'get').mockReturnValue(status);
    if (status === 'incompatible') vi.spyOn(client, 'connect').mockRejectedValue(new Error('Incompatible protocol'));
    return client;
  };
  expect(await prepareDaemonForUpdate({ createClient, onStopping: f.onStopping })).toEqual({ kind: 'unavailable', message: expect.stringContaining('felan daemon restart after updating') });
  expect(f.onStopping).not.toHaveBeenCalled();
  expect(f.fake.controls).toEqual([]);
});

it('reports a blocked host without stopping it', async () => {
  const f = fixture(); f.host.state = 'blocked';
  expect(await f.run()).toEqual({ kind: 'unavailable', message: 'Daemon is blocked. Run felan daemon restart after updating.' });
  expect(f.onStopping).not.toHaveBeenCalled();
  expect(f.fake.controls).toEqual([]);
});

it('reports a host that becomes blocked during drain', async () => {
  const f = fixture();
  f.host.onStop = () => ({ state: 'blocked', outcome: 'rejected', error: { code: 'host_blocked', message: 'Cleanup failed', retryable: false } });
  expect(await f.run()).toEqual({ kind: 'unavailable', message: 'Cleanup failed Run felan daemon restart after updating.' });
  expect(f.fake.controls).toHaveLength(1);
});

it('reports a host that becomes blocked while waiting for the drain', async () => {
  const f = fixture();
  f.host.onStop = () => { f.host.state = 'blocked'; return { state: 'draining' }; };
  expect(await f.run()).toEqual({ kind: 'unavailable', message: expect.stringContaining('felan daemon restart after updating') });
  expect(f.fake.controls).toMatchObject([{ op: 'host.stop' }, { op: 'host.status' }]);
  expect(f.fake.controls).toHaveLength(2);
});

it('preserves status errors rather than reporting an absent daemon', async () => {
  const f = fixture(); f.host.statusError = 'Status denied';
  expect(await f.run()).toEqual({ kind: 'unavailable', message: 'Status denied Run felan daemon restart after updating.' });
  expect(f.onStopping).not.toHaveBeenCalled();
  expect(f.fake.controls).toEqual([]);
});

it('uses an explicit target and closes on an aborted stop wait', async () => {
  const f = fixture(); const signal = new AbortController();
  const target = { kind: 'isolated', directory: join(tmpdir(), 'update-target'), namespaceId: 'update-target' } as const;
  f.host.onStop = () => { signal.abort(new Error('Update cancelled')); return { state: 'draining' }; };
  expect(await prepareDaemonForUpdate({ createClient: f.createClient, target, signal: signal.signal })).toEqual({
    kind: 'unavailable', message: 'Update cancelled Run felan daemon restart after updating.',
  });
  expect(f.createClient.mock.calls[0]![0].target).toEqual(target);
});
