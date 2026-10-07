import { SettingsManager } from '@earendil-works/pi-coding-agent';
import { describe, expect, it } from 'vitest';
import { installModelSelectionPersistenceScope } from '../src/model-selection.js';

describe('model selection persistence scope', () => {
  it('cleans up manual intent subscriptions on unsubscribe and session reset', () => {
    const scope = installModelSelectionPersistenceScope(SettingsManager.inMemory());
    let calls = 0;
    const unsubscribe = scope.onManualThinkingSelection(() => { calls += 1; });
    scope.notifyManualThinkingSelection();
    unsubscribe();
    scope.notifyManualThinkingSelection();
    expect(calls).toBe(1);
    scope.onManualThinkingSelection(() => { calls += 1; });
    scope.acquire('planning');
    scope.reset();
    scope.notifyManualThinkingSelection();
    expect(calls).toBe(1);
    expect(scope.owner).toBeUndefined();
  });

  it('isolates session ownership when sessions share one settings manager', () => {
    const settings = SettingsManager.inMemory({ defaultThinkingLevel: 'high' });
    const first = installModelSelectionPersistenceScope(settings);
    const second = installModelSelectionPersistenceScope(settings);
    const releaseFirst = first.acquire('first-session');
    expect(second.owner).toBeUndefined();
    const releaseSecond = second.acquire('second-session');
    second.clearOwnership();
    expect(first.owner).toBe('first-session');
    first.run(false, () => settings.setDefaultThinkingLevel('low'));
    second.run(false, () => settings.setDefaultThinkingLevel('medium'));
    expect(settings.getDefaultThinkingLevel()).toBe('high');
    releaseFirst();
    releaseSecond();
    expect(first.owner).toBeUndefined();
    expect(second.owner).toBeUndefined();
  });

  it('tracks automated provenance across async operations and protects newer ownership', async () => {
    const scope = installModelSelectionPersistenceScope(SettingsManager.inMemory());
    const release = scope.acquire('planning');
    expect(scope.owner).toBe('planning');
    expect(() => scope.acquire('other')).toThrow();
    await scope.run(false, async () => {
      await Promise.resolve();
      expect(scope.isAutomated()).toBe(true);
    });
    expect(scope.isAutomated()).toBe(false);
    scope.clearOwnership();
    const releaseNew = scope.acquire('implementation');
    release();
    expect(scope.owner).toBe('implementation');
    releaseNew();
    expect(scope.owner).toBeUndefined();
  });

  it('suppresses only session-scoped default writes', () => {
    const settings = SettingsManager.inMemory({
      defaultProvider: 'planner-provider',
      defaultModel: 'planner-model',
      defaultThinkingLevel: 'high',
      modelThinkingLevels: { 'implementation-provider/implementation-model': 'max' },
    });
    const scope = installModelSelectionPersistenceScope(settings);

    scope.run(false, () => {
      expect(settings.getDefaultThinkingLevel()).toBeUndefined();
      expect(settings.getModelThinkingLevel('implementation-provider', 'implementation-model')).toBeUndefined();
      settings.setDefaultModelAndProvider('implementation-provider', 'implementation-model');
      settings.setDefaultThinkingLevel('low');
    });

    expect(settings.getDefaultProvider()).toBe('planner-provider');
    expect(settings.getDefaultModel()).toBe('planner-model');
    expect(settings.getDefaultThinkingLevel()).toBe('high');
    expect(settings.getModelThinkingLevel('implementation-provider', 'implementation-model')).toBe('max');

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
