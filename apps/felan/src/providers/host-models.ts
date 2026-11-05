import { HOST_MAINTENANCE_SERVICE, HOST_MODELS_SERVICE, type Classifier, type ModelsService } from '@felan-ai/agent-core';
import { defineServiceProvider } from '@felan-ai/daemon/provider';
import { createLocalClassifier } from './classifier.js';
import { createLocalModelsService } from './models.js';
import { createSubscriptionUsageCache } from './models-subscription.js';
import { createLocalSettingsManager, getClassifierModelSetting } from './settings.js';

export default defineServiceProvider({
  scope: 'daemon',
  provides: [HOST_MODELS_SERVICE],
  requires: [HOST_MAINTENANCE_SERVICE],
  async create(context) {
    const lifetime = new AbortController();
    const signal = AbortSignal.any([context.signal, lifetime.signal]);
    const active = new Set<Promise<unknown>>();
    const subscriptionUsage = createSubscriptionUsageCache();
    let service: ModelsService | undefined;
    let activated = false;
    let closed = false;
    const current = () => {
      signal.throwIfAborted();
      if (!activated || !service) throw new Error('Host models are unavailable before activation or while settling.');
      return service;
    };
    const track = <T>(work: Promise<T>): Promise<T> => {
      active.add(work);
      void work.then(() => active.delete(work), () => active.delete(work));
      return work;
    };
    const classifier: Classifier = Object.freeze({
      canEvaluate: (state, questions) => {
        try { return current().classifier?.canEvaluate?.(state, questions) ?? false; }
        catch { return false; }
      },
      classify: (...args) => track(Promise.resolve().then(() => {
        const classifier = current().classifier;
        if (!classifier) throw new Error('Host classifier is unavailable.');
        return classifier.classify(...args);
      })),
    } satisfies Classifier);
    const value: ModelsService = Object.freeze({
      getAvailable: (...args) => track(Promise.resolve().then(() => current().getAvailable(...args))),
      getAvailableOfType: (...args) => track(Promise.resolve().then(() => current().getAvailableOfType(...args))),
      getSubscriptionUsage: (...args) => track(Promise.resolve().then(() => current().getSubscriptionUsage!(...args))),
      completeSimple: (...args) => track(Promise.resolve().then(() => current().completeSimple(...args))),
      generateImages: (...args) => track(Promise.resolve().then(() => current().generateImages(...args))),
      streamSimple: (...args) => {
        const stream = current().streamSimple(...args);
        track(stream.result());
        return stream;
      },
      classifier,
    } satisfies ModelsService);
    const waitForActive = async () => { while (active.size) await Promise.allSettled([...active]); };
    return {
      implementations: [{ contract: HOST_MODELS_SERVICE, value }],
      busy: () => active.size > 0,
      async activate() {
        signal.throwIfAborted();
        if (closed) throw new Error('Host models are closed.');
        const maintenance = context.services.get(HOST_MAINTENANCE_SERVICE);
        if (!maintenance) throw new Error('Host models require host maintenance.');
        const modelRuntime = maintenance.modelRuntime;
        const settings = createLocalSettingsManager(maintenance.agentDir, maintenance.agentDir);
        const selected = await createLocalClassifier(modelRuntime, getClassifierModelSetting(settings));
        signal.throwIfAborted();
        if (closed) throw new Error('Host models are closed.');
        service = createLocalModelsService({ modelRuntime, sessionId: 'host-maintenance', signal,
          isActive: () => activated,
          getSubscriptionUsage: model => subscriptionUsage(modelRuntime, model),
          ...(selected.classifier ? { classifier: selected.classifier } : {}) });
        activated = true;
      },
      async settle(mode) { closed = true; activated = false; if (mode === 'force') lifetime.abort(); await waitForActive(); },
      async dispose() { closed = true; activated = false; lifetime.abort(); await waitForActive(); },
    };
  },
});
