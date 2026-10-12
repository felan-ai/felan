import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  HostAgentRuntime,
  InMemoryCredentialStore,
  ModelRuntime,
  SessionManager,
  createAssistantMessageEventStream,
  getCurrentTools,
  type AgentSession,
  type Classifier,
  type FelanExtension,
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
  createLocalExtensionImporter,
  importLocalExtension,
  modelToolsExtensionPackage,
} from '@felan-ai/daemon/internal/extensions';
import { DAEMON_VERSION } from '@felan-ai/daemon';
import { createLocalFelanRuntime } from '../src/runtime.js';
import { createFelanAcpService } from '../src/acp/server.js';
import { SessionClient, type SessionClientOptions } from '../src/client/client.js';
import { createLocalSubagentExtensionImporter } from '@felan-ai/daemon/internal/subagents/host';
import type { LocalSubagentHost } from '@felan-ai/daemon/internal/subagents/host';
import { DaemonConfiguration } from '../../daemon/src/daemon/configuration.js';
import { DaemonControlStore } from '../../daemon/src/daemon/control-store.js';
import { createLocalDaemonProfile } from '../../daemon/src/daemon/local-profile.js';
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
    const importer = createLocalExtensionImporter({} as LocalSubagentHost, models, async () => {
      throw new Error('Model tools must be host-bound');
    });
    const registered = await registerTools(importer, classifier ? { classify } : undefined);
    expect([...registered.keys()].sort()).toEqual(tools);
    expect(models.getAvailableOfType).toHaveBeenCalledWith('image');
    expect(models.generateImages).not.toHaveBeenCalled();
    expect(classify).not.toHaveBeenCalled();
  });

  it.each([false, true])('suppresses only image tools on discovery failure (classifier=%s)', async (hasClassifier) => {
    const models = await offlineModels(true);
    vi.mocked(models.getAvailableOfType).mockRejectedValue(new Error('Offline discovery failure'));
    const importer = createLocalExtensionImporter({} as LocalSubagentHost, models);
    const tools = await registerTools(importer, hasClassifier ? { classify: vi.fn() } : undefined);
    expect([...tools.keys()]).toEqual(hasClassifier ? ['classify'] : []);
    expect(models.generateImages).not.toHaveBeenCalled();
  });

  it.each([false, true])('keeps the unbound default usable without model access (classifier=%s)', async (hasClassifier) => {
    const tools = await registerTools(importLocalExtension, hasClassifier ? { classify: vi.fn() } : undefined);
    expect([...tools.keys()]).toEqual(hasClassifier ? ['classify'] : []);
  });

  it('uses the effective custom classifier and forwards the cancellation signal', async () => {
    const models = await offlineModels(false);
    const classify = vi.fn().mockResolvedValue({ answers: { verdict: { type: 'choice', choice: 'pass' } } });
    const tools = await registerTools(createLocalExtensionImporter({} as LocalSubagentHost, models), { classify });
    const signal = new AbortController().signal;
    const state = { evidence: 'offline fixture' };
    const result = await tools.get('classify')!.execute('test', { state, questions }, signal, undefined, {} as never);
    expect(classify).toHaveBeenCalledExactlyOnceWith(state, questions, signal);
    expect(result.details).toMatchObject({ answers: { verdict: { type: 'choice', choice: 'pass' } } });
    expect(models.generateImages).not.toHaveBeenCalled();
  });

  it('uses the same authenticated model binding in the subagent importer', async () => {
    const models = await offlineModels(true);
    const importer = createLocalSubagentExtensionImporter({
      modelRuntime: models,
      importExtension: async () => { throw new Error('Model tools must be host-bound'); },
    }, {} as LocalSubagentHost);
    expect([...((await registerTools(importer, { classify: vi.fn() })).keys())].sort())
      .toEqual(['classify', 'generate_images']);
    expect(models.getAvailableOfType).toHaveBeenCalledExactlyOnceWith('image');
  });

  it('lists models from the injected runtime and rechecks availability', async () => {
    const models = await offlineModels(true);
    const tools = await registerTools(createLocalExtensionImporter({} as LocalSubagentHost, models));
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
  it('rebinds tools for root, fork, new, resumed, imported and changed-cwd sessions', async () => {
    const setup = await environment();
    const models = await offlineModels(true);
    const classify = vi.fn().mockResolvedValue({ answers: { verdict: { type: 'choice', choice: 'pass' } } });
    const sessionManager = SessionManager.create(setup.cwd, setup.sessionDir);
    const entryId = sessionManager.appendMessage({ role: 'user', content: 'offline prompt', timestamp: Date.now() });
    sessionManager.appendMessage(assistantMessage());
    const runtime = await createLocalFelanRuntime({
      ...setup, modelRuntime: models, sessionManager,
      runtimeFactory: (request) => new HostAgentRuntime(request.cwd, { ...request, classifier: { classify } }),
    });
    const verify = async () => {
      expect(runtime.diagnostics.filter(({ type }) => type === 'error')).toEqual([]);
      expect(runtime.session.getToolDefinition('generate_images')).toBeDefined();
      const tool = runtime.session.agent.state.tools.find(({ name }) => name === 'classify');
      expect(tool).toBeDefined();
      const signal = new AbortController().signal;
      const state = { cwd: runtime.cwd };
      await tool!.execute('test', { state, questions }, signal);
      expect(classify).toHaveBeenLastCalledWith(state, questions, signal);
    };
    try {
      await runtime.session.bindExtensions({ mode: 'print' });
      await verify();
      await runtime.fork(entryId, { position: 'at' });
      await verify();
      await runtime.newSession();
      await verify();
      const nextCwd = join(setup.homeDir, 'workspace-b');
      await mkdir(nextCwd);
      const resumed = SessionManager.create(nextCwd, setup.sessionDir);
      resumed.appendMessage({ role: 'user', content: 'resume', timestamp: Date.now() });
      resumed.appendMessage(assistantMessage());
      await runtime.switchSession(resumed.getSessionFile()!);
      expect(runtime.cwd).toBe(nextCwd);
      await verify();
      await runtime.importFromJsonl(resumed.getSessionFile()!);
      await verify();
      expect(classify).toHaveBeenCalledTimes(5);
      expect(models.getAvailableOfType).toHaveBeenCalledTimes(5);
      expect(models.generateImages).not.toHaveBeenCalled();
    } finally {
      await runtime.dispose();
    }
  });

  it('honors default enablement, explicit false and reloaded settings in real sessions', async () => {
    const setup = await environment();
    const models = await offlineModels(true);
    const runtime = await createLocalFelanRuntime({
      ...setup, modelRuntime: models,
      runtimeFactory: (request) => new HostAgentRuntime(request.cwd, { ...request, classifier: { classify: vi.fn() } }),
    });
    try {
      expect(runtime.session.getToolDefinition('classify')).toBeDefined();
      expect(runtime.session.getToolDefinition('generate_images')).toBeDefined();
      await writeSettings(setup.agentDir, false);
      await runtime.newSession();
      expect(runtime.session.getToolDefinition('classify')).toBeUndefined();
      expect(runtime.session.getToolDefinition('generate_images')).toBeUndefined();
      expect(models.getAvailableOfType).toHaveBeenCalledTimes(1);
      await writeSettings(setup.agentDir, true);
      await runtime.newSession();
      expect(runtime.session.getToolDefinition('classify')).toBeDefined();
      expect(runtime.session.getToolDefinition('generate_images')).toBeDefined();
      expect(models.getAvailableOfType).toHaveBeenCalledTimes(2);
    } finally {
      await runtime.dispose();
    }
  });

  it('binds both tools through real ACP session creation without inference', async () => {
    const classify = vi.fn();
    const fixture = await modelToolsAcpFixture({ classify });
    try {
      await client({ name: 'offline-model-tools' }).connectWith(fixture.service.app, async (connection) => {
        await connection.request(methods.agent.initialize, { protocolVersion: 1, clientCapabilities: {} });
        const { sessionId } = await connection.request(methods.agent.session.new, { cwd: fixture.cwd, mcpServers: [] });
        expect(fixture.openSession.mock.calls.map(([request]) => request.target.kind)).toEqual(['new', 'resume']);
        expect(fixture.openSession.mock.calls[1]![0].target).toEqual({ kind: 'resume', sessionFile: fixture.store.session(sessionId).piPath });
        expect(fixture.sessions).toHaveLength(1);
        expect(fixture.sessions[0]).toBe(fixture.registry.binding(sessionId)!.runtime.session);
        expect(fixture.sessions[0]!.sessionManager.getSessionId()).toBe(sessionId);
        expect(fixture.sessions[0]!.modelRuntime).toBe(fixture.models[1]);
        expect(fixture.sessions[0]!.getToolDefinition('classify')).toBeDefined();
        expect(fixture.sessions[0]!.getToolDefinition('generate_images')).toBeDefined();
        expect(fixture.clients).toHaveLength(1);
        expect(fixture.clients[0]!.getAttachment(sessionId)?.state.status).toBe('live');
        expect(fixture.store.session(sessionId).policy.effective).toBe('acp-strict');
      });
      expect(fixture.models).toHaveLength(2);
      expect(fixture.models[0]).not.toBe(fixture.models[1]);
      for (const models of fixture.models) expect(models.getAvailableOfType).toHaveBeenCalledWith('image');
      for (const models of [fixture.catalog, ...fixture.models]) {
        expect(models.generateImages).not.toHaveBeenCalled();
        expect(models.streamSimple).not.toHaveBeenCalled();
      }
      expect(classify).not.toHaveBeenCalled();
    } finally {
      await fixture.dispose();
    }
  });

  it('registers both tools in the child and completion-driven parent turn using the shared model runtime', async () => {
    const setup = await environment();
    const models = await offlineModels(true);
    const requests: { tools: string[]; prompt: string }[] = [];
    vi.mocked(models.streamSimple).mockImplementation((_model, context) => {
      requests.push({
        tools: getCurrentTools(context.messages).map(({ name }) => name),
        prompt: context.messages.filter(({ role }) => role === 'user').map(({ content }) => (
          typeof content === 'string' ? content : content.filter((block) => block.type === 'text')
            .map((block) => block.text).join('\n')
        )).join('\n'),
      });
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        stream.push({ type: 'done', reason: 'stop', message: assistantMessage() });
      });
      return stream;
    });
    const classify = vi.fn();
    const runtime = await createLocalFelanRuntime({
      ...setup, modelRuntime: models,
      runtimeFactory: (request) => new HostAgentRuntime(request.cwd, { ...request, classifier: { classify } }),
    });
    try {
      const spawned = await runtime.localSubagentHost.spawn({
        type: 'general', description: 'Offline tools check', prompt: 'Return the offline fixture.',
        model: `${chatModel.provider}/${chatModel.id}`,
      });
      expect(spawned.ok).toBe(true);
      if (!spawned.ok) throw new Error(spawned.error.message);
      await vi.waitFor(async () => {
        expect(await runtime.localSubagentHost.getResult(spawned.value.agentId))
          .toMatchObject({ ok: true, value: { status: 'completed' } });
        expect(requests).toHaveLength(2);
        expect(runtime.session.isStreaming).toBe(false);
      });
      expect(requests.map(({ prompt }) => prompt)).toEqual([
        'Return the offline fixture.',
        `Subagent completion: general ${spawned.value.agentId}: completed — Offline response`,
      ]);
      for (const { tools } of requests) {
        expect(tools).toEqual(expect.arrayContaining(['classify', 'generate_images']));
      }
      expect(models.getAvailableOfType).toHaveBeenCalledTimes(2);
      expect(models.generateImages).not.toHaveBeenCalled();
      expect(classify).not.toHaveBeenCalled();
    } finally {
      await runtime.dispose();
    }
  });
});

async function registerTools(
  importer: typeof importLocalExtension,
  classifier?: Classifier,
): Promise<Map<string, ToolDefinition>> {
  const { default: extension } = await importer(modelToolsExtensionPackage) as { default: FelanExtension };
  const tools = new Map<string, ToolDefinition>();
  await extension({
    runtime: classifier === undefined ? {} : { classifier },
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
    registry = new SessionRegistry({ owner, store, profile, idleMs: 0,
      services: input => ({ getExecutionPolicy: input.getExecutionPolicy, extensions: {
        configuration: async () => [],
        bind: async context => ({
          importExtension: createLocalExtensionImporter({} as LocalSubagentHost, context.modelRuntime),
          onSession: session => { sessions.push(session); },
          dispose: async () => {},
        }),
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
