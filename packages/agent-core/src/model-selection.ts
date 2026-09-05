import { AsyncLocalStorage } from 'node:async_hooks';
import type { SettingsManager } from '@earendil-works/pi-coding-agent';

export interface ModelSelectionPersistenceScope {
  run<T>(updateDefault: boolean, operation: () => T): T;
}

const installedScopes = new WeakMap<SettingsManager, ModelSelectionPersistenceScope>();

export function installModelSelectionPersistenceScope(
  settingsManager: SettingsManager,
): ModelSelectionPersistenceScope {
  const installed = installedScopes.get(settingsManager);
  if (installed) return installed;

  const updateDefaultScope = new AsyncLocalStorage<boolean>();
  const getDefaultThinkingLevel = settingsManager.getDefaultThinkingLevel.bind(settingsManager);
  const getModelThinkingLevel = settingsManager.getModelThinkingLevel.bind(settingsManager);
  const setDefaultModelAndProvider = settingsManager.setDefaultModelAndProvider.bind(settingsManager);
  const setDefaultThinkingLevel = settingsManager.setDefaultThinkingLevel.bind(settingsManager);

  // Pi consults persisted thinking defaults during setModel. Hide them from
  // session-only switches so the active effort carries across the transition.
  settingsManager.getDefaultThinkingLevel = () => (
    updateDefaultScope.getStore() === false ? undefined : getDefaultThinkingLevel()
  );
  settingsManager.getModelThinkingLevel = (provider, modelId) => (
    updateDefaultScope.getStore() === false ? undefined : getModelThinkingLevel(provider, modelId)
  );
  settingsManager.setDefaultModelAndProvider = (provider, modelId) => {
    if (updateDefaultScope.getStore() !== false) {
      setDefaultModelAndProvider(provider, modelId);
    }
  };
  settingsManager.setDefaultThinkingLevel = (level) => {
    if (updateDefaultScope.getStore() !== false) {
      setDefaultThinkingLevel(level);
    }
  };

  const scope: ModelSelectionPersistenceScope = {
    run: (updateDefault, operation) => updateDefaultScope.run(updateDefault, operation),
  };
  installedScopes.set(settingsManager, scope);
  return scope;
}
