import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLlamaExtension } from '../../src/providers/llama/extension.js';

afterEach(() => { vi.unstubAllGlobals(); });

describe('Pi llama.cpp adapter', () => {
  it('registers the local provider and command', async () => {
    const extension = createLlamaExtension();
    const providers: string[] = [];
    const commands: string[] = [];
    await extension({
      registerProvider: (provider: { id: string }) => providers.push(provider.id),
      registerCommand: (name: string) => commands.push(name),
      on: () => {},
    } as never);
    expect(providers).toEqual(['llama.cpp']);
    expect(commands).toEqual(['llama']);
  });

  it('authenticates and exposes a mock router catalog through the provider', async () => {
    const requests: Array<{ path: string; authorization: string | undefined }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input);
      requests.push({ path: url.pathname, authorization: new Headers(init?.headers).get('authorization') ?? undefined });
      return Response.json({ data: [{
        id: 'offline-model',
        status: { value: 'sleeping' },
        meta: { n_ctx: 4096 },
      }] });
    }));
    const extension = createLlamaExtension();
    let provider: {
      auth: { apiKey: { login: (interaction: {
        signal: AbortSignal;
        prompt: (options: { type: string }) => Promise<string>;
      }) => Promise<{ type: string; key?: string; env?: Record<string, string> }> } };
      refreshModels: (context: {
        allowNetwork: boolean;
        signal: AbortSignal;
        credential: { type: string; key: string; env: Record<string, string> };
        publish: (result: { update?: () => void }) => Promise<boolean>;
      }) => Promise<void>;
      getModels: () => readonly { id: string; provider: string }[];
    } | undefined;
    await extension({
      registerProvider: (registered: typeof provider) => { provider = registered; },
      registerCommand: () => {},
      on: () => {},
    } as never);
    if (!provider) throw new Error('Pi llama.cpp provider was not registered');
    const fields = ['http://127.0.0.1:8080', 'test-key'];
    const credential = await provider.auth.apiKey.login({
      signal: new AbortController().signal,
      prompt: async () => fields.shift() ?? '',
    });
    await provider.refreshModels({
      allowNetwork: true,
      signal: new AbortController().signal,
      credential: {
        type: 'api_key',
        key: credential.key ?? '',
        env: credential.env ?? {},
      },
      publish: async ({ update }) => {
        update?.();
        return true;
      },
    });
    expect(provider.getModels()).toEqual([expect.objectContaining({ id: 'offline-model', provider: 'llama.cpp' })]);
    expect(requests).toEqual([
      { path: '/models', authorization: 'Bearer test-key' },
      { path: '/models', authorization: 'Bearer test-key' },
    ]);
  });

});
