import type { ModelReference, ModelRuntime, ModelSubscriptionUsageResult } from '@felan-ai/agent-core';

type SubscriptionProviderName = 'openai' | 'codex' | 'anthropic' | 'xai';
type SubscriptionUsageHostResult = ModelSubscriptionUsageResult;
type SubscriptionUsageHostErrorCode = Extract<ModelSubscriptionUsageResult, { ok: false }>['error']['code'];
interface SubscriptionUsageHost {
  fetchUsage(request: { provider: SubscriptionProviderName; modelProvider: string; modelId?: string; signal: AbortSignal }): Promise<ModelSubscriptionUsageResult>;
}

const CODEX_PROVIDER = 'openai-codex';
const OPENAI_PROVIDER = 'openai';
const ANTHROPIC_PROVIDER = 'anthropic';
const XAI_PROVIDER = 'xai';
const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';
const OPENAI_APPS_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage/chatpass/apps';
const ANTHROPIC_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const XAI_USAGE_URL = 'https://cli-chat-proxy.grok.com/v1/billing?format=credits';

interface SubscriptionCacheEntry {
  result?: ModelSubscriptionUsageResult;
  pending?: Promise<ModelSubscriptionUsageResult>;
  refreshAt: number;
  rateLimits: number;
}

export function createSubscriptionUsageCache(fetchImplementation?: typeof fetch, now: () => number = Date.now) {
  const entries = new Map<string, SubscriptionCacheEntry>();
  return async (runtime: ModelRuntime, model: ModelReference): Promise<ModelSubscriptionUsageResult> => {
    const provider = model.provider === 'openai-codex' ? 'codex' : model.provider;
    if (provider !== 'codex' && provider !== 'openai' && provider !== 'anthropic' && provider !== 'xai') return failure('NO_CREDENTIALS');
    const key = provider === 'openai' ? `${provider}/${model.id}` : provider;
    let entry = entries.get(key);
    if (!entry) { entry = { refreshAt: 0, rateLimits: 0 }; entries.set(key, entry); }
    if (!entry.pending && (!entry.result || now() >= entry.refreshAt)) {
      const current = entry;
      current.pending = createLocalSubscriptionUsage(runtime, fetchImplementation ?? fetch).fetchUsage({
        provider, modelProvider: model.provider, modelId: model.id, signal: AbortSignal.timeout(5_000),
      }).then(result => {
        const limited = !result.ok && result.error.httpStatus === 429;
        current.rateLimits = limited ? current.rateLimits + 1 : 0;
        const backoff = limited ? Math.min(30 * 60_000, 60_000 * 2 ** (current.rateLimits - 1)) : 60_000;
        current.refreshAt = now() + Math.max(backoff, !result.ok ? result.error.retryAfterMs ?? 0 : 0);
        current.result = result;
        return result;
      }).finally(() => { delete current.pending; });
    }
    return structuredClone(await (entry.pending ?? entry.result!));
  };
}

export function createLocalSubscriptionUsage(
  modelRuntime: ModelRuntime,
  fetchImplementation: typeof fetch = fetch,
): SubscriptionUsageHost {
  return {
    async fetchUsage(request): Promise<SubscriptionUsageHostResult> {
      if (request.provider === 'openai') {
        if (request.modelProvider !== OPENAI_PROVIDER) return failure('NO_CREDENTIALS');
        return fetchOpenAIUsage(modelRuntime, request.modelId, fetchImplementation, request.signal);
      }
      const providerId = providerIdFor(request.provider);
      if (request.modelProvider !== providerId || !modelRuntime.isUsingSubscription(providerId)) {
        return failure('NO_CREDENTIALS');
      }

      let auth: Awaited<ReturnType<ModelRuntime['getAuth']>>;
      try {
        auth = await modelRuntime.getAuth(providerId, { signal: request.signal });
      } catch {
        return failure('FETCH_FAILED');
      }
      const token = auth?.auth.apiKey?.trim();
      if (!token) return failure('NO_CREDENTIALS');

      const headers: Record<string, string> = {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      };
      if (request.provider === 'codex') {
        const accountId = extractCodexAccountId(token);
        if (accountId) headers['ChatGPT-Account-Id'] = accountId;
      } else if (request.provider === 'xai') {
        headers['X-XAI-Token-Auth'] = 'xai-grok-cli';
      } else {
        headers['anthropic-beta'] = 'oauth-2025-04-20';
      }

      try {
        const response = await fetchImplementation(usageUrlFor(request.provider), {
          method: 'GET',
          headers,
          signal: request.signal,
        });
        if (!response.ok) {
          return failure('HTTP_ERROR', response.status, parseRetryAfterMs(response.headers.get('retry-after')));
        }
        return { ok: true, data: await response.json() };
      } catch {
        return failure('FETCH_FAILED');
      }
    },
  };
}

function providerIdFor(provider: SubscriptionProviderName): string {
  if (provider === 'openai') return OPENAI_PROVIDER;
  if (provider === 'codex') return CODEX_PROVIDER;
  if (provider === 'xai') return XAI_PROVIDER;
  return ANTHROPIC_PROVIDER;
}

function usageUrlFor(provider: SubscriptionProviderName): string {
  if (provider === 'openai') return CODEX_USAGE_URL;
  if (provider === 'codex') return CODEX_USAGE_URL;
  if (provider === 'xai') return XAI_USAGE_URL;
  return ANTHROPIC_USAGE_URL;
}

async function fetchOpenAIUsage(
  modelRuntime: ModelRuntime,
  modelId: string | undefined,
  fetchImplementation: typeof fetch,
  signal: AbortSignal,
): Promise<SubscriptionUsageHostResult> {
  if (!modelId || !modelRuntime.isUsingSubscription(OPENAI_PROVIDER)) return failure('NO_CREDENTIALS');

  let nativeAuth: Awaited<ReturnType<ModelRuntime['getAuth']>>;
  let companionAuth: Awaited<ReturnType<ModelRuntime['getAuth']>>;
  let nativeIdentity: { clientId: string } | undefined;
  try {
    const model = modelRuntime.getModel(OPENAI_PROVIDER, modelId);
    if (!model || model.baseUrl !== 'https://api.openai.com/v1') return failure('NO_CREDENTIALS');
    nativeAuth = await modelRuntime.getAuth(model, { signal });
    if (nativeAuth?.source !== 'OAuth'
      || Object.keys(nativeAuth.auth.headers ?? {}).some((key) => key.toLowerCase() === 'authorization')
      || nativeAuth.auth.baseUrl !== undefined) return failure('NO_CREDENTIALS');
    const nativeToken = nativeAuth.auth.apiKey?.trim();
    if (!nativeToken) return failure('NO_CREDENTIALS');
    nativeIdentity = parseOpenAINativeIdentity(nativeToken);
    if (!nativeIdentity) return failure('COMPANION_UNAVAILABLE');

  } catch {
    return failure('FETCH_FAILED');
  }

  if (!modelRuntime.isUsingSubscription(CODEX_PROVIDER)) return failure('COMPANION_UNAVAILABLE');
  try {
    companionAuth = await modelRuntime.getAuth(CODEX_PROVIDER, { signal });
  } catch {
    return failure('COMPANION_UNAVAILABLE');
  }
  if (companionAuth?.source !== 'OAuth') return failure('COMPANION_UNAVAILABLE');

  const companionToken = companionAuth?.auth.apiKey?.trim();
  if (!companionToken) return failure('COMPANION_UNAVAILABLE');
  const accountId = extractCodexAccountId(companionToken);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${companionToken}`,
    Accept: 'application/json',
    ...(accountId ? { 'ChatGPT-Account-Id': accountId } : {}),
  };

  try {
    const appsResponse = await fetchImplementation(OPENAI_APPS_USAGE_URL, {
      method: 'GET', headers, signal, redirect: 'error',
    });
    if (!appsResponse.ok) return failure('COMPANION_UNAVAILABLE', appsResponse.status,
      parseRetryAfterMs(appsResponse.headers.get('retry-after')));
    const apps = await readBoundedJson(appsResponse);
    if (!nativeIdentity || !hasUniqueOpenAIRegistration(apps, nativeIdentity.clientId)) {
      return failure('COMPANION_UNAVAILABLE');
    }

    const usageResponse = await fetchImplementation(CODEX_USAGE_URL, {
      method: 'GET', headers, signal, redirect: 'error',
    });
    if (!usageResponse.ok) return failure('COMPANION_UNAVAILABLE', usageResponse.status,
      parseRetryAfterMs(usageResponse.headers.get('retry-after')));
    const data = await readBoundedJson(usageResponse);
    if (!hasSharedPlanWindows(data)) return failure('COMPANION_UNAVAILABLE');
    return { ok: true, data };
  } catch {
    return failure('COMPANION_UNAVAILABLE');
  }
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const maxBytes = 256 * 1024;
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    await response.body?.cancel();
    throw new Error('Usage response exceeded its size limit');
  }
  if (!response.body) return undefined;

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytesRead = 0;
  let body = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      if (bytesRead > maxBytes) {
        await reader.cancel();
        throw new Error('Usage response exceeded its size limit');
      }
      body += decoder.decode(value, { stream: true });
    }
    body += decoder.decode();
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(body) as unknown;
}

function parseOpenAINativeIdentity(token: string): { clientId: string } | undefined {
  try {
    const encoded = token.split('.')[1];
    if (!encoded) return undefined;
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as unknown;
    if (!isRecord(payload)
      || typeof payload.client_id !== 'string'
      || !payload.client_id.trim()
      || payload.client_id.length > 512
      || typeof payload.scope !== 'string'
      || !payload.scope.split(/\s+/).includes('chatgpt.tokens.use.direct')) return undefined;
    return { clientId: payload.client_id };
  } catch {
    return undefined;
  }
}

function hasUniqueOpenAIRegistration(value: unknown, clientId: string): boolean {
  if (!isRecord(value) || !Array.isArray(value.items) || value.items.length > 128
    || Object.keys(value).some((key) => !['items', 'has_more', 'next_cursor'].includes(key))
    || value.has_more !== undefined && value.has_more !== false
    || value.next_cursor !== undefined && value.next_cursor !== null) return false;
  const ids: string[] = [];
  for (const item of value.items) {
    if (!isRecord(item) || typeof item.id !== 'string' || !item.id.trim() || item.id.length > 512) return false;
    ids.push(item.id);
  }
  return ids.filter((id) => id === clientId).length === 1;
}

function hasSharedPlanWindows(value: unknown): boolean {
  if (!isRecord(value) || !isRecord(value.rate_limit)) return false;
  const rateLimit = value.rate_limit;
  const windows = ['primary_window', 'secondary_window']
    .filter((name) => rateLimit[name] !== undefined)
    .map((name) => rateLimit[name]);
  return windows.length > 0 && windows.every((window) => isRecord(window)
    && typeof window.used_percent === 'number'
    && Number.isFinite(window.used_percent)
    && window.used_percent >= 0
    && window.used_percent <= 100
    && typeof window.limit_window_seconds === 'number'
    && Number.isFinite(window.limit_window_seconds)
    && window.limit_window_seconds > 0
    && window.limit_window_seconds <= 315_360_000
    && (window.reset_at === undefined || (typeof window.reset_at === 'number'
      && Number.isFinite(window.reset_at) && window.reset_at >= 0 && window.reset_at <= 8_640_000_000_000))
    && (window.reset_after_seconds === undefined || (typeof window.reset_after_seconds === 'number'
      && Number.isFinite(window.reset_after_seconds) && window.reset_after_seconds >= 0
      && window.reset_after_seconds <= 8_000_000_000_000)));
}

function failure(
  code: SubscriptionUsageHostErrorCode,
  httpStatus?: number,
  retryAfterMs?: number,
): SubscriptionUsageHostResult {
  return {
    ok: false,
    error: {
      code,
      ...(httpStatus === undefined ? {} : { httpStatus }),
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    },
  };
}

function parseRetryAfterMs(value: string | null): number | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1_000;
  const date = Date.parse(trimmed);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

function extractCodexAccountId(token: string): string | undefined {
  try {
    const encoded = token.split('.')[1];
    if (!encoded) return undefined;
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as unknown;
    if (!isRecord(payload)) return undefined;
    const auth = payload['https://api.openai.com/auth'];
    if (isRecord(auth) && typeof auth.chatgpt_account_id === 'string' && auth.chatgpt_account_id) {
      return auth.chatgpt_account_id;
    }
    for (const key of ['account_id', 'accountId', 'chatgpt_account_id', 'chatgptAccountId']) {
      const value = payload[key];
      if (typeof value === 'string' && value) return value;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
