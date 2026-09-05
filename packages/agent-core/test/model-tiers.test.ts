import { describe, expect, it } from 'vitest';
import {
  formatModelReference,
  getModelFamily,
  getModelStrength,
  isModelTier,
  parseModelReference,
  selectModelForTier,
  type ModelReference,
} from '../src/index.js';

function model(provider: string, id: string, name?: string): ModelReference {
  return { provider, id, ...(name === undefined ? {} : { name }) };
}

describe('model tiers', () => {
  it('parses model references and recognizes tier names', () => {
    expect(parseModelReference(' openrouter/anthropic/claude-haiku-5 ')).toEqual({
      provider: 'openrouter',
      id: 'anthropic/claude-haiku-5',
    });
    expect(formatModelReference(model('anthropic', 'claude-opus-5'))).toBe('anthropic/claude-opus-5');
    expect(parseModelReference('missing-provider')).toBeUndefined();
    expect(isModelTier('high')).toBe(true);
    expect(isModelTier('auto')).toBe(false);
  });

  it.each([
    ['anthropic', 'claude-opus-5', 'anthropic', 'high'],
    ['anthropic', 'claude-sonnet-5', 'anthropic', 'medium'],
    ['anthropic', 'claude-haiku-4-5', 'anthropic', 'low'],
    ['openai-codex', 'gpt-5.7-sol', 'openai', 'high'],
    ['openai-codex', 'gpt-6-astra', 'openai', 'high'],
    ['openai', 'gpt-5.7-terra', 'openai', 'medium'],
    ['openai', 'gpt-5.7-luna', 'openai', 'low'],
    ['google', 'gemini-4-pro-preview', 'google', 'high'],
    ['google-vertex', 'gemini-4-flash', 'google', 'medium'],
    ['google', 'gemini-4-flash-lite', 'google', 'low'],
    ['deepseek', 'deepseek-v5-pro', 'deepseek', 'high'],
    ['deepseek', 'deepseek-v5-flash', 'deepseek', 'low'],
    ['moonshotai', 'kimi-k3', 'kimi', 'high'],
    ['moonshotai', 'kimi-k2.7-code', 'kimi', 'medium'],
    ['zai', 'glm-5.2', 'zai', 'high'],
    ['zai', 'glm-5-turbo', 'zai', 'medium'],
    ['mistral', 'mistral-small-2701', 'mistral', 'low'],
    ['xai', 'grok-5', 'xai', 'high'],
  ] as const)('classifies %s/%s as %s %s', (provider, id, family, tier) => {
    const value = model(provider, id);
    expect(getModelFamily(value)).toBe(family);
    expect(getModelStrength(value)).toBe(tier);
  });

  it('recognizes model families exposed through OpenCode and other aggregate providers', () => {
    expect(getModelFamily(model('opencode', 'claude-opus-4-8'))).toBe('anthropic');
    expect(getModelStrength(model('opencode', 'claude-opus-4-8'))).toBe('high');
    expect(getModelFamily(model('opencode-go', 'qwen3.7-max'))).toBe('qwen');
    expect(getModelStrength(model('opencode-go', 'qwen3.7-max'))).toBe('high');
    expect(getModelFamily(model('openrouter', 'google/gemini-3.6-flash'))).toBe('google');
    expect(getModelFamily(model('github-copilot', 'gpt-5.6-luna'))).toBe('openai');
  });

  it('prefers the current provider before cross-provider fallback', () => {
    const openai = model('openai-codex', 'gpt-5.6-luna');
    const anthropic = model('anthropic', 'claude-haiku-4-5');

    expect(selectModelForTier('low', [openai, anthropic], {
      preferredModel: model('anthropic', 'claude-opus-5'),
    })?.model).toBe(anthropic);
    expect(selectModelForTier('low', [openai, anthropic], {
      preferredModel: model('openai-codex', 'gpt-5.6-sol'),
    })?.model).toBe(openai);
  });

  it('prefers the current family within OpenCode', () => {
    const openai = model('opencode', 'gpt-5.6-luna');
    const anthropic = model('opencode', 'claude-haiku-4-5');

    expect(selectModelForTier('low', [openai, anthropic], {
      preferredModel: model('opencode', 'claude-opus-5'),
    })?.model).toBe(anthropic);
  });

  it('prefers current family roles and newer versions over host catalog order', () => {
    const nano = model('opencode', 'gpt-5-nano');
    const luna = model('opencode', 'gpt-5.6-luna');
    const oldSonnet = model('opencode', 'claude-sonnet-4-5');
    const newSonnet = model('opencode', 'claude-sonnet-5');
    const gemma = model('google', 'gemma-4-31b-it');
    const flashLite = model('google', 'gemini-3.5-flash-lite');

    expect(selectModelForTier('low', [nano, luna], {
      preferredModel: model('opencode', 'gpt-5.6-sol'),
    })?.model).toBe(luna);
    expect(selectModelForTier('medium', [oldSonnet, newSonnet], {
      preferredModel: model('opencode', 'claude-opus-5'),
    })?.model).toBe(newSonnet);
    expect(selectModelForTier('low', [gemma, flashLite], {
      preferredModel: model('google', 'gemini-3.1-pro-preview'),
    })?.model).toBe(flashLite);
  });

  it('classifies unknown families dynamically and supports host overrides', () => {
    const small = model('custom', 'future-small-v2');
    const unknown = model('custom', 'future-standard-v2');

    expect(getModelStrength(small)).toBe('low');
    expect(getModelStrength(unknown)).toBe('medium');
    expect(selectModelForTier('high', [unknown], {
      classifyModel: () => 'high',
    })).toEqual({ model: unknown, tier: 'high' });
    expect(selectModelForTier('low', [])).toBeUndefined();
  });
});
