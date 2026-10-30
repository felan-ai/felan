import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ControlRequest, ControlResponse, HostBlocked } from '@felan-ai/session-protocol';
import * as supervisor from '@felan-ai/daemon/client';
import { identityFor } from '../../daemon/src/daemon/target.js';
import { clientDaemonTarget } from '../src/client-application.js';
import { SessionClient, type SessionClientOptions } from '../src/client/client.js';
import { waitForDaemonStop } from '../src/client/daemon-stop.js';
import { runDaemonCommand } from '../src/daemon-command.js';
import { FakeTransport } from './client-fixtures.js';

const roots: string[] = [];
const clients: SessionClient[] = [];
beforeEach(() => {
  vi.spyOn(supervisor, 'connectLocalIpc').mockRejectedValue(new Error('Unexpected real IPC connection'));
  vi.spyOn(supervisor, 'spawnDetachedDaemon').mockRejectedValue(new Error('Unexpected daemon launch'));
});
afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  try {
    expect(supervisor.connectLocalIpc).not.toHaveBeenCalled();
    expect(supervisor.spawnDetachedDaemon).not.toHaveBeenCalled();
  } finally {
    vi.restoreAllMocks();
    await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })));
  }
});

const blocked: HostBlocked = {
  recoverable: true, since: 1_700_000_000_000, message: 'Provider cleanup timed out',
  step: 'dispose_session', session: 'session-12345678', pid: 4321,
};
const detail = 'Daemon shutdown failed at dispose_session (session session-): Provider cleanup timed out.';
const kill = (pid: number) => process.platform === 'win32' ? `taskkill /F /PID ${pid}` : `kill -9 ${pid}`;
const manual = `Cleanup cannot be retried safely; force-terminate the daemon process (pid 4321) with \`${kill(4321)}\`, then start Felan again.`;

async function fixture(initial: { state?: ControlResponse['state']; blocked?: HostBlocked; incompatible?: boolean; buildMismatch?: 'version' | 'composition'; directoryName?: string } = { blocked }) {
  const root = await mkdtemp(join(tmpdir(), 'daemon-blocked-')); roots.push(root);
  const directory = initial.directoryName ? join(root, initial.directoryName) : root;
  const f = {
    state: initial.state ?? 'blocked', blocked: initial.blocked,
    fakes: [] as FakeTransport[],
    onControl: (_request: ControlRequest): Partial<ControlResponse> => ({}),
    logs: [] as Array<{ timestamp: number; level: 'info' | 'warning' | 'error'; message: string }>,
  };
  const createClient = vi.fn((options: SessionClientOptions) => {
    const fake = new FakeTransport(); f.fakes.push(fake);
    const composition = { managerPackage: '@fixture/manager', managerVersion: 'fixture', providerDigest: 'a'.repeat(64), configDigest: 'b'.repeat(64) };
    const client = new SessionClient({ ...options, connector: fake.connector, requestTimeoutMs: 200,
      ...(initial.incompatible || initial.buildMismatch === 'composition' ? { expectedComposition: { ...composition,
        providerDigest: 'd'.repeat(64) } } : {}) }); clients.push(client);
    const identity = identityFor(client.target, `instance-${f.fakes.length}`);
    const daemonVersion = initial.incompatible || initial.buildMismatch === 'version' ? 'previous' : options.expectedDaemonVersion ?? 'fixture';
    fake.onSend = (envelope, connection) => {
      if ('control' in envelope) {
        const request = envelope as unknown as ControlRequest;
        const response = f.onControl(request);
        fake.frame({ control: 1, re: request.id, identity, daemonVersion, supportedProtocol: 1,
          state: f.state, ...(f.blocked ? { blocked: f.blocked } : {}), outcome: 'accepted', ...response }, connection);
      } else if (envelope.op === 'hello') {
        fake.reply(envelope, { attachmentId: `hello-${connection}`, principal: 'principal', daemonVersion, protocol: 1,
          identity, composition, operations: ['host.status', 'host.logs'], interactionKinds: [] }, connection);
      } else if (envelope.op === 'host.status') {
        fake.reply(envelope, { identity, daemonVersion, protocol: 1, state: f.state,
          ...(f.blocked ? { blocked: f.blocked } : {}), active: { sessions: 1, runs: 0, work: 1, attachments: 1 }, setupNeeds: [] }, connection);
      } else if (envelope.op === 'host.logs') fake.reply(envelope, { entries: f.logs }, connection);
      else throw new Error(`Unexpected request: ${envelope.op}`);
    };
    return client;
  });
  const io = { writeOutput: vi.fn<(line: string) => void>(), writeError: vi.fn<(line: string) => void>() };
  return Object.assign(f, {
    createClient, io, directory, root,
    controls: () => f.fakes.flatMap(fake => fake.controls) as ControlRequest[],
    run: (args: string[]) => runDaemonCommand([...args, '--daemon-runtime', directory], io, { createClient }),
    connect: async () => {
      const client = createClient({ target: clientDaemonTarget({ daemonRuntime: directory }), clientVersion: 'fixture', kind: 'tui', reconnectAttempts: 0 });
      await client.connect(); return client;
    },
  });
}

describe('blocked daemon CLI', () => {
  it('shows the cause, session, step and forced restart recovery in status', async () => {
    const f = await fixture();
    expect(await f.run(['status'])).toBe(0);
    expect(f.io.writeOutput.mock.calls).toEqual([
      [expect.stringContaining(': blocked\nSessions: 1; runs: 0; active tasks: 1; attachments: 1')],
      [`${detail} Use felan daemon restart --force --daemon-runtime ${f.directory} to retry cleanup.`],
    ]);
    expect(f.io.writeError).not.toHaveBeenCalled();
    expect(f.controls()).toEqual([]);
  });

  it('shows the manual recovery and pid for an unrecoverable status', async () => {
    const f = await fixture({ blocked: { ...blocked, recoverable: false } });
    expect(await f.run(['status'])).toBe(0);
    expect(f.io.writeOutput).toHaveBeenLastCalledWith(`${detail} ${manual}`);
    expect(f.io.writeOutput.mock.calls.flat().join('\n')).not.toContain('--force');
  });

  it('still explains a blocked daemon with different build and provider configuration', async () => {
    const f = await fixture({ blocked, incompatible: true });
    expect(await f.run(['status'])).toBe(0);
    expect(f.io.writeOutput).toHaveBeenCalledWith(expect.stringContaining('Daemon previous: blocked\n'));
    expect(f.io.writeOutput).toHaveBeenLastCalledWith(`${detail} Use felan daemon restart --force --daemon-runtime ${f.directory} to retry cleanup.`);
    expect(f.controls()).toEqual([]);
  });

  it.each(['version', 'composition'] as const)('prints a %s build warning while retaining normal daemon status and blocked recovery', async buildMismatch => {
    const f = await fixture({ blocked, buildMismatch });
    expect(await f.run(['status'])).toBe(0);
    expect(f.io.writeOutput.mock.calls[0]?.[0]).toContain(': blocked\nSessions: 1');
    const warning = f.io.writeOutput.mock.calls[1]?.[0];
    expect(warning).toContain(buildMismatch === 'version' ? 'Daemon previous is running; this installation expects' : 'different package/provider build');
    expect(warning).toContain(`Run felan daemon restart --daemon-runtime ${f.directory} to apply the new build.`);
    expect(f.io.writeOutput).toHaveBeenLastCalledWith(`${detail} Use felan daemon restart --force --daemon-runtime ${f.directory} to retry cleanup.`);
    expect(f.controls()).toEqual([]); expect(f.io.writeError).not.toHaveBeenCalled();
  });

  it('shell-quotes both target selection flags in build-mismatch recovery', async () => {
    const f = await fixture({ state: 'ready', buildMismatch: 'version', directoryName: "project's runtime" });
    const config = join(f.root, "host's config.json");
    expect(await f.run(['status', '--host-config', config])).toBe(0);
    expect(f.io.writeOutput.mock.calls[1]?.[0]).toContain(
      `Run felan daemon restart --daemon-runtime '${f.root}/project'\\''s runtime' --host-config '${f.root}/host'\\''s config.json' to apply the new build.`);
    expect(f.controls()).toEqual([]);
  });

  it.each(['stop', 'restart'] as const)('%s without force refuses a recoverable block before sending drain', async action => {
    const f = await fixture();
    expect(await f.run([action])).toBe(1);
    expect(f.io.writeError).toHaveBeenCalledExactlyOnceWith(`${detail} Use felan daemon ${action} --force --daemon-runtime ${f.directory} to retry cleanup.`);
    expect(f.controls().map(request => request.op)).toEqual(['host.status']);
    expect(f.createClient).toHaveBeenCalledTimes(1);
  });

  it.each(['stop', 'restart'] as const)('%s without force refuses an unrecoverable block before sending drain', async action => {
    const f = await fixture({ blocked: { ...blocked, recoverable: false } });
    expect(await f.run([action])).toBe(1);
    expect(f.io.writeError).toHaveBeenCalledExactlyOnceWith(`${detail} ${manual}`);
    expect(f.controls().map(request => request.op)).toEqual(['host.status']);
    expect(f.createClient).toHaveBeenCalledTimes(1);
  });

  it('prints the daemon message unchanged when a host_blocked rejection carries no detail', async () => {
    const f = await fixture({ state: 'ready' });
    f.onControl = request => request.op === 'host.status' ? {} : {
      outcome: 'rejected', error: { code: 'host_blocked', message: 'Cleanup cannot be retried safely; terminate the daemon process 4321.', retryable: false },
    };
    expect(await f.run(['restart'])).toBe(1);
    expect(f.io.writeError).toHaveBeenCalledExactlyOnceWith('Cleanup cannot be retried safely; terminate the daemon process 4321.');
  });

  it.each(['stop', 'restart'] as const)('%s with force retries cleanup and reports success', async action => {
    const f = await fixture();
    f.onControl = request => {
      if (request.op !== 'host.status') { f.state = 'stopped'; f.blocked = undefined; return { state: 'draining' }; }
      return {};
    };
    expect(await f.run([action, '--force'])).toBe(0);
    expect(f.controls()).toMatchObject([
      { op: 'host.status' }, { op: `host.${action}`, params: { mode: 'force' } }, { op: 'host.status' },
    ]);
    expect(f.controls()).toHaveLength(3);
    expect(f.io.writeError).not.toHaveBeenCalled();
    expect(f.io.writeOutput).toHaveBeenCalledExactlyOnceWith(action === 'stop' ? 'Daemon stopped.' : 'Daemon restarted (instance-2).');
    expect(f.createClient).toHaveBeenCalledTimes(action === 'stop' ? 1 : 2);
    if (action === 'restart') expect(f.createClient.mock.calls[1]?.[0].launch?.replacing?.instanceId).toBe('instance-1');
  });

  it.each(['stop', 'restart'] as const)('%s reports a host_blocked race after a ready preflight', async action => {
    const f = await fixture({ state: 'ready' });
    f.onControl = request => request.op === 'host.status' ? {} : {
      outcome: 'rejected', state: 'blocked', blocked,
      error: { code: 'host_blocked', message: 'Cleanup became blocked during drain.', retryable: false },
    };
    expect(await f.run([action])).toBe(1);
    expect(f.io.writeError).toHaveBeenCalledExactlyOnceWith(`${detail} Use felan daemon ${action} --force --daemon-runtime ${f.directory} to retry cleanup.`);
    expect(f.controls()).toMatchObject([{ op: 'host.status' }, { op: `host.${action}`, params: { mode: 'drain' } }]);
    expect(f.controls()).toHaveLength(2);
    expect(f.createClient).toHaveBeenCalledTimes(1);
  });

  it.each(['stop', 'restart'] as const)('%s force rejection reports the blocked detail and unrecoverable pid once', async action => {
    const unrecoverable = { ...blocked, recoverable: false };
    const f = await fixture({ blocked: unrecoverable });
    f.onControl = request => request.op === 'host.status' ? {} : {
      outcome: 'rejected', blocked: unrecoverable,
      error: { code: 'host_blocked', message: 'Ownership was lost; cleanup cannot continue.', retryable: false },
    };
    expect(await f.run([action, '--force'])).toBe(1);
    expect(f.io.writeError).toHaveBeenCalledExactlyOnceWith(`${detail} ${manual}`);
    expect(f.controls()).toMatchObject([{ op: 'host.status' }, { op: `host.${action}`, params: { mode: 'force' } }]);
    expect(f.controls()).toHaveLength(2);
    expect(f.createClient).toHaveBeenCalledTimes(1);
  });

  it.each(['status', 'stop', 'restart'] as const)('%s shell-quotes the isolated recovery target with spaces and an apostrophe', async action => {
    const f = await fixture({ blocked, directoryName: "project's runtime" });
    expect(await f.run([action])).toBe(action === 'status' ? 0 : 1);
    const command = action === 'status' ? 'restart' : action;
    const message = `${detail} Use felan daemon ${command} --force --daemon-runtime '${f.root}/project'\\''s runtime' to retry cleanup.`;
    if (action === 'status') expect(f.io.writeOutput).toHaveBeenLastCalledWith(message);
    else expect(f.io.writeError).toHaveBeenCalledExactlyOnceWith(message);
    expect(f.createClient.mock.calls[0]?.[0].target).toMatchObject({ kind: 'isolated', directory: f.directory });
    expect(f.controls().every(request => request.op === 'host.status')).toBe(true);
  });

  it.each(['stop', 'restart'] as const)('%s retains the isolated recovery target when forced cleanup blocks again', async action => {
    const f = await fixture();
    f.onControl = request => request.op === 'host.status' ? {} : { state: 'draining' };
    expect(await f.run([action, '--force'])).toBe(1);
    expect(f.io.writeError).toHaveBeenCalledExactlyOnceWith(`${detail} Use felan daemon ${action} --force --daemon-runtime ${f.directory} to retry cleanup.`);
    expect(f.createClient).toHaveBeenCalledTimes(1);
  });

  it('uses the preflight detail when a rejected force response omits it', async () => {
    const f = await fixture({ blocked: { ...blocked, recoverable: false } });
    f.onControl = request => {
      if (request.op === 'host.status') return {};
      f.blocked = undefined;
      return { outcome: 'rejected', error: { code: 'host_blocked', message: 'Still blocked.', retryable: false } };
    };
    expect(await f.run(['stop', '--force'])).toBe(1);
    expect(f.io.writeError).toHaveBeenCalledExactlyOnceWith(`${detail} ${manual}`);
  });

  it.each(['stop', 'restart'] as const)('%s force reports the new failure rather than the old preflight detail', async action => {
    const f = await fixture();
    f.onControl = request => {
      if (request.op !== 'host.status') {
        f.blocked = { recoverable: false, since: blocked.since + 1, message: 'Runtime ownership changed!', step: 'release_runtime', pid: 9876 };
        return { state: 'draining' };
      }
      return {};
    };
    expect(await f.run([action, '--force'])).toBe(1);
    expect(f.io.writeError).toHaveBeenCalledExactlyOnceWith('Daemon shutdown failed at release_runtime: Runtime ownership changed! Cleanup cannot be retried safely; force-terminate the daemon process (pid 9876) with `' + kill(9876) + '`, then start Felan again.');
    expect(f.io.writeError.mock.calls.flat().join('\n')).not.toContain(blocked.message);
    expect(f.createClient).toHaveBeenCalledTimes(1);
    expect(f.io.writeOutput).not.toHaveBeenCalled();
  });

  it('keeps the detailed log entry intact rather than replacing it with a summary', async () => {
    const f = await fixture();
    const message = `Shutdown failed at dispose_session for session-12345678: ${'nested provider cleanup detail; '.repeat(80)}Caused by: worker did not settle`;
    f.logs = [{ timestamp: blocked.since, level: 'error', message }];
    expect(await f.run(['logs'])).toBe(0);
    expect(f.io.writeOutput).toHaveBeenCalledExactlyOnceWith(`2023-11-14T22:13:20.000Z error: ${message}`);
    expect(f.io.writeError).not.toHaveBeenCalled();
    expect(f.controls()).toEqual([]);
  });
});

describe('waitForDaemonStop blocked recovery', () => {
  it.each([
    { client: 'cli', action: 'stop', command: 'felan daemon stop --force' },
    { client: 'cli', action: 'restart', command: 'felan daemon restart --force' },
    { client: 'tui', action: 'stop', command: '/daemon stop force' },
    { client: 'tui', action: 'restart', command: '/daemon restart force' },
  ] as const)('uses the $client $action recovery command', async ({ client, action, command }) => {
    const f = await fixture();
    await expect(waitForDaemonStop(await f.connect(), undefined, { client, action })).rejects.toThrow(`${detail} Use ${command} to retry cleanup.`);
    expect(f.controls().map(request => request.op)).toEqual(['host.status']);
  });

  it('defaults to CLI restart recovery', async () => {
    const f = await fixture();
    await expect(waitForDaemonStop(await f.connect())).rejects.toThrow(`${detail} Use felan daemon restart --force to retry cleanup.`);
  });

  it('shell-quotes an explicitly supplied isolated CLI recovery target', async () => {
    const f = await fixture({ blocked, directoryName: "project's runtime" });
    await expect(waitForDaemonStop(await f.connect(), undefined, { client: 'cli', daemonRuntime: f.directory })).rejects.toThrow(
      `${detail} Use felan daemon restart --force --daemon-runtime '${f.root}/project'\\''s runtime' to retry cleanup.`,
    );
  });

  it.each(['cli', 'tui'] as const)('handles missing blocked details for %s', async client => {
    const f = await fixture({});
    const command = client === 'cli' ? 'felan daemon restart --force' : '/daemon restart force';
    await expect(waitForDaemonStop(await f.connect(), undefined, { client })).rejects.toThrow(`Daemon is blocked after an incomplete shutdown. Use ${command} to retry cleanup.`);
  });

  it.each(['cli', 'tui'] as const)('gives manual recovery for an unrecoverable block in %s', async client => {
    const f = await fixture({ blocked: { ...blocked, recoverable: false } });
    await expect(waitForDaemonStop(await f.connect(), undefined, { client })).rejects.toThrow(`${detail} ${manual}`);
  });

  it('omits unavailable pid, step and session without inventing values', async () => {
    const f = await fixture({ blocked: { recoverable: false, since: blocked.since, message: 'Ownership lost.' } });
    await expect(waitForDaemonStop(await f.connect(), undefined, { client: 'tui' })).rejects.toThrow('Daemon shutdown failed: Ownership lost. Cleanup cannot be retried safely; force-terminate the daemon process, then start Felan again.');
  });
});
