export type FelanApiFetch = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface CreateFelanApiExtensionOptions {
  /** API key used instead of FELAN_API_KEY when it is non-empty. */
  readonly apiKey?: string;
  /** Felan application or /api/v1 base URL. Defaults to FELAN_API_URL, then production. */
  readonly baseUrl?: string;
  /** Public documentation base URL used by target "docs". */
  readonly docsBaseUrl?: string;
  /** Trusted team slug used instead of FELAN_TEAM_SLUG when provided. */
  readonly teamSlug?: string;
  /** Host-injected fetch implementation. */
  readonly fetch?: FelanApiFetch;
  /** Per-request timeout in milliseconds. Defaults to 30 seconds. */
  readonly timeoutMs?: number;
}

export type FelanApiMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
export type FelanApiTarget = 'api' | 'docs';

export interface FelanApiResultDetails {
  readonly method: FelanApiMethod;
  readonly target?: FelanApiTarget;
  readonly path: string;
  readonly ok: boolean;
  readonly truncated: boolean;
  readonly status?: number;
  readonly error?:
    | 'invalid_request'
    | 'request_too_large'
    | 'timeout'
    | 'network_error'
    | 'response_error'
    | 'http_error';
}
