import { afterEach, expect, it, vi } from 'vitest';
import { SessionClient } from '../../felan/src/client/client.js';
import { HostSetupManager } from '../src/setup/manager.js';
import { AuthCleanupError, type startAuthWorker } from '../src/setup/auth-driver.js';
import { DaemonConfiguration } from '../src/daemon/configuration.js';
import { SessionServer } from '../src/daemon/server.js';
import { serverFixture, gate } from './fixtures/server.js';
import type { SetupDependency } from '../src/setup/dependencies.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); });

async function fixture(login?: typeof startAuthWorker, dependencies: readonly SetupDependency[] = []) {
  const f = await serverFixture({ now: Date.now });
  const models = f.root.runtime.session.modelRuntime;
  const provider = models.getProviders().find(provider => provider.auth.apiKey?.login);
  if (!provider) throw new Error('Missing deterministic provider metadata.');
  const manager = new HostSetupManager({ agentDir: f.owner.target.agentDir, runtime: f.root.agentRuntime, models,
    dependencies, ...(login ? { login } : {}), assertCurrent: () => f.owner.assertCurrent(), open: vi.fn(async () => {}) });
  const server = new SessionServer({ registry: f.registry, models, setup: manager, version: 'fixture',
    configuration: new DaemonConfiguration({ agentDir: f.owner.target.agentDir, definitions: [], assertCurrent: () => f.owner.assertCurrent() }) });
  const clients: SessionClient[] = [];
  cleanup.push(async () => { clients.forEach(client => client.close()); server.close(); await manager.drain(); await server.settleCommands(); await f.dispose(); });
  await server.start();
  async function client() {
    const client = new SessionClient({ target: { kind: 'isolated', directory: f.directory, namespaceId: f.owner.target.namespaceId, storeRoots: [f.directory] },
      kind: 'tui', clientVersion: 'fixture', retries: 0 }); clients.push(client); await client.connect(); return client;
  }
  return { ...f, manager, client, start: { kind: 'login' as const, provider: provider.id, method: 'api_key' as const, confirmed: true as const } };
}

it('carries secret answers only in ephemeral setup requests and scrubs completed client records', async () => {
  const received: string[] = [];
  const login: typeof startAuthWorker = async (_runtime, _start, options) => {
    const complete = gate();
    options.event({ kind: 'prompt', prompt: { id: 'secret', kind: 'input', message: 'API key', secret: true } });
    const abort = () => complete.resolve(); options.signal.addEventListener('abort', abort, { once: true });
    return { done: complete.promise.finally(() => options.signal.removeEventListener('abort', abort)),
      async answer(_id, text) { received.push(text); complete.resolve(); } };
  };
  const f = await fixture(login); const client = await f.client(); const other = await f.client();
  const start = await client.request('host.setup.start', f.start);
  if (start.outcome !== 'accepted') throw new Error('Setup did not start.');
  const jobId = start.result.id;
  await vi.waitFor(async () => expect(await client.request('host.setup.read', { jobId })).toMatchObject({ result: { state: 'waiting' } }));
  expect(await other.request('host.setup.read', { jobId })).toMatchObject({ outcome: 'rejected', error: { code: 'forbidden' } });
  const secret = 'synthetic-key-must-not-be-retained';
  expect(await client.request('host.setup.answer', { jobId, promptId: 'secret', text: secret })).toMatchObject({ outcome: 'accepted' });
  expect(received).toEqual([secret]);
  await vi.waitFor(async () => expect(await client.request('host.setup.read', { jobId })).toMatchObject({ result: { state: 'completed' } }));
  expect(JSON.stringify(f.store.snapshot())).not.toContain(secret);
  expect(f.store.snapshot().requests.some(request => request.op === 'host.setup.answer')).toBe(false);
  const retained = Reflect.get(client, 'records') as Map<string, unknown>;
  expect(JSON.stringify([...retained.values()])).not.toContain(secret);
});

it('cancels active setup on owner disconnect and does not transfer it to another client', async () => {
  const cancelled = gate();
  const login: typeof startAuthWorker = async (_runtime, _start, options) => {
    options.event({ kind: 'prompt', prompt: { id: 'code', kind: 'input', message: 'Code', secret: true } });
    options.signal.addEventListener('abort', () => cancelled.resolve(), { once: true });
    return { done: cancelled.promise, answer: async () => {} };
  };
  const f = await fixture(login); const client = await f.client();
  const start = await client.request('host.setup.start', f.start);
  if (start.outcome !== 'accepted') throw new Error('Setup did not start.');
  await vi.waitFor(() => expect(f.manager.read(start.result.id, client.capabilities!.attachmentId).state).toBe('waiting'));
  client.close(); await cancelled.promise; await f.manager.drain();
  const other = await f.client();
  expect(await other.request('host.setup.read', { jobId: start.result.id })).toMatchObject({ outcome: 'rejected' });
});

it('never installs on catalog reads or without an explicit selected action', async () => {
  let installed = false; const install = vi.fn(async () => { installed = true; });
  const dependency: SetupDependency = { id: 'fixture', extension: 'browser', revision: 2, label: 'Fixture', description: 'Fixture dependency', skipDisables: true,
    check: async () => ({ available: installed }), install };
  const f = await fixture(undefined, [dependency]);
  expect((await f.manager.catalog()).dependencies).toMatchObject([{ available: false, needsSetup: true }]); expect(install).not.toHaveBeenCalled();
  expect(() => f.manager.start({ kind: 'dependencies', choices: [{ id: 'fixture', action: 'install' }], confirmed: false } as never, 'owner')).toThrow();
  const skipped = f.manager.start({ kind: 'dependencies', choices: [{ id: 'fixture', action: 'skip' }], confirmed: true }, 'owner');
  await vi.waitFor(() => expect(f.manager.read(skipped.id, 'owner').state).toBe('completed'));
  expect(install).not.toHaveBeenCalled();
  const selected = f.manager.start({ kind: 'dependencies', choices: [{ id: 'fixture', action: 'install' }], confirmed: true }, 'owner');
  await vi.waitFor(() => expect(f.manager.read(selected.id, 'owner').state).toBe('completed'));
  expect(install).toHaveBeenCalledOnce();
  expect((await f.manager.catalog()).dependencies).toMatchObject([{ available: true, enabled: true, needsSetup: false }]);
  const unchanged = f.manager.start({ kind: 'dependencies', choices: [{ id: 'fixture', action: 'skip' }], confirmed: true }, 'owner');
  await vi.waitFor(() => expect(f.manager.read(unchanged.id, 'owner').state).toBe('completed'));
  expect((await f.manager.catalog()).dependencies).toMatchObject([{ available: true, enabled: true }]);
  expect(install).toHaveBeenCalledOnce();
});

it('blocks further work and shutdown completion when an auth child cannot be cleaned up', async () => {
  const f = await serverFixture({ now: Date.now }); cleanup.push(() => f.dispose());
  const models = f.root.runtime.session.modelRuntime;
  const provider = models.getProviders().find(provider => provider.auth.apiKey?.login)!;
  const manager = new HostSetupManager({ agentDir: f.owner.target.agentDir, runtime: f.root.agentRuntime, models,
    assertCurrent: () => f.owner.assertCurrent(), dependencies: [], open: async () => {},
    login: async () => ({ done: Promise.reject(new AuthCleanupError('Failed to stop owned test process')), answer: async () => {} }) });
  const request = { kind: 'login' as const, provider: provider.id, method: 'api_key' as const, confirmed: true as const };
  const job = manager.start(request, 'owner');
  await vi.waitFor(() => expect(manager.read(job.id, 'owner').state).toBe('failed'));
  await expect(manager.drain()).rejects.toBeInstanceOf(AuthCleanupError);
  expect(() => manager.start(request, 'owner')).toThrow();
});

it('reports authentication requirements before creating a session or starting a run', async () => {
  const f = await fixture(); const client = await f.client();
  vi.spyOn(f.root.runtime.session.modelRuntime, 'getAvailable').mockResolvedValue([]);
  const before = f.registry.list().length;
  expect(await client.request('sessions.create', { cwd: f.cwd, source: 'tui' })).toMatchObject({ outcome: 'rejected', error: { code: 'authentication_required' } });
  expect(f.registry.list()).toHaveLength(before);
  await client.attach(f.root.sessionId);
  expect(await client.request('prompt', { text: 'do not dispatch' }, { session: f.root.sessionId }))
    .toMatchObject({ outcome: 'rejected', error: { code: 'authentication_required' } });
  expect(f.store.session(f.root.sessionId).run.state).toBe('idle');
});
