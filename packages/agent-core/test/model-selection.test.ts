import { SettingsManager } from '@earendil-works/pi-coding-agent';
import { describe, expect, it } from 'vitest';
import { installModelSelectionPersistenceScope } from '../src/model-selection.js';

describe('model selection persistence scope', () => {
  it('suppresses only session-scoped default writes', () => {
    const settings = SettingsManager.inMemory({
      defaultProvider: 'planner-provider',
      defaultModel: 'planner-model',
      defaultThinkingLevel: 'high',
    });
    const scope = installModelSelectionPersistenceScope(settings);

    scope.run(false, () => {
      settings.setDefaultModelAndProvider('implementation-provider', 'implementation-model');
      settings.setDefaultThinkingLevel('low');
    });

    expect(settings.getDefaultProvider()).toBe('planner-provider');
    expect(settings.getDefaultModel()).toBe('planner-model');
    expect(settings.getDefaultThinkingLevel()).toBe('high');

    settings.setDefaultModelAndProvider('manual-provider', 'manual-model');
    settings.setDefaultThinkingLevel('medium');
    expect(settings.getDefaultProvider()).toBe('manual-provider');
    expect(settings.getDefaultModel()).toBe('manual-model');
    expect(settings.getDefaultThinkingLevel()).toBe('medium');
  });

  it('does not suppress a concurrent ordinary selection', async () => {
    const settings = SettingsManager.inMemory({
      defaultProvider: 'planner-provider',
      defaultModel: 'planner-model',
    });
    const scope = installModelSelectionPersistenceScope(settings);

    await Promise.all([
      scope.run(false, async () => {
        await Promise.resolve();
        settings.setDefaultModelAndProvider('implementation-provider', 'implementation-model');
        settings.setDefaultThinkingLevel('low');
      }),
      (async () => {
        await Promise.resolve();
        settings.setDefaultModelAndProvider('manual-provider', 'manual-model');
        settings.setDefaultThinkingLevel('high');
      })(),
    ]);

    expect(settings.getDefaultProvider()).toBe('manual-provider');
    expect(settings.getDefaultModel()).toBe('manual-model');
    expect(settings.getDefaultThinkingLevel()).toBe('high');
  });
});
