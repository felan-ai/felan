import { AsyncLocalStorage } from 'node:async_hooks';
import type { SettingsManager } from '@earendil-works/pi-coding-agent';

export interface SessionSelectionAutomation {
  readonly owner: string | undefined;
  isAutomated(): boolean;
  acquire(owner: string): () => void;
  onManualThinkingSelection(listener: () => void): () => void;
}

export interface ModelSelectionPersistenceScope extends SessionSelectionAutomation {
  run<T>(updateDefault: boolean, operation: () => T): T;
  clearOwnership(): void;
  notifyManualThinkingSelection(): void;
  reset(): void;
}

const persistenceScopes = new WeakMap<SettingsManager, AsyncLocalStorage<boolean>>();

export function installModelSelectionPersistenceScope(
  settingsManager: SettingsManager,
): ModelSelectionPersistenceScope {
  const updateDefaultScope = persistenceScope(settingsManager);
  let ownership: { owner: string; token: symbol } | undefined;
  const manualThinkingListeners = new Set<() => void>();
  const scope: ModelSelectionPersistenceScope = {
    run: (updateDefault, operation) => updateDefaultScope.run(updateDefault, operation),
    get owner() { return ownership?.owner; },
    isAutomated: () => updateDefaultScope.getStore() === false,
    acquire(owner) {
      if (!owner.trim() || ownership) throw new Error('Model selection is already owned or the owner is invalid');
      const token = Symbol(owner);
      ownership = { owner, token };
      return () => { if (ownership?.token === token) ownership = undefined; };
    },
    clearOwnership: () => { ownership = undefined; },
    onManualThinkingSelection(listener) {
      manualThinkingListeners.add(listener);
      return () => { manualThinkingListeners.delete(listener); };
    },
    notifyManualThinkingSelection: () => {
      for (const listener of manualThinkingListeners) listener();
    },
    reset: () => { ownership = undefined; manualThinkingListeners.clear(); },
  };
  return scope;
}

function persistenceScope(settingsManager: SettingsManager): AsyncLocalStorage<boolean> {
  const installed = persistenceScopes.get(settingsManager);
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

  persistenceScopes.set(settingsManager, updateDefaultScope);
  return updateDefaultScope;
}
