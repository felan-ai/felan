import type { ModelRuntime } from '@felan-ai/agent-core';
import { describe, expect, it, vi } from 'vitest';
import { createLocalSubscriptionUsage, createSubscriptionUsageCache } from '../../src/providers/models-subscription.js';

describe('local subscription usage host', () => {
  it('uses a matching Codex companion for native ChatGPT shared-plan usage', async () => {
    const nativeToken = nativeOpenAIToken('native-client');
    const companionToken = codexToken('account-1');
    const modelRuntime = nativeRuntime(nativeToken, companionToken);
    const fetchImplementation = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [{ id: 'native-client' }] })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ rate_limit: {
        primary_window: { limit_window_seconds: 18_000, used_percent: 20 },
      } })));
    const host = createLocalSubscriptionUsage(modelRuntime, fetchImplementation);
    const signal = new AbortController().signal;

    await expect(host.fetchUsage({
      provider: 'openai', modelProvider: 'openai', modelId: 'gpt-5.6', signal,
    })).resolves.toMatchObject({ ok: true, data: { rate_limit: { primary_window: { used_percent: 20 } } } });

    expect(modelRuntime.getAuth).toHaveBeenNthCalledWith(1, expect.objectContaining({
      provider: 'openai', id: 'gpt-5.6',
    }), { signal });
    expect(modelRuntime.getAuth).toHaveBeenNthCalledWith(2, 'openai-codex', { signal });
    expect(fetchImplementation).toHaveBeenNthCalledWith(1,
      'https://chatgpt.com/backend-api/wham/usage/chatpass/apps', expect.objectContaining({
        redirect: 'error', signal,
        headers: expect.objectContaining({ Authorization: `Bearer ${companionToken}` }),
      }));
    expect(fetchImplementation).toHaveBeenNthCalledWith(2,
      'https://chatgpt.com/backend-api/wham/usage', expect.objectContaining({
        redirect: 'error', headers: expect.objectContaining({ Authorization: `Bearer ${companionToken}` }),
      }));
    expect(fetchImplementation.mock.calls.flatMap(([, options]) =>
      Object.values(options?.headers ?? {}))).not.toContain(`Bearer ${nativeToken}`);
  });

  it.each([
    ['duplicate registration', { items: [{ id: 'client' }, { id: 'client' }] }],
    ['missing registration', { items: [{ id: 'other' }] }],
    ['incomplete registration list', { items: [{ id: 'client' }], has_more: true }],
    ['malformed registration', { items: [{ name: 'no-id' }] }],
  ])('fails closed for %s', async (_name, registrations) => {
    const modelRuntime = nativeRuntime(nativeOpenAIToken('client'), codexToken('account-1'));
    const fetchImplementation = vi.fn().mockResolvedValue(new Response(JSON.stringify(registrations)));
    const host = createLocalSubscriptionUsage(modelRuntime, fetchImplementation);

    await expect(host.fetchUsage({
      provider: 'openai', modelProvider: 'openai', modelId: 'gpt-5.6',
      signal: new AbortController().signal,
    })).resolves.toEqual({ ok: false, error: { code: 'COMPANION_UNAVAILABLE' } });
    expect(fetchImplementation).toHaveBeenCalledOnce();
  });

  it.each([401, 403, 429, 302])('falls back when the companion apps endpoint returns HTTP %i', async (status) => {
    const modelRuntime = nativeRuntime(nativeOpenAIToken('client'), codexToken('account-1'));
    const fetchImplementation = vi.fn().mockResolvedValue(new Response(null, { status }));
    const host = createLocalSubscriptionUsage(modelRuntime, fetchImplementation);

    await expect(host.fetchUsage({
      provider: 'openai', modelProvider: 'openai', modelId: 'gpt-5.6',
      signal: new AbortController().signal,
    })).resolves.toMatchObject({
      ok: false,
      error: { code: 'COMPANION_UNAVAILABLE', httpStatus: status },
    });
    expect(fetchImplementation).toHaveBeenCalledOnce();
  });

  it('rejects malformed, partial, and oversized native usage responses', async () => {
    const request = {
      provider: 'openai' as const, modelProvider: 'openai', modelId: 'gpt-5.6',
      signal: new AbortController().signal,
    };
    const modelRuntime = nativeRuntime(nativeOpenAIToken('client'), codexToken('account-1'));
    const partial = createLocalSubscriptionUsage(modelRuntime, vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [{ id: 'client' }] })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ rate_limit: {
        primary_window: { limit_window_seconds: 18_000, used_percent: 20 },
        secondary_window: {},
      } }))));
    await expect(partial.fetchUsage(request)).resolves.toMatchObject({
      ok: false, error: { code: 'COMPANION_UNAVAILABLE' },
    });

    const malformed = createLocalSubscriptionUsage(modelRuntime, vi.fn()
      .mockResolvedValueOnce(new Response('{')));
    await expect(malformed.fetchUsage(request)).resolves.toMatchObject({
      ok: false, error: { code: 'COMPANION_UNAVAILABLE' },
    });

    const oversized = createLocalSubscriptionUsage(modelRuntime, vi.fn()
      .mockResolvedValueOnce(new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(256 * 1024 + 1));
          controller.close();
        },
      }))));
    await expect(oversized.fetchUsage(request)).resolves.toMatchObject({
      ok: false, error: { code: 'COMPANION_UNAVAILABLE' },
    });
  });

  it('does not use native usage with a noncanonical model origin or missing Codex companion', async () => {
    const token = nativeOpenAIToken('client');
    const companion = codexToken('account-1');
    const modelRuntime = nativeRuntime(token, companion);
    modelRuntime.getModel = vi.fn(() => ({
      provider: 'openai', id: 'gpt-5.6', baseUrl: 'https://proxy.example/v1',
    }));
    const fetchImplementation = vi.fn();
    const host = createLocalSubscriptionUsage(modelRuntime, fetchImplementation);
    const request = {
      provider: 'openai' as const, modelProvider: 'openai', modelId: 'gpt-5.6',
      signal: new AbortController().signal,
    };
    await expect(host.fetchUsage(request)).resolves.toMatchObject({
      ok: false, error: { code: 'NO_CREDENTIALS' },
    });

    modelRuntime.getModel = vi.fn((provider, id) => provider === 'openai' && id === 'gpt-5.6'
      ? { provider: 'openai', id, baseUrl: 'https://api.openai.com/v1' }
      : undefined);
    modelRuntime.isUsingSubscription = vi.fn((provider) => provider === 'openai');
    await expect(host.fetchUsage(request)).resolves.toMatchObject({
      ok: false, error: { code: 'COMPANION_UNAVAILABLE' },
    });
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it('does not request companion usage when native OAuth is ineligible', async () => {
    const modelRuntime = nativeRuntime(nativeOpenAIToken('client'), codexToken('account-1'));
    modelRuntime.getAuth = vi.fn().mockResolvedValue({ auth: { apiKey: 'native' }, source: 'OPENAI_API_KEY' });
    const fetchImplementation = vi.fn();
    const host = createLocalSubscriptionUsage(modelRuntime, fetchImplementation);

    await expect(host.fetchUsage({
      provider: 'openai', modelProvider: 'openai', modelId: 'gpt-5.6',
      signal: new AbortController().signal,
    })).resolves.toEqual({ ok: false, error: { code: 'NO_CREDENTIALS' } });
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it('requires documented native token registration and direct-use claims', async () => {
    const modelRuntime = nativeRuntime('header.payload.signature', codexToken('account-1'));
    const fetchImplementation = vi.fn();
    const host = createLocalSubscriptionUsage(modelRuntime, fetchImplementation);

    await expect(host.fetchUsage({
      provider: 'openai', modelProvider: 'openai', modelId: 'gpt-5.6',
      signal: new AbortController().signal,
    })).resolves.toEqual({ ok: false, error: { code: 'COMPANION_UNAVAILABLE' } });
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it('aborts companion usage with the caller signal', async () => {
    const abort = new AbortController();
    const fetchImplementation = vi.fn((_url: string | URL | Request, options?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        if (options?.signal?.aborted) reject(new DOMException('aborted', 'AbortError'));
        else options?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      }));
    const host = createLocalSubscriptionUsage(
      nativeRuntime(nativeOpenAIToken('client'), codexToken('account-1')),
      fetchImplementation,
    );

    const request = host.fetchUsage({
      provider: 'openai', modelProvider: 'openai', modelId: 'gpt-5.6', signal: abort.signal,
    });
    abort.abort();
    await expect(request).resolves.toEqual({ ok: false, error: { code: 'COMPANION_UNAVAILABLE' } });
    expect(fetchImplementation).toHaveBeenCalledOnce();
  });

  it('uses Felan ModelRuntime OAuth for Codex usage', async () => {
    const token = codexToken('account-1');
    const modelRuntime = runtime({ provider: 'openai-codex', token });
    const fetchImplementation = vi.fn().mockResolvedValue(new Response(JSON.stringify({ rate_limit: {} })));
    const host = createLocalSubscriptionUsage(modelRuntime, fetchImplementation);
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
    const host = createLocalSubscriptionUsage(modelRuntime, fetchImplementation);

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
    const host = createLocalSubscriptionUsage(modelRuntime, fetchImplementation);
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
    const host = createLocalSubscriptionUsage(modelRuntime, fetchImplementation);
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

function nativeOpenAIToken(clientId: string): string {
  const payload = Buffer.from(JSON.stringify({
    client_id: clientId,
    scope: 'openid chatgpt.tokens.use.direct',
  })).toString('base64url');
  return `header.${payload}.signature`;
}

function nativeRuntime(nativeToken: string, companionToken: string): ModelRuntime {
  return {
    isUsingSubscription: vi.fn((provider) => provider === 'openai' || provider === 'openai-codex'),
    getModel: vi.fn((provider, id) => provider === 'openai' && id === 'gpt-5.6'
      ? { provider: 'openai', id, baseUrl: 'https://api.openai.com/v1' }
      : undefined),
    getAuth: vi.fn(async (providerOrModel) => {
      if (typeof providerOrModel === 'string') {
        return providerOrModel === 'openai-codex'
          ? { auth: { apiKey: companionToken }, source: 'OAuth' }
          : undefined;
      }
      return providerOrModel.provider === 'openai'
        ? { auth: { apiKey: nativeToken }, source: 'OAuth' }
        : undefined;
    }),
  } as unknown as ModelRuntime;
}

it('shares in-flight requests and cached usage across session model runtimes', async () => {
  let time = 0;
  let finish!: (response: Response) => void;
  const fetchUsage = vi.fn(() => new Promise<Response>(resolve => { finish = resolve; }));
  const query = createSubscriptionUsageCache(fetchUsage, () => time);
  const model = { provider: 'anthropic', id: 'claude' };
  const first = query(runtime({ provider: 'anthropic', token: 'a' }), model);
  const second = query(runtime({ provider: 'anthropic', token: 'a' }), model);
  await vi.waitFor(() => expect(fetchUsage).toHaveBeenCalledOnce());
  finish(new Response('{"five_hour":{"utilization":25}}'));
  expect(await first).toEqual(await second);
  await query(runtime({ provider: 'anthropic', token: 'a' }), model);
  expect(fetchUsage).toHaveBeenCalledOnce();
  time = 60_001;
  const next = query(runtime({ provider: 'anthropic', token: 'a' }), model);
  await vi.waitFor(() => expect(fetchUsage).toHaveBeenCalledTimes(2));
  finish(new Response('{}'));
  await next;
});

it('shares rate-limit backoff across sessions', async () => {
  let time = 0;
  const fetchUsage = vi.fn(async () => new Response('{}', { status: 429, headers: { 'Retry-After': '120' } }));
  const query = createSubscriptionUsageCache(fetchUsage, () => time);
  const model = { provider: 'anthropic', id: 'claude' };
  const models = runtime({ provider: 'anthropic', token: 'a' });
  await query(models, model);
  time = 60_001;
  await query(models, model);
  expect(fetchUsage).toHaveBeenCalledOnce();
  time = 120_001;
  await query(models, model);
  expect(fetchUsage).toHaveBeenCalledTimes(2);
});
