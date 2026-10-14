import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import {
  MODELS_SERVICE,
  createFelanServiceRegistry,
  loadFelanExtensions,
  type AssistantImages,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Classifier,
  type ConfiguredFelanExtension,
  type Context,
  type ExtensionAPI,
  type FelanExtensionAPI,
  type ImageModelInfo,
  type ImagesContext,
  type ModelReference,
  type ModelSubscriptionUsageResult,
  type ModelsCallOptions,
  type ModelsRequestOptions,
  type ModelsService,
  type SimpleStreamOptions,
  type TextModelInfo,
} from '../src/index.js';
import { TestAgentRuntime } from './test-agent-runtime.js';

describe('Models service contract', () => {
  it('exposes only model operations with portable Pi values and cancellable options', () => {
    expectTypeOf<ModelsService>().toEqualTypeOf<{
      getSubscriptionUsage?(model: ModelReference, options?: ModelsRequestOptions): Promise<ModelSubscriptionUsageResult>;
      getAvailable(providerId?: string, options?: ModelsRequestOptions): Promise<readonly TextModelInfo[]>;
      completeSimple(model: ModelReference, context: Context, options?: ModelsCallOptions): Promise<AssistantMessage>;
      streamSimple(model: ModelReference, context: Context, options?: ModelsCallOptions): AssistantMessageEventStream;
      getAvailableOfType(type: 'image', providerId?: string, options?: ModelsRequestOptions): Promise<readonly ImageModelInfo[]>;
      generateImages(model: ModelReference, context: ImagesContext, options?: ModelsRequestOptions): Promise<AssistantImages>;
      readonly classifier?: Classifier;
    }>();
    expectTypeOf<ModelsCallOptions>().toEqualTypeOf<Readonly<Pick<
      SimpleStreamOptions, 'signal' | 'maxTokens' | 'reasoning' | 'timeoutMs' | 'maxRetries' | 'cacheRetention' | 'sessionId'
    >>>();
    expectTypeOf<keyof ModelsCallOptions>().toEqualTypeOf<
      'signal' | 'maxTokens' | 'reasoning' | 'timeoutMs' | 'maxRetries' | 'cacheRetention' | 'sessionId'
    >();
    expectTypeOf<ModelsRequestOptions>().toEqualTypeOf<{ readonly signal?: AbortSignal }>();
    expectTypeOf<Extract<keyof TextModelInfo | keyof ImageModelInfo, 'baseUrl' | 'headers' | 'compat'>>().toEqualTypeOf<never>();
    expectTypeOf<keyof ModelsService>().toEqualTypeOf<
      'getAvailable' | 'completeSimple' | 'streamSimple' | 'getAvailableOfType' | 'generateImages' | 'classifier' | 'getSubscriptionUsage'
    >();
  });

  it('uses the versioned felan.models contract and admits only a configured provider', async () => {
    expect(MODELS_SERVICE).toMatchObject({ id: 'felan.models', major: 1, key: 'felan.models@1' });
    expect(Object.isFrozen(MODELS_SERVICE)).toBe(true);
    const services = createFelanServiceRegistry();
    expectTypeOf(services.get(MODELS_SERVICE)).toEqualTypeOf<ModelsService | undefined>();
    const initialize = vi.fn();
    const execution = vi.fn(() => ({}));
    const missing = vi.fn();
    const extension = Object.assign(initialize, {
      execution, serviceRequirements: { required: [MODELS_SERVICE] },
    });
    const loaded = await loadFelanExtensions(
      ['@example/models-consumer'], async () => ({ default: extension }),
      new TestAgentRuntime(), '/agent', [], undefined, services, missing,
    );
    expect(loaded).toEqual([]);
    expect(initialize).not.toHaveBeenCalled();
    expect(execution).not.toHaveBeenCalled();
    expect(missing).toHaveBeenCalledOnce();
    expect(missing).toHaveBeenCalledWith('@example/models-consumer', 'felan.models@1');
  });

  it('injects the configured service without requiring a classifier or constructing a provider', async () => {
    const models: ModelsService = {
      getAvailable: vi.fn<ModelsService['getAvailable']>(),
      completeSimple: vi.fn<ModelsService['completeSimple']>(),
      streamSimple: vi.fn<ModelsService['streamSimple']>(),
      getAvailableOfType: vi.fn<ModelsService['getAvailableOfType']>(),
      generateImages: vi.fn<ModelsService['generateImages']>(),
    };
    const services = createFelanServiceRegistry();
    services.set(MODELS_SERVICE, models);
    const extension: ConfiguredFelanExtension = Object.assign((pi: FelanExtensionAPI) => {
      expect(pi.services.get(MODELS_SERVICE)).toBe(models);
      expect(pi.services.get(MODELS_SERVICE)?.classifier).toBeUndefined();
    }, { serviceRequirements: { required: [MODELS_SERVICE] } });
    const loaded = await loadFelanExtensions(
      ['@example/models-consumer'], async () => ({ default: extension }),
      new TestAgentRuntime(), '/agent', [], undefined, services,
    );
    expect(loaded).toHaveLength(1);
    const inline = loaded[0]!;
    await (typeof inline === 'function' ? inline : inline.factory)({} as ExtensionAPI);
    for (const operation of Object.values(models)) expect(operation).not.toHaveBeenCalled();
  });
});
