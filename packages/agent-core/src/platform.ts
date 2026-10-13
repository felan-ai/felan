import { defineServiceContract } from './services.js';

export type FelanApiMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
export type FelanApiTarget = 'api' | 'docs';
export type FelanApiQueryValue = string | number | boolean;

export interface FelanApiRequest {
  readonly target?: FelanApiTarget;
  readonly method?: FelanApiMethod;
  readonly path?: string;
  readonly query?: Readonly<Record<string, FelanApiQueryValue>>;
  readonly body?: unknown;
}

export interface FelanApiResultDetails {
  readonly method: FelanApiMethod;
  readonly target?: FelanApiTarget;
  readonly path: string;
  readonly ok: boolean;
  readonly truncated: boolean;
  readonly status?: number;
  readonly error?: 'invalid_request' | 'request_too_large' | 'timeout' | 'network_error' | 'response_error' | 'http_error';
}

export interface FelanPlatformService {
  readonly teamSlug?: string;
  /** Results must be bounded, credential-redacted, and wrapped as untrusted content. */
  execute(request: FelanApiRequest, signal?: AbortSignal): Promise<{
    content: Array<{ type: 'text'; text: string }>;
    details: FelanApiResultDetails;
    isError?: true;
  }>;
}

export const FELAN_PLATFORM_SERVICE = defineServiceContract<FelanPlatformService>('felan.platform', 1);
