import { afterEach, describe, expect, it, vi } from 'vitest';
import { Type } from 'typebox';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { HostAgentRuntime, InMemoryCredentialStore, ModelRuntime, SessionManager, SettingsManager } from '@felan-ai/agent-core';
import type { ProviderWorkerRequest } from '../src/daemon/provider.js';
import { SessionRegistry } from '../src/daemon/registry.js';
import { createRegisteredWorkerLauncher } from '../src/daemon/worker.js';
import { DaemonControlStore } from '../src/daemon/control-store.js';
import { createRuntimeStorageRequest } from '../src/runtime-factory.js';
import { fixture as registryFixture, fixtures, offlineModel } from './fixtures/registry.js';
import { createTestSessionLifecycle, createTestSessionRuntime } from './fixtures/session-runtime.js';
import { serverFixture } from './fixtures/server.js';

afterEach(async () => { for (const cleanup of fixtures.splice(0)) await cleanup(); });

function fixture() {
  const canonical = { provider: 'provider', id: 'model', baseUrl: 'https://canonical.invalid' };
  const session = { prompt: vi.fn(async () => {}), abort: vi.fn(async () => {}), dispose: vi.fn(),
    bindExtensions: vi.fn(async () => {}), setActiveToolsByName: vi.fn(), getActiveToolNames: () => ['read'], messages: [], thinkingLevel: 'medium' };
  const registry = { assertNewWork: vi.fn(), assertDispatch: vi.fn(),
    openWorker: vi.fn(async () => ({ sessionId: 'worker', runtime: { session } })),
    close: vi.fn(async () => {}), projection: () => ({ setOrigin: vi.fn() }),
    runWorker: vi.fn(async (_id: string, work: () => Promise<void>) => work()) };
  const models = { getAvailable: vi.fn(async () => [canonical]) };
  const open = createRegisteredWorkerLauncher(registry as unknown as SessionRegistry, { id: 'parent', root: 'parent' }, models as unknown as ModelRuntime,
    [{ provider: 'provider', id: 'model' }]);
  const request = { runtime: {}, sessionManager: {}, settingsManager: {}, model: { provider: 'provider', id: 'model' }, allowedTools: ['read'] } as ProviderWorkerRequest;
  return { canonical, session, registry, models, open, request };
}

describe('admitted worker launcher', () => {
  it('binds the wrapped worker runtime to its own lifetime', async () => {
    const f = await serverFixture();
    const lifecycle = await createTestSessionLifecycle({ agentDir: f.owner.target.agentDir,
      wrapRuntime: (runtime, request) => f.registry.wrapOpeningRuntime(runtime, request.rootSessionId),
    });
    fixtures.push(async () => { await f.dispose(); await lifecycle.dispose(); });
    f.registry.options.lifecycle = lifecycle;
    const workspace = join(f.root.resources.sessionStorageBase, f.root.sessionId, 'worker'); await mkdir(workspace, { recursive: true });
    const manager = SessionManager.create(f.cwd, f.root.resources.sessionDir);
    await writeFile(manager.getSessionFile()!, JSON.stringify(manager.getHeader()) + '\n');
    const original = new HostAgentRuntime(workspace, createRuntimeStorageRequest(workspace, f.owner.target.agentDir, f.root.sessionId));
    const worker = await f.registry.openWorker(f.root.sessionId, {
      runtime: original, modelRuntime: f.root.runtime.session.modelRuntime, model: offlineModel, sessionManager: manager,
      settingsManager: SettingsManager.create(workspace, f.owner.target.agentDir), allowedTools: ['read'],
    });
    const runtime = worker.agentRuntime;
    expect(runtime).not.toBe(original);
    const content = new TextEncoder().encode('worker artifact');
    await runtime.writeFile('artifact.txt', content);
    expect(await runtime.readFile('artifact.txt')).toEqual(content);
    const process = await runtime.processes!.startShell('printf worker-output');
    expect(f.registry.processes.list(f.root.sessionId)).toContainEqual(expect.objectContaining({
      session: worker.sessionId, root: f.root.sessionId,
    }));
    await process.dispose();
    await f.registry.close(worker.sessionId);
    await expect(runtime.readFile('artifact.txt')).rejects.toThrow('Session runtime is closed to new work.');
    await expect(runtime.writeFile('artifact.txt', content)).rejects.toThrow('Session runtime is closed to new work.');
    await expect(f.root.agentRuntime.readFile(join(workspace, 'artifact.txt'))).resolves.toEqual(content);
  });

  it('passes worker identity to the host stream wrapper before dispatching inference', async () => {
    const stream = vi.fn();
    const wrapped = vi.fn();
    const wrapWorkerStream = vi.fn<NonNullable<import('../src/daemon/session-runtime.js').SessionRuntime['wrapWorkerStream']>>(
      () => original => (...args) => { wrapped(); return original(...args); },
    );
    const f = await serverFixture({ onStream: async () => { stream(); },
      createComposition: runtimeFactory => ({ ...createTestSessionRuntime({ runtimeFactory }), wrapWorkerStream }),
    });
    fixtures.push(() => f.dispose());
    const workspace = join(f.root.resources.sessionStorageBase, f.root.sessionId, 'worker'); await mkdir(workspace, { recursive: true });
    const manager = SessionManager.create(f.cwd, f.root.resources.sessionDir);
    await writeFile(manager.getSessionFile()!, JSON.stringify(manager.getHeader()) + '\n');
    const worker = await f.registry.openWorker(f.root.sessionId, {
      runtime: new HostAgentRuntime(workspace, createRuntimeStorageRequest(workspace, f.owner.target.agentDir, f.root.sessionId)),
      modelRuntime: f.root.runtime.session.modelRuntime, model: offlineModel,
      sessionManager: SessionManager.open(manager.getSessionFile()!, f.root.resources.sessionDir, f.cwd),
      settingsManager: SettingsManager.create(workspace, f.owner.target.agentDir), allowedTools: ['read'],
    });
    expect(wrapWorkerStream).toHaveBeenCalledExactlyOnceWith({ id: worker.sessionId, root: f.root.sessionId, parent: f.root.sessionId });
    await f.registry.runWorker(worker.sessionId, () => worker.runtime.session.prompt('Do the work'));
    expect(wrapped).toHaveBeenCalledOnce();
    expect(stream).toHaveBeenCalledOnce();
    expect(wrapped.mock.invocationCallOrder[0]).toBeLessThan(stream.mock.invocationCallOrder[0]!);
  });

  it('re-resolves the model and opens only through the canonical registry', async () => {
    const f = fixture();
    const worker = await f.open({ ...f.request, model: { ...f.request.model, baseUrl: 'https://caller.invalid' } as ProviderWorkerRequest['model'] });
    expect(f.registry.openWorker).toHaveBeenCalledWith('parent', expect.objectContaining({ model: f.canonical, allowedTools: ['read'] }));
    await worker.bindExtensions({ mode: 'print' });
    expect(f.session.bindExtensions).toHaveBeenCalledWith({ mode: 'print' });
    worker.setActiveToolsByName(['read']);
    expect(() => worker.setActiveToolsByName(['bash'])).toThrow('cannot widen');
    await worker.prompt('work');
    expect(f.registry.runWorker).toHaveBeenCalledWith('worker', expect.any(Function));
    await worker.dispose();
    expect(f.registry.close).toHaveBeenCalledWith('worker');
    expect(f.session.dispose).not.toHaveBeenCalled();
  });

  it('rejects unavailable or disallowed models before canonical registration', async () => {
    const f = fixture();
    await expect(f.open({ ...f.request, model: { provider: 'other', id: 'model' } })).rejects.toThrow('outside the current scope');
    expect(f.registry.openWorker).not.toHaveBeenCalled();
    f.models.getAvailable.mockResolvedValueOnce([]);
    await expect(f.open(f.request)).rejects.toThrow('unavailable');
    expect(f.registry.openWorker).not.toHaveBeenCalled();
  });

  it('closes a newly registered worker if cancellation wins during opening', async () => {
    const f = fixture();
    const control = new AbortController();
    f.registry.openWorker.mockImplementationOnce(async () => {
      control.abort();
      return { sessionId: 'worker', runtime: { session: f.session } };
    });
    await expect(f.open({ ...f.request, signal: control.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(f.registry.close).toHaveBeenCalledWith('worker');
    expect(f.session.prompt).not.toHaveBeenCalled();
  });

  it('loads root extension paths for workers, retaining paths and tool restrictions after restart', async () => {
    const f = await registryFixture(); await f.registry.shutdown();
    const path = join(f.cwd, 'host-extension.ts');
    await writeFile(path, `export default pi => { pi.registerTool({ name: 'host_probe', label: 'Probe', description: 'Probe',
      parameters: { type: 'object', properties: {} }, async execute() { return { content: [{ type: 'text', text: 'probe' }] }; } }); };`);
    let registry: SessionRegistry;
    let store = f.store;
    const profile = await createTestSessionLifecycle({ agentDir: f.owner.target.agentDir,
      runtimeFactory: request => registry.wrapOpeningRuntime(new HostAgentRuntime(request.cwd, request), request.rootSessionId),
      createModelRuntime: async () => {
        const models = await ModelRuntime.create({ modelsPath: null, credentials: new InMemoryCredentialStore(), refreshOnCreate: false });
        models.registerProvider('offline', { api: 'openai-completions', baseUrl: offlineModel.baseUrl, apiKey: 'fixture', models: [offlineModel] });
        return models;
      } });
    fixtures.push(() => profile.dispose());
    const create = () => new SessionRegistry({ ...f.registry.options, store, lifecycle: profile });
    registry = create(); f.replaceRegistry(registry, store);
    const root = await registry.create({ cwd: f.cwd, target: { kind: 'new' }, extensionPaths: [path], model: offlineModel });
    expect(root.runtime.session.getActiveToolNames()).toContain('host_probe');
    const workspace = join(root.resources.sessionStorageBase, root.sessionId, 'worker'); await mkdir(workspace, { recursive: true });
    const manager = SessionManager.create(f.cwd, root.resources.sessionDir);
    await writeFile(manager.getSessionFile()!, JSON.stringify(manager.getHeader()) + '\n');
    const worker = await registry.openWorker(root.sessionId, {
      runtime: new HostAgentRuntime(workspace, createRuntimeStorageRequest(workspace, f.owner.target.agentDir, root.sessionId)),
      modelRuntime: root.runtime.session.modelRuntime, model: offlineModel, sessionManager: manager,
      settingsManager: SettingsManager.create(workspace, f.owner.target.agentDir), allowedTools: ['read'],
    });
    expect(worker.runtime.session.getAllTools().map(tool => tool.name)).toContain('host_probe');
    expect(worker.runtime.session.getActiveToolNames()).toEqual(['read']);
    expect(store.session(worker.sessionId).profile).toEqual({ extensionPaths: [path], allowedTools: ['read'] });
    await registry.shutdown(); store.close();
    store = new DaemonControlStore(f.owner); registry = create(); f.replaceRegistry(registry, store);
    const restored = await registry.restore(worker.sessionId);
    expect(store.session(worker.sessionId).profile?.extensionPaths).toEqual([path]);
    expect(restored.runtime.session.getAllTools().map(tool => tool.name)).toContain('host_probe');
    expect(restored.runtime.session.getActiveToolNames()).toEqual(['read']);
  });

  it('reopens a closed worker without its custom tools and never widens its stored tool set', async () => {
    const f = await registryFixture(); await f.registry.shutdown();
    let registry: SessionRegistry;
    let store = f.store;
    const profile = await createTestSessionLifecycle({ agentDir: f.owner.target.agentDir,
      runtimeFactory: request => registry.wrapOpeningRuntime(new HostAgentRuntime(request.cwd, request), request.rootSessionId),
      createModelRuntime: async () => {
        const models = await ModelRuntime.create({ modelsPath: null, credentials: new InMemoryCredentialStore(), refreshOnCreate: false });
        models.registerProvider('offline', { api: 'openai-completions', baseUrl: offlineModel.baseUrl, apiKey: 'fixture', models: [offlineModel] });
        return models;
      } });
    fixtures.push(() => profile.dispose());
    const create = () => new SessionRegistry({ ...f.registry.options, store, lifecycle: profile });
    registry = create(); f.replaceRegistry(registry, store);
    const root = await registry.create({ cwd: f.cwd, target: { kind: 'new' }, model: offlineModel });
    const workspace = join(root.resources.sessionStorageBase, root.sessionId, 'worker'); await mkdir(workspace, { recursive: true });
    const manager = SessionManager.create(f.cwd, root.resources.sessionDir);
    await writeFile(manager.getSessionFile()!, JSON.stringify(manager.getHeader()) + '\n');
    const stageProbe = { name: 'stage_probe', label: 'Stage probe', description: 'Probe', parameters: Type.Object({}),
      async execute() { return { content: [{ type: 'text' as const, text: 'probe' }], details: {} }; } };
    const worker = await registry.openWorker(root.sessionId, {
      runtime: new HostAgentRuntime(workspace, createRuntimeStorageRequest(workspace, f.owner.target.agentDir, root.sessionId)),
      modelRuntime: root.runtime.session.modelRuntime, model: offlineModel, sessionManager: manager,
      settingsManager: SettingsManager.create(workspace, f.owner.target.agentDir), allowedTools: ['read', 'stage_probe'], customTools: [stageProbe],
    });
    expect(worker.runtime.session.getActiveToolNames().sort()).toEqual(['read', 'stage_probe']);
    await registry.close(worker.sessionId);
    const reopened = await registry.adopt(worker.sessionId, {});
    expect(reopened.runtime.session.getAllTools().map(tool => tool.name)).not.toContain('stage_probe');
    expect(reopened.runtime.session.getActiveToolNames()).toEqual(['read']);
  });
});
