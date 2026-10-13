import { createHash } from 'node:crypto';
import {
  MODELS_SERVICE,
  createAssistantMessageEventStream,
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  type Classifier,
  type ImageApi,
  type ImageModel,
  type ImageModelInfo,
  type Model,
  type Api,
  type ModelCost,
  type ModelReference,
  type ModelRuntime,
  type ModelsCallOptions,
  type ModelsRequestOptions,
  type ModelsService,
  type TextModelInfo,
} from '@felan-ai/agent-core';
import { defineServiceProvider } from '@felan-ai/daemon/provider';
import { createSubscriptionUsageCache } from './models-subscription.js';

const subscriptionUsage = createSubscriptionUsageCache();

export type LocalModelsRuntime = Pick<ModelRuntime,
  'getAvailable' | 'getAvailableOfType' | 'completeSimple' | 'streamSimple' | 'generateImages'>;

export interface CreateLocalModelsServiceOptions {
  readonly modelRuntime: LocalModelsRuntime;
  readonly sessionId: string;
  readonly getAllowedModels?: (signal?: AbortSignal) => readonly ModelReference[] | Promise<readonly ModelReference[]>;
  readonly classifier?: Classifier;
  readonly signal?: AbortSignal;
  readonly isActive?: () => boolean;
  readonly getSubscriptionUsage?: NonNullable<ModelsService['getSubscriptionUsage']>;
}

class ModelsAccessError extends Error {}

export function createLocalModelsService(options: CreateLocalModelsServiceOptions): ModelsService {
  if (typeof options.sessionId !== 'string' || !options.sessionId.trim()) {
    throw new Error('Models service requires an explicit session ID.');
  }
  const { modelRuntime: runtime, sessionId, getAllowedModels, classifier } = options;
  const callSignal = (signal?: AbortSignal) => options.signal && signal
    ? AbortSignal.any([options.signal, signal]) : options.signal ?? signal;
  function assertActive(): void {
    if (options.isActive?.() === false) throw new ModelsAccessError('Model inference is unavailable before activation or while settling.');
  }

  async function discover<T extends ModelReference>(load: () => Promise<readonly T[]>, signal?: AbortSignal): Promise<readonly T[]> {
    const models = await abortable(load, signal);
    const allowed = getAllowedModels ? await abortable(() => Promise.resolve(getAllowedModels(signal)), signal) : undefined;
    if (getAllowedModels && !Array.isArray(allowed)) throw new ModelsAccessError('Model scope is unavailable.');
    return allowed === undefined ? models : models.filter(model => allowed.some(reference => sameModel(reference, model)));
  }

  async function textModel(reference: ModelReference, signal?: AbortSignal): Promise<Model<Api>> {
    const requested = copyReference(reference);
    const models = await discover(() => runtime.getAvailable(requested.provider, signalOptions(signal)), signal);
    const model = models.find(candidate => sameModel(candidate, requested));
    if (!model) throw new ModelsAccessError('Requested model is unavailable in this session.');
    return model;
  }

  async function imageModel(reference: ModelReference, signal?: AbortSignal): Promise<ImageModel<ImageApi>> {
    const requested = copyReference(reference);
    const models = await discover(() => runtime.getAvailableOfType('image', requested.provider, signalOptions(signal)), signal);
    const model = models.find(candidate => sameModel(candidate, requested));
    if (!model) throw new ModelsAccessError('Requested image model is unavailable in this session.');
    return model;
  }

  return Object.freeze({
    ...(options.getSubscriptionUsage ? { getSubscriptionUsage: (reference: ModelReference, request?: ModelsRequestOptions) => {
      const signal = callSignal(request?.signal);
      return protect(signal, 'Subscription usage query failed.', async () => {
        assertActive();
        const model = await textModel(reference, signal);
        signal?.throwIfAborted();
        assertActive();
        return options.getSubscriptionUsage!({ provider: model.provider, id: model.id }, signalOptions(signal));
      });
    } } : {}),
    getAvailable: (providerId?: string, request?: ModelsRequestOptions) => {
      const signal = callSignal(request?.signal);
      return protect(signal, 'Model discovery failed.', async () => {
        validateProviderId(providerId);
        const models = await discover(() => runtime.getAvailable(providerId, signalOptions(signal)), signal);
        return models.filter(model => providerId === undefined || model.provider === providerId).map(publicTextModel);
      });
    },
    getAvailableOfType: (type: 'image', providerId?: string, request?: ModelsRequestOptions) => {
      const signal = callSignal(request?.signal);
      return protect(signal, 'Image model discovery failed.', async () => {
        if (type !== 'image') throw new ModelsAccessError('Only image model discovery is supported.');
        validateProviderId(providerId);
        const models = await discover(() => runtime.getAvailableOfType('image', providerId, signalOptions(signal)), signal);
        return models.filter(model => providerId === undefined || model.provider === providerId).map(publicImageModel);
      });
    },
    completeSimple: (reference, context, request) => {
      const signal = callSignal(request?.signal);
      return protect(signal, 'Model completion failed.', async () => {
        assertActive();
        const prepared = callOptions(request, sessionId, signal);
        const model = await textModel(reference, signal);
        signal?.throwIfAborted();
        assertActive();
        const result = await runtime.completeSimple(model, context, prepared);
        return publicResponse(result);
      });
    },
    streamSimple: (reference, context, request) => {
      const signal = callSignal(request?.signal);
      const target = createAssistantMessageEventStream();
      let current: AssistantMessage | undefined;
      let model: Model<Api> | undefined;
      let requested: ModelReference | undefined;
      void (async () => {
        let iterator: AsyncIterator<AssistantMessageEvent> | undefined;
        let pendingRead: Promise<IteratorResult<AssistantMessageEvent>> | undefined;
        let source: AssistantMessageEventStream | undefined;
        let failed = false;
        let failure: unknown;
        try {
          assertActive();
          requested = copyReference(reference);
          const prepared = callOptions(request, sessionId, signal);
          model = await textModel(requested, signal);
          signal?.throwIfAborted();
          assertActive();
          source = runtime.streamSimple(model, context, prepared);
          iterator = source[Symbol.asyncIterator]();
          for (;;) {
            pendingRead = iterator.next();
            const next = await abortable(() => pendingRead!, signal);
            pendingRead = undefined;
            if (next.done) break;
            const event = next.value;
            if ('partial' in event) current = event.partial;
            if (event.type === 'error') {
              current = event.error;
              break;
            }
            if (event.type === 'done') {
              current = event.message;
              break;
            }
            target.push('partial' in event ? { ...event, partial: publicPartial(event.partial) } : event);
          }
        } catch (error) {
          failed = true;
          failure = error;
        } finally {
          // Cancellation requests do not prove the provider has stopped. Keep
          // the result pending until outstanding reads, cleanup and the source settle.
          const results = await Promise.allSettled([
            pendingRead,
            Promise.resolve().then(() => iterator?.return?.()),
            Promise.resolve().then(() => source?.result()),
          ] as const);
          for (const result of results) {
            if (result.status === 'rejected') {
              failed = true;
              failure = result.reason;
            }
          }
          const result = results[2];
          if (result.status === 'fulfilled' && result.value) current = result.value;
        }
        let message = current;
        if (failed || signal?.aborted || !message || message.stopReason === 'pending') {
          message = {
            ...(current ?? {
              role: 'assistant', content: [], api: model?.api ?? 'unknown',
              provider: model?.provider ?? requested?.provider ?? 'unknown', model: model?.id ?? requested?.id ?? 'unknown',
              usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
              timestamp: Date.now(),
            }),
            stopReason: signal?.aborted ? 'aborted' : 'error',
            errorMessage: safeError(failure, signal, 'Model stream failed.').message,
          };
        }
        message = publicResponse(message);
        const reason = message.stopReason;
        if (reason === 'stop' || reason === 'length' || reason === 'toolUse' || reason === 'deferred') {
          target.push({ type: 'done', reason, message });
        } else {
          target.push({ type: 'error', reason: reason === 'aborted' ? 'aborted' : 'error', error: message });
        }
        target.end(message);
      })();
      return target;
    },
    generateImages: (reference, context, request) => {
      const signal = callSignal(request?.signal);
      return protect(signal, 'Image generation failed.', async () => {
        assertActive();
        const model = await imageModel(reference, signal);
        signal?.throwIfAborted();
        assertActive();
        const result = await runtime.generateImages(model, context, signalOptions(signal));
        if (result.stopReason === 'error' || result.stopReason === 'aborted') {
          return { ...result, errorMessage: result.stopReason === 'aborted' ? 'Model request aborted.' : 'Image generation failed.' };
        }
        if (result.errorMessage === undefined) return result;
        const safe = { ...result };
        delete safe.errorMessage;
        return safe;
      });
    },
    ...(classifier ? { classifier: Object.freeze({
      ...(classifier.canEvaluate ? { canEvaluate: (state: unknown, questions: Parameters<Classifier['classify']>[1]) => {
        try { return !options.signal?.aborted && options.isActive?.() !== false && classifier.canEvaluate!(state, questions); } catch { return false; }
      } } : {}),
      classify: (...args: Parameters<Classifier['classify']>) => {
        const signal = callSignal(args[2]);
        return protect(signal, 'Classification failed.', async () => {
          assertActive();
          const result = await classifier.classify(args[0], args[1], signal);
          signal?.throwIfAborted();
          return result;
        });
      },
    }) } : {}),
  } satisfies ModelsService);
}

function copyReference(reference: ModelReference): ModelReference {
  if (typeof reference?.provider !== 'string' || !reference.provider.trim()
    || typeof reference.id !== 'string' || !reference.id.trim()) {
    throw new ModelsAccessError('A provider and model ID are required.');
  }
  return { provider: reference.provider, id: reference.id };
}

function sameModel(a: ModelReference, b: ModelReference): boolean {
  return a.provider === b.provider && a.id === b.id;
}

function validateProviderId(providerId: string | undefined): void {
  if (providerId !== undefined && (typeof providerId !== 'string' || !providerId.trim())) {
    throw new ModelsAccessError('Invalid provider ID.');
  }
}

function signalOptions(signal?: AbortSignal): ModelsRequestOptions {
  return signal === undefined ? {} : { signal };
}

function callOptions(request: ModelsCallOptions | undefined, sessionId: string, signal?: AbortSignal): ModelsCallOptions {
  const result: { -readonly [K in keyof ModelsCallOptions]: ModelsCallOptions[K] } = signalOptions(signal);
  for (const key of ['maxTokens', 'timeoutMs', 'maxRetries'] as const) {
    const value = request?.[key];
    if (value === undefined) continue;
    if (!Number.isSafeInteger(value) || value < (key === 'maxRetries' ? 0 : 1)) {
      throw new ModelsAccessError(`Invalid ${key} option.`);
    }
    result[key] = value;
  }
  if (request?.reasoning !== undefined) {
    if (!['minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(request.reasoning)) throw new ModelsAccessError('Invalid reasoning option.');
    result.reasoning = request.reasoning;
  }
  if (request?.cacheRetention !== undefined) {
    if (!['none', 'short', 'long'].includes(request.cacheRetention)) throw new ModelsAccessError('Invalid cache retention option.');
    result.cacheRetention = request.cacheRetention;
  }
  if (request?.sessionId !== undefined && typeof request.sessionId !== 'string') throw new ModelsAccessError('Invalid cache affinity hint.');
  result.sessionId = `felan-models:${createHash('sha256').update(JSON.stringify([sessionId, request?.sessionId ?? ''])).digest('hex')}`;
  return result;
}

function publicCost(cost: ModelCost): ModelCost {
  const rates = ({ input, output, cacheRead, cacheWrite }: ModelCost) => ({ input, output, cacheRead, cacheWrite });
  return { ...rates(cost), ...(cost.tiers ? { tiers: cost.tiers.map(tier => ({ ...rates(tier), inputTokensAbove: tier.inputTokensAbove })) } : {}) };
}

function publicBase(model: Model<Api> | ImageModel<ImageApi>) {
  return { id: model.id, name: model.name, provider: model.provider, api: model.api,
    input: [...model.input], cost: publicCost(model.cost) };
}

function publicTextModel(model: Model<Api>): TextModelInfo {
  const thinkingLevelMap = model.thinkingLevelMap && Object.fromEntries(
    (['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const)
      .filter(key => Object.hasOwn(model.thinkingLevelMap!, key))
      .map(key => [key, model.thinkingLevelMap![key]]),
  );
  return { ...publicBase(model), reasoning: model.reasoning, contextWindow: model.contextWindow, maxTokens: model.maxTokens,
    ...(thinkingLevelMap ? { thinkingLevelMap } : {}) };
}

function publicImageModel(model: ImageModel<ImageApi>): ImageModelInfo {
  return { ...publicBase(model), type: 'image', output: [...model.output] };
}

function publicResponse(message: AssistantMessage): AssistantMessage {
  const failed = message.stopReason === 'error' || message.stopReason === 'aborted';
  if (!failed && message.errorMessage === undefined && message.diagnostics === undefined) return message;
  const result = { ...message };
  delete result.diagnostics;
  delete result.errorMessage;
  if (failed) result.errorMessage = message.stopReason === 'aborted' ? 'Model request aborted.' : 'Model request failed.';
  return result;
}

function publicPartial(message: AssistantMessage): AssistantMessage {
  const result = structuredClone(message);
  delete result.errorMessage;
  delete result.diagnostics;
  return result;
}

function safeError(error: unknown, signal: AbortSignal | undefined, message: string): Error {
  if (signal?.aborted) return new DOMException('Model request aborted.', 'AbortError');
  return error instanceof ModelsAccessError ? error : new Error(message);
}

async function protect<T>(signal: AbortSignal | undefined, message: string, operation: () => Promise<T>): Promise<T> {
  try {
    signal?.throwIfAborted();
    return await operation();
  } catch (error) {
    throw safeError(error, signal, message);
  }
}

function abortable<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) return Promise.reject(new DOMException('Model request aborted.', 'AbortError'));
  if (!signal) return Promise.resolve().then(operation);
  return new Promise<T>((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(new DOMException('Model request aborted.', 'AbortError')); };
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(() => { signal.throwIfAborted(); return operation(); }).then(
      value => { signal.removeEventListener('abort', abort); if (signal.aborted) abort(); else resolve(value); },
      error => { signal.removeEventListener('abort', abort); reject(error); },
    );
  });
}

export default defineServiceProvider({
  scope: 'session',
  provides: [MODELS_SERVICE],
  async create(context) {
    const lifetime = new AbortController();
    let activated = false;
    const subscriptionRequests = new Set<Promise<unknown>>();
    const service = createLocalModelsService({ modelRuntime: context.modelRuntime, sessionId: context.sessionId,
      async getSubscriptionUsage(model) {
        const pending = subscriptionUsage(context.modelRuntime, model);
        subscriptionRequests.add(pending);
        try { return await pending; }
        finally { subscriptionRequests.delete(pending); }
      },
      signal: AbortSignal.any([context.signal, lifetime.signal]),
      isActive: () => activated,
      ...(context.allowedModels === undefined ? {} : { getAllowedModels: () => context.allowedModels! }),
      ...(context.runtime.classifier ? { classifier: context.runtime.classifier } : {}) });
    const active = new Set<Promise<unknown>>();
    const track = <T>(work: Promise<T>): Promise<T> => {
      active.add(work);
      void work.then(() => active.delete(work), () => active.delete(work));
      return work;
    };
    const value = Object.freeze({
      getSubscriptionUsage: (...args) => track(service.getSubscriptionUsage!(...args)),
      getAvailable: (...args) => track(service.getAvailable(...args)),
      getAvailableOfType: (...args) => track(service.getAvailableOfType(...args)),
      completeSimple: (...args) => track(service.completeSimple(...args)),
      generateImages: (...args) => track(service.generateImages(...args)),
      streamSimple: (...args) => {
        const stream = service.streamSimple(...args);
        track(stream.result());
        return stream;
      },
      ...(service.classifier ? { classifier: {
        ...(service.classifier.canEvaluate ? { canEvaluate: service.classifier.canEvaluate.bind(service.classifier) } : {}),
        classify: (...args: Parameters<Classifier['classify']>) => track(service.classifier!.classify(...args)),
      } } : {}),
    } satisfies ModelsService);
    const waitForActive = async () => { while (active.size || subscriptionRequests.size) await Promise.allSettled([...active, ...subscriptionRequests]); };
    return { implementations: [{ contract: MODELS_SERVICE, value }],
      async activate() { lifetime.signal.throwIfAborted(); activated = true; },
      async settle(mode: 'drain' | 'force') { activated = false; if (mode === 'force') lifetime.abort(); await waitForActive(); },
      async dispose() { activated = false; lifetime.abort(); await waitForActive(); } };
  },
});
