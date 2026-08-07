import type { ModelRuntime } from '@felan-ai/agent-core';
import { describe, expect, it, vi } from 'vitest';
import { createLocalSubscriptionUsageHost } from '../src/powerline.js';

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
