import {
  formatFelanApiContent,
} from './boundary.js';
import type {
  FelanApiFetch,
  FelanApiMethod,
  FelanApiTarget,
  FelanApiResultDetails,
} from './contracts.js';

const DEFAULT_BASE_URL = 'https://app.felan.ai';
const DEFAULT_DOCS_BASE_URL = 'https://felan.ai/docs';
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 300_000;
const MAX_API_KEY_BYTES = 16_384;
const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_QUERY_ENTRIES = 100;
const METHODS = new Set<FelanApiMethod>(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

export type FelanApiQueryValue = string | number | boolean;

export interface FelanApiRequest {
  readonly target?: FelanApiTarget;
  readonly method?: FelanApiMethod;
  readonly path?: string;
  readonly query?: Readonly<Record<string, FelanApiQueryValue>>;
  readonly body?: unknown;
}

export interface ResolvedFelanApiConfig {
  readonly apiKey: string;
  readonly baseUrl: URL;
  readonly docsBaseUrl: URL;
  readonly fetch: FelanApiFetch;
  readonly timeoutMs: number;
}

export interface ResolveFelanApiConfigOptions {
  readonly apiKey?: string;
  readonly baseUrl?: string;
  readonly docsBaseUrl?: string;
  readonly fetch?: FelanApiFetch;
  readonly timeoutMs?: number;
}

interface BoundedResponse {
  readonly text: string;
  readonly truncated: boolean;
}

class SafeRequestError extends Error {
  constructor(
    readonly code: NonNullable<FelanApiResultDetails['error']>,
    message: string,
  ) {
    super(message);
    this.name = 'SafeRequestError';
  }
}

export function configuredFelanApiKey(explicit: string | undefined): string | undefined {
  const configured = explicit === undefined
    ? normalizeString(process.env.FELAN_API_KEY)
    : normalizeString(explicit);
  if (configured === undefined) return undefined;
  if (Buffer.byteLength(configured, 'utf8') > MAX_API_KEY_BYTES || /[\0-\x1f\x7f]/u.test(configured)) {
    throw new Error('Felan API key is invalid');
  }
  return configured;
}

export function resolveFelanApiConfig(options: ResolveFelanApiConfigOptions): ResolvedFelanApiConfig {
  const apiKey = configuredFelanApiKey(options.apiKey);
  if (!apiKey) throw new Error('Felan API key is unavailable');
  return {
    apiKey,
    baseUrl: normalizeBaseUrl(
      normalizeString(options.baseUrl)
      ?? normalizeString(process.env.FELAN_API_URL)
      ?? DEFAULT_BASE_URL,
    ),
    docsBaseUrl: normalizeDocsBaseUrl(
      normalizeString(options.docsBaseUrl)
      ?? normalizeString(process.env.FELAN_DOCS_URL)
      ?? DEFAULT_DOCS_BASE_URL,
    ),
    fetch: options.fetch ?? globalThis.fetch.bind(globalThis),
    timeoutMs: normalizeTimeout(options.timeoutMs),
  };
}

export async function executeFelanApiRequest(
  config: ResolvedFelanApiConfig,
  request: FelanApiRequest,
  signal?: AbortSignal,
): Promise<{
  content: Array<{ type: 'text'; text: string }>;
  details: FelanApiResultDetails;
  isError?: true;
}> {
  const method = normalizeMethod(request.method);
  const target = request.target ?? 'api';
  if (target === 'docs') return executeFelanDocsRequest(config, request.path, method, signal);
  let safePath = safePathForDetails(request.path);
  if (target !== 'api') return failure(method, safePath, 'invalid_request', 'Felan API target is invalid.');
  try {
    const url = buildRequestUrl(config.baseUrl, request.path, request.query);
    safePath = `${url.pathname}${url.search ? '?…' : ''}`;
    const body = requestBody(method, request.body);
    const controller = requestController(signal, config.timeoutMs);
    let response: Response;
    try {
      response = await config.fetch(url, {
        method,
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${config.apiKey}`,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body }),
        signal: controller.signal,
        redirect: 'error',
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      if (controller.timedOut()) {
        return failure(method, safePath, 'timeout', 'Felan API request timed out.');
      }
      return failure(method, safePath, 'network_error', 'Felan API request failed before receiving a response.');
    }
    if (controller.timedOut()) {
      controller.dispose();
      return failure(method, safePath, 'timeout', 'Felan API request timed out.');
    }

    let bounded: BoundedResponse;
    try {
      bounded = await readBoundedResponse(response);
    } catch (error) {
      if (signal?.aborted) throw error;
      if (controller.timedOut()) {
        return failure(method, safePath, 'timeout', 'Felan API request timed out.');
      }
      return failure(method, safePath, 'response_error', 'Felan API response could not be read.', response.status);
    } finally {
      controller.dispose();
    }
    if (controller.timedOut()) {
      return failure(method, safePath, 'timeout', 'Felan API request timed out.');
    }
    const bodyValue = responseBodyValue(response.headers.get('content-type'), bounded.text);
    const formatted = formatFelanApiContent({
      status: response.status,
      data: bodyValue,
      ...(bounded.truncated ? { responseTruncated: true } : {}),
    }, config.apiKey);
    const details: FelanApiResultDetails = {
      method,
      path: safePath,
      status: response.status,
      ok: response.ok,
      truncated: bounded.truncated || formatted.truncated,
      ...(response.ok ? {} : { error: 'http_error' }),
    };
    return {
      content: [{ type: 'text', text: formatted.text }],
      details,
      ...(response.ok ? {} : { isError: true }),
    };
  } catch (error) {
    if (signal?.aborted) throw error;
    if (error instanceof SafeRequestError) {
      return failure(method, safePath, error.code, error.message);
    }
    return failure(method, safePath, 'invalid_request', 'Felan API request is invalid.');
  }
}

async function executeFelanDocsRequest(
  config: ResolvedFelanApiConfig,
  inputPath: string | undefined,
  method: FelanApiMethod,
  signal: AbortSignal | undefined,
): Promise<{
  content: Array<{ type: 'text'; text: string }>;
  details: FelanApiResultDetails;
  isError?: true;
}> {
  if (method !== 'GET') {
    return failure(method, safePathForDetails(inputPath), 'invalid_request', 'Documentation requests only support GET.');
  }
  const safePath = safePathForDetails(inputPath ?? 'llms.txt');
  try {
    const url = buildDocsUrl(config.docsBaseUrl, inputPath);
    const controller = requestController(signal, config.timeoutMs);
    let response: Response;
    try {
      response = await config.fetch(url, {
        method: 'GET',
        headers: { Accept: inputPath?.trim() ? 'text/markdown' : 'text/plain' },
        signal: controller.signal,
        redirect: 'error',
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      if (controller.timedOut()) return failure(method, safePath, 'timeout', 'Felan documentation request timed out.');
      return failure(method, safePath, 'network_error', 'Felan documentation request failed before receiving a response.');
    }
    if (controller.timedOut()) {
      controller.dispose();
      return failure(method, safePath, 'timeout', 'Felan documentation request timed out.');
    }
    let bounded: BoundedResponse;
    try {
      bounded = await readBoundedResponse(response);
    } catch (error) {
      if (signal?.aborted) throw error;
      if (controller.timedOut()) return failure(method, safePath, 'timeout', 'Felan documentation request timed out.');
      return failure(method, safePath, 'response_error', 'Felan documentation response could not be read.', response.status);
    } finally {
      controller.dispose();
    }
    if (controller.timedOut()) return failure(method, safePath, 'timeout', 'Felan documentation request timed out.');
    const formatted = formatFelanApiContent({
      status: response.status,
      data: bounded.text,
      ...(bounded.truncated ? { responseTruncated: true } : {}),
    }, config.apiKey);
    return {
      content: [{ type: 'text', text: formatted.text }],
      details: {
        method,
        target: 'docs',
        path: safePath,
        status: response.status,
        ok: response.ok,
        truncated: bounded.truncated || formatted.truncated,
        ...(response.ok ? {} : { error: 'http_error' }),
      },
      ...(response.ok ? {} : { isError: true }),
    };
  } catch (error) {
    if (signal?.aborted) throw error;
    if (error instanceof SafeRequestError) return failure(method, safePath, error.code, error.message);
    return failure(method, safePath, 'invalid_request', 'Felan documentation request is invalid.');
  }
}

function normalizeBaseUrl(input: string): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error('Felan API base URL must be an absolute HTTP(S) URL');
  }
  if (
    (url.protocol !== 'https:' && url.protocol !== 'http:')
    || url.username
    || url.password
    || url.search
    || url.hash
  ) {
    throw new Error('Felan API base URL must be an HTTP(S) URL without credentials, query, or fragment');
  }
  const pathname = url.pathname.replace(/\/+$/u, '');
  const apiPath = pathname.endsWith('/api/v1')
    ? pathname
    : `${pathname || ''}/api/v1`;
  url.pathname = `${apiPath}/`;
  return url;
}

function normalizeDocsBaseUrl(input: string): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error('Felan documentation base URL must be an absolute HTTP(S) URL');
  }
  if (
    (url.protocol !== 'https:' && url.protocol !== 'http:')
    || url.username
    || url.password
    || url.search
    || url.hash
  ) {
    throw new Error('Felan documentation base URL must be an HTTP(S) URL without credentials, query, or fragment');
  }
  url.pathname = `${url.pathname.replace(/\/+$/u, '')}/`;
  return url;
}

function normalizeTimeout(value: number | undefined): number {
  if (value === undefined) return DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_TIMEOUT_MS) {
    throw new Error(`Felan API timeout must be an integer between 1 and ${MAX_TIMEOUT_MS} milliseconds`);
  }
  return value;
}

function normalizeMethod(value: FelanApiMethod | undefined): FelanApiMethod {
  const method = value ?? 'GET';
  if (!METHODS.has(method)) throw new SafeRequestError('invalid_request', 'Felan API method is invalid.');
  return method;
}

function buildRequestUrl(
  baseUrl: URL,
  inputPath: string | undefined,
  query: Readonly<Record<string, FelanApiQueryValue>> | undefined,
): URL {
  if (typeof inputPath !== 'string') {
    throw new SafeRequestError('invalid_request', 'Felan API path must be a relative API path.');
  }
  const trimmed = inputPath.trim();
  if (
    !trimmed
    || trimmed.length > 2_048
    || trimmed.startsWith('//')
    || trimmed.includes('\\')
    || trimmed.includes('?')
    || trimmed.includes('#')
    || /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(trimmed)
    || /[\0-\x1f\x7f]/u.test(trimmed)
  ) {
    throw new SafeRequestError('invalid_request', 'Felan API path must be relative to /api/v1 without a query or fragment.');
  }
  const relativePath = trimmed.replace(/^\//u, '');
  for (const segment of relativePath.split('/')) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      throw new SafeRequestError('invalid_request', 'Felan API path contains invalid encoding.');
    }
    if (decoded === '.' || decoded === '..' || decoded.includes('/') || decoded.includes('\\')) {
      throw new SafeRequestError('invalid_request', 'Felan API path cannot traverse outside /api/v1.');
    }
  }
  const url = new URL(relativePath, baseUrl);
  if (url.origin !== baseUrl.origin || !url.pathname.startsWith(baseUrl.pathname)) {
    throw new SafeRequestError('invalid_request', 'Felan API path cannot traverse outside /api/v1.');
  }
  appendQuery(url, query);
  return url;
}

function buildDocsUrl(baseUrl: URL, inputPath: string | undefined): URL {
  if (!inputPath?.trim()) return new URL('llms.txt', baseUrl);
  let normalized = inputPath.trim().replace(/^\/+|\/+$/gu, '');
  if (normalized.startsWith('docs/')) normalized = normalized.slice('docs/'.length);
  normalized = normalized.replace(/\.md$/iu, '');
  const segments = normalized.split('/');
  if (
    segments.length === 0
    || segments.some((segment) => !/^[a-z0-9][a-z0-9._-]*$/iu.test(segment))
  ) {
    throw new SafeRequestError('invalid_request', 'Documentation path is invalid.');
  }
  return new URL(`${segments.map(encodeURIComponent).join('/')}.md`, baseUrl);
}

function appendQuery(url: URL, query: Readonly<Record<string, FelanApiQueryValue>> | undefined): void {
  if (query === undefined) return;
  if (typeof query !== 'object' || query === null || Array.isArray(query)) {
    throw new SafeRequestError('invalid_request', 'Felan API query must be an object of primitive values.');
  }
  const entries = Object.entries(query);
  if (entries.length > MAX_QUERY_ENTRIES) {
    throw new SafeRequestError('invalid_request', `Felan API query supports at most ${MAX_QUERY_ENTRIES} entries.`);
  }
  for (const [name, value] of entries) {
    if (!name || name.length > 128 || /[\0-\x1f\x7f]/u.test(name)) {
      throw new SafeRequestError('invalid_request', 'Felan API query contains an invalid name.');
    }
    if (
      (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean')
      || (typeof value === 'number' && !Number.isFinite(value))
      || (typeof value === 'string' && value.length > 4_096)
    ) {
      throw new SafeRequestError('invalid_request', 'Felan API query values must be bounded strings, finite numbers, or booleans.');
    }
    url.searchParams.set(name, String(value));
  }
}

function requestBody(method: FelanApiMethod, value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (method === 'GET') {
    throw new SafeRequestError('invalid_request', 'GET requests cannot include a body.');
  }
  let body: string | undefined;
  try {
    body = JSON.stringify(value);
  } catch {
    throw new SafeRequestError('invalid_request', 'Felan API body must be valid JSON data.');
  }
  if (body === undefined) {
    throw new SafeRequestError('invalid_request', 'Felan API body must be valid JSON data.');
  }
  if (Buffer.byteLength(body, 'utf8') > MAX_REQUEST_BYTES) {
    throw new SafeRequestError('request_too_large', 'Felan API request body is too large.');
  }
  return body;
}

function requestController(signal: AbortSignal | undefined, timeoutMs: number): {
  readonly signal: AbortSignal;
  timedOut(): boolean;
  dispose(): void;
} {
  const controller = new AbortController();
  let didTimeOut = false;
  const onAbort = () => controller.abort(signal?.reason);
  if (signal?.aborted) onAbort();
  else signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => {
    didTimeOut = true;
    controller.abort(new Error('Felan API request timeout'));
  }, timeoutMs);
  timer.unref();
  return {
    signal: controller.signal,
    timedOut: () => didTimeOut,
    dispose: () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    },
  };
}

async function readBoundedResponse(response: Response): Promise<BoundedResponse> {
  if (!response.body) return { text: '', truncated: false };
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let bytes = 0;
  let truncated = false;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      const remaining = MAX_RESPONSE_BYTES - bytes;
      if (remaining <= 0) {
        truncated = true;
        await reader.cancel();
        break;
      }
      const chunk = next.value.subarray(0, remaining);
      bytes += chunk.byteLength;
      text += decoder.decode(chunk, { stream: true });
      if (chunk.byteLength < next.value.byteLength) {
        truncated = true;
        await reader.cancel();
        break;
      }
    }
    text += decoder.decode();
    return { text, truncated };
  } finally {
    reader.releaseLock();
  }
}

function responseBodyValue(contentType: string | null, text: string): unknown {
  if (!text) return null;
  if (contentType?.toLowerCase().includes('json')) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return text;
}

function failure(
  method: FelanApiMethod,
  path: string,
  error: NonNullable<FelanApiResultDetails['error']>,
  message: string,
  status?: number,
): {
  content: Array<{ type: 'text'; text: string }>;
  details: FelanApiResultDetails;
  isError: true;
} {
  return {
    content: [{ type: 'text', text: message }],
    details: {
      method,
      path,
      ...(status === undefined ? {} : { status }),
      ok: false,
      truncated: false,
      error,
    },
    isError: true,
  };
}

function safePathForDetails(value: unknown): string {
  if (typeof value !== 'string') return '[invalid path]';
  const withoutQuery = value.split(/[?#]/u, 1)[0]?.trim() ?? '';
  return withoutQuery.slice(0, 256) || '[invalid path]';
}

function normalizeString(value: string | undefined): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
