import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  HOST_MAINTENANCE_SERVICE, HOST_MODELS_SERVICE, MODELS_SERVICE, SESSIONS_SERVICE,
  HostAgentRuntime, createExtensionServiceAccess, createFelanServiceRegistry,
  type Api, type AssistantMessage, type FelanExtensionAPI, type HostMaintenance,
  type Model, type ModelRuntime, type ModelsService,
} from '@felan-ai/agent-core';
import { createConfiguredProviders, loadHostConfig } from '@felan-ai/daemon/daemon-bootstrap';
import { MEMORY_SCHEDULER_SERVICE } from '@felan-ai/ext-memory/daemon';
import { afterEach, describe, expect, it, vi } from 'vitest';
import hostModels from '../src/providers/host-models.js';
import { importLocalExtension } from '../src/providers/extensions.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
});

async function directory() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'felan-host-models-')));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  return root;
}

function runtimeFixture() {
  const model: Model<Api> = {
    id: 'test', provider: 'fixture', name: 'Test', api: 'openai-responses',
    reasoning: false, input: ['text'], contextWindow: 8_192, maxTokens: 1_024,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, baseUrl: 'https://invalid.test',
  };
  const response: AssistantMessage = {
    role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id,
    stopReason: 'stop', timestamp: 0,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  };
  const runtime = {
    getAvailable: vi.fn(async () => [model]),
    getAvailableOfType: vi.fn(async () => []),
    completeSimple: vi.fn(async () => response),
    classify: vi.fn(),
  };
  return { model, response, runtime, modelRuntime: runtime as unknown as ModelRuntime };
}

describe('host models', () => {
  it('resolves maintenance only at activation and drains in-flight inference without a session', async () => {
    const agentDir = await directory();
    const f = runtimeFixture();
    const registry = createFelanServiceRegistry();
    const services = createExtensionServiceAccess(registry, { required: [HOST_MAINTENANCE_SERVICE] });
    const instance = await hostModels.create({ services, options: undefined, signal: new AbortController().signal });
    cleanups.push(() => instance.dispose());
    const models = instance.implementations[0]!.value as ModelsService;
    await expect(models.getAvailable()).rejects.toThrow('before activation');
    expect(f.runtime.getAvailableOfType).not.toHaveBeenCalled();
    registry.set(HOST_MAINTENANCE_SERVICE, { agentDir, modelRuntime: f.modelRuntime } as HostMaintenance);
    await instance.activate!();
    expect(await models.getAvailable()).toEqual([expect.objectContaining({ id: 'test' })]);
    expect(models.classifier!.canEvaluate!({}, {})).toBe(false);
    let finish!: (message: AssistantMessage) => void;
    f.runtime.completeSimple.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const pending = models.completeSimple(f.model, { messages: [] });
    await vi.waitFor(() => expect(f.runtime.completeSimple).toHaveBeenCalledOnce());
    expect(instance.busy!()).toBe(true);
    let settled = false;
    const draining = instance.settle!('drain').then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    await expect(models.getAvailable()).rejects.toThrow('settling');
    finish(f.response);
    await expect(pending).resolves.toEqual(f.response);
    await draining;
    expect(instance.busy!()).toBe(false);
  });

  it('selects the configured classifier and aborts model calls on forced shutdown', async () => {
    const agentDir = await directory();
    await writeFile(join(agentDir, 'settings.json'), JSON.stringify({ felanClassifier: { model: 'local/chosen' } }));
    const f = runtimeFixture();
    const classifier = { type: 'classifier', provider: 'local', id: 'chosen', api: 'typesafe-system-one',
      name: 'Chosen', input: ['text'], contextWindow: 64_000, cost: { input: 0, output: 0 } };
    f.runtime.getAvailableOfType.mockResolvedValue([classifier] as never);
    const registry = createFelanServiceRegistry();
    registry.set(HOST_MAINTENANCE_SERVICE, { agentDir, modelRuntime: f.modelRuntime } as HostMaintenance);
    const instance = await hostModels.create({
      services: createExtensionServiceAccess(registry, { required: [HOST_MAINTENANCE_SERVICE] }),
      options: undefined, signal: new AbortController().signal,
    });
    cleanups.push(() => instance.dispose());
    await instance.activate!();
    const models = instance.implementations[0]!.value as ModelsService;
    const questions = { ready: { type: 'bool' as const, instructions: 'Is it ready?', criteria: { true: 'Ready', false: 'Not ready' } } };
    f.runtime.classify.mockResolvedValue({ stopReason: 'stop', answers: { ready: { type: 'bool', probability: 1 } } });
    expect(models.classifier!.canEvaluate!({ ready: true }, questions)).toBe(true);
    await models.classifier!.classify({ ready: true }, questions);
    expect(f.runtime.classify).toHaveBeenCalledWith(classifier, expect.anything(), expect.objectContaining({ signal: expect.any(AbortSignal) }));
    let requestSignal!: AbortSignal;
    f.runtime.completeSimple.mockImplementation((_model: unknown, _context: unknown, options: { signal: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        requestSignal = options.signal;
        requestSignal.addEventListener('abort', () => reject(requestSignal.reason), { once: true });
      }));
    const pending = models.completeSimple(f.model, { messages: [] });
    const rejected = expect(pending).rejects.toThrow('aborted');
    await vi.waitFor(() => expect(f.runtime.completeSimple).toHaveBeenCalledOnce());
    await instance.settle!('force');
    await rejected;
    expect(requestSignal.aborted).toBe(true);
    expect(models.classifier!.canEvaluate!({}, questions)).toBe(false);
  });

  it('loads the packaged providers and shares the scheduler coordinator with the installed extension', async () => {
    const agentDir = await directory();
    const cwd = join(agentDir, 'workspace');
    await mkdir(cwd);
    const project = join(agentDir, 'memory', 'v1', 'projects', createHash('sha256').update(cwd).digest('hex'));
    await mkdir(project, { recursive: true });
    await writeFile(join(project, 'project.json'), JSON.stringify({ version: 1, canonicalRoot: cwd }));
    const manager = {
      packageName: '@felan-ai/felan', version: '0.36.0',
      resolveFrom: new URL('../dist/daemon-host.js', import.meta.url).href,
      resolveProvider: (specifier: string) => import.meta.resolve(specifier),
      packagedDefaultPath: fileURLToPath(new URL('../dist/host.json', import.meta.url)),
    };
    const config = await loadHostConfig({ agentDir, packagedDefaultPath: manager.packagedDefaultPath });
    const loaded = await createConfiguredProviders({ config: config.config, manager });
    cleanups.push(() => loaded.dispose());
    expect(loaded.services.get(HOST_MODELS_SERVICE)).toBeDefined();
    const scheduler = loaded.services.get(MEMORY_SCHEDULER_SERVICE)!;
    expect(scheduler).toBeDefined();
    const f = runtimeFixture();
    const registry = { assertNewWork: vi.fn(), assertHostWork: vi.fn(), assertAdmission: vi.fn(), listed: () => [] };
    const configuration = { get: async () => ({ values: {} }) };
    loaded.maintenance.bind({ agentDir, modelRuntime: f.modelRuntime, registry: registry as never, configuration: configuration as never });
    const sharedModule = await import(new URL('./local/shared.js', import.meta.resolve('@felan-ai/ext-memory')).href);
    const shared = sharedModule.acquireSharedLocalMemoryCoordinator({ agentDir });
    cleanups.push(() => shared.release());
    const attach = vi.spyOn(shared.coordinator, 'attach');
    await loaded.activate();
    expect(await scheduler.status()).toEqual([{ projectRoot: cwd, status: expect.objectContaining({ enabled: true }) }]);
    expect(attach).toHaveBeenCalledWith(expect.objectContaining({ persistent: true, scheduling: true }));
    const extension = await importLocalExtension('@felan-ai/ext-memory') as { default: (api: FelanExtensionAPI) => void };
    const handlers = new Map<string, () => Promise<void>>();
    extension.default({
      runtime: new HostAgentRuntime(cwd, { agentDir, pathAccess: 'host', agentStorageRoot: agentDir,
        sessionStorageRoot: join(agentDir, 'reader') }), agentDir,
      services: { get: (contract: { key: string }) => contract.key === MODELS_SERVICE.key ? loaded.services.get(HOST_MODELS_SERVICE)
        : contract.key === SESSIONS_SERVICE.key ? { current: { id: 'reader', root: 'host' } } : undefined },
      on: (event: string, handler: () => Promise<void>) => handlers.set(event, handler),
      registerCapability: vi.fn(), registerCommand: vi.fn(),
    } as unknown as FelanExtensionAPI);
    cleanups.push(() => handlers.get('session_shutdown')!());
    expect(attach).toHaveBeenCalledTimes(2);
    await loaded.settle('drain');
    expect(await scheduler.status()).toEqual([]);
  });
});
