import { expect, it, vi } from 'vitest';
import type { ProviderSessionContext } from '@felan-ai/daemon/provider';
import type { McpOAuthCallbackService } from '@felan-ai/ext-mcp/service';
import { reserveOAuthCallback } from '../src/providers/mcp/callback-server.js';
import provider from '../src/providers/mcp-callback.js';

vi.mock('../src/providers/mcp/callback-server.js', () => ({ reserveOAuthCallback: vi.fn() }));

it('keeps callbacks inactive until activation and cancels them on settle', async () => {
  let callbackSignal: AbortSignal | undefined;
  const release = vi.fn();
  vi.mocked(reserveOAuthCallback).mockImplementation(async (redirectUri, _state, signal) => {
    callbackSignal = signal;
    return { redirectUri, release, wait: () => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }) };
  });
  const instance = await provider.create({ signal: new AbortController().signal } as ProviderSessionContext);
  const service = instance.implementations[0]!.value as McpOAuthCallbackService;
  const reserve = () => service.reserve('http://127.0.0.1:3118/callback', 'x'.repeat(43), new AbortController().signal);
  await expect(reserve()).rejects.toThrow('MCP callback service is unavailable.');
  expect(reserveOAuthCallback).not.toHaveBeenCalled();
  await instance.activate?.();
  await reserve();
  expect(callbackSignal?.aborted).toBe(false);
  await instance.settle?.('force');
  expect(callbackSignal?.aborted).toBe(true);
  expect(release).toHaveBeenCalled();
  await expect(reserve()).rejects.toThrow('MCP callback service is unavailable.');
  await instance.dispose();
});
