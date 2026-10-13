import { createServer } from 'node:http';
import { describe, expect, it } from 'vitest';
import { createLlamaExtension } from '../../src/providers/llama/extension.js';

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
    const server = createServer((request, response) => {
      requests.push({ path: request.url ?? '', authorization: request.headers.authorization });
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ data: [{
        id: 'offline-model',
        status: { value: 'sleeping' },
        meta: { n_ctx: 4096 },
      }] }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Mock llama.cpp server did not start');
    try {
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
      const fields = [`http://127.0.0.1:${address.port}`, 'test-key'];
      const credential = await provider.auth.apiKey.login({
        signal: AbortSignal.timeout(5_000),
        prompt: async () => fields.shift() ?? '',
      });
      await provider.refreshModels({
        allowNetwork: true,
        signal: AbortSignal.timeout(5_000),
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
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

});
