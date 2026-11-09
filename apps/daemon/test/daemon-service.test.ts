import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { HOST_MAINTENANCE_SERVICE, HostAgentRuntime, InMemoryCredentialStore, ModelRuntime, SessionManager, SettingsManager, createAssistantMessageEventStream,
  defineServiceContract, type HostMaintenance, type HostWorkerOptions, type SessionsHistory } from '@felan-ai/agent-core';
import { SessionClient } from '../../felan/src/client/client.js';
import { settleDaemonWork, startDaemonService } from '../src/daemon/service.js';
import { acquireDaemonOwnership } from '../src/daemon/ownership.js';
import { LegacySessionIndex } from '../src/daemon/legacy-sessions.js';
import { resolveDaemonTarget } from '../src/daemon/target.js';
import { assistant, offlineModel } from './fixtures/registry.js';
import { DaemonControlStore } from '../src/daemon/control-store.js';
import { TestHostConfiguration as DaemonConfiguration } from './fixtures/host-services.js';
import * as providerLoader from '../src/daemon/provider-loader.js';
import { defineServiceProvider } from '../src/daemon/provider.js';
import { createRuntimeStorageRequest } from '../src/runtime-factory.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const testManager = { packageName: '@felan-ai/test-manager', version: '0.0.0',
  resolveFrom: import.meta.url,
  resolveProvider: (specifier: string) => {
    if (specifier === '@felan-ai/test-manager/provider') return new URL('./fixtures/service-provider.ts', import.meta.url).href;
    throw new Error(`Unexpected fixture provider: ${specifier}`);
  } };

async function target(initialize = true) {
  const root = await mkdtemp(join(process.cwd(), '.s14-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'isolated');
  await mkdir(directory, { mode: 0o700 });
  const input = { kind: 'isolated' as const, directory, namespaceId: randomUUID() };
  const hostConfigPath = join(resolveDaemonTarget(input).agentDir, 'host.json');
  if (initialize) {
    const owner = await acquireDaemonOwnership(input);
    try {
      await writeFile(hostConfigPath, JSON.stringify({ version: 1, services: [
        { id: 'felan.runtime', major: 1, use: '@felan-ai/test-manager/provider' },
        { id: 'felan.session-runtime', major: 1, use: '@felan-ai/test-manager/provider' },
      ], extensions: [] }), { mode: 0o600 });
    } finally { await owner.release(); }
  }
  return { target: input, hostConfigPath };
}

async function models() {
  const runtime = await ModelRuntime.create({ modelsPath: null, credentials: new InMemoryCredentialStore(), refreshOnCreate: false });
  runtime.registerProvider('offline', { api: 'openai-completions', baseUrl: offlineModel.baseUrl, apiKey: 'fixture', models: [offlineModel], streamSimple: () => {
    const stream = createAssistantMessageEventStream(); queueMicrotask(() => stream.push({ type: 'done', reason: 'stop', message: assistant() })); return stream;
  } });
  return runtime;
}

it('assembles owned service state and executes a real offline session before explicit shutdown', async () => {
  const { target: input, hostConfigPath } = await target();
  const createModels = vi.fn(models);
  const service = await startDaemonService(input, { manager: testManager, hostConfigPath, createModelRuntime: createModels });
  cleanups.push(async () => { if (service.lifecycle.state !== 'stopped') { await service.requestStop('stop', 'force'); await service.stopped; } });
  expect(createModels).toHaveBeenCalledOnce();
  const client = new SessionClient({ target: input, clientVersion: 'fixture', kind: 'tui', expected: service.owner.identity });
  cleanups.push(async () => client.close()); await client.connect();
  expect(await client.request('host.status', {})).toMatchObject({ outcome: 'accepted', result: { state: 'ready', setupNeeds: [], composition: { managerPackage: testManager.packageName } } });
  const created = await client.request('sessions.create', { cwd: input.directory, model: { provider: 'offline', id: 'fixture' } });
  expect(created.outcome).toBe('accepted'); if (created.outcome !== 'accepted') return;
  expect((await stat(join(service.owner.target.agentDir, 'storage'))).mode & 0o777).toBe(0o700);
  await client.attach(created.result.sessionId);
  expect(await client.request('prompt', { text: 'offline request' }, { session: created.result.sessionId })).toMatchObject({ outcome: 'accepted' });
  await vi.waitFor(() => expect(client.getAttachment(created.result.sessionId)?.state.snapshot?.history.entries.some(row => row.role === 'assistant')).toBe(true));
  await vi.waitFor(() => expect(client.getAttachment(created.result.sessionId)?.state.snapshot?.run.state).toBe('idle'));
  expect((await client.request('host.logs', {})).outcome).toBe('accepted');
  expect(await client.control('host.stop', 'drain')).toMatchObject({ outcome: 'accepted' });
  expect(await service.stopped).toBe('stop');
  const next = await acquireDaemonOwnership(input); await next.release();
});

it('reports the provider setup need unless the host lists models or a model dependency is ready', async () => {
  const { target: input, hostConfigPath } = await target();
  const empty = async () => {
    const runtime = await ModelRuntime.create({ modelsPath: null, credentials: new InMemoryCredentialStore(), refreshOnCreate: false });
    vi.spyOn(runtime, 'getAvailableSnapshot').mockReturnValue([]);
    return runtime;
  };
  const service = await startDaemonService(input, { manager: testManager, hostConfigPath, createModelRuntime: empty });
  cleanups.push(async () => { if (service.lifecycle.state !== 'stopped') { await service.requestStop('stop', 'force'); await service.stopped; } });
  const client = new SessionClient({ target: input, clientVersion: 'fixture', kind: 'tui' }); cleanups.push(async () => client.close()); await client.connect();
  const provider = [{ code: 'provider', message: expect.stringContaining('model provider') }];
  expect(await client.request('host.status', {})).toMatchObject({ outcome: 'accepted', result: { setupNeeds: provider } });
  const setup = (Reflect.get(service.server, 'options') as { setup: { modelProviderReady?(): Promise<boolean> } }).setup;
  setup.modelProviderReady = async () => true;
  expect(await client.request('host.status', {})).toMatchObject({ outcome: 'accepted', result: { setupNeeds: [] } });
  expect(await client.request('sessions.create', { cwd: input.directory })).toMatchObject({ outcome: 'accepted' });
  setup.modelProviderReady = async () => { throw new Error('Detection failed.'); };
  expect(await client.request('host.status', {})).toMatchObject({ outcome: 'accepted', result: { setupNeeds: provider } });
  expect(await client.request('sessions.create', { cwd: input.directory })).toMatchObject({ outcome: 'rejected', error: { code: 'authentication_required' } });
  delete setup.modelProviderReady;
  expect(await client.request('sessions.create', { cwd: input.directory })).toMatchObject({ outcome: 'rejected', error: { code: 'authentication_required' } });
});

it('creates private setup and agent storage roots before host dependency setup', async () => {
  const { target: input, hostConfigPath } = await target();
  const roots = ['setup', 'agent'].map(name => join(resolveDaemonTarget(input).agentDir, 'storage', name));
  for (const root of roots) await expect(stat(root)).rejects.toMatchObject({ code: 'ENOENT' });

  const service = await startDaemonService(input, { manager: testManager, hostConfigPath, createModelRuntime: models });
  cleanups.push(async () => { if (service.lifecycle.state !== 'stopped') { await service.requestStop('stop', 'force'); await service.stopped; } });

  for (const root of roots) {
    const storage = await stat(root);
    expect(storage.isDirectory()).toBe(true);
    expect(storage.mode & 0o777).toBe(0o700);
  }
});

it('starts forced cancellation before joining a broker continuation that needs it', async () => {
  let release!: () => void; const joined = new Promise<void>(resolve => { release = resolve; });
  const shutdown = vi.fn(async () => { release(); });
  const drain = vi.fn(() => joined);
  const work = settleDaemonWork({ shutdown, waitForDrain: vi.fn(async () => {}) }, { drain }, 'force');
  try { expect(drain).toHaveBeenCalledOnce(); expect(shutdown).toHaveBeenCalledWith({ interrupt: true }); }
  finally { release(); await work; }
});

it.each(['drain', 'force'] as const)('binds host maintenance before activation and joins workers and provider settlement on %s', async mode => {
  const { target: input, hostConfigPath } = await target();
  const config = JSON.parse(await readFile(hostConfigPath, 'utf8'));
  const contract = defineServiceContract<object>('test.maintenance', 1);
  config.services.push({ id: contract.id, major: 1, use: '@felan-ai/test-manager/maintenance' });
  await writeFile(hostConfigPath, JSON.stringify(config));
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void; const entering = new Promise<void>(resolve => { entered = resolve; });
  let maintenance!: HostMaintenance; let history!: SessionsHistory; let request!: HostWorkerOptions;
  let finishProvider!: () => void; const provider = new Promise<void>(resolve => { finishProvider = resolve; });
  let closeMaintenance!: ReturnType<typeof vi.fn>;
  let workerFinished = false; let providerBusy = true;
  cleanups.push(async () => { release(); providerBusy = false; finishProvider(); });
  const settle = vi.fn(async () => {
    expect(workerFinished).toBe(true);
    expect(maintenance.signal.aborted).toBe(true);
    expect(() => maintenance.sessions({ kind: 'all' })).toThrow();
    expect(() => maintenance.openWorker(request)).toThrow();
    await provider;
  });
  const dispose = vi.fn(async () => {});
  const definition = defineServiceProvider({ scope: 'daemon', provides: [contract], requires: [HOST_MAINTENANCE_SERVICE], async create(context) {
    maintenance = context.services.get(HOST_MAINTENANCE_SERVICE)!;
    expect(() => maintenance.sessions({ kind: 'all' })).toThrow('unavailable');
    return { implementations: [{ contract, value: {} }], busy: () => providerBusy, settle, dispose,
      async activate() {
        history = maintenance.sessions({ kind: 'all' });
        expect((await history.list({ scope: 'visible' })).items).toEqual([]);
        const agentDir = maintenance.agentDir;
        const cwd = join(agentDir, 'storage', 'agent', 'memory', 'staging');
        const sessionDir = join(agentDir, 'sessions');
        await mkdir(cwd, { recursive: true }); await mkdir(sessionDir, { recursive: true });
        const created = SessionManager.create(input.directory, sessionDir);
        await writeFile(created.getSessionFile()!, JSON.stringify(created.getHeader()) + '\n');
        const sessionManager = SessionManager.open(created.getSessionFile()!, sessionDir, input.directory);
        request = { runtime: new HostAgentRuntime(cwd, createRuntimeStorageRequest(cwd, agentDir, sessionManager.getSessionId())),
          sessionManager, settingsManager: SettingsManager.create(cwd, agentDir), model: offlineModel, allowedTools: ['read'] };
        const worker = await maintenance.openWorker(request);
        void worker.prompt('Wait for shutdown.').then(() => { throw new Error('Worker should be interrupted.'); }, error => {
          expect(error).toMatchObject({ name: 'AbortError' }); workerFinished = true;
        });
        await entering;
      } };
  } });
  const url = new URL('./fixtures/maintenance-provider.ts', import.meta.url).href;
  const original = providerLoader.createConfiguredProviders;
  const loader = vi.spyOn(providerLoader, 'createConfiguredProviders').mockImplementation(async options => {
    const providers = await original({ ...options,
      importModule: async specifier => specifier === url ? { default: definition } : import(specifier) });
    closeMaintenance = vi.fn(() => providers.maintenance.close());
    return { ...providers, maintenance: { ...providers.maintenance, close: closeMaintenance } };
  });
  cleanups.push(async () => { loader.mockRestore(); });
  const manager = { ...testManager, resolveProvider: (specifier: string) => specifier === '@felan-ai/test-manager/maintenance' ? url : testManager.resolveProvider(specifier) };
  const service = await startDaemonService(input, { manager, hostConfigPath, createModelRuntime: async () => {
    const runtime = await models();
    runtime.registerProvider('offline', { api: 'openai-completions', baseUrl: offlineModel.baseUrl, apiKey: 'fixture', models: [offlineModel], streamSimple: () => {
      const stream = createAssistantMessageEventStream(); entered();
      void held.then(() => stream.push({ type: 'done', reason: 'stop', message: assistant() })); return stream;
    } });
    return runtime;
  } });
  cleanups.push(async () => { release(); providerBusy = false; finishProvider(); if (service.lifecycle.state !== 'stopped') { await service.requestStop('stop', 'force'); await service.stopped; } });
  expect(maintenance.modelRuntime).toBe(service.server.options.models);
  expect(service.registry.listed()).toEqual([]);
  expect(await service.registry.activeWork()).toBe(0);
  expect(maintenance.signal.aborted).toBe(false);
  const client = new SessionClient({ target: input, clientVersion: 'fixture', kind: 'tui', expected: service.owner.identity });
  cleanups.push(async () => client.close()); await client.connect();
  expect(await client.request('host.status', {})).toMatchObject({ outcome: 'accepted', result: { active: { work: 1 } } });
  await service.requestStop('stop', mode);
  expect(maintenance.signal.aborted).toBe(mode === 'force');
  expect(settle).not.toHaveBeenCalled(); expect(dispose).not.toHaveBeenCalled();
  release();
  await vi.waitFor(() => expect(settle).toHaveBeenCalledOnce());
  expect(closeMaintenance).toHaveBeenCalledOnce();
  expect(service.lifecycle.state).toBe('draining'); expect(dispose).not.toHaveBeenCalled();
  expect(await client.request('host.status', {})).toMatchObject({ outcome: 'accepted', result: { active: { work: 1 } } });
  providerBusy = false; finishProvider();
  await service.stopped;
  expect(dispose).toHaveBeenCalledOnce();
  expect(() => maintenance.agentDir).toThrow(expect.objectContaining({ name: 'AbortError' }));
  await expect(history.list({ scope: 'visible' })).rejects.toThrow();
});

it('forces an owned foreground process to settle and persists its interrupted run before release', async () => {
  const { target: input, hostConfigPath } = await target(); const service = await startDaemonService(input, { manager: testManager, hostConfigPath, createModelRuntime: models });
  cleanups.push(async () => { if (service.lifecycle.state !== 'stopped') { await service.requestStop('stop', 'force'); await service.stopped; } });
  const client = new SessionClient({ target: input, clientVersion: 'fixture', kind: 'tui' }); cleanups.push(async () => client.close()); await client.connect();
  const created = await client.request('sessions.create', { cwd: input.directory, model: { provider: 'offline', id: 'fixture' } });
  expect(created.outcome).toBe('accepted'); if (created.outcome !== 'accepted') return;
  await client.attach(created.result.sessionId);
  const shell = await client.request('shell.execute', { command: 'sleep 30', includeInContext: false }, { session: created.result.sessionId });
  expect(shell.outcome).toBe('accepted'); if (shell.outcome !== 'accepted') return;
  const run = service.registry.options.store.session(created.result.sessionId).run;
  expect(run.state).toBe('running');
  expect((await client.control('host.stop', 'force')).outcome).toBe('accepted');
  await service.stopped;
  const owner = await acquireDaemonOwnership(input); const store = new DaemonControlStore(owner);
  try {
    expect(store.session(created.result.sessionId).run).toEqual({ ...run, state: 'interrupted' });
    expect(store.snapshot().resources.find(row => row.id === shell.result.resourceId)?.state).toBe('exited');
  } finally { store.close(); await owner.release(); }
});

it('keeps admitting work with unverified prior process records and never signals their stored identity', async () => {
  const { target: input, hostConfigPath } = await target(); const owner = await acquireDaemonOwnership(input); const seed = new DaemonControlStore(owner);
  try {
    seed.createSession({ id: 'prior-session', root: 'prior-session', cwd: input.directory, piPath: join(owner.target.agentDir, 'sessions', 'prior.jsonl'),
      title: 'Synthetic prior session', state: 'open', residency: 'warm', run: { state: 'idle' }, policy: { effective: 'host-default', generation: 0 } });
    seed.putResource({ id: 'synthetic-process', session: 'prior-session', root: 'prior-session', kind: 'foreground', state: 'running', updatedAt: Date.now() });
  } finally { seed.close(); await owner.release(); }
  const service = await startDaemonService(input, { manager: testManager, hostConfigPath, createModelRuntime: models });
  cleanups.push(async () => {
    if (service.lifecycle.state !== 'stopped') {
      const row = service.registry.options.store.snapshot().resources.find(row => row.id === 'synthetic-process')!;
      service.registry.options.store.putResource({ ...row, state: 'exited' });
      await service.requestStop('stop', 'force'); await service.stopped;
    }
  });
  const client = new SessionClient({ target: input, clientVersion: 'fixture', kind: 'tui' }); cleanups.push(async () => client.close()); await client.connect();
  expect(await client.request('host.status', {})).toMatchObject({ outcome: 'accepted', result: { state: 'ready', setupNeeds: [] } });
  expect(service.lifecycle.state).toBe('ready');
});

it('joins a dispatched global settings writer before closing its control store or releasing ownership', async () => {
  const { target: input, hostConfigPath } = await target(); const service = await startDaemonService(input, { manager: testManager, hostConfigPath, createModelRuntime: models });
  cleanups.push(async () => { if (service.lifecycle.state !== 'stopped') { await service.requestStop('stop', 'force'); await service.stopped; } });
  const client = new SessionClient({ target: input, clientVersion: 'fixture', kind: 'tui' }); cleanups.push(async () => client.close()); await client.connect();
  let entered!: () => void; const entering = new Promise<void>(resolve => { entered = resolve; });
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
  let joining!: () => void; const joinStarted = new Promise<void>(resolve => { joining = resolve; });
  const order: string[] = [];
  const originalSet = DaemonConfiguration.prototype.set;
  const writer = vi.spyOn(DaemonConfiguration.prototype, 'set').mockImplementation(async function (this: DaemonConfiguration, scope, value) {
    entered(); await held; await originalSet.call(this, scope, value); order.push('write');
  });
  const originalJoin = service.server.settleCommands.bind(service.server);
  const joinSpy = vi.spyOn(service.server, 'settleCommands').mockImplementation(async () => { joining(); await originalJoin(); });
  const originalClose = service.registry.options.store.close.bind(service.registry.options.store);
  const close = vi.spyOn(service.registry.options.store, 'close').mockImplementation(() => { order.push('close'); originalClose(); });
  cleanups.push(async () => { release(); writer.mockRestore(); joinSpy.mockRestore(); close.mockRestore(); });
  const write = client.request('config.set', { scope: 'global', values: { defaultThinking: 'low' } });
  await entering;
  expect((await client.control('host.stop', 'drain')).outcome).toBe('accepted');
  await joinStarted;
  expect(close).not.toHaveBeenCalled(); expect(() => service.owner.assertCurrent()).not.toThrow();
  release(); const result = await write; expect(['accepted', 'indeterminate']).toContain(result.outcome);
  await service.stopped; expect(order).toEqual(['write', 'close']);
});

it('redacts credentials from startup failure diagnostics', async () => {
  const { target: input, hostConfigPath } = await target();
  const secret = 'https://admin:pa55@models.example.test/v1?key=query-secret';
  await expect(startDaemonService(input, { manager: testManager, hostConfigPath, createModelRuntime: async () => { throw new Error(`Model setup failed for ${secret}`); } }))
    .rejects.toThrow('Model setup failed');
  const stderr = await readFile(join(resolveDaemonTarget(input).runtimeDirectory, 'stderr.log'), 'utf8');
  expect(stderr).toContain('Model setup failed'); expect(stderr).not.toContain('pa55'); expect(stderr).not.toContain('query-secret');
});

it('reports a recoverable shutdown failure on every management surface and explicitly retries cleanup', async () => {
  const { target: input, hostConfigPath } = await target();
  const service = await startDaemonService(input, { manager: testManager, hostConfigPath, createModelRuntime: models });
  let fail = true;
  cleanups.push(async () => { fail = false; if (service.lifecycle.state !== 'stopped') { await service.requestStop('stop', 'force'); await service.stopped; } });
  const client = new SessionClient({ target: input, clientVersion: 'fixture', kind: 'tui' }); cleanups.push(async () => client.close()); await client.connect();
  const created = await client.request('sessions.create', { cwd: input.directory, model: { provider: 'offline', id: 'fixture' } });
  expect(created.outcome).toBe('accepted'); if (created.outcome !== 'accepted') return;
  const id = created.result.sessionId; await client.attach(id);
  const disposed = vi.fn(async () => {});
  service.registry.registerService(id, { busy: () => false, settle: async mode => {
    if (mode !== 'drain' && fail) { fail = false; throw new AggregateError([new Error('api_key=sk-test-12345678\nfixture failure')], 'service failed'); }
  }, dispose: disposed });
  expect(await client.control('host.stop', 'drain')).toMatchObject({ outcome: 'accepted' });
  await vi.waitFor(() => expect(service.lifecycle.state).toBe('blocked'));
  const blocked = service.lifecycle.blocked!;
  expect(blocked).toMatchObject({ recoverable: true, step: 'session-services', session: id, pid: process.pid, message: expect.stringContaining('fixture failure') });
  expect(blocked.message).not.toContain('sk-test'); expect(blocked.message).not.toContain('\n');
  expect(await client.request('host.status', {})).toMatchObject({ outcome: 'accepted', result: { state: 'blocked', blocked } });
  expect(await client.control('host.status')).toMatchObject({ outcome: 'accepted', state: 'blocked', blocked });
  const logs = await client.request('host.logs', {});
  expect(logs).toMatchObject({ outcome: 'accepted', result: { entries: expect.arrayContaining([
    expect.objectContaining({ level: 'error', message: expect.stringContaining(`Daemon shutdown failed at session-services (session ${id}):`) }),
  ]) } });
  const stderr = await readFile(join(service.owner.target.runtimeDirectory, 'stderr.log'), 'utf8');
  expect(stderr).toContain('session-services'); expect(stderr).toContain(id); expect(stderr).toContain('fixture failure'); expect(stderr).toContain('stack'); expect(stderr).not.toContain('sk-test');
  for (const op of ['host.stop', 'host.restart'] as const) {
    expect(await client.control(op, 'drain')).toMatchObject({ outcome: 'rejected', state: 'blocked', blocked, error: { code: 'host_blocked' } });
    expect(await client.request(op, { expected: service.owner.identity, mode: 'drain' })).toMatchObject({ outcome: 'rejected', error: { code: 'host_blocked' } });
  }
  expect(service.lifecycle.blocked).toEqual(blocked);
  expect(await client.request('sessions.create', { cwd: input.directory })).toMatchObject({ outcome: 'rejected', error: { code: 'host_blocked' } });
  expect(await client.request('prompt', { text: 'refused' }, { session: id })).toMatchObject({ outcome: 'rejected', error: { code: 'host_blocked' } });
  expect(disposed).not.toHaveBeenCalled(); expect(() => service.owner.assertCurrent()).not.toThrow();
  expect(await client.control('host.stop', 'force')).toMatchObject({ outcome: 'accepted', state: 'draining' });
  expect(await service.stopped).toBe('stop'); expect(disposed).toHaveBeenCalledOnce();
  const next = await acquireDaemonOwnership(input); await next.release();
});

it('starts the pre-daemon transcript warm-up after startup and aborts it on shutdown', async () => {
  const { target: input, hostConfigPath } = await target();
  let signal: AbortSignal | undefined;
  const warm = vi.spyOn(LegacySessionIndex.prototype, 'warm').mockImplementation((_sessions, warmSignal) => {
    signal = warmSignal;
    return new Promise<void>(resolve => warmSignal.addEventListener('abort', () => resolve(), { once: true }));
  });
  try {
    const service = await startDaemonService(input, { manager: testManager, hostConfigPath, createModelRuntime: vi.fn(models) });
    cleanups.push(async () => { if (service.lifecycle.state !== 'stopped') { await service.requestStop('stop', 'force'); await service.stopped; } });
    await vi.waitFor(() => expect(warm).toHaveBeenCalledOnce());
    expect(signal?.aborted).toBe(false);
    await service.requestStop('stop', 'drain'); await service.stopped;
    expect(signal?.aborted).toBe(true);
  } finally { warm.mockRestore(); }
});
