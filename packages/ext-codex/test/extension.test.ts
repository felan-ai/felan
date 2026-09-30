import type {
  AgentRuntime,
  Api,
  ExtensionContext,
  FelanExtensionAPI,
  Model,
} from '@felan-ai/agent-core';
import { describe, expect, it, vi } from 'vitest';
import codexExtension from '../src/index.js';

type Handler = (event: any, ctx: ExtensionContext) => unknown;

const RESPONSES_APIS = [
  ['openai-codex', 'openai-codex-responses'],
  ['openai', 'openai-codex-responses'],
  ['openai', 'openai-responses'],
] as const;
const REASONING_MODELS = ['gpt-6-astra', 'gpt-6-sol', 'gpt-6.1-sol', 'gpt-6-luna'].flatMap((id) => (
  RESPONSES_APIS.map(([provider, api]) => ({ provider, api, id }))
));

describe('Codex extension activation', () => {
  it('resolves ultrafast and fallback afresh after model selection through the provider hook', async () => {
    const harness = createHarness(true, { priority: 'ultrafast', fast: false });
    await codexExtension(harness.pi);
    for (const [id, serviceTier] of [
      ['gpt-6-astra', 'ultrafast'], ['gpt-6-sol', 'priority'], ['gpt-6-astra', 'ultrafast'],
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

  it('activates the structured tool surface for GPT-6 Astra', async () => {
    const harness = createHarness();
    const ctx = context('openai-codex', 'gpt-6-astra');
    await codexExtension(harness.pi);

    await harness.emit('session_start', {}, ctx);

    expect(harness.activeTools).toEqual(expect.arrayContaining([
      'apply_patch',
    ]));
    expect(harness.activeTools).toContain('read');
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

  it.each(REASONING_MODELS)('preserves the original $provider/$api/$id effort when thinking changes between turns', async ({ provider, api, id }) => {
    const harness = createHarness();
    const ctx = context(provider, id, api);
    await codexExtension(harness.pi);

    const oldUser = { role: 'user', content: 'Draft a plan.', timestamp: 1 };
    const oldAssistant = {
      role: 'assistant', content: 'Here is a plan.', timestamp: 2,
      api: ctx.model!.api, provider: ctx.model!.provider, model: ctx.model!.id,
    };
    const nextUser = { role: 'user', content: 'Examine the edge cases.', timestamp: 3 };
    persistMessage(ctx, oldUser);
    persistMessage(ctx, oldAssistant);
    await harness.emit('thinking_level_select', { previousLevel: 'low', level: 'high' }, ctx);
    persistMessage(ctx, nextUser);
    const [projection] = await harness.emit('context', {
      messages: [oldUser, oldAssistant, nextUser],
    }, ctx) as [{ messages: Array<{ role: string; content: string }> }];
    const input = projection.messages.map(({ role, content }) => ({
      role: role === 'custom' ? 'user' : role,
      content,
    }));
    const [request] = await harness.emit('before_provider_request', {
      payload: {
        model: id,
        reasoning: { effort: 'high', summary: 'auto' },
        input,
      },
    }, ctx);

    expect(request).toMatchObject({
      reasoning: { effort: 'low', summary: 'auto' },
      input: [
        { role: 'user', content: 'Draft a plan.' },
        { role: 'assistant', content: 'Here is a plan.' },
        { type: 'configuration_update', reasoning: { effort: 'high' } },
        { role: 'user', content: 'Examine the edge cases.' },
      ],
    });
  });

  it.each(RESPONSES_APIS)('uses the new request-level effort before the first response in a model lane on %s/%s', async (provider, api) => {
    const harness = createHarness();
    const ctx = context(provider, 'gpt-6-astra', api);
    await codexExtension(harness.pi);

    await harness.emit('thinking_level_select', { previousLevel: 'low', level: 'high' }, ctx);
    expect(sessionBranches.get(ctx)).toEqual([]);
    const [request] = await harness.emit('before_provider_request', {
      payload: { model: 'gpt-6-astra', reasoning: { effort: 'high' }, input: [{ role: 'user', content: 'Hello' }] },
    }, ctx);
    expect(request).toMatchObject({
      reasoning: { effort: 'high' }, input: [{ role: 'user', content: 'Hello' }],
    });
  });

  it.each(REASONING_MODELS)(
    'records a cache-preserving change for $provider/$api/$id', async ({ provider, api, id }) => {
      const harness = createHarness();
      const ctx = context(provider, id, api);
      await codexExtension(harness.pi);

      persistAnswer(ctx);

      await harness.emit('thinking_level_select', { previousLevel: 'low', level: 'high' }, ctx);

      expect(sessionBranches.get(ctx)).toContainEqual(expect.objectContaining({
        type: 'custom',
        data: expect.objectContaining({ initialEffort: 'low', effort: 'high' }),
      }));
    },
  );

  it.each(['gpt-6-astra', 'gpt-6.1-sol'])('supports the openai provider for %s when its API is Codex Responses', async (id) => {
    const harness = createHarness();
    const ctx = context('openai', id, 'openai-codex-responses');
    await codexExtension(harness.pi);
    persistAnswer(ctx);
    await harness.emit('thinking_level_select', { previousLevel: 'low', level: 'high' }, ctx);

    expect(sessionBranches.get(ctx)).toContainEqual(expect.objectContaining({
      type: 'custom', data: expect.objectContaining({ initialEffort: 'low', effort: 'high' }),
    }));
  });

  it.each(REASONING_MODELS.filter(({ id }) => id === 'gpt-6-sol' || id === 'gpt-6-luna'))(
    'preserves $provider/$api/$id effort when moving from none to high', async ({ provider, api, id }) => {
      const harness = createHarness();
      const ctx = context(provider, id, api);
      await codexExtension(harness.pi);

      persistAnswer(ctx);

      await harness.emit('thinking_level_select', { previousLevel: 'off', level: 'high' }, ctx);

      expect(sessionBranches.get(ctx)).toContainEqual(expect.objectContaining({
        data: expect.objectContaining({ initialEffort: 'none', effort: 'high' }),
      }));
    },
  );

  it.each([
    ['openai', 'gpt-5.4', 'openai-responses'],
    ['openai', 'gpt-6-astra', 'openai-completions'],
    ['openai-codex', 'gpt-6-astra', 'openai-responses'],
    ['custom', 'gpt-6-astra', 'openai-responses'],
    ['openai-codex', 'gpt-5.4', 'openai-codex-responses'],
    ['anthropic', 'claude-opus-5', 'anthropic-messages'],
  ] as const)('does not record Codex reasoning updates for %s/%s', async (provider, id, api) => {
    const harness = createHarness();
    const ctx = context(provider, id, api);
    await codexExtension(harness.pi);
    persistAnswer(ctx);

    await harness.emit('thinking_level_select', { previousLevel: 'low', level: 'high' }, ctx);

    expect(sessionBranches.get(ctx)?.some((entry) => entry.type === 'custom')).toBe(false);
  });

  it.each(RESPONSES_APIS)('defers a selector change made during streaming until the run settles on %s/%s', async (provider, api) => {
    const harness = createHarness();
    const ctx = context(provider, 'gpt-6-astra', api);
    ctx.isIdle = () => false;
    await codexExtension(harness.pi);
    persistAnswer(ctx);

    await harness.emit('thinking_level_select', { previousLevel: 'low', level: 'high' }, ctx);
    expect(sessionBranches.get(ctx)).toHaveLength(1);

    ctx.isIdle = () => true;
    await harness.emit('agent_settled', {}, ctx);
    expect(sessionBranches.get(ctx)).toHaveLength(2);
  });

  it.each(RESPONSES_APIS)('applies a queued user follow-up effort at its safe turn boundary on %s/%s', async (provider, api) => {
    const harness = createHarness();
    const ctx = context(provider, 'gpt-6-astra', api);
    await codexExtension(harness.pi);
    const oldAssistant = {
      role: 'assistant', content: 'Previous answer', timestamp: 1,
      api: ctx.model!.api, provider: ctx.model!.provider, model: ctx.model!.id,
    };
    persistMessage(ctx, oldAssistant);
    ctx.isIdle = () => false;

    await harness.emit('turn_end', { message: { role: 'assistant' }, toolResults: [] }, ctx);
    await harness.emit('turn_start', { turnIndex: 1 }, ctx);
    const user = { role: 'user', content: 'Follow up', timestamp: 2 };
    persistMessage(ctx, user);
    await harness.emit('thinking_level_select', { previousLevel: 'low', level: 'high' }, ctx);
    const [projection] = await harness.emit('context', { messages: [user] }, ctx) as [
      { messages: Array<{ role: string; content: string }> },
    ];
    expect(projection.messages.map(({ role }) => role)).toEqual(['custom', 'user']);
    const [request] = await harness.emit('before_provider_request', {
      payload: {
        model: 'gpt-6-astra', reasoning: { effort: 'high' },
        input: projection.messages.map(({ content }) => ({ role: 'user', content })),
      },
    }, ctx);
    expect(request).toMatchObject({
      reasoning: { effort: 'low' },
      input: [{ type: 'configuration_update', reasoning: { effort: 'high' } }, { role: 'user', content: 'Follow up' }],
    });
    expect(sessionBranches.get(ctx)?.at(-1)).toMatchObject({ type: 'custom' });

    const resumed = createHarness();
    await codexExtension(resumed.pi);
    const [replayed] = await resumed.emit('context', { messages: [oldAssistant, user] }, ctx) as [
      { messages: Array<{ role: string }> },
    ];
    expect(replayed.messages.map(({ role }) => role)).toEqual(['assistant', 'custom', 'user']);
  });

  it.each(RESPONSES_APIS)('does not flush a streaming change between tool continuations on %s/%s', async (provider, api) => {
    const harness = createHarness();
    const ctx = context(provider, 'gpt-6-astra', api);
    await codexExtension(harness.pi);
    persistAnswer(ctx);
    ctx.isIdle = () => false;
    await harness.emit('turn_start', { turnIndex: 1 }, ctx);
    await harness.emit('thinking_level_select', { previousLevel: 'low', level: 'high' }, ctx);
    const result = { role: 'toolResult', content: 'Build completed', timestamp: 2 };
    persistMessage(ctx, result);

    const [projection] = await harness.emit('context', { messages: [result] }, ctx) as [
      { messages: Array<{ role: string }> },
    ];
    expect(projection.messages).toEqual([result]);
    expect(sessionBranches.get(ctx)?.some((entry) => entry.type === 'custom')).toBe(false);

    ctx.isIdle = () => true;
    await harness.emit('agent_settled', {}, ctx);
    expect(sessionBranches.get(ctx)?.at(-1)?.type).toBe('custom');
  });

  it.each(RESPONSES_APIS)('reconciles a delayed thinking event before a new user request is rewritten on %s/%s', async (provider, api) => {
    const harness = createHarness();
    const ctx = context(provider, 'gpt-6-astra', api);
    await codexExtension(harness.pi);
    persistAnswer(ctx);
    harness.setLevel('low');
    await harness.emit('before_agent_start', { prompt: 'Continue' }, ctx);
    const user = { role: 'user', content: 'Continue', timestamp: 2 };
    persistMessage(ctx, user);
    ctx.isIdle = () => false;
    harness.setLevel('high');

    const [projection] = await harness.emit('context', { messages: [user] }, ctx) as [
      { messages: Array<{ role: string; content: string }> },
    ];
    expect(projection.messages.map(({ role }) => role)).toEqual(['custom', 'user']);
    const [request] = await harness.emit('before_provider_request', {
      payload: {
        model: 'gpt-6-astra', reasoning: { effort: 'high' },
        input: projection.messages.map(({ content }) => ({ role: 'user', content })),
      },
    }, ctx);
    expect(request).toMatchObject({
      reasoning: { effort: 'low' },
      input: [{ type: 'configuration_update', reasoning: { effort: 'high' } }, { role: 'user', content: 'Continue' }],
    });
    await harness.emit('thinking_level_select', { previousLevel: 'low', level: 'high' }, ctx);
    expect(sessionBranches.get(ctx)?.filter((entry) => entry.type === 'custom')).toHaveLength(1);
  });

  it.each(RESPONSES_APIS)('drops a queued change when switching sessions or models during a run on %s/%s', async (provider, api) => {
    const harness = createHarness();
    const oldSession = context(provider, 'gpt-6-astra', api);
    oldSession.isIdle = () => false;
    await codexExtension(harness.pi);
    persistAnswer(oldSession);
    await harness.emit('thinking_level_select', { previousLevel: 'low', level: 'high' }, oldSession);

    const nextSession = context(provider, 'gpt-6-astra', api);
    await harness.emit('session_start', {}, nextSession);
    await harness.emit('agent_settled', {}, nextSession);
    expect(sessionBranches.get(nextSession)).toEqual([]);

    await harness.emit('thinking_level_select', { previousLevel: 'low', level: 'high' }, oldSession);
    oldSession.model = model(provider, 'gpt-6-sol', api);
    await harness.emit('model_select', { model: oldSession.model }, oldSession);
    await harness.emit('agent_settled', {}, oldSession);
    expect(sessionBranches.get(oldSession)).toHaveLength(1);
  });

  it.each(RESPONSES_APIS)('does not inject an update from another model lane after a switch on %s/%s', async (provider, api) => {
    const harness = createHarness();
    const ctx = context(provider, 'gpt-6-astra', api);
    await codexExtension(harness.pi);
    persistAnswer(ctx);
    await harness.emit('thinking_level_select', { previousLevel: 'low', level: 'high' }, ctx);

    ctx.model = model(provider, 'gpt-6-sol', api);
    const nextUser = { role: 'user', content: 'Hello', timestamp: 1 };
    persistMessage(ctx, nextUser);
    const [projection] = await harness.emit('context', { messages: [nextUser] }, ctx) as [
      { messages: Array<{ role: string; content: string }> },
    ];
    expect(projection.messages).toEqual([nextUser]);
    const [request] = await harness.emit('before_provider_request', {
      payload: { model: 'gpt-6-sol', reasoning: { effort: 'medium' }, input: [{ role: 'user', content: 'Hello' }] },
    }, ctx);
    expect(request).toMatchObject({
      reasoning: { effort: 'medium' },
      input: [{ role: 'user', content: 'Hello' }],
    });
  });

  it.each(RESPONSES_APIS.flatMap(([provider, api]) => (
    RESPONSES_APIS.filter(([nextProvider, nextApi]) => nextProvider !== provider || nextApi !== api)
      .map(([nextProvider, nextApi]) => ({ provider, api, nextProvider, nextApi }))
  )))('isolates $provider/$api updates from $nextProvider/$nextApi', async ({ provider, api, nextProvider, nextApi }) => {
    const harness = createHarness();
    const ctx = context(provider, 'gpt-6-astra', api);
    await codexExtension(harness.pi);
    persistAnswer(ctx);
    await harness.emit('thinking_level_select', { previousLevel: 'low', level: 'high' }, ctx);

    ctx.model = model(nextProvider, 'gpt-6-astra', nextApi);
    const user = { role: 'user', content: 'Continue', timestamp: 2 };
    persistMessage(ctx, user);
    const [projection] = await harness.emit('context', { messages: [user] }, ctx) as [
      { messages: Array<{ role: string; content: string }> },
    ];
    expect(projection.messages).toEqual([user]);
    const [request] = await harness.emit('before_provider_request', {
      payload: { reasoning: { effort: 'high' }, input: [{ role: 'user', content: user.content }] },
    }, ctx);
    expect(request).toMatchObject({
      reasoning: { effort: 'high' }, input: [{ role: 'user', content: user.content }],
    });
  });

  it.each(RESPONSES_APIS)('replays a persisted update after a session is resumed, but not on a fork before it on %s/%s', async (provider, api) => {
    const ctx = context(provider, 'gpt-6-astra', api);
    const oldUser = { role: 'user', content: 'First turn', timestamp: 1 };
    const oldAssistant = {
      role: 'assistant', content: 'First answer', timestamp: 2,
      api: ctx.model!.api, provider: ctx.model!.provider, model: ctx.model!.id,
    };
    persistMessage(ctx, oldUser);
    persistMessage(ctx, oldAssistant);
    const original = createHarness();
    await codexExtension(original.pi);
    await original.emit('thinking_level_select', { previousLevel: 'low', level: 'high' }, ctx);

    const resumed = createHarness();
    await codexExtension(resumed.pi);
    const nextUser = { role: 'user', content: 'Next turn', timestamp: 3 };
    persistMessage(ctx, nextUser);
    const [projection] = await resumed.emit('context', { messages: [oldUser, oldAssistant, nextUser] }, ctx) as [
      { messages: Array<{ role: string; content: string }> },
    ];
    expect(projection.messages.map((message) => message.role)).toEqual([
      'user', 'assistant', 'custom', 'user',
    ]);
    const [request] = await resumed.emit('before_provider_request', {
      payload: {
        model: 'gpt-6-astra', reasoning: { effort: 'high' },
        input: projection.messages.map(({ role, content }) => ({
          role: role === 'custom' ? 'user' : role, content,
        })),
      },
    }, ctx);
    expect(request).toMatchObject({
      reasoning: { effort: 'low' },
      input: [
        { role: 'user', content: 'First turn' },
        { role: 'assistant', content: 'First answer' },
        { type: 'configuration_update', reasoning: { effort: 'high' } },
        { role: 'user', content: 'Next turn' },
      ],
    });

    const fork = context(provider, 'gpt-6-astra', api);
    sessionBranches.set(fork, sessionBranches.get(ctx)!.slice(0, 2));
    const [forkProjection] = await resumed.emit('context', { messages: [oldUser, oldAssistant] }, fork) as [
      { messages: Array<{ role: string }> },
    ];
    expect(forkProjection?.messages ?? [oldUser, oldAssistant]).toEqual([oldUser, oldAssistant]);
  });

  it.each(RESPONSES_APIS)('records the current effort before a new turn if it differs from the resumed lane on %s/%s', async (provider, api) => {
    const harness = createHarness();
    const ctx = context(provider, 'gpt-6-astra', api);
    await codexExtension(harness.pi);
    persistAnswer(ctx);
    await harness.emit('thinking_level_select', { previousLevel: 'low', level: 'high' }, ctx);
    const resumed = createHarness();
    await codexExtension(resumed.pi);
    await resumed.emit('thinking_level_select', { previousLevel: 'high', level: 'medium' },
      context('openai', 'gpt-5.4', 'openai-responses'));

    await resumed.emit('before_agent_start', { prompt: 'Continue' }, ctx);

    expect(sessionBranches.get(ctx)?.at(-1)).toMatchObject({
      type: 'custom', data: { initialEffort: 'low', effort: 'medium' },
    });
  });

  it.each(RESPONSES_APIS.flatMap(([provider, api]) => (
    (['manual', 'threshold', 'overflow'] as const).map((reason) => ({ provider, api, reason }))
  )))(
    'retires updates after $reason compaction on $provider/$api and starts a new effort baseline', async ({ reason, provider, api }) => {
      const harness = createHarness();
      const ctx = context(provider, 'gpt-6-astra', api);
      await codexExtension(harness.pi);
      persistAnswer(ctx);
      await harness.emit('thinking_level_select', { previousLevel: 'low', level: 'high' }, ctx);
      const branch = sessionBranches.get(ctx)!;
      const compactionEntry = { type: 'compaction', id: 'compacted', parentId: branch.at(-1)?.id ?? null };
      branch.push(compactionEntry);
      await harness.emit('session_compact', { reason, compactionEntry }, ctx);
      const summary = { role: 'compactionSummary', content: 'Summary', timestamp: 5 };
      const nextUser = { role: 'user', content: 'New request', timestamp: 6 };
      persistMessage(ctx, nextUser);

      const [projection] = await harness.emit('context', { messages: [summary, nextUser] }, ctx) as [
        { messages: Array<{ role: string }> },
      ];
      expect(projection?.messages ?? [summary, nextUser]).toEqual([summary, nextUser]);

      persistAnswer(ctx, 7);
      await harness.emit('thinking_level_select', { previousLevel: 'high', level: 'medium' }, ctx);
      expect(branch.at(-1)).toMatchObject({
        type: 'custom',
        data: { initialEffort: 'high', effort: 'medium' },
      });
    },
  );

  it.each(RESPONSES_APIS)('does not send adjacent updates or incompatible automatic history changes on %s/%s', async (provider, api) => {
    const harness = createHarness();
    const ctx = context(provider, 'gpt-6-astra', api);
    await codexExtension(harness.pi);
    persistAnswer(ctx);
    await harness.emit('thinking_level_select', { previousLevel: 'low', level: 'medium' }, ctx);
    await harness.emit('thinking_level_select', { previousLevel: 'medium', level: 'high' }, ctx);
    const nextUser = { role: 'user', content: 'Next turn', timestamp: 1 };
    persistMessage(ctx, nextUser);
    const [projection] = await harness.emit('context', { messages: [nextUser] }, ctx) as [
      { messages: Array<{ role: string; content: string }> },
    ];
    const input = projection.messages.map(({ content }) => ({ role: 'user', content }));
    const payload = { model: 'gpt-6-astra', input, reasoning: { effort: 'high' } };
    const [request] = await harness.emit('before_provider_request', { payload }, ctx) as [
      { input: Array<{ type: string; reasoning: { effort: string } }> },
    ];
    expect(request.input).toEqual([
      { type: 'configuration_update', reasoning: { effort: 'high' } },
      { role: 'user', content: 'Next turn' },
    ]);
    await expect(harness.emit('before_provider_request', {
      payload: { ...payload, truncation: 'auto' },
    }, ctx)).rejects.toThrow(/truncation|compaction/iu);
    await expect(harness.emit('before_provider_request', {
      payload: { ...payload, context_management: [{ type: 'compaction' }] },
    }, ctx)).rejects.toThrow(/truncation|compaction/iu);
  });

  it.each(RESPONSES_APIS)('rewrites Pi Responses input_text carriers without exposing the marker on %s/%s', async (provider, api) => {
    const harness = createHarness();
    const ctx = context(provider, 'gpt-6-astra', api);
    await codexExtension(harness.pi);
    persistAnswer(ctx);
    await harness.emit('thinking_level_select', { previousLevel: 'low', level: 'high' }, ctx);
    const [projection] = await harness.emit('context', { messages: [] }, ctx) as [
      { messages: Array<{ content: string }> },
    ];
    const [request] = await harness.emit('before_provider_request', {
      payload: {
        model: 'gpt-6-astra', reasoning: { effort: 'high' },
        input: [
          { role: 'user', content: [{ type: 'input_text', text: projection.messages[0]!.content }] },
          { role: 'user', content: [{ type: 'input_text', text: 'Continue' }] },
        ],
      },
    }, ctx) as [{ input: unknown[] }];
    expect(request.input).toEqual([
      { type: 'configuration_update', reasoning: { effort: 'high' } },
      { role: 'user', content: [{ type: 'input_text', text: 'Continue' }] },
    ]);
  });

  it.each(RESPONSES_APIS)('coalesces native replay updates next to newly projected updates on %s/%s', async (provider, api) => {
    const harness = createHarness();
    const ctx = context(provider, 'gpt-6-astra', api);
    await codexExtension(harness.pi);
    persistAnswer(ctx);
    await harness.emit('thinking_level_select', { previousLevel: 'low', level: 'medium' }, ctx);
    const [projection] = await harness.emit('context', { messages: [] }, ctx) as [
      { messages: Array<{ content: string }> },
    ];
    const [request] = await harness.emit('before_provider_request', {
      payload: {
        model: 'gpt-6-astra', reasoning: { effort: 'medium' },
        input: [
          { role: 'user', content: projection.messages[0]!.content },
          { type: 'configuration_update', reasoning: { effort: 'high' } },
          { role: 'user', content: 'Continue' },
        ],
      },
    }, ctx) as [{ input: unknown[]; reasoning: { effort: string } }];
    expect(request.input).toEqual([
      { type: 'configuration_update', reasoning: { effort: 'high' } },
      { role: 'user', content: 'Continue' },
    ]);
    expect(request.reasoning.effort).toBe('low');
  });

  it.each(RESPONSES_APIS)('rejects a carrier in an unsupported Responses input shape on %s/%s', async (provider, api) => {
    const harness = createHarness();
    const ctx = context(provider, 'gpt-6-astra', api);
    await codexExtension(harness.pi);
    persistAnswer(ctx);
    await harness.emit('thinking_level_select', { previousLevel: 'low', level: 'high' }, ctx);
    const [projection] = await harness.emit('context', { messages: [] }, ctx) as [
      { messages: Array<{ content: string }> },
    ];

    await expect(harness.emit('before_provider_request', {
      payload: {
        model: 'gpt-6-astra',
        input: [{ role: 'user', content: [
          { type: 'input_text', text: projection.messages[0]!.content },
          { type: 'input_text', text: 'More content' },
        ] }],
      },
    }, ctx)).rejects.toThrow(/reasoning update carrier/iu);
  });

  it.each(RESPONSES_APIS)('rejects a malformed persisted Codex update rather than sending it as user content on %s/%s', async (provider, api) => {
    const harness = createHarness();
    const ctx = context(provider, 'gpt-6-astra', api);
    await codexExtension(harness.pi);
    sessionBranches.get(ctx)!.push({
      type: 'custom', id: 'bad-update', parentId: null, customType: 'codex-reasoning-update',
      data: { initialEffort: 'low', effort: 'invalid' },
    });

    await expect(harness.emit('context', { messages: [] }, ctx)).rejects.toThrow(/reasoning update/iu);
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

  it('does not register or unregister shared providers', async () => {
    const harness = createHarness();
    await codexExtension(harness.pi);
    expect(harness.registerProvider).not.toHaveBeenCalled();

    await harness.emit('session_shutdown', {}, context('openai', 'gpt-5.4'));

    expect(harness.unregisterProvider).not.toHaveBeenCalled();
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
    const harness = createHarness(true, { postAgentRunCompaction: false });
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

function createHarness(processSupport = true, config: Record<string, unknown> = {}) {
  const handlers = new Map<string, Handler[]>();
  const activeTools = ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls', 'ask_user', 'Agent', 'TaskCreate'];
  const registerTool = vi.fn();
  const registerProvider = vi.fn();
  const unregisterProvider = vi.fn();
  let activeContext: ExtensionContext | undefined;
  let thinkingLevel = 'high';
  const pi = {
    runtime: unusedRuntime(processSupport),
    agentDir: '/agent',
    config,
    registerCapability: vi.fn(),
    registerTool,
    registerProvider,
    unregisterProvider,
    appendEntry: vi.fn((customType: string, data: unknown) => {
      if (!activeContext) throw new Error('No active context');
      const branch = sessionBranches.get(activeContext)!;
      branch.push({
        type: 'custom', customType, data, id: `entry-${branch.length}`,
        parentId: branch.at(-1)?.id ?? null, timestamp: new Date().toISOString(),
      });
    }),
    getThinkingLevel: () => thinkingLevel,
    events: {
      emit: () => {},
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
    setLevel(level: string) { thinkingLevel = level; },
    async emit(name: string, event: unknown, ctx: ExtensionContext) {
      const results: unknown[] = [];
      activeContext = ctx;
      if (name === 'thinking_level_select') thinkingLevel = (event as { level: string }).level;
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
  sessionBranches.set(ctx, branch);
  return ctx;
}

const sessionEntries = new WeakMap<ExtensionContext, Map<string, unknown>>();
const sessionBranches = new WeakMap<ExtensionContext, Array<{ id: string; [key: string]: unknown }>>();

function persistMessage(ctx: ExtensionContext, message: {
  role: string; content: string; timestamp: number; api?: Api; provider?: string; model?: string;
}): void {
  const branch = sessionBranches.get(ctx)!;
  branch.push({ type: 'message', message, id: `entry-${branch.length}`, parentId: branch.at(-1)?.id ?? null });
}

function persistAnswer(ctx: ExtensionContext, timestamp = 1): void {
  persistMessage(ctx, {
    role: 'assistant', content: 'Previous answer', timestamp,
    api: ctx.model!.api, provider: ctx.model!.provider, model: ctx.model!.id,
  });
}

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

function unusedRuntime(processSupport: boolean): AgentRuntime {
  const unused = async (): Promise<never> => { throw new Error('unused'); };
  return {
    kind: 'host',
    cwd: '/workspace',
    ...(processSupport ? { processes: { startShell: unused } } : {}),
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
