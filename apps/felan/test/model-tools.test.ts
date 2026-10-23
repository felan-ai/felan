import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  HostAgentRuntime,
  InMemoryCredentialStore,
  ModelRuntime,
  MODELS_SERVICE,
  SessionManager,
  createExtensionServiceAccess,
  createFelanServiceRegistry,
  type AgentSession,
  type Classifier,
  type ConfiguredFelanExtension,
  type FelanExtensionAPI,
  type ImageApi,
  type ImageModel,
  type Model,
  type ToolDefinition,
} from '@felan-ai/agent-core';
import { client, methods } from '@agentclientprotocol/sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  builtinExtensionPackages,
  importLocalExtension,
} from '../src/providers/extensions.js';
import { DAEMON_VERSION } from '@felan-ai/daemon';
import { composeLocalSession } from './fixtures/local-composition.js';
import { createFelanAcpService } from '../src/acp/server.js';
import { SessionClient, type SessionClientOptions } from '../src/client/client.js';
import { DaemonConfiguration } from '../src/providers/configuration.js';
import { DaemonControlStore } from '../../daemon/src/daemon/control-store.js';
import { createTestLocalSessionLifecycle as createLocalDaemonProfile } from './providers/fixtures/session-runtime.js';
import { createLocalModelsService } from '../src/providers/models.js';
import { acquireDaemonOwnership } from '../../daemon/src/daemon/ownership.js';
import { SessionRegistry } from '../../daemon/src/daemon/registry.js';
import { SessionServer } from '../../daemon/src/daemon/server.js';

const temporaryPaths: string[] = [];
const imageModel: ImageModel<ImageApi> = {
  type: 'image', id: 'offline-image', name: 'Offline Image', provider: 'offline',
  api: 'openai-images', baseUrl: 'https://example.invalid', input: ['text'], output: ['image'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const chatModel: Model<'anthropic-messages'> = {
  id: 'offline-chat', name: 'Offline Chat', provider: 'offline', api: 'anthropic-messages',
  baseUrl: 'https://example.invalid', input: ['text'], reasoning: false,
  contextWindow: 100_000, maxTokens: 4096,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const questions = {
  verdict: { type: 'choice' as const, instructions: 'Choose a verdict.', criteria: { pass: 'Valid', fail: 'Invalid' } },
};

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('local model-tools binding', () => {
  it.each([
    { classifier: false, images: false, tools: [] },
    { classifier: true, images: false, tools: ['classify'] },
    { classifier: false, images: true, tools: ['generate_images'] },
    { classifier: true, images: true, tools: ['classify', 'generate_images'] },
  ])('registers only supported tools: $tools', async ({ classifier, images, tools }) => {
    const models = await offlineModels(images);
    const classify = vi.fn();
    const importExtension = vi.fn(importLocalExtension);
    const registered = await registerTools(importExtension, classifier ? { classify } : undefined, models);
    expect(importExtension).toHaveBeenCalledExactlyOnceWith(builtinExtensionPackages.modelTools);
    expect([...registered.keys()].sort()).toEqual(tools);
    expect(vi.mocked(models.getAvailableOfType).mock.calls.some(call => call[0] === 'image')).toBe(true);
    expect(models.generateImages).not.toHaveBeenCalled();
    expect(classify).not.toHaveBeenCalled();
  });

  it.each([false, true])('suppresses only image tools on discovery failure (classifier=%s)', async (hasClassifier) => {
    const models = await offlineModels(true);
    vi.mocked(models.getAvailableOfType).mockRejectedValue(new Error('Offline discovery failure'));
    const tools = await registerTools(importLocalExtension, hasClassifier ? { classify: vi.fn() } : undefined, models);
    expect([...tools.keys()]).toEqual(hasClassifier ? ['classify'] : []);
    expect(models.generateImages).not.toHaveBeenCalled();
  });

  it.each([false, true])('keeps the service-backed default usable without an optional model provider (classifier=%s)', async (hasClassifier) => {
    const tools = await registerTools(importLocalExtension, hasClassifier ? { classify: vi.fn() } : undefined);
    expect([...tools.keys()]).toEqual(hasClassifier ? ['classify'] : []);
  });

  it('uses the effective custom classifier and forwards the cancellation signal', async () => {
    const models = await offlineModels(false);
    const classify = vi.fn().mockResolvedValue({ answers: { verdict: { type: 'choice', choice: 'pass' } } });
    const tools = await registerTools(importLocalExtension, { classify }, models);
    const signal = new AbortController().signal;
    const state = { evidence: 'offline fixture' };
    const result = await tools.get('classify')!.execute('test', { state, questions }, signal, undefined, {} as never);
    expect(classify).toHaveBeenCalledExactlyOnceWith(state, questions, signal);
    expect(result.details).toMatchObject({ answers: { verdict: { type: 'choice', choice: 'pass' } } });
    expect(models.generateImages).not.toHaveBeenCalled();
  });

  it('lists models from the injected runtime and rechecks availability', async () => {
    const models = await offlineModels(true);
    const tools = await registerTools(importLocalExtension, undefined, models);
    const list = () => tools.get('generate_images')!.execute('list', { action: 'list' }, undefined, undefined, {} as never);
    expect((await list()).details).toEqual({ models: [{
      provider: imageModel.provider, model: imageModel.id, name: imageModel.name,
      input: imageModel.input, output: imageModel.output,
    }] });
    vi.mocked(models.getAvailableOfType).mockResolvedValue([]);
    expect((await list()).details).toEqual({ models: [] });
    expect(models.generateImages).not.toHaveBeenCalled();
  });
});

describe('model-tools session lifecycle', () => {
  it('binds tools in fresh, resumed and changed-cwd provider compositions', async () => {
    const setup = await environment();
    const classify = vi.fn().mockResolvedValue({ answers: { verdict: { type: 'choice', choice: 'pass' } } });
    const original = SessionManager.create(setup.cwd, setup.sessionDir);
    original.appendMessage({ role: 'user', content: 'offline prompt', timestamp: Date.now() });
    original.appendMessage(assistantMessage());
    const nextCwd = join(setup.homeDir, 'workspace-b');
    await mkdir(nextCwd);
    for (const manager of [original, SessionManager.open(original.getSessionFile()!), SessionManager.create(nextCwd, setup.sessionDir)]) {
      const models = await offlineModels(true);
      const result = await composeLocalSession({ ...setup, cwd: manager.getCwd(), modelRuntime: models,
        sessionManager: manager, extensionPackages: [builtinExtensionPackages.modelTools],
        runtimeFactory: request => new HostAgentRuntime(request.cwd, { ...request, classifier: { classify } }),
      });
      try {
        await result.session.bindExtensions({ mode: 'print' });
        expect(result.session.getToolDefinition('generate_images')).toBeDefined();
        const tool = result.session.agent.state.tools.find(({ name }) => name === 'classify');
        expect(tool).toBeDefined();
        const signal = new AbortController().signal;
        const state = { cwd: manager.getCwd() };
        await tool!.execute('test', { state, questions }, signal);
        expect(classify).toHaveBeenLastCalledWith(state, questions, signal);
        expect(models.generateImages).not.toHaveBeenCalled();
      } finally {
        await result.dispose();
      }
    }
    expect(classify).toHaveBeenCalledTimes(3);
  });

  it('honors default enablement, explicit false and updated provider settings', async () => {
    const setup = await environment();
    for (const enabled of [true, false, true]) {
      await writeSettings(setup.agentDir, enabled);
      const result = await composeLocalSession({ ...setup, modelRuntime: await offlineModels(true),
        extensionPackages: [builtinExtensionPackages.modelTools],
        runtimeFactory: request => new HostAgentRuntime(request.cwd, { ...request, classifier: { classify: vi.fn() } }),
      });
      try {
        expect(result.session.getToolDefinition('classify') !== undefined).toBe(enabled);
        expect(result.session.getToolDefinition('generate_images') !== undefined).toBe(enabled);
      } finally {
        await result.dispose();
      }
    }
  });

  it('binds both tools through real ACP session creation without inference', async () => {
    const classify = vi.fn();
    const fixture = await modelToolsAcpFixture({ classify });
    try {
      await client({ name: 'offline-model-tools' }).connectWith(fixture.service.app, async (connection) => {
        await connection.request(methods.agent.initialize, { protocolVersion: 1, clientCapabilities: {} });
        const { sessionId } = await connection.request(methods.agent.session.new, { cwd: fixture.cwd, mcpServers: [] });
        expect(fixture.openSession.mock.calls.map(([request]) => request.target.kind)).toEqual(['new']);
        expect(fixture.sessions).toHaveLength(1);
        expect(fixture.sessions[0]).toBe(fixture.registry.binding(sessionId)!.runtime.session);
        expect(fixture.sessions[0]!.sessionManager.getSessionId()).toBe(sessionId);
        expect(fixture.sessions[0]!.sessionManager.getSessionFile()).toBe(fixture.store.session(sessionId).piPath);
        expect(fixture.sessions[0]!.modelRuntime).toBe(fixture.models[0]);
        expect(fixture.sessions[0]!.getToolDefinition('classify')).toBeDefined();
        expect(fixture.sessions[0]!.getToolDefinition('generate_images')).toBeDefined();
        expect(fixture.clients).toHaveLength(1);
        expect(fixture.clients[0]!.getAttachment(sessionId)?.state.status).toBe('live');
        expect(fixture.store.session(sessionId).policy.effective).toBe('acp-strict');
      });
      expect(fixture.models).toHaveLength(1);
      expect(fixture.models[0]).not.toBe(fixture.catalog);
      for (const models of fixture.models) expect(vi.mocked(models.getAvailableOfType).mock.calls.some(call => call[0] === 'image')).toBe(true);
      for (const models of [fixture.catalog, ...fixture.models]) {
        expect(models.generateImages).not.toHaveBeenCalled();
        expect(models.streamSimple).not.toHaveBeenCalled();
      }
      expect(classify).not.toHaveBeenCalled();
    } finally {
      await fixture.dispose();
    }
  });

});

async function registerTools(
  importer: typeof importLocalExtension,
  classifier?: Classifier,
  models?: ModelRuntime,
): Promise<Map<string, ToolDefinition>> {
  const { default: extension } = await importer(builtinExtensionPackages.modelTools) as { default: ConfiguredFelanExtension };
  expect(extension.serviceRequirements).toEqual({ optional: [MODELS_SERVICE] });
  const services = createFelanServiceRegistry();
  if (models) services.set(MODELS_SERVICE, createLocalModelsService({ modelRuntime: models, sessionId: 'fixture' }));
  const tools = new Map<string, ToolDefinition>();
  await extension({
    runtime: classifier === undefined ? {} : { classifier },
    services: createExtensionServiceAccess(services, extension.serviceRequirements!),
    registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
  } as unknown as FelanExtensionAPI);
  return tools;
}

async function offlineModels(images: boolean): Promise<ModelRuntime> {
  const models = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false,
  });
  vi.spyOn(models, 'getAvailableOfType').mockResolvedValue(images ? [imageModel] : []);
  vi.spyOn(models, 'generateImages').mockRejectedValue(new Error('Live image inference is forbidden'));
  vi.spyOn(models, 'getAvailableSnapshot').mockReturnValue([chatModel]);
  vi.spyOn(models, 'getAvailable').mockResolvedValue([chatModel]);
  vi.spyOn(models, 'getModel').mockImplementation((provider, id) => (
    provider === chatModel.provider && id === chatModel.id ? chatModel : undefined
  ));
  vi.spyOn(models, 'hasConfiguredAuth').mockImplementation((provider) => provider === 'offline');
  vi.spyOn(models, 'getProviders').mockReturnValue([{ id: 'offline' }] as ReturnType<ModelRuntime['getProviders']>);
  vi.spyOn(models, 'refresh').mockResolvedValue({ aborted: false, errors: new Map() });
  vi.spyOn(models, 'streamSimple').mockImplementation(() => { throw new Error('Live chat inference is forbidden'); });
  return models;
}

async function modelToolsAcpFixture(classifier: Classifier) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'mt-acp-')));
  temporaryPaths.push(directory);
  const target = { kind: 'isolated' as const, directory, namespaceId: randomUUID(), storeRoots: [directory] };
  const owner = await acquireDaemonOwnership(target);
  const cleanups: Array<() => void | Promise<void>> = [() => owner.release()];
  const dispose = async () => {
    const errors: unknown[] = [];
    for (const cleanup of cleanups.splice(0).reverse()) {
      try { await cleanup(); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, 'Failed to dispose model-tools ACP fixture');
  };
  try {
    const cwd = join(directory, 'workspace');
    await mkdir(cwd);
    await writeSettings(owner.target.agentDir, true);
    const models: ModelRuntime[] = [];
    const sessions: AgentSession[] = [];
    let registry: SessionRegistry;
    const profile = await createLocalDaemonProfile({
      agentDir: owner.target.agentDir, homeDir: directory, deferActivation: true,
      initializeProcess: async () => ({ diagnostics: [], assertConfiguration: () => [] }),
      createModelRuntime: async () => {
        const runtime = await offlineModels(true);
        models.push(runtime);
        return runtime;
      },
      runtimeFactory: request => registry.wrapOpeningRuntime(new HostAgentRuntime(request.cwd, { ...request, classifier }), request.rootSessionId),
    });
    const openSession = vi.spyOn(profile, 'openSession');
    cleanups.push(() => profile.dispose());
    const store = new DaemonControlStore(owner);
    cleanups.push(() => store.close());
    registry = new SessionRegistry({ owner, store, lifecycle: profile, idleMs: 0,
      services: input => ({ getExecutionPolicy: input.getExecutionPolicy, extensions: {
        configuration: async () => [],
        bind: async context => {
          const services = context.services.fork();
          services.set(MODELS_SERVICE, createLocalModelsService({ modelRuntime: context.modelRuntime, sessionId: context.sessionManager.getSessionId() }));
          return {
            services,
            importExtension: importLocalExtension,
            onSession: session => { sessions.push(session); },
            dispose: async () => {},
          };
        },
      } }),
    });
    cleanups.push(() => registry.shutdown());
    const catalog = await offlineModels(true);
    const configuration = new DaemonConfiguration({ agentDir: owner.target.agentDir, definitions: [], assertCurrent: () => registry.assertAdmission() });
    const server = new SessionServer({ registry, configuration, models: catalog, version: DAEMON_VERSION });
    cleanups.push(() => server.close());
    await server.start();
    const clients: SessionClient[] = [];
    const createClient = ({ launch: _launch, ...options }: SessionClientOptions) => {
      const client = new SessionClient({ ...options, target, expected: owner.identity, requestTimeoutMs: 1000 });
      clients.push(client);
      cleanups.push(() => client.close());
      return client;
    };
    const service = createFelanAcpService({ agentDir: owner.target.agentDir, createClient });
    cleanups.push(() => service.dispose());
    return { cwd, store, sessions, models, catalog, clients, service, registry, openSession, dispose };
  } catch (error) {
    try { await dispose(); } catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Failed to create model-tools ACP fixture'); }
    throw error;
  }
}

async function environment() {
  const homeDir = await mkdtemp(join(tmpdir(), 'felan-model-tools-'));
  temporaryPaths.push(homeDir);
  const cwd = join(homeDir, 'workspace');
  const agentDir = join(homeDir, 'agent');
  const sessionDir = join(agentDir, 'sessions');
  await Promise.all([cwd, sessionDir].map((path) => mkdir(path, { recursive: true })));
  await writeSettings(agentDir, true);
  return { cwd, agentDir, homeDir, sessionDir };
}

async function writeSettings(agentDir: string, enabled: boolean) {
  const flags = Object.fromEntries(Object.keys(builtinExtensionPackages)
    .filter((name) => name !== 'modelTools').map((name) => [name, false]));
  await writeFile(join(agentDir, 'settings.json'), JSON.stringify({
    builtinExtensions: { ...flags, ...(enabled ? {} : { modelTools: false }) },
    felanThinking: { dynamic: false },
  }));
}

function assistantMessage() {
  return {
    role: 'assistant' as const, content: [{ type: 'text' as const, text: 'Offline response' }],
    api: chatModel.api, provider: chatModel.provider, model: chatModel.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: 'stop' as const, timestamp: Date.now(),
  };
}
