import { afterEach, expect, it, vi } from 'vitest';
import { SessionClient } from '../../felan/src/client/client.js';
import { TestHostConfiguration as DaemonConfiguration } from './fixtures/host-services.js';
import { HostLifecycle } from '../src/daemon/lifecycle.js';
import { SessionServer, type SessionServerOptions } from '../src/daemon/server.js';
import { gate, serverFixture } from './fixtures/server.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); });

async function fixture(held = false, composition?: SessionServerOptions['composition']) {
  const f = await serverFixture({ now: Date.now }); const settled = gate(); const complete = vi.fn(async () => {});
  const lifecycle = new HostLifecycle({ target: f.owner.target, identity: f.owner.identity,
    beginDrain: () => f.registry.beginDrain(), endDrain: () => f.registry.endDrain(), settle: async () => { if (held) await settled.promise; }, complete });
  const server = new SessionServer({ registry: f.registry, models: f.root.runtime.session.modelRuntime, version: 'fixture',
    ...(composition ? { composition } : {}),
    configuration: new DaemonConfiguration({ definitions: [], assertCurrent: () => f.owner.assertCurrent() }),
    management: { lifecycle, logs: () => ({ entries: [{ timestamp: 1, level: 'info', message: 'Daemon ready.' }] }) } });
  const clients: SessionClient[] = [];
  cleanup.push(async () => { settled.resolve(); for (const client of clients) client.close(); server.close(); await f.dispose(); });
  await server.start();
  async function client(kind: 'tui' | 'acp' | 'headless' = 'tui') {
    const client = new SessionClient({ target: { kind: 'isolated', directory: f.directory, namespaceId: f.owner.target.namespaceId, storeRoots: [f.directory] },
      clientVersion: 'fixture', kind, expected: f.owner.identity });
    clients.push(client); await client.connect(); return client;
  }
  return { ...f, client, lifecycle, complete, settled, server };
}

it('advertises management operations to every verified local client and exposes bounded log data', async () => {
  const f = await fixture();
  for (const kind of ['tui', 'acp', 'headless'] as const) {
    const client = await f.client(kind);
    expect(client.capabilities?.operations).toEqual(expect.arrayContaining(['host.stop', 'host.restart', 'host.logs']));
    expect(await client.request('host.logs', { limit: 5 })).toMatchObject({ outcome: 'accepted', result: { entries: [{ message: 'Daemon ready.' }] } });
  }
});

it('uses the identity-verified control connection for consented restart', async () => {
  const f = await fixture(true); const client = await f.client();
  await expect(client.control('host.restart')).rejects.toThrow(); expect(f.lifecycle.state).toBe('ready');
  const result = await client.control('host.restart', 'drain');
  expect(result).toMatchObject({ outcome: 'accepted', state: 'draining', identity: f.owner.identity });
  expect(await client.control('host.status')).toMatchObject({ outcome: 'accepted', state: 'draining' });
  expect(f.complete).not.toHaveBeenCalled(); f.settled.resolve();
  await vi.waitFor(() => expect(f.complete).toHaveBeenCalledWith('restart'));
});

it('rejects new session work during drain while keeping status available', async () => {
  const f = await fixture(true); const client = await f.client(); await client.attach(f.root.sessionId);
  expect(await client.request('host.stop', { expected: f.owner.identity, mode: 'drain' })).toMatchObject({ outcome: 'accepted', result: { state: 'draining' } });
  expect(await client.request('prompt', { text: 'must not run' }, { session: f.root.sessionId })).toMatchObject({ outcome: 'rejected', error: { code: 'busy' } });
  expect(await client.request('host.status', {})).toMatchObject({ outcome: 'accepted', result: { state: 'draining' } });
  expect(f.root.runtime.session.messages).toHaveLength(0);
  await expect(client.attach(f.root.sessionId)).rejects.toThrow();
});

it('attaches to a compatible mismatched build without restarting when the client cannot relaunch it', async () => {
  const f = await fixture(true);
  const client = new SessionClient({ target: { kind: 'isolated', directory: f.directory, namespaceId: f.owner.target.namespaceId, storeRoots: [f.directory] },
    clientVersion: 'fixture', expectedDaemonVersion: 'different-version', kind: 'tui' });
  cleanup.push(async () => client.close());
  await client.connect();
  expect(client.status).toBe('ready'); expect(client.identity).toEqual(f.owner.identity); expect(client.incompatibleActiveWork).toBeUndefined();
  expect(client.buildMismatch).toEqual({ daemonVersion: 'fixture', expectedDaemonVersion: 'different-version', activeWork: 0 });
  expect((await client.attach(f.root.sessionId)).outcome).toBe('accepted');
  expect(await client.request('host.status', {})).toMatchObject({ outcome: 'accepted', result: { state: 'ready' } });
  expect(await client.control('host.status')).toMatchObject({ outcome: 'accepted', state: 'ready', identity: f.owner.identity });
  expect(f.lifecycle.state).toBe('ready'); expect(f.complete).not.toHaveBeenCalled();
});

it('attaches across provider differences while preserving explicit lifecycle controls', async () => {
  const composition = { managerPackage: '@test/manager', managerVersion: 'fixture', providerDigest: 'a'.repeat(64),
    configDigest: 'b'.repeat(64) };
  const f = await fixture(true, composition);
  const client = new SessionClient({ target: { kind: 'isolated', directory: f.directory, namespaceId: f.owner.target.namespaceId, storeRoots: [f.directory] },
    clientVersion: 'fixture', expectedDaemonVersion: 'fixture', expectedComposition: { ...composition, providerDigest: 'd'.repeat(64) }, kind: 'tui' });
  cleanup.push(async () => client.close());
  await client.connect();
  expect(client.status).toBe('ready'); expect(client.identity).toEqual(f.owner.identity);
  expect(client.buildMismatch).toBeDefined();
  expect((await client.attach(f.root.sessionId)).outcome).toBe('accepted');
  expect(f.lifecycle.state).toBe('ready');
  expect(await client.control('host.status')).toMatchObject({ outcome: 'accepted', state: 'ready', identity: f.owner.identity });
  await expect(client.control('host.restart')).rejects.toThrow(); expect(f.lifecycle.state).toBe('ready');
  expect(f.complete).not.toHaveBeenCalled();
  expect(await client.control('host.restart', 'drain')).toMatchObject({ outcome: 'accepted', state: 'draining', identity: f.owner.identity });
  expect(f.complete).not.toHaveBeenCalled(); f.settled.resolve();
  await vi.waitFor(() => expect(f.complete).toHaveBeenCalledWith('restart'));
});

it('reports an unrecoverable block and rejects force and new work with process recovery guidance', async () => {
  const f = await fixture(); const client = await f.client(); await client.attach(f.root.sessionId);
  f.lifecycle.block(new Error('fixture ownership lost'), 'ownership-lost');
  const blocked = f.lifecycle.blocked!;
  expect(blocked).toMatchObject({ recoverable: false, step: 'ownership-lost', pid: process.pid });
  expect(await client.control('host.status')).toMatchObject({ outcome: 'accepted', state: 'blocked', blocked });
  expect(await client.request('host.status', {})).toMatchObject({ outcome: 'accepted', result: { state: 'blocked', blocked } });
  for (const op of ['host.stop', 'host.restart'] as const) {
    expect(await client.control(op, 'force')).toMatchObject({ outcome: 'rejected', state: 'blocked', blocked,
      error: { code: 'host_blocked', message: expect.stringContaining(`force-terminate the daemon process ${process.pid} (${process.platform === 'win32' ? 'taskkill /F /PID' : 'kill -9'} ${process.pid})`) } });
  }
  expect(await client.request('sessions.create', { cwd: f.cwd })).toMatchObject({ outcome: 'rejected', error: {
    code: 'host_blocked', message: expect.stringContaining(`terminate the daemon process ${process.pid}`),
  } });
  expect(await client.request('prompt', { text: 'refused' }, { session: f.root.sessionId })).toMatchObject({ outcome: 'rejected', error: { code: 'host_blocked' } });
  expect(f.complete).not.toHaveBeenCalled(); expect(f.lifecycle.blocked).toEqual(blocked);
});

it('keeps control diagnostics and force rejection available after release has sealed commands', async () => {
  const f = await fixture(); const client = await f.client();
  f.complete.mockImplementation(async () => { f.server.sealCommands(); throw new Error('release failed'); });
  expect(await client.control('host.stop', 'force')).toMatchObject({ outcome: 'accepted' });
  await vi.waitFor(() => expect(f.lifecycle.state).toBe('blocked'));
  expect(await client.control('host.status')).toMatchObject({ state: 'blocked', blocked: { recoverable: false, step: 'release' } });
  expect(await client.request('host.status', {})).toMatchObject({ outcome: 'accepted', result: { state: 'blocked' } });
  expect(await client.control('host.restart', 'force')).toMatchObject({ outcome: 'rejected', blocked: { recoverable: false }, error: { code: 'host_blocked' } });
  expect(f.complete).toHaveBeenCalledOnce();
});
