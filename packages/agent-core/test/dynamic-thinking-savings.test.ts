import { describe, expect, it, vi } from 'vitest';
import type { Api, AssistantMessage, Model } from '../src/index.js';
import { estimateHighEffortOutputTokens, reportDynamicThinkingSavings } from '../src/dynamic-thinking/savings.js';

const astra = {
  api: 'openai-codex-responses', provider: 'openai-codex', id: 'gpt-6-astra', reasoning: true,
} as Model<Api>;

describe('dynamic-thinking high-effort estimate', () => {
  it('uses the same explicitly heuristic uplift for supported models and high-to-lower selections', () => {
    const usage = { output: 1_000, reasoning: 400 };
    const officialModels = ['gpt-6-astra', 'gpt-6-sol', 'gpt-6.1-sol', 'gpt-6-luna'].map((id) => ({
      ...astra, provider: 'openai', api: 'openai-responses' as const, id,
    }));
    for (const model of [astra, { ...astra, id: 'gpt-6-sol' }, { ...astra, id: 'gpt-6-luna' }, ...officialModels, {
      ...astra, api: 'anthropic-messages' as const, provider: 'anthropic', id: 'claude-opus-5-5',
      compat: { supportsMidConvoEffort: true },
    }]) {
      expect(estimateHighEffortOutputTokens(model, 'high', 'medium', usage)).toBe(1_020);
      expect(estimateHighEffortOutputTokens(model, 'high', 'low', usage)).toBe(1_020);
    }
  });

  it('does not estimate unsupported models or unchanged/upshifted effort', () => {
    const usage = { output: 1_000, reasoning: 400 };
    expect(estimateHighEffortOutputTokens(astra, 'high', 'high', usage)).toBeUndefined();
    expect(estimateHighEffortOutputTokens(astra, 'medium', 'low', usage)).toBeUndefined();
    expect(estimateHighEffortOutputTokens(astra, 'medium', 'high', usage)).toBeUndefined();
    expect(estimateHighEffortOutputTokens({ ...astra, id: 'gpt-5.6-sol' }, 'high', 'medium', usage))
      .toBeUndefined();
    expect(estimateHighEffortOutputTokens({ ...astra, api: 'openai-responses' }, 'high', 'medium', usage))
      .toBeUndefined();
    expect(estimateHighEffortOutputTokens({ ...astra, provider: 'custom' }, 'high', 'medium', usage))
      .toBeUndefined();
    expect(estimateHighEffortOutputTokens({ ...astra, api: 'anthropic-messages', provider: 'anthropic',
      id: 'claude-opus-5-5', compat: { supportsMidConvoEffort: false } }, 'high', 'medium', usage))
      .toBeUndefined();
  });

  it('requires trustworthy observed reasoning usage and bounded arithmetic', () => {
    expect(estimateHighEffortOutputTokens(astra, 'high', 'medium', { output: 100 })).toBeUndefined();
    expect(estimateHighEffortOutputTokens(astra, 'high', 'medium', { output: 100, reasoning: 0 }))
      .toBeUndefined();
    expect(estimateHighEffortOutputTokens(astra, 'high', 'medium', { output: 100, reasoning: 101 }))
      .toBeUndefined();
    expect(estimateHighEffortOutputTokens(astra, 'high', 'medium', { output: 100, reasoning: 19 }))
      .toBeUndefined();
    expect(estimateHighEffortOutputTokens(astra, 'high', 'medium', {
      output: Number.MAX_SAFE_INTEGER, reasoning: 100,
    })).toBeUndefined();
  });

  it('prices additional tokens at the observed effective output rate, not the catalog base rate', async () => {
    const report = vi.fn().mockResolvedValue(undefined);
    const message = {
      stopReason: 'stop',
      usage: {
        input: 50, output: 1_000, reasoning: 400, cacheRead: 0, cacheWrite: 0,
        cost: { total: 0.08, output: 0.04 },
      },
    } as AssistantMessage;
    await reportDynamicThinkingSavings({ report }, {
      ...astra, cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 10 },
    }, 'high', 'medium', message, 0.0002);
    expect(report).toHaveBeenCalledOnce();
    expect(report.mock.calls[0]?.[0].baseline.costUsd).toBeCloseTo(0.0808);
    expect(report.mock.calls[0]?.[0].actual.costUsd).toBeCloseTo(0.0802);
  });
});
