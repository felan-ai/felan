import { uuidv7 } from '@felan-ai/agent-core';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { InMemoryCredentialStore, ModelRuntime } from '@felan-ai/agent-core';
import type { UiDocument } from '@felan-ai/session-protocol';
import { afterEach, expect, it, vi } from 'vitest';
import { OrderedAdmission } from '../../daemon/src/daemon/admission.js';
import { createRegistryInteractionBroker } from '../../daemon/src/daemon/broker.js';
import { createDaemonExecutionServices } from '../../daemon/src/daemon/execution-services.js';
import { HostLifecycle } from '../../daemon/src/daemon/lifecycle.js';
import { settleDaemonWork, startDaemonService } from '../../daemon/src/daemon/service.js';
import { acquireDaemonOwnership } from '../../daemon/src/daemon/ownership.js';
import type { SessionRuntime } from '../../daemon/src/daemon/session-runtime.js';
import { createTestSessionRuntime } from '../../daemon/test/fixtures/session-runtime.js';
import { serverFixture } from '../../daemon/test/fixtures/server.js';
import { offlineModel } from '../../daemon/test/fixtures/registry.js';
import { SessionClient } from '../src/client/client.js';
import { waitForDaemonStop } from '../src/client/daemon-stop.js';
import { FELAN_VERSION } from '../src/version.js';
import { TERMINAL_INTERACTION_KINDS, TERMINAL_UI_CAPABILITIES } from '../src/tui/interactions.js';
import { TuiAltScreen, type Terminal } from '@earendil-works/pi-tui';
import { TuiSessionController } from '../src/tui/controller.js';
import { runDaemonTerminal } from '../src/tui/run.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.restoreAllMocks(); });

async function fixture() {
  let composition!: SessionRuntime;
  const f = await serverFixture({ now: Date.now, deferActivation: true, extensionPackages: ['@felan-ai/ext-context-view'],
    createComposition(runtimeFactory) {
      return composition = createTestSessionRuntime({ runtimeFactory, importExtension: async () => import('@felan-ai/ext-context-view') });
    },
    servicesFactory: registry => createDaemonExecutionServices(registry, createRegistryInteractionBroker(registry), composition),
  });
  cleanups.push(() => f.dispose());
  const start = () => {
    const id = uuidv7();
    f.store.admit({ v: 1, id, op: 'command.invoke', session: f.root.sessionId, params: { name: 'context', arguments: '' } }, 'client');
    return f.registry.runAdmitted(id, f.root.sessionId, { kind: 'tui', attachment: 'client' }, session => session.prompt('/context'));
  };
  const document = () => f.registry.projection(f.root.sessionId).snapshot().presentation.find(element => element.kind === 'document') as UiDocument | undefined;
  return { ...f, start, document };
}

it('closes the real context command to idle and reopens its report', async () => {
  const f = await fixture();
  let previousId: string | undefined;
  for (let index = 0; index < 2; index++) {
    const work = f.start();
    await vi.waitFor(() => expect(f.document()).toBeDefined());
    const element = f.document()!;
    expect(element.title).toBe('Context usage');
    expect(element.id).not.toBe(previousId); previousId = element.id;
    expect(f.store.session(f.root.sessionId).run.state).toBe('waiting');
    const id = uuidv7();
    const action = { elementId: element.id, revision: element.revision, actionId: 'close', outcome: 'cancel' as const, values: {} };
    f.store.admit({ v: 1, id, op: 'ui.action', session: f.root.sessionId, params: action }, 'client');
    await f.registry.mutateAdmitted(id, f.root.sessionId, async () => {
      await f.registry.prepareUiAction(f.root.sessionId, action)({ requestId: id, signal: new AbortController().signal });
    });
    await work;
    expect(f.store.session(f.root.sessionId).run.state).toBe('idle');
    expect(f.document()).toBeUndefined();
  }
});

it('cancels the real context command without disposing its session', async () => {
  const f = await fixture(); const work = f.start();
  await vi.waitFor(() => expect(f.document()).toBeDefined());
  await f.registry.cancel(f.root.sessionId); await work;
  expect(f.store.session(f.root.sessionId)).toMatchObject({ state: 'open', run: { state: 'idle' } });
  expect(f.document()).toBeUndefined();
});

it.each(['drain', 'force'] as const)('%s stop closes the real context command before releasing ownership', async mode => {
  const f = await fixture(); const work = f.start();
  await vi.waitFor(() => expect(f.document()).toBeDefined());
  const complete = vi.fn(async () => {
    expect(f.registry.binding(f.root.sessionId)).toBeUndefined();
    await expect(f.registry.settleWriters()).resolves.toBeUndefined();
    expect(() => f.owner.assertCurrent()).not.toThrow();
  });
  const lifecycle = new HostLifecycle({ target: f.owner.target, identity: f.owner.identity, timeoutMs: 2000,
    beginDrain: () => f.registry.beginDrain(), complete,
    settle: mode => settleDaemonWork(f.registry, createRegistryInteractionBroker(f.registry), mode),
  });
  const admission = new OrderedAdmission(f.store, { now: Date.now }); const id = uuidv7();
  const response = await admission.submit({ v: 1, id, op: 'host.stop', params: { expected: f.owner.identity, confirmed: true, mode } }, 'client', command => lifecycle.prepare(command));
  expect(response.outcome).toBe('accepted'); lifecycle.afterResponse(id);
  await work;
  await vi.waitFor(() => expect(lifecycle.state).toBe('stopped'));
  expect(complete).toHaveBeenCalledOnce();
});

it('stops the real daemon on the first force command with an attached context view open', async () => {
  const root = await mkdtemp(join(process.cwd(), '.context-stop-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'daemon');
  await mkdir(directory, { mode: 0o700 });
  const target = { kind: 'isolated' as const, directory, namespaceId: randomUUID() };
  const owner = await acquireDaemonOwnership(target);
  const hostConfigPath = join(owner.target.agentDir, 'host.json');
  try {
    const config = JSON.parse(await readFile(new URL('../src/host.json', import.meta.url), 'utf8'));
    config.extensions = [{ package: '@felan-ai/ext-context-view' }];
    await writeFile(hostConfigPath, JSON.stringify(config), { mode: 0o600 });
  } finally { await owner.release(); }
  const service = await startDaemonService(target, { hostConfigPath, drainTimeoutMs: 2000,
    manager: { packageName: '@felan-ai/felan', version: FELAN_VERSION, resolveFrom: import.meta.url,
      resolveProvider: specifier => new URL(`../src/providers/${specifier.split('/').at(-1)}.ts`, import.meta.url).href },
    createModelRuntime: async () => {
      const models = await ModelRuntime.create({ modelsPath: null, credentials: new InMemoryCredentialStore(), refreshOnCreate: false });
      models.registerProvider('offline', { api: offlineModel.api, baseUrl: offlineModel.baseUrl, apiKey: 'fixture', models: [offlineModel] });
      return models;
    },
  });
  let settlementError: unknown;
  const shutdown = service.registry.shutdown.bind(service.registry);
  vi.spyOn(service.registry, 'shutdown').mockImplementation(async options => {
    try { await shutdown(options); } catch (error) { settlementError = error; throw error; }
  });
  cleanups.push(async () => {
    if (service.lifecycle.state !== 'stopped') {
      await service.requestStop('stop', 'force');
      await vi.waitFor(() => expect(service.lifecycle.state, inspect(settlementError)).toBe('stopped'), { timeout: 3000 });
    }
  });
  const client = new SessionClient({ target, clientVersion: FELAN_VERSION, kind: 'tui',
    capabilities: [...TERMINAL_UI_CAPABILITIES], interactionKinds: [...TERMINAL_INTERACTION_KINDS] });
  cleanups.push(async () => client.close());
  await client.connect();
  const created = await client.request('sessions.create', { cwd: root, source: 'tui', model: { provider: 'offline', id: 'fixture' } });
  expect(created.outcome).toBe('accepted');
  if (created.outcome !== 'accepted') throw new Error('Session creation failed');
  const session = created.result.sessionId;
  const controller = new TuiSessionController(client);
  let input: (data: string) => void = () => {};
  const terminal: Terminal = {
    columns: 120, rows: 40, kittyProtocolActive: false,
    start: handler => { input = handler; }, stop() {}, async drainInput() {},
    write() {}, moveBy() {}, hideCursor() {}, showCursor() {}, clearLine() {}, clearFromCursor() {}, clearScreen() {},
    setTitle() {}, setProgress() {}, setProgramStatus() {},
  };
  const tui = new TuiAltScreen(terminal);
  const lifetime = new AbortController();
  const running = runDaemonTerminal(controller, { cwd: root, sessionId: session, terminal, createTui: () => tui,
    clientConfigDir: join(root, 'client'), signal: lifetime.signal });
  cleanups.push(async () => { lifetime.abort(); await running; await controller.dispose(); });
  await vi.waitFor(() => expect(controller.sessionId).toBe(session));
  const screen = () => { tui.renderNow(true); return tui.getScreenLines().join('\n'); };
  await vi.waitFor(() => expect(screen()).toContain('Manage optional extensions'));
  input('\x1b');
  await vi.waitFor(() => expect(screen()).not.toContain('Manage optional extensions'));
  const document = () => client.getAttachment(session)?.state.snapshot?.presentation.find(element => element.kind === 'document') as UiDocument | undefined;
  for (let index = 0; index < 3; index++) {
    expect(await client.request('command.invoke', { name: 'context', arguments: '' }, { session })).toMatchObject({ outcome: 'accepted' });
    await vi.waitFor(() => expect(document()?.title).toBe('Context usage'));
    await vi.waitFor(() => expect(client.getAttachment(session)?.state.snapshot?.run.state).toBe('waiting'));
    await vi.waitFor(() => expect(screen()).toContain('Context usage'));
    if (index < 2) {
      input('\x1b');
      await vi.waitFor(() => expect(client.getAttachment(session)?.state.snapshot?.run.state).toBe('idle'));
      await vi.waitFor(() => expect(screen()).not.toContain('Context usage'));
      expect(document()).toBeUndefined();
    }
  }
  expect(service.lifecycle.state).toBe('ready');
  const transport = await service.registry.binding(session)!.agentRuntime.processes!.startStdio!(process.execPath, ['-e', 'process.stdin.resume()']);
  const settleTransport = vi.fn(async () => { await transport.closeInput().catch(() => {}); await transport.dispose(); });
  const unregister = service.registry.registerService(session, { busy: () => false, settle: settleTransport, async dispose() {} });
  cleanups.push(async () => { unregister(); await transport.dispose(); });
  const control = new SessionClient({ target, clientVersion: FELAN_VERSION, kind: 'tui' });
  cleanups.push(async () => control.close());
  await control.connect();
  expect(await control.control('host.stop', { confirmed: true, mode: 'force' })).toMatchObject({ outcome: 'accepted' });
  await vi.waitFor(() => expect(service.lifecycle.state, inspect(settlementError)).toBe('stopped'), { timeout: 3000 });
  await expect(waitForDaemonStop(control)).resolves.toBeUndefined();
  expect(settleTransport).toHaveBeenCalledOnce();
  expect(await service.stopped).toBe('stop');
  const next = await acquireDaemonOwnership(target);
  await next.release();
}, 20_000);
