import { stream as anthropicStream } from '@earendil-works/pi-ai/api/anthropic-messages';
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';
import { describe, expect, it } from 'vitest';
import { normalizeContext, type AssistantMessage } from '../src/index.js';

describe('Anthropic mid-conversation effort transport', () => {
  it.each(['low', 'high'] as const)('keeps the top-level effort fixed when the next turn selects %s', async (effort) => {
    const model = anthropicProvider().getModels().find((candidate) => candidate.id === 'claude-opus-5-5');
    expect(model?.compat?.supportsMidConvoEffort).toBe(true);
    if (!model) throw new Error('Missing Claude Opus 5.5 model');
    const prior = {
      role: 'assistant', content: [{ type: 'text', text: 'Previous answer' }],
      api: model.api, provider: model.provider, model: model.id, providerThinkingLevel: 'medium',
      usage: {
        input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: 'stop', timestamp: 1,
    } as AssistantMessage;
    let payload: Record<string, unknown> | undefined;
    const stream = anthropicStream(model, normalizeContext({
      messages: [
        { role: 'user', content: 'Previous request', timestamp: 0 },
        prior,
        { role: 'user', content: 'Next request', timestamp: 2 },
      ],
    }), {
      apiKey: 'test-only', effort,
      onPayload: (value) => { payload = value as Record<string, unknown>; throw new Error('Request intercepted before dispatch'); },
    });
    await stream.result();

    expect(payload).toMatchObject({
      output_config: { effort: 'high' },
      thinking: { type: 'adaptive' },
    });
    expect(payload?.betas).toEqual(expect.arrayContaining(['mid-conversation-output-config-2026-07-01']));
    const messages = payload?.messages as Array<{ role: string; output_config?: { effort: string } }>;
    expect(messages).toEqual(expect.arrayContaining([
      { role: 'system', content: [], output_config: { effort: 'medium' } },
      { role: 'system', content: [], output_config: { effort } },
    ]));
  });
});
