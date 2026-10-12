import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import { InMemoryCredentialStore, ModelRuntime, createAssistantMessageEventStream } from '@felan-ai/agent-core';
import { SessionClient } from '../../felan/src/client/client.js';
import { builtinExtensionPackages } from '../src/extension-catalog.js';
import { settleDaemonWork, startDaemonService } from '../src/daemon/service.js';
import { spawnDetachedDaemon } from '../src/daemon/supervisor.js';
import { acquireDaemonOwnership } from '../src/daemon/ownership.js';
import { assistant, offlineModel } from './fixtures/registry.js';
import { DaemonControlStore } from '../src/daemon/control-store.js';
import { DaemonConfiguration } from '../src/daemon/configuration.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function target() {
  const directory = await mkdtemp(join(tmpdir(), 's14-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  return { kind: 'isolated' as const, directory, namespaceId: randomUUID() };
}

async function models() {
  const runtime = await ModelRuntime.create({ modelsPath: null, credentials: new InMemoryCredentialStore(), refreshOnCreate: false });
  runtime.registerProvider('offline', { api: 'openai-completions', baseUrl: offlineModel.baseUrl, apiKey: 'fixture', models: [offlineModel], streamSimple: () => {
    const stream = createAssistantMessageEventStream(); queueMicrotask(() => stream.push({ type: 'done', reason: 'stop', message: assistant() })); return stream;
  } });
  return runtime;
}

it('assembles owned service state and executes a real offline session before explicit shutdown', async () => {
  const input = await target();
  const service = await startDaemonService(input, { createModelRuntime: models, initializeProcess: async () => ({ diagnostics: [], assertConfiguration: () => [] }) });
  cleanups.push(async () => { if (service.lifecycle.state !== 'stopped') { await service.requestStop('stop', 'force'); await service.stopped; } });
  await writeFile(join(service.owner.target.agentDir, 'settings.json'), JSON.stringify({ builtinExtensions: Object.fromEntries(Object.keys(builtinExtensionPackages).map(key => [key, false])) }));
  const client = new SessionClient({ target: input, clientVersion: 'fixture', kind: 'tui', expected: service.owner.identity });
  cleanups.push(async () => client.close()); await client.connect();
  expect(await client.request('host.status', {})).toMatchObject({ outcome: 'accepted', result: { state: 'ready', setupNeeds: [] } });
  const created = await client.request('sessions.create', { cwd: input.directory, source: 'tui', model: { provider: 'offline', id: 'fixture' } });
  expect(created.outcome).toBe('accepted'); if (created.outcome !== 'accepted') return;
  expect((await stat(join(service.owner.target.agentDir, 'storage'))).mode & 0o777).toBe(0o700);
  await client.attach(created.result.sessionId);
  expect(await client.request('prompt', { text: 'offline request' }, { session: created.result.sessionId })).toMatchObject({ outcome: 'accepted' });
  await vi.waitFor(() => expect(client.getAttachment(created.result.sessionId)?.state.snapshot?.history.entries.some(row => row.role === 'assistant')).toBe(true));
  await vi.waitFor(() => expect(client.getAttachment(created.result.sessionId)?.state.snapshot?.run.state).toBe('idle'));
  expect((await client.request('host.logs', {})).outcome).toBe('accepted');
  expect(await client.control('host.stop', { confirmed: true, mode: 'drain' })).toMatchObject({ outcome: 'accepted' });
  expect(await service.stopped).toBe('stop');
  const next = await acquireDaemonOwnership(input); await next.release();
});

it('launches the emitted installed entrypoint and remains alive after a client detaches', async () => {
  const input = await target();
  const receipt = await spawnDetachedDaemon({ target: input, entrypoint: fileURLToPath(new URL('../dist/index.js', import.meta.url)) });
  const cleanup = new SessionClient({ target: input, expected: receipt.identity, clientVersion: 'fixture', kind: 'tui' });
  cleanups.push(async () => {
    try {
      await cleanup.connect();
      expect((await cleanup.control('host.stop', { confirmed: true, mode: 'force' })).outcome).toBe('accepted');
      await vi.waitFor(async () => { const owner = await acquireDaemonOwnership(input); await owner.release(); }, { timeout: 5_000 });
    }
    finally { cleanup.close(); }
  });
  const client = new SessionClient({ target: input, expected: receipt.identity, clientVersion: 'fixture', kind: 'tui' });
  await client.connect(); client.close();
  await cleanup.connect();
  expect(await cleanup.control('host.status')).toMatchObject({ outcome: 'accepted', state: 'ready', identity: receipt.identity });
  expect(await cleanup.request('host.status', {})).toMatchObject({ outcome: 'accepted', result: { setupNeeds: [{ code: 'provider' }] } });
});

it('starts forced cancellation before joining a broker continuation that needs it', async () => {
  let release!: () => void; const joined = new Promise<void>(resolve => { release = resolve; });
  const shutdown = vi.fn(async () => { release(); });
  const drain = vi.fn(() => joined);
  const work = settleDaemonWork({ shutdown, waitForDrain: vi.fn(async () => {}) }, { drain }, 'force');
  try { expect(drain).toHaveBeenCalledOnce(); expect(shutdown).toHaveBeenCalledWith({ interrupt: true }); }
  finally { release(); await work; }
});

it('forces an owned foreground process to settle and persists its interrupted run before release', async () => {
  const input = await target(); const service = await startDaemonService(input, { createModelRuntime: models,
    initializeProcess: async () => ({ diagnostics: [], assertConfiguration: () => [] }) });
  cleanups.push(async () => { if (service.lifecycle.state !== 'stopped') { await service.requestStop('stop', 'force'); await service.stopped; } });
  await writeFile(join(service.owner.target.agentDir, 'settings.json'), JSON.stringify({ builtinExtensions: Object.fromEntries(Object.keys(builtinExtensionPackages).map(key => [key, false])) }));
  const client = new SessionClient({ target: input, clientVersion: 'fixture', kind: 'tui' }); cleanups.push(async () => client.close()); await client.connect();
  const created = await client.request('sessions.create', { cwd: input.directory, source: 'tui', model: { provider: 'offline', id: 'fixture' } });
  expect(created.outcome).toBe('accepted'); if (created.outcome !== 'accepted') return;
  await client.attach(created.result.sessionId);
  const shell = await client.request('shell.execute', { command: 'sleep 30', includeInContext: false }, { session: created.result.sessionId });
  expect(shell.outcome).toBe('accepted'); if (shell.outcome !== 'accepted') return;
  const run = service.registry.options.store.session(created.result.sessionId).run;
  expect(run.state).toBe('running');
  expect((await client.control('host.stop', { confirmed: true, mode: 'force' })).outcome).toBe('accepted');
  await service.stopped;
  const owner = await acquireDaemonOwnership(input); const store = new DaemonControlStore(owner);
  try {
    expect(store.session(created.result.sessionId).run).toEqual({ ...run, state: 'interrupted' });
    expect(store.snapshot().resources.find(row => row.id === shell.result.resourceId)?.state).toBe('exited');
  } finally { store.close(); await owner.release(); }
});

it('blocks recovered unknown processes instead of signalling a stored process identity', async () => {
  const input = await target(); const owner = await acquireDaemonOwnership(input); const seed = new DaemonControlStore(owner);
  try {
    seed.createSession({ id: 'prior-session', root: 'prior-session', cwd: input.directory, piPath: join(owner.target.agentDir, 'sessions', 'prior.jsonl'),
      title: 'Synthetic prior session', state: 'open', residency: 'warm', run: { state: 'idle' }, policy: { effective: 'host-default', generation: 0 } });
    seed.putResource({ id: 'synthetic-process', session: 'prior-session', root: 'prior-session', kind: 'foreground', state: 'running', updatedAt: Date.now() });
  } finally { seed.close(); await owner.release(); }
  const service = await startDaemonService(input, { createModelRuntime: models, initializeProcess: async () => ({ diagnostics: [], assertConfiguration: () => [] }) });
  cleanups.push(async () => {
    if (service.lifecycle.state !== 'stopped') {
      const row = service.registry.options.store.snapshot().resources.find(row => row.id === 'synthetic-process')!;
      service.registry.options.store.putResource({ ...row, state: 'exited' });
      await service.requestStop('stop', 'force'); await service.stopped;
    }
  });
  const client = new SessionClient({ target: input, clientVersion: 'fixture', kind: 'tui' }); cleanups.push(async () => client.close()); await client.connect();
  expect(await client.request('host.status', {})).toMatchObject({ outcome: 'accepted', result: { state: 'blocked', setupNeeds: [{ code: 'process_recovery' }] } });
  expect((await client.control('host.stop', { confirmed: true, mode: 'force' })).outcome).toBe('rejected');
  expect(service.lifecycle.state).toBe('blocked');
});

it('joins a dispatched global settings writer before closing its control store or releasing ownership', async () => {
  const input = await target(); const service = await startDaemonService(input, { createModelRuntime: models,
    initializeProcess: async () => ({ diagnostics: [], assertConfiguration: () => [] }) });
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
  const join = vi.spyOn(service.server, 'settleCommands').mockImplementation(async () => { joining(); await originalJoin(); });
  const originalClose = service.registry.options.store.close.bind(service.registry.options.store);
  const close = vi.spyOn(service.registry.options.store, 'close').mockImplementation(() => { order.push('close'); originalClose(); });
  cleanups.push(async () => { release(); writer.mockRestore(); join.mockRestore(); close.mockRestore(); });
  const write = client.request('config.set', { scope: 'global', values: { defaultThinking: 'low' } });
  await entering;
  expect((await client.control('host.stop', { confirmed: true, mode: 'drain' })).outcome).toBe('accepted');
  await joinStarted;
  expect(close).not.toHaveBeenCalled(); expect(() => service.owner.assertCurrent()).not.toThrow();
  release(); const result = await write; expect(['accepted', 'indeterminate']).toContain(result.outcome);
  await service.stopped; expect(order).toEqual(['write', 'close']);
});
