import type {
  AgentRuntime,
  Api,
  ExtensionContext,
  FelanExtensionAPI,
  Model,
  ModelsService,
  Provider,
} from '@felan-ai/agent-core';
import { createExtensionServiceAccess, createFelanServiceRegistry, MODELS_SERVICE, RUN_HOLD_EVENT, type RunHoldEvent } from '@felan-ai/agent-core';
import { describe, expect, it, vi } from 'vitest';
import codexExtension from '../src/index.js';

type Handler = (event: any, ctx: ExtensionContext) => unknown;

describe('Codex extension activation', () => {
  it('resolves ultrafast and fallback afresh after model selection through the provider hook', async () => {
    const harness = createHarness({ priority: 'ultrafast', fast: false });
    await codexExtension(harness.pi);
    for (const [id, serviceTier] of [
      ['gpt-6-astra', 'ultrafast'],
      ['gpt-6.1-sol', 'ultrafast'],
      ['gpt-6.2-astra', 'ultrafast'],
      ['gpt-6.2-sol', 'ultrafast'],
      ['gpt-6-sol', 'priority'],
      ['gpt-6-astra', 'ultrafast'],
    ] as const) {
      const ctx = context('openai-codex', id, 'openai-codex-responses');
      await harness.emit('model_select', { model: ctx.model }, ctx);
      const [request] = await harness.emit('before_provider_request', {
        payload: { model: id, reasoning: { effort: 'high' } },
      }, ctx);
      expect(request).toMatchObject({ service_tier: serviceTier, reasoning: { effort: 'high' } });
    }
  });

  it('replaces only ordinary coding tools and preserves unrelated tools for eligible models', async () => {
    const harness = createHarness();
    await codexExtension(harness.pi);

    await harness.emit('session_start', {}, context('openai-codex', 'gpt-5.3-codex'));

    expect(harness.activeTools).toEqual([
      'read', 'bash', 'grep', 'find', 'ls', 'ask_user', 'Agent', 'TaskCreate',
      'apply_patch',
    ]);
    expect(harness.registerTool.mock.calls.map(([tool]) => tool.name)).toEqual([
      'apply_patch',
    ]);
  });

  it('normalizes Codex function-tool strictness through the provider hook', async () => {
    const harness = createHarness();
    const ctx = context('openai-codex', 'gpt-6-astra');
    await codexExtension(harness.pi);

    const [result] = await harness.emit('before_provider_request', {
      payload: {
        tools: [
          { type: 'function', name: 'optional', strict: null },
          { type: 'function', name: 'strict', strict: true },
        ],
      },
    }, ctx);

    expect(result).toEqual({
      tools: [
        { type: 'function', name: 'optional', strict: false },
        { type: 'function', name: 'strict', strict: true },
      ],
      text: { verbosity: 'low' },
    });
  });

  it.each([
    ['openai-codex', 'openai-codex-responses'],
    ['openai', 'openai-codex-responses'],
    ['openai', 'openai-responses'],
  ] as const)('preserves Pi-native reasoning updates on %s/%s', async (provider, api) => {
    const harness = createHarness();
    const ctx = context(provider, 'gpt-6.1-sol', api);
    await codexExtension(harness.pi);
    const payload = {
      model: ctx.model!.id,
      reasoning: { effort: 'medium' },
      input: [
        { role: 'user', content: 'Continue' },
        { type: 'configuration_update', reasoning: { effort: 'high' } },
      ],
    };

    await harness.emit('thinking_level_select', { previousLevel: 'low', level: 'high' }, ctx);
    expect(await harness.emit('context', { messages: [] }, ctx)).toEqual([]);
    const [request] = await harness.emit('before_provider_request', { payload }, ctx) as [typeof payload];

    expect(request.input).toBe(payload.input);
    expect(request.reasoning).toBe(payload.reasoning);
    expect(harness.pi.appendEntry).not.toHaveBeenCalled();
  });

  it('restores ordinary tools when switching away and activates on a later GPT selection', async () => {
    const harness = createHarness();
    await codexExtension(harness.pi);
    await harness.emit('session_start', {}, context('openai', 'gpt-5.4'));

    await harness.emit('model_select', { model: model('anthropic', 'claude-opus') }, context('anthropic', 'claude-opus'));
    expect(harness.activeTools).toEqual([
      'read', 'bash', 'grep', 'find', 'ls', 'ask_user', 'Agent', 'TaskCreate', 'edit', 'write',
    ]);

    await harness.emit('model_select', { model: model('openai', 'gpt-5.4') }, context('openai', 'gpt-5.4'));
    expect(harness.activeTools).toContain('apply_patch');
    expect(harness.activeTools).toContain('bash');
  });

  it('keeps ordinary tools for non-GPT OpenAI models', async () => {
    const harness = createHarness();
    await codexExtension(harness.pi);
    await harness.emit('session_start', {}, context('openai', 'o3'));

    expect(harness.activeTools).toEqual([
      'read', 'bash', 'edit', 'write', 'grep', 'find', 'ls', 'ask_user', 'Agent', 'TaskCreate',
    ]);
  });

  it('defers eligible threshold compaction until the agent settles by default', async () => {
    const harness = createHarness();
    await codexExtension(harness.pi);
    const ctx = context('openai-codex', 'gpt-5.3-codex');
    const compact = vi.fn();
    ctx.isIdle = () => false;
    ctx.compact = compact;

    await expect(harness.emit('session_before_compact', { reason: 'threshold' }, ctx))
      .resolves.toEqual([{ cancel: true }]);
    await harness.emit('agent_settled', {}, ctx);

    expect(compact).toHaveBeenCalledTimes(1);
  });

  it('refuses a run hold while it owes the run a deferred compaction', async () => {
    const harness = createHarness();
    await codexExtension(harness.pi);
    const ctx = context('openai-codex', 'gpt-5.3-codex');
    ctx.isIdle = () => false;
    ctx.compact = vi.fn();
    const refusals = () => {
      const reasons: string[] = [];
      harness.pi.events.emit(RUN_HOLD_EVENT, { refuse: (reason: string) => reasons.push(reason) } satisfies RunHoldEvent);
      return reasons;
    };

    await harness.emit('agent_start', {}, ctx);
    expect(refusals()).toEqual([]);
    await harness.emit('session_before_compact', { reason: 'threshold' }, ctx);
    expect(refusals()).toHaveLength(1);
    await harness.emit('agent_settled', {}, ctx);
    expect(ctx.compact).toHaveBeenCalledTimes(1);
    expect(refusals()).toEqual([]);
  });

  it('schedules at most one post-agent compaction per agent run', async () => {
    const harness = createHarness();
    await codexExtension(harness.pi);
    const ctx = context('openai-codex', 'gpt-5.3-codex');
    ctx.isIdle = () => false;

    await harness.emit('agent_start', {}, ctx);
    await harness.emit('session_before_compact', { reason: 'threshold' }, ctx);
    await harness.emit('agent_settled', {}, ctx);
    const options = vi.mocked(ctx.compact).mock.calls[0]![0]!;

    await expect(harness.emit('session_before_compact', { reason: 'threshold' }, ctx))
      .resolves.toEqual([{ cancel: true }]);
    options.onComplete?.({} as never);
    await expect(harness.emit('session_before_compact', { reason: 'threshold' }, ctx))
      .resolves.toEqual([{ cancel: true }]);
    await harness.emit('agent_settled', {}, ctx);

    expect(ctx.compact).toHaveBeenCalledTimes(1);

    await harness.emit('agent_start', {}, ctx);
    await harness.emit('session_before_compact', { reason: 'threshold' }, ctx);
    await harness.emit('agent_settled', {}, ctx);

    expect(ctx.compact).toHaveBeenCalledTimes(2);
  });

  it('does not report user-aborted post-agent compaction as a failure', async () => {
    const harness = createHarness();
    await codexExtension(harness.pi);
    const ctx = context('openai', 'gpt-5.4');
    const notify = vi.fn();
    ctx.isIdle = () => false;
    ctx.ui = { notify } as never;

    await harness.emit('session_before_compact', { reason: 'threshold' }, ctx);
    await harness.emit('agent_settled', {}, ctx);
    const options = vi.mocked(ctx.compact).mock.calls[0]![0]!;
    options.onError?.(new Error('Turn prefix summarization failed: This operation was aborted'));
    await harness.emit('session_before_compact', { reason: 'threshold' }, ctx);
    await harness.emit('agent_settled', {}, ctx);

    expect(notify).not.toHaveBeenCalled();
    expect(ctx.compact).toHaveBeenCalledTimes(1);
  });

  it('does not follow a completed immediate compaction with post-agent compaction', async () => {
    const harness = createHarness();
    await codexExtension(harness.pi);
    const ctx = context('openai', 'gpt-5.4');
    ctx.isIdle = () => false;

    await harness.emit('agent_start', {}, ctx);
    await harness.emit('session_before_compact', { reason: 'threshold' }, ctx);
    await harness.emit('session_before_compact', { reason: 'overflow' }, ctx);
    const compactionEntry = persistCompaction(ctx, 'immediate-compaction');
    await harness.emit('session_compact', {
      reason: 'overflow',
      compactionEntry,
    }, ctx);
    await harness.emit('session_before_compact', { reason: 'threshold' }, ctx);
    await harness.emit('agent_settled', {}, ctx);

    expect(ctx.compact).not.toHaveBeenCalled();
  });

  it.each(['manual', 'overflow'] as const)(
    'lets %s compaction supersede a deferred threshold without another post-agent compaction',
    async (reason) => {
      const harness = createHarness();
      await codexExtension(harness.pi);
      const ctx = context('openai', 'gpt-5.4');
      ctx.isIdle = () => false;

      await harness.emit('session_before_compact', { reason: 'threshold' }, ctx);
      await expect(harness.emit('session_before_compact', { reason }, ctx))
        .resolves.toEqual([undefined]);
      await harness.emit('agent_settled', {}, ctx);

      expect(ctx.compact).not.toHaveBeenCalled();
    },
  );

  it('ignores completion callbacks from a replaced session', async () => {
    const harness = createHarness();
    await codexExtension(harness.pi);
    const ctx = context('openai', 'gpt-5.4');
    ctx.isIdle = () => false;

    await harness.emit('session_before_compact', { reason: 'threshold' }, ctx);
    await harness.emit('agent_settled', {}, ctx);
    const previousOptions = vi.mocked(ctx.compact).mock.calls[0]![0]!;

    await harness.emit('session_start', {}, ctx);
    await harness.emit('session_before_compact', { reason: 'threshold' }, ctx);
    await harness.emit('agent_settled', {}, ctx);
    const currentOptions = vi.mocked(ctx.compact).mock.calls[1]![0]!;
    previousOptions.onComplete?.({} as never);

    await expect(harness.emit('session_before_compact', { reason: 'threshold' }, ctx))
      .resolves.toEqual([{ cancel: true }]);
    currentOptions.onComplete?.({} as never);
    await harness.emit('agent_settled', {}, ctx);

    expect(ctx.compact).toHaveBeenCalledTimes(2);
  });

  it.each(['onComplete', 'onError'] as const)(
    'ignores %s callbacks after session shutdown invalidates the context',
    async (callback) => {
      const harness = createHarness();
      await codexExtension(harness.pi);
      const ctx = context('openai', 'gpt-5.4');
      let contextActive = true;
      ctx.isIdle = () => {
        if (!contextActive) {
          throw new Error('This extension ctx is stale after session replacement or reload.');
        }
        return false;
      };

      await harness.emit('session_before_compact', { reason: 'threshold' }, ctx);
      await harness.emit('agent_settled', {}, ctx);
      const options = vi.mocked(ctx.compact).mock.calls[0]![0]!;

      await harness.emit('session_shutdown', { reason: 'resume' }, ctx);
      contextActive = false;

      expect(() => {
        if (callback === 'onComplete') options.onComplete?.({} as never);
        else options.onError?.(new Error('Compaction cancelled'));
      }).not.toThrow();
    },
  );

  it('ignores a successful compaction event from a replaced session', async () => {
    const harness = createHarness();
    await codexExtension(harness.pi);
    const previousCtx = context('openai', 'gpt-5.4');
    const currentCtx = context('openai', 'gpt-5.4');
    previousCtx.isIdle = () => false;
    currentCtx.isIdle = () => false;

    await harness.emit('session_before_compact', {
      reason: 'overflow',
      branchEntries: [{ id: 'previous-leaf' }],
    }, previousCtx);
    await harness.emit('session_start', {}, currentCtx);
    await harness.emit('agent_start', {}, currentCtx);
    await harness.emit('session_before_compact', {
      reason: 'overflow',
      branchEntries: [{ id: 'current-leaf' }],
    }, currentCtx);
    await harness.emit('session_compact', {
      reason: 'overflow',
      compactionEntry: { id: 'previous-compaction', parentId: 'previous-leaf' },
    }, currentCtx);
    const currentEntry = persistCompaction(currentCtx, 'current-compaction', 'current-leaf');
    await harness.emit('session_compact', {
      reason: 'overflow',
      compactionEntry: currentEntry,
    }, currentCtx);
    await harness.emit('session_before_compact', { reason: 'threshold' }, currentCtx);
    await harness.emit('agent_settled', {}, currentCtx);

    expect(currentCtx.compact).not.toHaveBeenCalled();
  });

  it('recognizes a successful compaction after its branch advances', async () => {
    const harness = createHarness();
    await codexExtension(harness.pi);
    const ctx = context('openai', 'gpt-5.4');
    ctx.isIdle = () => false;

    await harness.emit('agent_start', {}, ctx);
    await harness.emit('session_before_compact', {
      reason: 'overflow',
      branchEntries: [{ id: 'initial-leaf' }],
    }, ctx);
    const compactionEntry = persistCompaction(ctx, 'advanced-compaction', 'new-custom-entry');
    await harness.emit('session_compact', {
      reason: 'overflow',
      compactionEntry,
    }, ctx);
    await harness.emit('session_before_compact', { reason: 'threshold' }, ctx);
    await harness.emit('agent_settled', {}, ctx);

    expect(ctx.compact).not.toHaveBeenCalled();
  });

  it('supersedes stale Pi compaction attribution after a failure', async () => {
    const harness = createHarness();
    await codexExtension(harness.pi);
    const ctx = context('openai', 'gpt-5.4');
    ctx.isIdle = () => false;

    await harness.emit('agent_start', {}, ctx);
    await harness.emit('session_before_compact', {
      reason: 'overflow',
      branchEntries: [{ id: 'failed-leaf' }],
    }, ctx);
    await harness.emit('session_compact_failed', { reason: 'overflow' }, ctx);
    await harness.emit('session_before_compact', {
      reason: 'overflow',
      branchEntries: [{ id: 'current-leaf' }],
    }, ctx);
    const compactionEntry = persistCompaction(ctx, 'current-compaction', 'current-leaf');
    await harness.emit('session_compact', {
      reason: 'overflow',
      compactionEntry,
    }, ctx);
    await harness.emit('session_before_compact', {
      reason: 'threshold',
      branchEntries: [{ id: 'current-leaf' }],
    }, ctx);
    await harness.emit('agent_settled', {}, ctx);

    expect(ctx.compact).not.toHaveBeenCalled();
  });

  it('preserves a queued run compaction request until the previous compaction completes', async () => {
    const harness = createHarness();
    await codexExtension(harness.pi);
    const ctx = context('openai', 'gpt-5.4');
    let idle = false;
    ctx.isIdle = () => idle;

    await harness.emit('agent_start', {}, ctx);
    await harness.emit('session_before_compact', { reason: 'threshold' }, ctx);
    await harness.emit('agent_settled', {}, ctx);
    const previousOptions = vi.mocked(ctx.compact).mock.calls[0]![0]!;
    await harness.emit('session_before_compact', {
      reason: 'manual',
      branchEntries: [{ id: 'previous-leaf' }],
    }, ctx);

    await harness.emit('agent_start', {}, ctx);
    await harness.emit('session_before_compact', { reason: 'threshold' }, ctx);
    await harness.emit('agent_settled', {}, ctx);
    expect(ctx.compact).toHaveBeenCalledTimes(1);

    const compactionEntry = persistCompaction(ctx, 'previous-compaction', 'previous-leaf');
    await harness.emit('session_compact', {
      reason: 'manual',
      compactionEntry,
    }, ctx);
    idle = true;
    previousOptions.onComplete?.({} as never);

    expect(ctx.compact).toHaveBeenCalledTimes(2);
  });

  it('keeps Pi threshold timing when post-agent compaction is disabled', async () => {
    const harness = createHarness({ postAgentRunCompaction: false });
    await codexExtension(harness.pi);
    const ctx = context('openai-codex', 'gpt-5.3-codex');
    ctx.isIdle = () => false;

    await expect(harness.emit('session_before_compact', { reason: 'threshold' }, ctx))
      .resolves.toEqual([undefined]);
    await harness.emit('agent_settled', {}, ctx);

    expect(ctx.compact).not.toHaveBeenCalled();
  });

  it('does not defer threshold compaction for non-GPT models', async () => {
    const harness = createHarness();
    await codexExtension(harness.pi);
    const ctx = context('openai', 'o3');
    ctx.isIdle = () => false;

    await expect(harness.emit('session_before_compact', { reason: 'threshold' }, ctx))
      .resolves.toEqual([undefined]);
  });

  it('does not defer manual or overflow compaction', async () => {
    const harness = createHarness();
    await codexExtension(harness.pi);
    const ctx = context('openai', 'gpt-5.4');
    ctx.isIdle = () => false;

    await expect(harness.emit('session_before_compact', { reason: 'manual' }, ctx))
      .resolves.toEqual([undefined]);
    await expect(harness.emit('session_before_compact', { reason: 'overflow' }, ctx))
      .resolves.toEqual([undefined]);
  });

  it('clears deferred state if the model changes before settlement', async () => {
    const harness = createHarness();
    await codexExtension(harness.pi);
    const gpt = context('openai', 'gpt-5.4');
    gpt.isIdle = () => false;
    await harness.emit('session_before_compact', { reason: 'threshold' }, gpt);

    const other = context('anthropic', 'claude-opus');
    await harness.emit('agent_settled', {}, other);
    await harness.emit('agent_settled', {}, gpt);

    expect(gpt.compact).not.toHaveBeenCalled();
  });
});

describe('Codex image provider registration', () => {
  it('declares optional Models access without losing its execution contribution', () => {
    expect(codexExtension.serviceRequirements).toEqual({ optional: [MODELS_SERVICE] });
    expect(codexExtension.execution).toBeTypeOf('function');
  });

  it('registers only a native image provider by default', async () => {
    const harness = createHarness();
    await codexExtension(harness.pi);

    expect(harness.registerProvider).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      id: 'openai-codex-images',
      getModels: expect.any(Function),
      getAllModels: expect.any(Function),
      generateImages: expect.any(Function),
    }));
    const [provider] = harness.registerProvider.mock.calls[0]!;
    expect(provider.getModels()).toEqual([]);
    expect(provider.getAllModels?.().map(({ id }) => id)).toEqual(['gpt-image-2', 'gpt-image-2.5']);
    expect(harness.getAvailable).toHaveBeenCalledWith('openai-codex');

    await harness.emit('session_shutdown', {}, context('openai', 'gpt-5.4'));
    expect(harness.unregisterProvider).not.toHaveBeenCalled();
  });

  it.each([
    { config: { imageGeneration: false }, modelsAvailable: true },
    { config: {}, modelsAvailable: false },
  ])('does not register when disabled or Models is absent: %j', async ({ config, modelsAvailable }) => {
    const harness = createHarness(config, modelsAvailable);
    await codexExtension(harness.pi);

    expect(harness.registerProvider).not.toHaveBeenCalled();
    expect(harness.getAvailable).not.toHaveBeenCalled();
  });

  it.each([true, false, 'rejected'] as const)('uses the initial availability result %s before session_start', async (available) => {
    const harness = createHarness();
    if (available === false) harness.getAvailable.mockResolvedValue([]);
    if (available === 'rejected') harness.getAvailable.mockRejectedValue(new Error('unavailable'));
    await codexExtension(harness.pi);
    expect(harness.getAvailable).toHaveBeenCalledWith('openai-codex');
    const [provider] = harness.registerProvider.mock.calls[0]!;
    const options = {
      signal: new AbortController().signal,
      ctx: { env: async () => undefined, fileExists: async () => false },
    };
    const expected = available === true ? { type: 'api_key', source: 'OpenAI Codex login' } : undefined;
    await expect(provider.auth.apiKey!.check!(options)).resolves.toEqual(expected);

    harness.getAvailable.mockRejectedValue(new Error('must not be called again'));
    await expect(provider.auth.apiKey!.check!(options)).resolves.toEqual(expected);
    await expect(provider.auth.apiKey!.resolve(options)).resolves.toBeUndefined();
  });

  it.each([true, false])('uses registry auth status after session_start despite initial availability %s', async (available) => {
    const harness = createHarness();
    if (!available) harness.getAvailable.mockResolvedValue([]);
    await codexExtension(harness.pi);
    const [provider] = harness.registerProvider.mock.calls[0]!;
    const getProviderAuthStatus = vi.fn<ExtensionContext['modelRegistry']['getProviderAuthStatus']>();
    const getProviderAuth = vi.fn<ExtensionContext['modelRegistry']['getProviderAuth']>();
    const ctx = context('openai-codex', 'gpt-6-astra');
    ctx.modelRegistry = { getProviderAuthStatus, getProviderAuth } as unknown as ExtensionContext['modelRegistry'];
    await harness.emit('session_start', {}, ctx);
    const options = {
      signal: new AbortController().signal,
      ctx: { env: async () => undefined, fileExists: async () => false },
    };
    for (const configured of [!available, available]) {
      getProviderAuthStatus.mockReturnValue({ configured });
      await expect(provider.auth.apiKey!.check!(options)).resolves.toEqual(configured
        ? { type: 'api_key', source: 'OpenAI Codex login' }
        : undefined);
    }
    expect(getProviderAuthStatus).toHaveBeenCalledWith('openai-codex');
    expect(getProviderAuth).not.toHaveBeenCalled();
  });

  it('resolves the current session registry token only after session_start', async () => {
    const harness = createHarness();
    await codexExtension(harness.pi);
    const [provider] = harness.registerProvider.mock.calls[0]!;
    const getProviderAuth = vi.fn<ExtensionContext['modelRegistry']['getProviderAuth']>();
    const ctx = context('openai-codex', 'gpt-6-astra');
    ctx.modelRegistry = { getProviderAuth } as unknown as ExtensionContext['modelRegistry'];
    const options = {
      signal: new AbortController().signal,
      ctx: { env: async () => undefined, fileExists: async () => false },
    };
    await expect(provider.auth.apiKey!.resolve(options)).resolves.toBeUndefined();
    expect(getProviderAuth).not.toHaveBeenCalled();
    await harness.emit('session_start', {}, ctx);

    getProviderAuth.mockResolvedValue({ auth: { apiKey: '  test-codex-token\n' } });
    await expect(provider.auth.apiKey!.resolve(options)).resolves.toEqual({
      auth: { apiKey: 'test-codex-token' }, source: 'OpenAI Codex login',
    });
    expect(getProviderAuth).toHaveBeenCalledWith('openai-codex');

    for (const auth of [undefined, { auth: {} }, { auth: { apiKey: ' \n' } }]) {
      getProviderAuth.mockResolvedValue(auth);
      await expect(provider.auth.apiKey!.resolve(options)).resolves.toBeUndefined();
    }
    const nextContext = context('openai-codex', 'gpt-6-astra');
    const nextAuth = vi.fn<ExtensionContext['modelRegistry']['getProviderAuth']>()
      .mockResolvedValue({ auth: { apiKey: 'next-session-token' } });
    nextContext.modelRegistry = { getProviderAuth: nextAuth } as unknown as ExtensionContext['modelRegistry'];
    await harness.emit('session_start', {}, nextContext);
    await expect(provider.auth.apiKey!.resolve(options)).resolves.toEqual({
      auth: { apiKey: 'next-session-token' }, source: 'OpenAI Codex login',
    });
    expect(nextAuth).toHaveBeenCalledWith('openai-codex');
  });
});

function createHarness(config: Record<string, unknown> = {}, modelsAvailable = true) {
  const handlers = new Map<string, Handler[]>();
  const bus = new Map<string, Array<(data: unknown) => void>>();
  const activeTools = ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls', 'ask_user', 'Agent', 'TaskCreate'];
  const registerTool = vi.fn();
  const registerProvider = vi.fn<(provider: Provider) => void>();
  const unregisterProvider = vi.fn();
  const getAvailable = vi.fn<ModelsService['getAvailable']>()
    .mockResolvedValue([model('openai-codex', 'gpt-6-astra')]);
  const services = createFelanServiceRegistry();
  if (modelsAvailable) services.set(MODELS_SERVICE, { getAvailable } as unknown as ModelsService);
  const pi = {
    runtime: unusedRuntime(),
    services: createExtensionServiceAccess(services, codexExtension.serviceRequirements!),
    agentDir: '/agent',
    config,
    registerCapability: vi.fn(),
    registerTool,
    registerProvider,
    unregisterProvider,
    appendEntry: vi.fn(),
    events: {
      emit: (channel: string, data: unknown) => { for (const handler of bus.get(channel) ?? []) handler(data); },
      on: (channel: string, handler: (data: unknown) => void) => {
        bus.set(channel, [...(bus.get(channel) ?? []), handler]);
        return () => bus.set(channel, (bus.get(channel) ?? []).filter(item => item !== handler));
      },
    },
    getActiveTools: () => [...activeTools],
    setActiveTools: (names: string[]) => activeTools.splice(0, activeTools.length, ...names),
    on: (name: string, handler: Handler) => {
      const list = handlers.get(name) ?? [];
      list.push(handler);
      handlers.set(name, list);
    },
  } as unknown as FelanExtensionAPI;
  return {
    pi,
    activeTools,
    registerTool,
    registerProvider,
    unregisterProvider,
    getAvailable,
    async emit(name: string, event: unknown, ctx: ExtensionContext) {
      const results: unknown[] = [];
      for (const handler of handlers.get(name) ?? []) results.push(await handler(event, ctx));
      return results;
    },
  };
}

function context(provider: string, id: string, api: Api = 'openai-responses'): ExtensionContext {
  const entries = new Map<string, unknown>();
  const branch: Array<{ id: string; [key: string]: unknown }> = [];
  const ctx = {
    mode: 'print',
    model: model(provider, id, api),
    isIdle: () => true,
    compact: vi.fn(),
    sessionManager: {
      getEntry: (entryId: string) => entries.get(entryId),
      getSessionId: () => 'test-session',
      getBranch: () => [...branch],
      getEntries: () => [...branch],
      getLeafId: () => branch.at(-1)?.id ?? null,
    },
  } as unknown as ExtensionContext;
  sessionEntries.set(ctx, entries);
  return ctx;
}

const sessionEntries = new WeakMap<ExtensionContext, Map<string, unknown>>();
function persistCompaction(ctx: ExtensionContext, id: string, parentId?: string): Record<string, unknown> {
  const entry = { type: 'compaction', id, parentId };
  sessionEntries.get(ctx)?.set(id, entry);
  return entry;
}

function model(provider: string, id: string, api: Api = 'openai-responses'): Model<Api> {
  return {
    provider, id, api, input: ['text', 'image'], reasoning: true,
    thinkingLevelMap: {
      off: id === 'gpt-6-sol' || id === 'gpt-6-luna' ? 'none' : null,
      low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max',
    },
  } as Model<Api>;
}

function unusedRuntime(): AgentRuntime {
  const unused = async (): Promise<never> => { throw new Error('unused'); };
  return {
    kind: 'host',
    cwd: '/workspace',
    processes: { startShell: unused },
    logger: { level: 'off', child() { return this; }, debug() {}, info() {}, warn() {}, error() {} },
    storage: () => ({ root: '/storage', readFile: unused, writeFile: unused, appendFile: unused, listFiles: unused, mkdir: unused, remove: unused }),
    exec: unused,
    shell: unused,
    readFile: unused,
    writeFile: unused,
    listFiles: unused,
    mkdir: unused,
    remove: unused,
  };
}
