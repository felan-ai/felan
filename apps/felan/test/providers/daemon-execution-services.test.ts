import { HostAgentRuntime, HOST_RUNTIME_SERVICE, HOST_WORKERS_SERVICE, RUNTIME_LIFETIME_SERVICE, MODELS_SERVICE, SESSIONS_SERVICE, SESSIONS_HISTORY_SERVICE, SettingsManager, createFelanServiceRegistry, createReadOnlySessionsService, type AgentRuntime, type SessionsService } from '@felan-ai/agent-core';
import { LocalMemoryRun } from '@felan-ai/ext-memory';
import { afterEach, expect, it, vi } from 'vitest';
import { createRegistryInteractionBroker, type InteractionBroker } from '../../../daemon/src/daemon/broker.js';
import { createDaemonExecutionServices } from '../../../daemon/src/daemon/execution-services.js';
import type { RegistryOpenRequest, SessionRegistry } from '../../../daemon/src/daemon/registry.js';
import { createRegistrySessionsService } from '../../../daemon/src/daemon/session-services.js';
import { createLocalExecutionRoots, createLocalExecutionServices } from '../../src/providers/execution-services.js';
import type { ExecutionHost } from '@felan-ai/daemon/provider';
import type { SessionRuntime } from '../../../daemon/src/daemon/session-runtime.js';
import { createLocalSessionRuntime } from '../../src/providers/session-runtime.js';
import { createLocalModelsService } from '../../src/providers/models.js';
import { builtinExtensionPackages, type BuiltinExtensionName } from '../../src/providers/extension-catalog.js';
import { serverFixture } from '../../../daemon/test/fixtures/server.js';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture(builtins: BuiltinExtensionName[] = ['subagents', 'askUser'], skill = false) {
  let broker: InteractionBroker | undefined;
  const requests: RegistryOpenRequest[] = [];
  const scopes = new Map<string, { runtime: AgentRuntime; sessions: SessionsService; openWorker: import('@felan-ai/agent-core').HostWorkerLauncher }>();
  let composition!: SessionRuntime;
  let currentRegistry!: SessionRegistry;
  const localRoots = createLocalExecutionRoots();
  const roots = { ...localRoots, async open(context, port) {
    const root = await localRoots.open(context, port);
    return root;
  } } satisfies ReturnType<typeof createLocalExecutionRoots>;
  const f = await serverFixture({ now: Date.now, deferActivation: true, builtins, skill,
    extensionPackages: builtins.map(name => builtinExtensionPackages[name]),
    async openServiceScope(context) {
      const services = createFelanServiceRegistry();
      const lifecycles = new Set<import('@felan-ai/agent-core').RuntimeLifecycle>();
      const sessions: import('@felan-ai/agent-core').SessionsService = {
        ...createRegistrySessionsService(currentRegistry, context.execution!.port.current, context.runtime.cwd),
      };
      const openWorker = context.execution!.port.openWorker;
      scopes.set(context.sessionId, { runtime: context.runtime, sessions, openWorker });
      services.set(HOST_WORKERS_SERVICE, openWorker);
      services.set(RUNTIME_LIFETIME_SERVICE, { register(lifecycle) {
        lifecycles.add(lifecycle); return () => { lifecycles.delete(lifecycle); };
      } });
      services.set(HOST_RUNTIME_SERVICE, { create: (cwd, options) => new HostAgentRuntime(cwd, options) });
      services.set(SESSIONS_SERVICE, sessions);
      services.set(SESSIONS_HISTORY_SERVICE, createReadOnlySessionsService(sessions));
      services.set(MODELS_SERVICE, createLocalModelsService({ modelRuntime: context.modelRuntime, sessionId: context.sessionId,
        ...(context.allowedModels ? { getAllowedModels: () => context.allowedModels! } : {}) }));
      return { services, inlineExtensions: [], busy: () => [...lifecycles].some(lifecycle => lifecycle.busy()),
        async activate() {}, async settle(mode) { await Promise.all([...lifecycles].map(lifecycle => lifecycle.settle(mode ?? 'force'))); },
        async dispose() { await Promise.all([...lifecycles].map(lifecycle => lifecycle.dispose())); services.revoke(); } };
    },
    createComposition(runtimeFactory) {
      const base = createLocalSessionRuntime({ initializeProcess: async () => ({ diagnostics: [], assertConfiguration: () => [] }),
        runtimeService: { create: (cwd, options) => new HostAgentRuntime(cwd, options) }, runtimeFactory });
      composition = { ...base, bindExtensions: createLocalExecutionServices(roots) };
      return composition;
    },
    servicesFactory: registry => {
      currentRegistry = registry;
      broker = createRegistryInteractionBroker(registry, {  });
      const services = createDaemonExecutionServices(registry, broker, composition);
      return input => { requests.push(input.request); return services(input); };
    } });
  cleanups.push(async () => { await broker!.drain(); await f.dispose(); });
  return { ...f, broker: broker!, composition, requests, scopes, host: (id: string) => f.registry.executionHost(id) };
}

it('assembles real root tools and a registered root subagent host', async () => {
  const f = await fixture();
  expect(f.root.runtime.session.getAllTools().map(tool => tool.name)).toEqual(expect.arrayContaining(['Agent', 'ask_user']));
  const host = f.host(f.root.sessionId);
  expect(f.root.runtime.session.getAllTools().find(tool => tool.name === 'Agent')?.parameters).toBeDefined();
  expect(host.hasActiveJobs()).toBe(false);
});

it('supplies required services to package-owned execution entries', async () => {
  const f = await fixture(['memory', 'subagents', 'askUser', 'tasks', 'prewalk', 'modelTools', 'insights', 'sessionTitle', 'promptHistory']);
  expect(f.root.diagnostics.filter(diagnostic => diagnostic.message.includes('required service'))).toEqual([]);
  expect(f.root.runtime.session.getAllTools().map(tool => tool.name)).toEqual(expect.arrayContaining(['Agent', 'ask_user', 'TaskCreate']));
  const commands = f.root.runtime.session.extensionRunner?.getRegisteredCommands().map(command => command.name);
  expect(commands).toEqual(expect.arrayContaining(['insights', 'prewalk', 'prompt-history', 'savings']));
});

it('assigns project scope at the known skill source and exposes portable savings output', async () => {
  const f = await fixture(['subagents', 'askUser'], true);
  expect(f.root.runtime.session.resourceLoader.getSkills().skills.find(skill => skill.name === 'shared-test-skill')?.sourceInfo.scope).toBe('project');
  await f.root.runtime.session.prompt('/savings');
  expect(f.registry.projection(f.root.sessionId).snapshot().presentation).toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: 'notification', text: expect.stringContaining('Felan Code estimated savings') }),
  ]));
});

it('scopes execution controls to each child session', async () => {
  const f = await fixture(); const host = f.host(f.root.sessionId);
  const first = await host.spawnSession({ label: 'general', description: 'first child', prompt: 'first', model: { provider: 'offline', id: 'fixture' } });
  expect(first.ok).toBe(true); if (!first.ok) return;
  const second = await host.spawnSession({ label: 'general', description: 'second child', prompt: 'second', model: { provider: 'offline', id: 'fixture' } });
  expect(second.ok).toBe(true); if (!second.ok) return;
  await vi.waitFor(() => expect(host.getExecution(first.value.executionId)?.status).toBe('completed'));
  await vi.waitFor(() => expect(host.getExecution(second.value.executionId)?.status).toBe('completed'));
  await host.settle();
  const childId = host.getExecution(first.value.executionId)!.sessionId!;
  const childHost = f.host(childId);
  expect(childHost).not.toBe(host);
  expect(f.requests.some(request => request.parentSessionId === f.root.sessionId)).toBe(true);
  expect((await childHost.getResult(second.value.executionId)).ok).toBe(false);
  expect((await host.scopeToSession(childId).getResult(second.value.executionId)).ok).toBe(false);
  expect(() => host.scopeToSession('unknown-session')).toThrow();
});

it('passes the child definition label to local preparation and extension binding', async () => {
  const f = await fixture();
  const prepare = vi.spyOn(f.composition, 'prepare');
  const bindExtensions = vi.spyOn(f.composition, 'bindExtensions');
  const host = f.host(f.root.sessionId);
  const child = await host.spawnSession({ label: 'explore', description: 'Inspect', prompt: 'Inspect the implementation',
    model: { provider: 'offline', id: 'fixture' } });
  if (!child.ok) throw new Error(child.error.message);
  const id = child.value.executionId;
  expect(prepare.mock.calls.find(([context]) => context.session.id === id)?.[0].execution).toEqual({ label: 'explore' });
  expect(bindExtensions.mock.calls.find(([context]) => context.sessionManager.getSessionId() === id)?.[0].execution).toEqual({ label: 'explore' });
  await vi.waitFor(() => expect(host.getExecution(id)?.status).toBe('completed'));
  await host.settle();
});

it('disposes explicitly idle-safe services during eviction and rebuilds them on restore', async () => {
  const f = await fixture(); const original = f.host(f.root.sessionId);
  expect(await f.registry.evictIdle()).toContain(f.root.sessionId);
  expect(f.registry.binding(f.root.sessionId)).toBeUndefined();
  await f.registry.restore(f.root.sessionId);
  expect(f.host(f.root.sessionId)).not.toBe(original);
  expect(f.registry.binding(f.root.sessionId)?.runtime.session.getAllTools().map(tool => tool.name)).toContain('Agent');
});

it('keeps a root host alive while a child runtime remains warm', async () => {
  const f = await fixture(); const host = f.host(f.root.sessionId);
  const child = await host.spawnSession({ label: 'general', description: 'attached child', prompt: 'child', model: { provider: 'offline', id: 'fixture' } });
  expect(child.ok).toBe(true); if (!child.ok) return;
  await vi.waitFor(() => expect(host.getExecution(child.value.executionId)?.status).toBe('completed')); await host.settle();
  const childId = host.getExecution(child.value.executionId)!.sessionId!;
  const attachment = await f.registry.attach(childId, { principal: 'fixture', kind: 'tui' });
  expect(await f.registry.evictIdle()).not.toContain(f.root.sessionId);
  expect(f.host(f.root.sessionId)).toBe(host);
  f.registry.detach(childId, attachment.attachment);
});

it('installs the package-owned memory control command with core services', async () => {
  const f = await fixture(['memory', 'subagents']);
  expect(f.root.runtime.session.extensionRunner?.getRegisteredCommands().some(command => command.name === 'memory')).toBe(true);
  await f.registry.beginDrain(); await f.registry.waitForDrain();
});

it('does not install commands, statuses or start memory work when memory is not loaded', async () => {
  const f = await fixture([]);
  await f.root.runtime.session.prompt('An ordinary turn without memory.');
  expect(f.root.runtime.session.extensionRunner?.getRegisteredCommands().some(command => command.name === 'memory')).toBe(false);
  expect(f.registry.projection(f.root.sessionId).snapshot().presentation.some(item => JSON.stringify(item).includes('memory'))).toBe(false);
  expect(f.registry.list().map(session => session.id)).toEqual([f.root.sessionId]);
  await expect(lstat(join(f.directory, 'agent', 'memory'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('admits a retained memory journal through host workers and persists its worker messages through Runtime', async () => {
  const f = await fixture(['memory']);
  const environment = f.scopes.get(f.root.sessionId)!;
  const { runtime, openWorker } = environment;
  const run = await LocalMemoryRun.create(environment, {
    projectDirectory: join(f.directory, 'agent', 'memory', 'v1', 'projects', 'fixture'),
    sessionDirectory: join(f.root.resources.sessionDir, 'memory'),
    projectKey: 'fixture', projectRoot: f.cwd, checkpoints: [], baseFingerprint: '1'.repeat(64),
  });
  const worker = await openWorker({
    runtime: new HostAgentRuntime(run.workspace, { pathAccess: 'host',
      sessionStorageRoot: runtime.storage('session').root, agentStorageRoot: runtime.storage('agent').root }),
    sessionManager: run.sessionManager, settingsManager: SettingsManager.inMemory(),
    model: { provider: 'offline', id: 'fixture' }, allowedTools: ['read'],
  });
  try {
    await worker.bindExtensions({ mode: 'print' });
    worker.setActiveToolsByName(['read']);
    await worker.prompt('Inspect the staged memory.');
    await run.finish('completed');
    expect(f.registry.list()).toContainEqual(expect.objectContaining({ id: run.metadata.sessionId, parent: f.root.sessionId }));
    const journal = new TextDecoder().decode(await runtime.readFile(run.sessionManager.getSessionFile()!));
    expect(journal).toContain('Inspect the staged memory.');
    expect(journal).toContain('"role":"assistant"');
  } finally { await worker.dispose(); }
});
