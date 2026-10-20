import { expect, it, vi } from 'vitest';
import type { ProviderSessionContext } from '@felan-ai/daemon/provider';
import type { McpOAuthCallbackService } from '@felan-ai/ext-mcp/service';
import { reserveOAuthCallback } from '../src/providers/mcp/callback-server.js';
import provider from '../src/providers/mcp-callback.js';
import { openHostUrl } from '../src/providers/setup-open.js';

vi.mock('../src/providers/mcp/callback-server.js', () => ({ reserveOAuthCallback: vi.fn() }));
vi.mock('../src/providers/setup-open.js', () => ({ openHostUrl: vi.fn(async () => {}) }));

it('opens authorization URLs only on an active host runtime', async () => {
  const url = 'https://auth.example.test/authorize';
  const runtime = { kind: 'host' };
  const instance = await provider.create({ signal: new AbortController().signal, runtime } as unknown as ProviderSessionContext);
  const service = instance.implementations[0]!.value as McpOAuthCallbackService;
  const signal = new AbortController().signal;
  await expect(service.openAuthorizationUrl!(url, signal)).rejects.toThrow('MCP callback service is unavailable.');
  await instance.activate?.();
  await service.openAuthorizationUrl!(url, signal);
  expect(openHostUrl).toHaveBeenCalledWith(runtime, url, expect.any(AbortSignal));
  await instance.dispose();

  vi.mocked(openHostUrl).mockClear();
  const docker = await provider.create({ signal: new AbortController().signal, runtime: { kind: 'docker' } } as unknown as ProviderSessionContext);
  await docker.activate?.();
  await expect((docker.implementations[0]!.value as McpOAuthCallbackService).openAuthorizationUrl!(url, signal))
    .rejects.toThrow('Opening a browser requires a host runtime.');
  expect(openHostUrl).not.toHaveBeenCalled();
  await docker.dispose();
});

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
