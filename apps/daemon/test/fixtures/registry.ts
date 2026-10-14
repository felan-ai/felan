import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { HostAgentRuntime, InMemoryCredentialStore, ModelRuntime, createAssistantMessageEventStream, SessionManager, type AgentSession, type AgentSessionEvent, type AgentSessionRuntime, type AgentRuntime, type AssistantMessage, type Model, type Api } from '@felan-ai/agent-core';
import { vi } from 'vitest';
import { acquireDaemonOwnership, type DaemonOwnership } from '../../src/daemon/ownership.js';
import { DaemonControlStore, type ControlStoreOptions } from '../../src/daemon/control-store.js';
import { SessionRegistry } from '../../src/daemon/registry.js';
import type { SessionLifecycle, SessionOpenRequest, SessionBinding } from '../../src/daemon/session-lifecycle-contracts.js';
import { createTestSessionLifecycle } from './session-runtime.js';
import { restoreSessionCursor } from '../../src/daemon/session-cursor.js';
import { fakeProcessAdapter } from './process-provider.js';
import type { ProcessAdapter } from '../../src/daemon/process-adapter.js';

export const supported = ['darwin', 'linux'].includes(process.platform);
export const now = 1_800_000_000_000;
export const fixtures: Array<() => Promise<void>> = [];
export function requestId(): string { const hex = now.toString(16).padStart(12, '0'); return `${hex.slice(0, 8)}-${hex.slice(8)}-7${randomUUID().slice(1, 4)}-8${randomUUID().slice(1, 4)}-${randomUUID().slice(-12)}`; }
export function assistant(text = 'done'): AssistantMessage {
  return { role: 'assistant', content: [{ type: 'text', text }], api: 'openai-completions', provider: 'offline', model: 'fixture', stopReason: 'stop', timestamp: now,
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}
export function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
export const offlineModel: Model<Api> = { id: 'fixture', name: 'Fixture', api: 'openai-completions', provider: 'offline', baseUrl: 'https://example.invalid', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 1024 };

export async function realFixture(onStream?: () => Promise<void>) {
  const f = await fixture(); await f.registry.shutdown();
  await writeFile(join(f.owner.target.agentDir, 'settings.json'), JSON.stringify({}));
  let registry: SessionRegistry;
  const profile = await createTestSessionLifecycle({ agentDir: f.owner.target.agentDir,
    runtimeFactory: request => registry.wrapOpeningRuntime(new HostAgentRuntime(request.cwd, request), request.rootSessionId),
    createModelRuntime: async () => {
      const models = await ModelRuntime.create({ modelsPath: null, credentials: new InMemoryCredentialStore(), refreshOnCreate: false });
      models.registerProvider('offline', { api: 'openai-completions', baseUrl: offlineModel.baseUrl, apiKey: 'fixture', models: [offlineModel], streamSimple: () => {
        const stream = createAssistantMessageEventStream();
        void Promise.resolve().then(onStream).then(() => stream.push({ type: 'done', reason: 'stop', message: assistant() }));
        return stream;
      } });
      return models;
    } });
  fixtures.push(() => profile.dispose());
  registry = new SessionRegistry({ owner: f.owner, store: f.store, lifecycle: profile, idleMs: 0, processAdapter: fakeProcessAdapter(), services: ({ getExecutionPolicy }) => ({ getExecutionPolicy,
    extensions: { configuration: async () => [], bind: async () => ({ importExtension: async () => ({ default() {} }), wrapStreamFunction: stream => stream, dispose: async () => {} }) } }) });
  f.replaceRegistry(registry, f.store);
  const root = await registry.create({ cwd: f.cwd, target: { kind: 'new' }, model: offlineModel });
  return { ...f, registry, profile, root };
}
export interface FakeSession {
  session: AgentSession;
  emit(event: AgentSessionEvent): void;
  listeners: Set<(event: AgentSessionEvent) => void>;
  queue: { steering: string[]; followUp: string[] };
  dispose: ReturnType<typeof vi.fn>;
  abort: ReturnType<typeof vi.fn>;
}
export async function fixture(options: ControlStoreOptions = {}, processAdapter: ProcessAdapter = fakeProcessAdapter()) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 's6-')));
  let owner: DaemonOwnership | undefined;
  let store: DaemonControlStore | undefined;
  let registry: SessionRegistry | undefined;
  const releases = new Set<() => void>();
  fixtures.push(async () => {
    for (const release of releases) release();
    await registry?.shutdown(); store?.close(); await owner?.release();
    await rm(directory, { recursive: true, force: true });
  });
  owner = await acquireDaemonOwnership({ kind: 'isolated', directory, namespaceId: randomUUID() });
  store = new DaemonControlStore(owner, { now: () => now, ...options });
  const agentDir = owner.target.agentDir; const cwd = join(directory, 'workspace'); await mkdir(cwd);
  const instances = new Map<string, FakeSession>(); const opened: SessionOpenRequest[] = [];
  const profile: SessionLifecycle = {
    apiVersion: 1, id: 'fixture', dispose: vi.fn(async () => {}),
    resolveResources: async request => ({ cwd: request.cwd, agentDir, sessionDir: request.sessionDir ?? join(agentDir, 'sessions'),
      sessionStorageBase: join(agentDir, 'storage', 'sessions'), agentStorageRoot: join(agentDir, 'storage', 'agent'),
      writableRoots: [agentDir] }),
    openSession: vi.fn(async request => {
      opened.push(request);
      const source = request.target.kind === 'resume' ? request.target.sessionFile : undefined;
      await request.ownership.assertOwned(request.resources, { kind: request.target.kind, destinationDirectory: request.resources.sessionDir, ...(source ? { sourceSessionFile: source } : {}) });
      const manager = source ? SessionManager.open(source, request.resources.sessionDir, request.resources.cwd) : SessionManager.create(request.resources.cwd, request.resources.sessionDir);
      if (request.target.kind === 'resume' && request.target.cursor) restoreSessionCursor(manager, request.target.cursor);
      const id = manager.getSessionId();
      const listeners = new Set<(event: AgentSessionEvent) => void>();
      const emit = (event: AgentSessionEvent) => { for (const listener of listeners) listener(event); };
      let idle = true;
      const queue = { steering: [] as string[], followUp: [] as string[] };
      const abort = vi.fn(async () => { idle = true; emit({ type: 'agent_settled', aborted: true }); });
      const dispose = vi.fn(async () => {});
      const session = {
        sessionManager: manager, get sessionId() { return id; }, get sessionFile() { return manager.getSessionFile(); },
        model: { id: 'fixture', name: 'Fixture', provider: 'offline' }, thinkingLevel: 'off',
        get isIdle() { return idle; }, get pendingMessageCount() { return queue.steering.length + queue.followUp.length; },
        getAllTools: () => [], getActiveToolNames: () => [], getAvailableThinkingLevels: () => ['off'], scopedModels: [],
        modelRuntime: { getAvailableSnapshot: () => [] },
        resourceLoader: { getSkills: () => ({ skills: [], diagnostics: [] }) } satisfies Pick<AgentSession['resourceLoader'], 'getSkills'>,
        refreshContext: () => {}, setActiveToolsByName: () => {},
        getSteeringMessages: () => queue.steering, getFollowUpMessages: () => queue.followUp,
        extensionRunner: { getRegisteredCommands: () => [] }, subscribe: (listener: (event: AgentSessionEvent) => void) => { listeners.add(listener); return () => listeners.delete(listener); },
        abort, prompt: async (text: string) => {
          idle = false; emit({ type: 'agent_start' });
          manager.appendMessage({ role: 'user', content: text, timestamp: now });
          const message = assistant(); emit({ type: 'message_start', message }); emit({ type: 'message_end', message }); manager.appendMessage(message);
          idle = true; emit({ type: 'agent_settled', aborted: false });
        },
      } as unknown as AgentSession;
      instances.set(id, { session, emit, listeners, queue, dispose, abort });
      const runtime = { session, dispose } as unknown as AgentSessionRuntime;
      return { runtime, agentRuntime: {} as AgentRuntime, sessionId: id, rootSessionId: request.parentSessionId ? request.rootSessionId! : id,
        ...(request.parentSessionId ? { parentSessionId: request.parentSessionId } : {}), resources: request.resources, diagnostics: [], toolProvenance: [],
        tools: { provenance: [], requiresApproval: policy => policy.mode === 'acp-strict' } } satisfies SessionBinding;
    }),
  };
  const createRegistry = (current = store!) => new SessionRegistry({ owner: owner!, store: current, lifecycle: profile, idleMs: 0, now: options.now ?? (() => now), processAdapter,
    services: ({ getExecutionPolicy }) => ({ getExecutionPolicy, extensions: { configuration: async () => [], bind: async () => ({ importExtension: async () => ({ default() {} }), dispose: async () => {} }) } }) });
  registry = createRegistry();
  return { directory, cwd, owner, store, registry, profile, instances, opened, releases, createRegistry,
    replaceRegistry(value: SessionRegistry, current: DaemonControlStore) { registry = value; store = current; } };
}
