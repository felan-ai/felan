import type {
  Api,
  AssistantImages,
  AssistantMessage,
  AssistantMessageEventStream,
  Context,
  ImageApi,
  ImageModel,
  ImagesContext,
  Model,
  SimpleStreamOptions,
} from '@earendil-works/pi-ai';
import type { Classifier } from '../classifier/types.js';
import type { ModelReference } from '../model-tiers.js';
import { defineServiceContract } from '../services.js';

export interface ModelsRequestOptions {
  readonly signal?: AbortSignal;
}

export type ModelSubscriptionUsageResult =
  | { readonly ok: true; readonly data: unknown }
  | { readonly ok: false; readonly error: {
    readonly code: 'NO_CREDENTIALS' | 'COMPANION_UNAVAILABLE' | 'FETCH_FAILED' | 'HTTP_ERROR';
    readonly httpStatus?: number;
    readonly retryAfterMs?: number;
  } };

export type ModelsCallOptions = Readonly<Pick<
  SimpleStreamOptions,
  'signal' | 'maxTokens' | 'reasoning' | 'timeoutMs' | 'maxRetries' | 'cacheRetention' | 'sessionId'
>>;

export type TextModelInfo = Readonly<Pick<Model<Api>,
  'id' | 'name' | 'api' | 'provider' | 'input' | 'cost' | 'reasoning' | 'thinkingLevelMap' | 'contextWindow' | 'maxTokens'
>>;

export type ImageModelInfo = Readonly<Pick<ImageModel<ImageApi>,
  'id' | 'name' | 'api' | 'provider' | 'type' | 'input' | 'output' | 'cost'
>>;

/**
 * Implementations expose only this facade, never the underlying model runtime.
 * Providers resolve model references against the current authenticated, allowed
 * scope on every call. Caller model metadata and unlisted option keys must not
 * reach provider dispatch. Availability describes selection metadata, not
 * endpoint authority, headers or credentials.
 * Request limits remain host-controlled. sessionId is a cache-affinity hint,
 * not a session selector, and must be namespaced to the authorized scope.
 */
export interface ModelsService {
  getSubscriptionUsage?(model: ModelReference, options?: ModelsRequestOptions): Promise<ModelSubscriptionUsageResult>;
  getAvailable(providerId?: string, options?: ModelsRequestOptions): Promise<readonly TextModelInfo[]>;
  completeSimple(model: ModelReference, context: Context, options?: ModelsCallOptions): Promise<AssistantMessage>;
  streamSimple(model: ModelReference, context: Context, options?: ModelsCallOptions): AssistantMessageEventStream;
  getAvailableOfType(type: 'image', providerId?: string, options?: ModelsRequestOptions): Promise<readonly ImageModelInfo[]>;
  generateImages(model: ModelReference, context: ImagesContext, options?: ModelsRequestOptions): Promise<AssistantImages>;
  readonly classifier?: Classifier;
}

export const MODELS_SERVICE = defineServiceContract<ModelsService>('felan.models', 1);
