import { describe, expect, it, vi } from 'vitest';
import {
  selectDynamicThinkingLevel,
  type Api,
  type Classifier,
  type Model,
} from '../src/index.js';

const evidence = { conversation: [{ role: 'user', text: 'Earlier request' }], tool_activity: [] } as const;

function model(provider: string, api: Api, id: string, supported = false): Model<Api> {
  return {
    provider, api, id, reasoning: true, input: ['text'],
    thinkingLevelMap: { off: null, low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' },
    compat: { supportsMidConvoEffort: supported },
  } as Model<Api>;
}

function classifier(choice: string): Classifier & { classify: ReturnType<typeof vi.fn> } {
  return { classify: vi.fn().mockResolvedValue({ answers: { effort: { type: 'choice', choice } } }) };
}

describe('dynamic thinking selection', () => {
  it('selects model-supported efforts using provider-specific guidance and bounded evidence', async () => {
    const codex = classifier('high');
    const selected = await selectDynamicThinkingLevel(
      codex, model('openai-codex', 'openai-codex-responses', 'gpt-6-sol'),
      'Investigate a race condition', evidence, 'low',
    );
    expect(selected).toBe('high');
    expect(codex.classify).toHaveBeenCalledOnce();
    expect(codex.classify.mock.calls[0]?.[0]).toMatchObject({ request: 'Investigate a race condition', session: evidence });
    expect(codex.classify.mock.calls[0]?.[1].effort.criteria.high).toMatch(/complex|debug/iu);

    const anthropic = classifier('medium');
    expect(await selectDynamicThinkingLevel(
      anthropic, model('anthropic', 'anthropic-messages', 'claude-opus-5-5', true),
      'Write a summary', evidence, 'high',
    )).toBe('medium');
    expect(anthropic.classify.mock.calls[0]?.[1].effort.criteria.medium).toBeTruthy();
  });

  it('does not classify an unsupported provider or accept an invalid answer', async () => {
    const unsupported = classifier('low');
    expect(await selectDynamicThinkingLevel(
      unsupported, model('openai', 'openai-responses', 'gpt-6-sol'), 'Help', evidence, 'high',
    )).toBeUndefined();
    expect(unsupported.classify).not.toHaveBeenCalled();

    expect(await selectDynamicThinkingLevel(
      classifier('off'), model('openai-codex', 'openai-codex-responses', 'gpt-6-astra'),
      'Help', evidence, 'high',
    )).toBeUndefined();
  });

  it.each(['openai-codex', 'openai'])(
    'classifies GPT-6.1 Sol effort on %s Codex Responses', async (provider) => {
      const effort = classifier('low');
      expect(await selectDynamicThinkingLevel(
        effort, model(provider, 'openai-codex-responses', 'gpt-6.1-sol'),
        'Give a concise answer', evidence, 'high',
      )).toBe('low');
      expect(effort.classify).toHaveBeenCalledOnce();
      expect(Object.keys(effort.classify.mock.calls[0]?.[1].effort.criteria))
        .toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    },
  );

  it('keeps GPT-6.1 Sol ineligible on standard OpenAI Responses', async () => {
    const effort = classifier('low');
    expect(await selectDynamicThinkingLevel(
      effort, model('openai', 'openai-responses', 'gpt-6.1-sol'),
      'Give a concise answer', evidence, 'high',
    )).toBeUndefined();
    expect(effort.classify).not.toHaveBeenCalled();
  });

  it('keeps the current level when classification fails, is uncertain, or is aborted', async () => {
    const supported = model('anthropic', 'anthropic-messages', 'claude-opus-5-5', true);
    const failing = { classify: vi.fn().mockRejectedValue(new Error('classifier unavailable')) };
    expect(await selectDynamicThinkingLevel(failing, supported, 'Analyze', evidence, 'medium')).toBeUndefined();
    const uncertain = { classify: vi.fn().mockResolvedValue({
      answers: { effort: { type: 'choice', choice: 'max', confidence: 0.2 } },
    }) };
    expect(await selectDynamicThinkingLevel(uncertain, supported, 'Analyze', evidence, 'medium')).toBeUndefined();

    const controller = new AbortController();
    const pending = { classify: vi.fn().mockImplementation(async () => {
      controller.abort();
      return { answers: { effort: { type: 'choice', choice: 'high' } } };
    }) };
    expect(await selectDynamicThinkingLevel(pending, supported, 'Analyze', evidence, 'medium', controller.signal))
      .toBeUndefined();
  });
});
