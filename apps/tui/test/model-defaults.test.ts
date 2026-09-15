import { builtinProviders } from '@felan-ai/agent-core';
import { describe, expect, it } from 'vitest';
import {
  acquireFelanModelDefaults,
  FELAN_DEFAULT_MODEL_PER_PROVIDER,
} from '../src/model-defaults.js';

describe('Felan model defaults', () => {
  it('covers every built-in provider', () => {
    expect(Object.keys(FELAN_DEFAULT_MODEL_PER_PROVIDER).sort()).toEqual(
      builtinProviders().map(({ id }) => id).sort(),
    );
  });

  it('uses Felan current defaults for the primary frontier providers', () => {
    expect(FELAN_DEFAULT_MODEL_PER_PROVIDER).toMatchObject({
      anthropic: 'claude-opus-5',
      google: 'gemini-3.8-flash',
      'google-vertex': 'gemini-3.8-flash',
      openai: 'gpt-5.6-sol',
      'openai-codex': 'gpt-5.6-sol',
      'vercel-ai-gateway': 'zai/glm-5.3',
    });
  });

  it('references models in each non-empty built-in catalog', () => {
    for (const provider of builtinProviders()) {
      const models = provider.getModels();
      if (models.length === 0) continue;
      expect(
        models.some(({ id }) => id === FELAN_DEFAULT_MODEL_PER_PROVIDER[provider.id]),
        `${provider.id}/${FELAN_DEFAULT_MODEL_PER_PROVIDER[provider.id]} is not in the built-in catalog`,
      ).toBe(true);
    }
  });

  it('overrides the Pi defaults used by startup and login', async () => {
    const piEntry = import.meta.resolve('@earendil-works/pi-coding-agent');
    const resolverUrl = new URL('./core/model-resolver.js', piEntry);
    const resolver = await import(resolverUrl.href) as {
      readonly defaultModelPerProvider: Record<string, string>;
    };
    const original = { ...resolver.defaultModelPerProvider };
    const releaseFirst = await acquireFelanModelDefaults();
    const releaseSecond = await acquireFelanModelDefaults();
    try {
      expect(resolver.defaultModelPerProvider).toEqual(FELAN_DEFAULT_MODEL_PER_PROVIDER);
      expect(resolver.defaultModelPerProvider.openai).toBe('gpt-5.6-sol');
      expect(resolver.defaultModelPerProvider['openai-codex']).toBe('gpt-5.6-sol');
      releaseFirst();
      expect(resolver.defaultModelPerProvider).toEqual(FELAN_DEFAULT_MODEL_PER_PROVIDER);
    } finally {
      releaseFirst();
      releaseSecond();
    }
    expect(resolver.defaultModelPerProvider).toEqual(original);
  });
});
