import type { ModelRuntime } from '@felan-ai/agent-core';
import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createFileSubscriptionUsageStore,
  createLocalSavingsUsageHost,
  createLocalSubscriptionUsageHost,
} from '../src/powerline.js';

describe('local subscription usage host', () => {
  it('uses Felan ModelRuntime OAuth for Codex usage', async () => {
    const token = codexToken('account-1');
    const modelRuntime = runtime({ provider: 'openai-codex', token });
    const fetchImplementation = vi.fn().mockResolvedValue(new Response(JSON.stringify({ rate_limit: {} })));
    const host = createLocalSubscriptionUsageHost(modelRuntime, fetchImplementation);
    const signal = new AbortController().signal;

    await expect(host.fetchUsage({
      provider: 'codex',
      modelProvider: 'openai-codex',
      signal,
    })).resolves.toEqual({ ok: true, data: { rate_limit: {} } });

    expect(modelRuntime.getAuth).toHaveBeenCalledWith('openai-codex', { signal });
    expect(fetchImplementation).toHaveBeenCalledWith(
      'https://chatgpt.com/backend-api/wham/usage',
      expect.objectContaining({
        method: 'GET',
        signal,
        headers: expect.objectContaining({
          Authorization: `Bearer ${token}`,
          'ChatGPT-Account-Id': 'account-1',
        }),
      }),
    );
  });

  it('uses Anthropic subscription OAuth and beta headers', async () => {
    const modelRuntime = runtime({ provider: 'anthropic', token: 'anthropic-token' });
    const fetchImplementation = vi.fn().mockResolvedValue(new Response('{}'));
    const host = createLocalSubscriptionUsageHost(modelRuntime, fetchImplementation);

    await expect(host.fetchUsage({
      provider: 'anthropic',
      modelProvider: 'anthropic',
      signal: new AbortController().signal,
    })).resolves.toEqual({ ok: true, data: {} });

    expect(fetchImplementation).toHaveBeenCalledWith(
      'https://api.anthropic.com/api/oauth/usage',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer anthropic-token',
          'anthropic-beta': 'oauth-2025-04-20',
        }),
      }),
    );
  });

  it('uses xAI SuperGrok OAuth and Grok Build billing headers', async () => {
    const modelRuntime = runtime({ provider: 'xai', token: 'xai-token' });
    const fetchImplementation = vi.fn().mockResolvedValue(new Response(JSON.stringify({ config: {} })));
    const host = createLocalSubscriptionUsageHost(modelRuntime, fetchImplementation);
    const signal = new AbortController().signal;

    await expect(host.fetchUsage({
      provider: 'xai',
      modelProvider: 'xai',
      signal,
    })).resolves.toEqual({ ok: true, data: { config: {} } });

    expect(modelRuntime.getAuth).toHaveBeenCalledWith('xai', { signal });
    expect(fetchImplementation).toHaveBeenCalledWith(
      'https://cli-chat-proxy.grok.com/v1/billing?format=credits',
      expect.objectContaining({
        method: 'GET',
        signal,
        headers: expect.objectContaining({
          Authorization: 'Bearer xai-token',
          'X-XAI-Token-Auth': 'xai-grok-cli',
        }),
      }),
    );
  });

  it('rejects non-subscription auth and maps provider failures', async () => {
    const getAuth = vi.fn();
    const modelRuntime = {
      isUsingSubscription: vi.fn().mockReturnValue(false),
      getAuth,
    } as unknown as ModelRuntime;
    const fetchImplementation = vi.fn();
    const host = createLocalSubscriptionUsageHost(modelRuntime, fetchImplementation);
    const signal = new AbortController().signal;

    await expect(host.fetchUsage({
      provider: 'codex',
      modelProvider: 'openai-codex',
      signal,
    })).resolves.toEqual({ ok: false, error: { code: 'NO_CREDENTIALS' } });
    expect(getAuth).not.toHaveBeenCalled();
    expect(fetchImplementation).not.toHaveBeenCalled();

    modelRuntime.isUsingSubscription = vi.fn().mockReturnValue(true);
    modelRuntime.getAuth = vi.fn().mockResolvedValue({ auth: { apiKey: 'token' } });
    fetchImplementation.mockResolvedValue(new Response('{}', { status: 429 }));
    await expect(host.fetchUsage({
      provider: 'codex',
      modelProvider: 'openai-codex',
      signal,
    })).resolves.toEqual({ ok: false, error: { code: 'HTTP_ERROR', httpStatus: 429 } });

    fetchImplementation.mockResolvedValue(new Response('{}', { status: 429, headers: { 'Retry-After': '120' } }));
    await expect(host.fetchUsage({
      provider: 'codex',
      modelProvider: 'openai-codex',
      signal,
    })).resolves.toEqual({ ok: false, error: { code: 'HTTP_ERROR', httpStatus: 429, retryAfterMs: 120_000 } });
  });

  it('lets only the refresh lease holder fetch until it releases the lease', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'felan-subscription-lease-'));
    try {
      const path = join(directory, 'agent', 'subscription-usage.json');
      const fetchImplementation = vi.fn(async () => new Response('{}'));
      const holder = createLocalSubscriptionUsageHost(
        runtime({ provider: 'anthropic', token: 'a' }),
        fetchImplementation,
        path,
      );
      const follower = createLocalSubscriptionUsageHost(
        runtime({ provider: 'anthropic', token: 'b' }),
        fetchImplementation,
        path,
      );
      const request = {
        provider: 'anthropic' as const,
        modelProvider: 'anthropic',
        signal: new AbortController().signal,
      };

      await expect(holder.fetchUsage(request)).resolves.toEqual({ ok: true, data: {} });
      await expect(follower.fetchUsage(request)).resolves.toEqual({
        ok: false,
        error: { code: 'REFRESH_DEFERRED' },
      });
      await expect(holder.fetchUsage(request)).resolves.toEqual({ ok: true, data: {} });
      expect(fetchImplementation).toHaveBeenCalledTimes(2);

      holder.releaseRefreshLease?.('anthropic');
      await vi.waitFor(async () => {
        await expect(follower.fetchUsage(request)).resolves.toEqual({ ok: true, data: {} });
      });
      follower.releaseRefreshLease?.('anthropic');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('persists subscription usage across store instances', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'felan-subscription-usage-'));
    try {
      const path = join(directory, 'agent', 'subscription-usage.json');
      expect(createFileSubscriptionUsageStore(path).get('anthropic')).toBeUndefined();

      createFileSubscriptionUsageStore(path).set('anthropic', {
        rateLimitedCount: 1,
        blockedUntil: 1_000,
        snapshot: {
          provider: 'anthropic',
          displayName: 'Claude Plan',
          windows: [{ label: '5h', usedPercent: 60 }],
        },
      });

      expect(createFileSubscriptionUsageStore(path).get('anthropic')).toEqual({
        rateLimitedCount: 1,
        blockedUntil: 1_000,
        snapshot: {
          provider: 'anthropic',
          displayName: 'Claude Plan',
          windows: [{ label: '5h', usedPercent: 60 }],
        },
      });

      await writeFile(path, 'not json');
      expect(createFileSubscriptionUsageStore(path).get('anthropic')).toBeUndefined();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe('local savings usage host', () => {
  it('queries all savings for seven inclusive UTC calendar days', async () => {
    const query = vi.fn().mockResolvedValue({ savedCostUsd: 4.25, hasUnpricedMeasurements: false });
    const host = createLocalSavingsUsageHost(
      { query },
      () => new Date('2026-03-10T12:34:00Z'),
    );
    const result = await host.query({ periodDays: 7, signal: new AbortController().signal });
    expect(result).toEqual({ savedCostUsd: 4.25, hasUnpricedMeasurements: false });
    expect(query).toHaveBeenCalledWith({
      scope: 'all',
      from: new Date('2026-03-04T00:00:00Z'),
      to: new Date('2026-03-10T12:34:00Z'),
    });
  });

  it('does not query when the request is already aborted', async () => {
    const query = vi.fn();
    const host = createLocalSavingsUsageHost({ query });
    const abort = new AbortController();
    abort.abort();
    await expect(host.query({ periodDays: 7, signal: abort.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(query).not.toHaveBeenCalled();
  });
});

function runtime(options: { provider: string; token: string }): ModelRuntime {
  return {
    isUsingSubscription: vi.fn((provider) => provider === options.provider),
    getAuth: vi.fn(async (provider) => provider === options.provider
      ? { auth: { apiKey: options.token }, source: 'OAuth' }
      : undefined),
  } as unknown as ModelRuntime;
}

function codexToken(accountId: string): string {
  const payload = Buffer.from(JSON.stringify({
    'https://api.openai.com/auth': { chatgpt_account_id: accountId },
  })).toString('base64url');
  return `header.${payload}.signature`;
}
