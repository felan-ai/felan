import type { ExtensionCommandContext, FelanExtensionAPI, Model, SessionEntry } from '@felan-ai/agent-core';
import { describe, expect, it, vi } from 'vitest';
import { createFusionExtension, FUSION_CONFIG } from '../src/index.js';
import type { FusionHost, FusionReview, FusionReviewActions } from '../src/contracts.js';

const model = (provider: string, id: string): Model<any> => ({
  provider, id, name: `${provider}/${id}`, api: 'openai-completions', baseUrl: 'https://test.invalid',
  reasoning: false, input: ['text'], cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 32000, maxTokens: 2000,
});

function harness(overrides: { mode?: 'tui' | 'print'; idle?: boolean; participants?: string[] } = {}) {
  const models = [model('openai', 'one'), model('other', 'two')];
  const entries: SessionEntry[] = [];
  const requests: unknown[] = [];
  const messages: unknown[] = [];
  const notifications: unknown[] = [];
  const handlerStore: {
    handler?: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
    handlers: Record<string, (args: string, ctx: ExtensionCommandContext) => Promise<void>>;
  } = { handlers: {} };
  const events = new Map<string, Array<(...args: unknown[]) => void>>();
  const api = {
    config: {
      participants: overrides.participants ?? [], fusionModel: 'inherit', concurrency: 2,
      timeoutSeconds: 10, maxOutputChars: 1000, thinking: 'off',
    },
    on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      events.set(event, [...(events.get(event) ?? []), listener]);
      return () => {};
    }),
    registerCommand: vi.fn((name: string, options: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }) => {
      handlerStore.handlers[name] = options.handler;
      if (name === 'fusion') handlerStore.handler = options.handler;
    }),
    registerCapability: vi.fn(),
    appendEntry: vi.fn((type: string, data: unknown) => entries.push({ type: 'custom', customType: type, data } as SessionEntry)),
    sendMessage: vi.fn((...args: unknown[]) => messages.push(args)),
  } as unknown as FelanExtensionAPI;
  const ctx = {
    mode: overrides.mode ?? 'tui', hasUI: true, cwd: '/workspace', model: models[0], scopedModels: [], signal: undefined,
    isIdle: () => overrides.idle ?? true,
    isProjectTrusted: () => true,
    sessionManager: { getBranch: () => entries },
    modelRegistry: {
      getAvailable: () => models,
      hasConfiguredAuth: () => true,
      streamSimple: (selected: Model<any>, request: { messages: readonly { content: string }[] }) => {
        requests.push({ selected, request });
        return { result: async () => ({
          role: 'assistant', content: [{ type: 'text', text: `response for ${selected.id}` }],
          provider: selected.provider, model: selected.id, usage: { input: 1, output: 2, totalTokens: 3, cost: { total: 0.01 } },
          stopReason: 'stop',
        }) };
      },
    },
    ui: {
      notify: (...args: unknown[]) => notifications.push(args),
      setStatus: vi.fn(),
    },
  } as unknown as ExtensionCommandContext;
  return { api, ctx, entries, requests, messages, notifications, handlerStore, events };
}

describe('Fusion slash command', () => {
  it('offers the saved lineup, preselects it on change, and waits for approval', async () => {
    const h = harness({ participants: ['openai/one', 'other/two'] });
    const host: FusionHost = {
      confirm: vi.fn(async () => true),
      selectRunAction: vi.fn().mockResolvedValueOnce('change').mockResolvedValueOnce('run'),
      configure: vi.fn(async () => {
        expect(h.requests).toHaveLength(0);
        return { participants: ['other/two', 'openai/one'], fusionModel: 'other/two' };
      }),
      review: vi.fn(async () => {}),
    };
    createFusionExtension(host)(h.api);
    await h.handlerStore.handler!('compare', h.ctx);
    expect(host.configure).toHaveBeenCalledWith(h.ctx, expect.any(Array), ['openai/one', 'other/two'], 'inherit');
    expect(host.selectRunAction).toHaveBeenLastCalledWith(h.ctx, ['other/two', 'openai/one'], 'other/two');
    expect(host.confirm).not.toHaveBeenCalled();
    expect(h.requests).toHaveLength(3);
  });

  it('does not make requests when saved-lineup confirmation is canceled', async () => {
    const h = harness({ participants: ['openai/one', 'other/two'] });
    const host: FusionHost = {
      confirm: vi.fn(async () => true), selectRunAction: async () => 'cancel',
      configure: vi.fn(), review: vi.fn(),
    };
    createFusionExtension(host)(h.api);
    await h.handlerStore.handler!('compare', h.ctx);
    expect(h.requests).toHaveLength(0);
    expect(host.configure).not.toHaveBeenCalled();
  });
  it('compares answers, persists review, and only sends a message after explicit Fuse', async () => {
    const h = harness();
    const reviews: Array<{ get: () => FusionReview; actions: FusionReviewActions }> = [];
    const host: FusionHost = {
      confirm: async () => true,
      configure: async () => ({ participants: ['openai/one', 'other/two'], fusionModel: 'inherit' }),
      review: async (_ctx, get, actions) => { reviews.push({ get, actions }); },
    };
    createFusionExtension(host)(h.api);
    expect(FUSION_CONFIG.fields.participants.default).toEqual([]);
    await h.handlerStore.handler!('compare approaches', h.ctx);
    expect(h.requests).toHaveLength(3);
    expect(reviews[0]?.get()).toMatchObject({ prompt: 'compare approaches', answers: [{ model: 'openai/one' }, { model: 'other/two' }], comparison: { text: expect.any(String) } });
    expect(h.api.appendEntry).toHaveBeenCalledOnce();
    expect(h.messages).toHaveLength(0);
    await reviews[0]!.actions.fuse();
    expect(h.requests).toHaveLength(4);
    expect(h.messages).toHaveLength(1);
    expect(h.messages[0]).toEqual([expect.objectContaining({ content: expect.stringContaining('response for') }), { triggerTurn: false }]);
    expect(h.api.appendEntry).toHaveBeenCalledTimes(2);
  });

  it('reopens an unfinished branch review without model requests', async () => {
    const h = harness({ participants: ['openai/one', 'other/two'] });
    const opened: Array<() => FusionReview> = [];
    const host: FusionHost = {
      confirm: async () => true,
      configure: async () => undefined,
      review: async (_ctx, get) => { opened.push(get); },
    };
    createFusionExtension(host)(h.api);
    await h.handlerStore.handler!('a prompt', h.ctx);
    const requestCount = h.requests.length;
    await h.handlerStore.handler!('', h.ctx);
    expect(opened).toHaveLength(2);
    expect(opened[1]?.()).toEqual(opened[0]?.());
    expect(h.requests).toHaveLength(requestCount);
  });

  it('starts a new prompt after completed fusion and leaves cancellation request-free', async () => {
    const h = harness({ participants: ['openai/one', 'other/two'] });
    const reviews: Array<{ get: () => FusionReview; actions: FusionReviewActions }> = [];
    const input = vi.fn().mockResolvedValueOnce(undefined).mockResolvedValueOnce('A new question');
    h.ctx.ui.input = input;
    const host: FusionHost = {
      confirm: vi.fn(async () => true), configure: vi.fn(),
      review: async (_ctx, get, actions) => { reviews.push({ get, actions }); },
    };
    createFusionExtension(host)(h.api);
    await h.handlerStore.handler!('Original question', h.ctx);
    await reviews[0]!.actions.fuse();
    expect(h.requests).toHaveLength(4);
    await h.handlerStore.handler!('', h.ctx);
    expect(h.requests).toHaveLength(4);
    expect(reviews).toHaveLength(1);
    await h.handlerStore.handler!('', h.ctx);
    expect(input).toHaveBeenCalledWith('New Fusion prompt');
    expect(reviews[1]!.get().prompt).toBe('A new question');
    expect(reviews[1]!.get().fused).toBeUndefined();
    expect(h.requests).toHaveLength(7);
    expect(host.confirm).toHaveBeenCalledTimes(2);
  });

  it('retries only failed participants and preserves successful answers', async () => {
    const h = harness();
    const reviews: Array<{ get: () => FusionReview; actions: FusionReviewActions }> = [];
    const original = h.ctx.modelRegistry as unknown as { streamSimple(model: Model<any>, context: { messages: readonly { content: string }[] }, options?: unknown): { result(): Promise<unknown> } };
    let failOther = true;
    original.streamSimple = (selected, request) => {
      h.requests.push({ selected, request });
      return { result: async () => {
        if (selected.provider === 'other' && failOther) throw new Error('temporary provider failure');
        return {
          role: 'assistant', content: [{ type: 'text', text: `response for ${selected.id}` }],
          provider: selected.provider, model: selected.id, usage: { input: 1, output: 2, totalTokens: 3, cost: { total: 0.01 } }, stopReason: 'stop',
        };
      } };
    };
    const host: FusionHost = {
      confirm: async () => true,
      configure: async () => ({ participants: ['openai/one', 'other/two'], fusionModel: 'inherit' }),
      review: async (_ctx, get, actions) => { reviews.push({ get, actions }); },
    };
    createFusionExtension(host)(h.api);
    await h.handlerStore.handler!('question', h.ctx);
    expect(reviews[0]?.get().failures).toEqual([{ model: 'other/two', message: 'Fusion request failed for other/two: temporary provider failure' }]);
    expect(h.requests).toHaveLength(2);
    failOther = false;
    await reviews[0]!.actions.retryParticipants();
    expect(h.requests).toHaveLength(4);
    expect(reviews[0]?.get().answers.map(({ model }) => model)).toEqual(['openai/one', 'other/two']);
    expect(reviews[0]?.get().failures).toBeUndefined();
  });

  it('rejects headless and busy runs before requesting models', async () => {
    for (const overrides of [{ mode: 'print' as const }, { idle: false }]) {
      const h = harness({ ...overrides, participants: ['openai/one', 'other/two'] });
      const host: FusionHost = { confirm: vi.fn(), configure: vi.fn(), review: vi.fn() };
      createFusionExtension(host)(h.api);
      await h.handlerStore.handler!('question', h.ctx);
      expect(h.requests).toHaveLength(0);
      expect(host.configure).not.toHaveBeenCalled();
    }
  });

  it('does not spend when the user declines the request-count confirmation', async () => {
    const h = harness();
    const host: FusionHost = {
      confirm: vi.fn(async () => false),
      configure: async () => ({ participants: ['openai/one', 'other/two'], fusionModel: 'inherit' }),
      review: vi.fn(),
    };
    createFusionExtension(host)(h.api);
    await h.handlerStore.handler!('question', h.ctx);
    expect(host.confirm).toHaveBeenCalledOnce();
    expect(h.requests).toHaveLength(0);
    expect(host.review).not.toHaveBeenCalled();
  });

  it('saves a changed model lineup without inference and uses it for the next run', async () => {
    const h = harness({ participants: ['openai/one', 'other/two'] });
    const reviews: Array<() => FusionReview> = [];
    const host: FusionHost = {
      confirm: async () => true,
      configure: vi.fn(async () => ({ participants: ['other/two', 'openai/one'], fusionModel: 'other/two' })),
      review: async (_ctx, getReview) => { reviews.push(getReview); },
    };
    createFusionExtension(host)(h.api);
    await h.handlerStore.handlers['fusion-models']!('', h.ctx);
    expect(h.requests).toHaveLength(0);
    expect(host.configure).toHaveBeenCalledOnce();
    await h.handlerStore.handler!('question', h.ctx);
    expect(host.configure).toHaveBeenCalledOnce();
    expect(reviews[0]?.().fusionModel).toBe('other/two');
    expect(h.requests).toHaveLength(3);
  });

  it('does not adopt a lineup dialog result after the session changes', async () => {
    const h = harness({ participants: ['openai/one', 'other/two'] });
    let resolveConfiguration!: (value: { participants: readonly string[]; fusionModel: string } | undefined) => void;
    const host: FusionHost = {
      confirm: vi.fn(async () => true),
      configure: vi.fn(() => new Promise<{ participants: readonly string[]; fusionModel: string } | undefined>((resolve) => { resolveConfiguration = resolve; })),
      review: vi.fn(),
    };
    createFusionExtension(host)(h.api);
    const running = h.handlerStore.handlers['fusion-models']!('', h.ctx);
    await Promise.resolve();
    for (const listener of h.events.get('session_before_switch') ?? []) listener();
    resolveConfiguration({ participants: ['other/two', 'openai/one'], fusionModel: 'other/two' });
    await running;
    expect(h.requests).toHaveLength(0);
    await h.handlerStore.handler!('question', h.ctx);
    expect(h.requests.at(-1)).toMatchObject({ selected: { provider: 'openai', id: 'one' } });
  });

  it('aborts in-flight model requests when session replacement begins', async () => {
    const h = harness({ participants: ['openai/one', 'other/two'] });
    const host: FusionHost = { confirm: vi.fn(async () => true), configure: vi.fn(), review: vi.fn() };
    const controllers: AbortSignal[] = [];
    const modelRegistry = h.ctx.modelRegistry as unknown as { streamSimple(model: Model<any>, context: unknown, options: { signal: AbortSignal }): { result(): Promise<never> } };
    modelRegistry.streamSimple = (_model, _context, { signal }) => {
      controllers.push(signal);
      return { result: () => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })) };
    };
    createFusionExtension(host)(h.api);
    const running = h.handlerStore.handler!('question', h.ctx);
    await Promise.resolve();
    for (const listener of h.events.get('session_before_switch') ?? []) listener();
    await running;
    expect(controllers.every((signal) => signal.aborted)).toBe(true);
    expect(h.messages).toHaveLength(0);
  });

  it('does not start requests if the session changes while model selection or confirmation is open', async () => {
    for (const stage of ['configure', 'confirm'] as const) {
      const h = harness();
      const selected = deferred<{ participants: readonly string[]; fusionModel: string } | undefined>();
      const confirmation = deferred<boolean>();
      const started = deferred<void>();
      const host: FusionHost = {
        confirm: vi.fn(async () => {
          started.resolve();
          return confirmation.promise;
        }),
        configure: vi.fn(async () => {
          if (stage === 'configure') {
            started.resolve();
            return selected.promise;
          }
          return { participants: ['openai/one', 'other/two'], fusionModel: 'inherit' };
        }),
        review: vi.fn(),
      };
      createFusionExtension(host)(h.api);
      const running = h.handlerStore.handler!('question', h.ctx);
      await started.promise;
      for (const listener of h.events.get('session_before_switch') ?? []) listener();
      if (stage === 'configure') selected.resolve({ participants: ['openai/one', 'other/two'], fusionModel: 'inherit' });
      else confirmation.resolve(true);
      await running;
      expect(h.requests).toHaveLength(0);
      expect(host.review).not.toHaveBeenCalled();
    }
  });

  it('fences stale review actions after a session replacement', async () => {
    const h = harness({ participants: ['openai/one', 'other/two'] });
    let actions: FusionReviewActions | undefined;
    const host: FusionHost = {
      confirm: async () => true,
      configure: vi.fn(),
      review: async (_ctx, _getReview, reviewActions) => { actions = reviewActions; },
    };
    createFusionExtension(host)(h.api);
    await h.handlerStore.handler!('question', h.ctx);
    expect(h.requests).toHaveLength(3);
    for (const listener of h.events.get('session_before_switch') ?? []) listener();
    await actions!.fuse();
    expect(h.requests).toHaveLength(3);
    expect(h.messages).toHaveLength(0);
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}
