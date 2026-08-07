import type { ModelRuntime } from '@felan-ai/agent-core';
import type {
  SubscriptionProviderName,
  SubscriptionUsageHost,
  SubscriptionUsageHostResult,
} from '@felan-ai/ext-powerline';

const CODEX_PROVIDER = 'openai-codex';
const ANTHROPIC_PROVIDER = 'anthropic';
const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';
const ANTHROPIC_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';

export function createLocalSubscriptionUsageHost(
  modelRuntime: ModelRuntime,
  fetchImplementation: typeof fetch = fetch,
): SubscriptionUsageHost {
  return {
    async fetchUsage(request): Promise<SubscriptionUsageHostResult> {
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
      } else {
        headers['anthropic-beta'] = 'oauth-2025-04-20';
      }

      try {
        const response = await fetchImplementation(usageUrlFor(request.provider), {
          method: 'GET',
          headers,
          signal: request.signal,
        });
        if (!response.ok) return failure('HTTP_ERROR', response.status);
        return { ok: true, data: await response.json() };
      } catch {
        return failure('FETCH_FAILED');
      }
    },
  };
}

function providerIdFor(provider: SubscriptionProviderName): string {
  return provider === 'codex' ? CODEX_PROVIDER : ANTHROPIC_PROVIDER;
}

function usageUrlFor(provider: SubscriptionProviderName): string {
  return provider === 'codex' ? CODEX_USAGE_URL : ANTHROPIC_USAGE_URL;
}

function failure(
  code: 'NO_CREDENTIALS' | 'FETCH_FAILED' | 'HTTP_ERROR',
  httpStatus?: number,
): SubscriptionUsageHostResult {
  return {
    ok: false,
    error: {
      code,
      ...(httpStatus === undefined ? {} : { httpStatus }),
    },
  };
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
