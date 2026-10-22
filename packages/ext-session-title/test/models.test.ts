import {
  createExtensionServiceAccess,
  createFelanServiceRegistry,
  createSilentLogger,
  MODELS_SERVICE,
  type AssistantMessage,
  type ExtensionContext,
  type FelanExtensionAPI,
  type ModelsService,
  type SessionEntry,
  type TextModelInfo,
} from '@felan-ai/agent-core';
import { describe, expect, it, vi } from 'vitest';
import extension from '../src/index.js';
import { createSessionTitleModelsHost } from '../src/models.js';

describe('Models-backed session titles', () => {
  it.each(['tui', 'rpc', 'json', 'print'] as const)('names a new root in %s mode without consulting UI', async mode => {
    const fake = fakeModels();
    const h = harness(fake.service, { mode });
    h.start('Review the authentication flow.');
    await vi.waitFor(() => expect(h.rename).toHaveBeenCalledWith('Review authentication flow'));
    expect(fake.getAvailable).toHaveBeenCalledWith('test', { signal: expect.any(AbortSignal) });
    const [reference, context, options] = fake.complete.mock.calls[0]!;
    expect(reference).toEqual({ provider: 'test', id: 'cheap' });
    expect(Object.keys(reference).sort()).toEqual(['id', 'provider']);
    expect(context.systemPrompt).toContain('untrusted source text');
    expect(context.messages[0]?.content).toContain('Review the authentication flow.');
    expect(options).toMatchObject({ maxTokens: 64, maxRetries: 0, reasoning: 'minimal', cacheRetention: 'none', timeoutMs: 30_000 });
    expect(options?.signal).toBe(fake.getAvailable.mock.calls[0]?.[1]?.signal);
    expect(h.notify).not.toHaveBeenCalled();
    h.start('Follow-up');
    await tick();
    expect(fake.complete).toHaveBeenCalledOnce();
    await h.shutdown();
  });

  it.each(['named', 'resumed', 'forked'] as const)('does not discover or dispatch for %s sessions', async kind => {
    const fake = fakeModels();
    const h = harness(fake.service, {
      ...(kind === 'named' ? { name: 'Manual title' } : {}),
      ...(kind === 'resumed' ? { entries: [userEntry()] } : {}),
      ...(kind === 'forked' ? { parentSession: '/parent.jsonl' } : {}),
    });
    h.start('Name this session');
    await h.shutdown();
    expect(fake.getAvailable).not.toHaveBeenCalled();
    expect(fake.complete).not.toHaveBeenCalled();
    expect(h.rename).not.toHaveBeenCalled();
  });

  it('prefers an eligible current low-tier model without crossing providers', async () => {
    const current = model('muse-spark-1.3-contributor-free', 'test', 5);
    const fake = fakeModels([model('cheaper', 'test', 0), model(current.id, 'other', 0), current]);
    fake.getAvailable.mockResolvedValue(fake.available);
    const h = harness(fake.service, { currentModel: current });
    h.start('Name this session');
    await vi.waitFor(() => expect(h.rename).toHaveBeenCalledOnce());
    expect(fake.complete.mock.calls[0]?.[0]).toEqual({ provider: 'test', id: current.id });
    await h.shutdown();
  });

  it('does not fall back to another provider when no current-provider text model is available', async () => {
    const fake = fakeModels([model('cheap', 'other'), { ...model('image-only'), input: ['image'] }]);
    fake.getAvailable.mockResolvedValue(fake.available);
    const h = harness(fake.service);
    h.start('Name this session');
    await vi.waitFor(() => expect(h.debug).toHaveBeenCalledWith(
      { component: 'session-title', sessionId: 'session-1', reason: 'no-text-models' }, 'Session title generation skipped.',
    ));
    expect(fake.complete).not.toHaveBeenCalled();
    expect(h.rename).not.toHaveBeenCalled();
    await h.shutdown();
  });

  it('re-discovers after auth or scope changes and never dispatches a revoked selection', async () => {
    const fake = fakeModels();
    fake.getAvailable.mockImplementationOnce(async () => {
      const snapshot = fake.available;
      fake.available = [];
      return snapshot;
    });
    const h = harness(fake.service);
    h.start('First try');
    await vi.waitFor(() => expect(h.warn).toHaveBeenCalledOnce());
    await tick();
    expect(fake.dispatched).toHaveLength(0);
    expect(h.rename).not.toHaveBeenCalled();
    fake.available = [model('newly-authorized')];
    h.start('Retry');
    await vi.waitFor(() => expect(h.rename).toHaveBeenCalledOnce());
    expect(fake.getAvailable).toHaveBeenCalledTimes(2);
    expect(fake.dispatched).toEqual([{ provider: 'test', id: 'newly-authorized' }]);
    await h.shutdown();
  });

  it('retries transient discovery and completion failures only up to the existing limit', async () => {
    const fake = fakeModels();
    fake.getAvailable.mockRejectedValueOnce(new Error('private discovery details'));
    fake.complete.mockRejectedValue(new Error('private provider details'));
    const h = harness(fake.service);
    for (let attempt = 1; attempt <= 3; attempt++) {
      h.start('Retry');
      await vi.waitFor(() => expect(h.warn).toHaveBeenCalledTimes(attempt));
      await tick();
    }
    h.start('Fourth attempt');
    await tick();
    expect(fake.getAvailable).toHaveBeenCalledTimes(3);
    expect(fake.complete).toHaveBeenCalledTimes(2);
    expect(h.warn.mock.calls[0]?.[0]).toEqual({ component: 'session-title', sessionId: 'session-1', stage: 'prepare' });
    expect(h.warn.mock.calls[1]?.[0]).toEqual({ component: 'session-title', sessionId: 'session-1', stage: 'complete' });
    expect(JSON.stringify(h.warn.mock.calls)).not.toContain('private');
    expect(h.notify).not.toHaveBeenCalled();
    await h.shutdown();
  });

  it('returns real provider usage unchanged and logs only completion metadata', async () => {
    const fake = fakeModels();
    const debug = vi.fn();
    const host = createSessionTitleModelsHost(fake.service, { ...createSilentLogger(), debug });
    const result = await host.complete({
      sessionId: 'session-1', requestId: 'request-1', model: fake.available[0]!,
      context: { messages: [{ role: 'user', content: 'private prompt', timestamp: 0 }] }, options: {},
    });
    expect(result).toBe(fake.response);
    expect(debug).toHaveBeenCalledWith({
      component: 'session-title', sessionId: 'session-1', requestId: 'request-1',
      model: { provider: 'test', id: 'actual-provider-model' }, stopReason: 'stop', usage: fake.response.usage,
    }, 'Session title completion received.');
    expect(JSON.stringify(debug.mock.calls)).not.toContain('private prompt');
    expect(JSON.stringify(debug.mock.calls)).not.toContain('Review authentication flow');
  });

  it.each(['discovery', 'completion'] as const)('preserves manual rename authority during %s', async stage => {
    const fake = fakeModels();
    let finish!: () => void;
    const pending = new Promise<void>(resolve => { finish = resolve; });
    if (stage === 'discovery') fake.getAvailable.mockImplementation(async () => { await pending; return fake.available; });
    else fake.complete.mockImplementation(async () => { await pending; return fake.response; });
    const h = harness(fake.service);
    h.start('Name this session');
    await vi.waitFor(() => expect(stage === 'discovery' ? fake.getAvailable : fake.complete).toHaveBeenCalledOnce());
    h.state.name = 'Manual title';
    finish();
    await vi.waitFor(() => expect(h.debug).toHaveBeenCalledWith(
      { component: 'session-title', sessionId: 'session-1', reason: 'title-already-set' }, 'Session title generation skipped.',
    ));
    expect(h.rename).not.toHaveBeenCalled();
    if (stage === 'discovery') expect(fake.complete).not.toHaveBeenCalled();
    expect(h.state.name).toBe('Manual title');
    await h.shutdown();
  });

  it.each(['discovery', 'completion'] as const)('aborts and drains %s, ignoring late provider success', async stage => {
    const fake = fakeModels();
    let finish!: () => void;
    const pending = new Promise<void>(resolve => { finish = resolve; });
    if (stage === 'discovery') fake.getAvailable.mockImplementation(async () => { await pending; return fake.available; });
    else fake.complete.mockImplementation(async () => { await pending; return fake.response; });
    const h = harness(fake.service);
    h.start('Name this session');
    await vi.waitFor(() => expect(stage === 'discovery' ? fake.getAvailable : fake.complete).toHaveBeenCalledOnce());
    let stopped = false;
    const shutdown = h.shutdown().then(() => { stopped = true; });
    try {
      expect(fake.getAvailable.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
      if (stage === 'completion') expect(fake.complete.mock.calls[0]?.[2]?.signal?.aborted).toBe(true);
      await Promise.resolve();
      expect(stopped).toBe(false);
    } finally {
      finish();
      await shutdown;
    }
    expect(h.rename).not.toHaveBeenCalled();
  });
});

function model(id: string, provider = 'test', cost = 1): TextModelInfo {
  return {
    id, provider, name: id, api: 'openai-completions', input: ['text'], reasoning: false,
    cost: { input: cost, output: cost, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32_000, maxTokens: 4096,
  };
}

function fakeModels(available = [model('cheap')]) {
  const response: AssistantMessage = {
    role: 'assistant', content: [{ type: 'text', text: 'Review authentication flow' }],
    api: 'openai-completions', provider: 'test', model: 'actual-provider-model', stopReason: 'stop', timestamp: 0,
    usage: { input: 37, output: 5, cacheRead: 7, cacheWrite: 0, totalTokens: 49,
      cost: { input: 0.01, output: 0.02, cacheRead: 0.003, cacheWrite: 0, total: 0.033 } },
  };
  const dispatched: Array<{ provider: string; id: string }> = [];
  const getAvailable = vi.fn<ModelsService['getAvailable']>(async (provider): Promise<readonly TextModelInfo[]> => fake.available.filter(candidate => candidate.provider === provider));
  const complete = vi.fn<ModelsService['completeSimple']>(async (reference): Promise<AssistantMessage> => {
    if (!fake.available.some(candidate => candidate.provider === reference.provider && candidate.id === reference.id)) {
      throw new Error('Model is outside current authenticated scope');
    }
    dispatched.push(reference);
    return response;
  });
  const service: ModelsService = {
    getAvailable, completeSimple: complete,
    streamSimple: () => { throw new Error('Unexpected streaming request'); },
    getAvailableOfType: async () => [], generateImages: async () => { throw new Error('Unexpected image request'); },
  };
  const fake = { available, response, dispatched, getAvailable, complete, service };
  return fake;
}

function harness(models: ModelsService, options: {
  mode?: ExtensionContext['mode']; name?: string; entries?: SessionEntry[]; parentSession?: string; currentModel?: TextModelInfo;
} = {}) {
  const state = { name: options.name };
  const rename = vi.fn((name: string) => { state.name = name; });
  const debug = vi.fn(); const warn = vi.fn(); const notify = vi.fn(() => { throw new Error('No UI required'); });
  const registry = createFelanServiceRegistry();
  registry.set(MODELS_SERVICE, models);
  let before!: (event: { messageType: 'user'; prompt: string }, context: ExtensionContext) => void;
  let shutdown!: () => Promise<void>;
  const context = {
    mode: options.mode ?? 'rpc', hasUI: false,
    model: { ...(options.currentModel ?? model('active')), baseUrl: 'https://private.invalid', headers: { authorization: 'not-for-extensions' } },
    ui: { notify },
    sessionManager: {
      getEntries: () => options.entries ?? [], getSessionId: () => 'session-1',
      getHeader: () => ({ parentSession: options.parentSession }),
    },
  } as unknown as ExtensionContext;
  extension({
    services: createExtensionServiceAccess(registry, extension.serviceRequirements!),
    runtime: { logger: { ...createSilentLogger(), debug, warn } },
    getSessionName: () => state.name, setSessionName: rename,
    on: (event: string, handler: unknown) => {
      if (event === 'before_agent_start') before = handler as typeof before;
      if (event === 'session_shutdown') shutdown = handler as typeof shutdown;
    },
  } as unknown as FelanExtensionAPI);
  return { state, rename, debug, warn, notify, start: (prompt: string) => before({ messageType: 'user', prompt }, context), shutdown: () => shutdown() };
}

function userEntry(): SessionEntry {
  return { type: 'message', message: { role: 'user', content: 'Prior prompt', timestamp: 0 } } as SessionEntry;
}

async function tick(): Promise<void> { await new Promise<void>(resolve => setTimeout(resolve, 0)); }
