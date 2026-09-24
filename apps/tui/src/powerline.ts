import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { ModelRuntime } from '@felan-ai/agent-core';
import {
  createSubscriptionUsageStore,
  type SavingsUsageHost,
  type SavingsUsageHostResult,
  type SubscriptionProviderName,
  type SubscriptionUsageHost,
  type SubscriptionUsageHostErrorCode,
  type SubscriptionUsageHostResult,
  type SubscriptionUsageStore,
} from '@felan-ai/ext-powerline';
import { acquireLocalFileLock, type LocalFileLock } from './lock.js';
import type { SavingsService } from './savings.js';

export function createLocalSavingsUsageHost(
  service: Pick<SavingsService, 'query'>,
  now: () => Date = () => new Date(),
): SavingsUsageHost {
  return {
    async query(request): Promise<SavingsUsageHostResult> {
      if (request.signal.aborted) throw new DOMException('The operation was aborted', 'AbortError');
      const to = now();
      const today = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate()));
      const from = new Date(today);
      from.setUTCDate(from.getUTCDate() - (request.periodDays - 1));
      const report = await service.query({ scope: 'all', from, to });
      if (request.signal.aborted) throw new DOMException('The operation was aborted', 'AbortError');
      return { savedCostUsd: report.savedCostUsd, hasUnpricedMeasurements: report.hasUnpricedMeasurements };
    },
  };
}

const CODEX_PROVIDER = 'openai-codex';
const ANTHROPIC_PROVIDER = 'anthropic';
const XAI_PROVIDER = 'xai';
const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';
const ANTHROPIC_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const XAI_USAGE_URL = 'https://cli-chat-proxy.grok.com/v1/billing?format=credits';

const MAX_USAGE_STATE_BYTES = 64 * 1024;
const REFRESH_LEASE_STALE_MS = 60_000;

/** Persists usage snapshots and rate-limit backoff so restarts and concurrent Felan processes share them. */
export function createFileSubscriptionUsageStore(path: string): SubscriptionUsageStore {
  return createSubscriptionUsageStore({
    read() {
      let content: string;
      try {
        content = readFileSync(path, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
      }
      if (content.length > MAX_USAGE_STATE_BYTES) return undefined;
      return JSON.parse(content) as unknown;
    },
    write(value) {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      const temporary = `${path}.${process.pid}.tmp`;
      writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
      renameSync(temporary, path);
    },
  });
}

/**
 * With `refreshLeasePath`, only the process holding a provider's lease calls the usage endpoint;
 * others defer to the shared store. A crashed holder's lease goes stale and another process takes over.
 */
export function createLocalSubscriptionUsageHost(
  modelRuntime: ModelRuntime,
  fetchImplementation: typeof fetch = fetch,
  refreshLeasePath?: string,
): SubscriptionUsageHost {
  const leases = new Map<SubscriptionProviderName, LocalFileLock>();

  async function holdsRefreshLease(provider: SubscriptionProviderName): Promise<boolean> {
    if (refreshLeasePath === undefined) return true;
    const held = leases.get(provider);
    if (held && !held.isCompromised()) return true;
    leases.delete(provider);
    try {
      await mkdir(dirname(refreshLeasePath), { recursive: true, mode: 0o700 });
      leases.set(provider, await acquireLocalFileLock(refreshLeasePath, {
        realpath: false,
        lockfilePath: `${refreshLeasePath}.${provider}.lease`,
        stale: REFRESH_LEASE_STALE_MS,
      }));
      return true;
    } catch (error) {
      // Refresh without coordination when the lease itself cannot work.
      return (error as NodeJS.ErrnoException).code !== 'ELOCKED';
    }
  }

  return {
    releaseRefreshLease(provider) {
      const lease = leases.get(provider);
      if (!lease) return;
      leases.delete(provider);
      void lease.release().catch(() => {});
    },
    async fetchUsage(request): Promise<SubscriptionUsageHostResult> {
      const providerId = providerIdFor(request.provider);
      if (request.modelProvider !== providerId || !modelRuntime.isUsingSubscription(providerId)) {
        return failure('NO_CREDENTIALS');
      }
      if (!(await holdsRefreshLease(request.provider))) return failure('REFRESH_DEFERRED');

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
  if (provider === 'codex') return CODEX_PROVIDER;
  if (provider === 'xai') return XAI_PROVIDER;
  return ANTHROPIC_PROVIDER;
}

function usageUrlFor(provider: SubscriptionProviderName): string {
  if (provider === 'codex') return CODEX_USAGE_URL;
  if (provider === 'xai') return XAI_USAGE_URL;
  return ANTHROPIC_USAGE_URL;
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
