import type { Context, ExtensionCommandContext, Model } from '@felan-ai/agent-core';
import { describe, expect, it, vi } from 'vitest';
import { resolveFusionModels } from '../src/models.js';

const model = (provider: string, id: string): Model<any> => ({
  provider,
  id,
  name: `${provider}/${id}`,
  api: 'openai-completions',
  baseUrl: 'https://example.invalid',
  reasoning: false,
  input: ['text'],
  cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 32000,
  maxTokens: 4000,
});

function context(options: {
  readonly models?: readonly Model<any>[];
  readonly scoped?: readonly Model<any>[];
  readonly current?: Model<any>;
  readonly noCurrent?: boolean;
  readonly aborted?: boolean;
} = {}) {
  const available = options.models ?? [
    model('openrouter', 'anthropic/claude-sonnet-4'),
    model('openai', 'gpt-5'),
    model('other', 'private'),
  ];
  const scope = options.scoped;
  const streamCalls: unknown[][] = [];
  const streamSimple = vi.fn((selected: Model<any>, request: Context, options?: unknown) => {
    streamCalls.push([selected, request, options]);
    return ({
    result: async () => ({
      role: 'assistant',
      content: [{ type: 'text', text: 'answer' }],
      provider: available[0]!.provider,
      model: available[0]!.id,
      usage: { input: 2, output: 3, totalTokens: 5, cost: { total: 0.04 } },
      stopReason: 'stop',
    }),
    });
  });
  const ctx = {
    signal: options.aborted ? AbortSignal.abort() : undefined,
    model: options.noCurrent ? undefined : options.current ?? available[1],
    scopedModels: scope?.map((entry) => ({ model: entry })) ?? [],
    modelRegistry: {
      getAvailable: () => available,
      hasConfiguredAuth: () => true,
      streamSimple,
    },
  } as unknown as ExtensionCommandContext;
  return { ctx, streamSimple, available, streamCalls };
}

describe('Fusion model runtime', () => {
  it('resolves authenticated models and preserves nested provider/model IDs', async () => {
    const { ctx, streamSimple, available, streamCalls } = context();
    const runtime = resolveFusionModels(ctx, ['openrouter/anthropic/claude-sonnet-4', 'openai/gpt-5'], 'inherit');
    expect(runtime.participants.map(({ reference }) => reference)).toEqual([
      'openrouter/anthropic/claude-sonnet-4', 'openai/gpt-5',
    ]);
    expect(runtime.fusionModel?.reference).toBe('openai/gpt-5');
    const answer = await runtime.complete({
      prompt: 'Compare these', model: runtime.participants[0]!, maxOutputChars: 1000,
      signal: new AbortController().signal, thinking: 'off',
    });
    expect(answer).toMatchObject({ text: 'answer', model: 'openrouter/anthropic/claude-sonnet-4', usage: { totalTokens: 5, estimatedCost: 0.04 } });
    expect(streamSimple).toHaveBeenCalledWith(available[0], expect.objectContaining({ messages: [{ role: 'user', content: 'Compare these', timestamp: expect.any(Number) }] }), expect.objectContaining({ maxTokens: 334 }));
    expect((streamCalls[0]?.[1] as Context)).not.toHaveProperty('tools');
  });

  it('rejects models outside the authenticated session scope', () => {
    const { ctx, available } = context({ scoped: [availableFake() ] });
    expect(() => resolveFusionModels(ctx, ['openai/gpt-5', 'other/private'], 'openai/gpt-5'))
      .toThrow('unavailable, unauthenticated, or outside the session model scope');
  });

  it('rejects unavailable inherited fusion model before any request', () => {
    const { ctx } = context({ noCurrent: true });
    expect(() => resolveFusionModels(ctx, ['openrouter/anthropic/claude-sonnet-4', 'openai/gpt-5'], 'inherit'))
      .toThrow('Select an authenticated fusion model');
  });

  it('rejects duplicate participants and cancellation before discovery', () => {
    const { ctx, streamSimple } = context();
    expect(() => resolveFusionModels(ctx, ['openai/gpt-5', 'openai/gpt-5'], 'openai/gpt-5')).toThrow('unique');
    const cancelled = context({ aborted: true });
    expect(() => resolveFusionModels(cancelled.ctx, ['openai/gpt-5', 'openrouter/anthropic/claude-sonnet-4'], 'openai/gpt-5'))
      .toThrow('cancelled before model discovery');
    expect(streamSimple).not.toHaveBeenCalled();
  });
});

function availableFake(): Model<any> {
  return model('openai', 'gpt-5');
}
