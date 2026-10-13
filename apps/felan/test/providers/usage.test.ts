import { expect, it, vi } from 'vitest';
import { HostAgentRuntime, USAGE_SERVICE } from '@felan-ai/agent-core';
import type { ProviderSessionContext } from '@felan-ai/daemon/provider';
import savings, { SavingsService } from '../../src/providers/savings.js';
it('gates savings queries on activation and joins reads before disposal', async () => {
  let finish!: () => void;
  const query = vi.fn(async () => {
    await new Promise<void>(resolve => { finish = resolve; });
    return { savedCostUsd: 2, hasUnpricedMeasurements: false };
  });
  vi.spyOn(SavingsService.prototype, 'query').mockImplementation(query);
  const instance = await savings.create({ runtime: new HostAgentRuntime('/tmp', { sessionStorageRoot: '/tmp', agentStorageRoot: '/tmp' }), rootSessionId: 'root',
    signal: new AbortController().signal } as ProviderSessionContext);
  const service = instance.implementations.find(row => row.contract === USAGE_SERVICE)!.value as import('@felan-ai/agent-core').UsageService;
  const request = { from: new Date('2026-10-01'), to: new Date('2026-10-07') };
  await expect(service.querySavings(request)).rejects.toThrow('inactive');
  await instance.activate!();
  const result = service.querySavings(request);
  let disposed = false;
  const disposal = instance.dispose().then(() => { disposed = true; });
  await Promise.resolve();
  expect(disposed).toBe(false);
  finish();
  await expect(result).resolves.toEqual({ savedCostUsd: 2, hasUnpricedMeasurements: false });
  await disposal;
  await expect(service.querySavings(request)).rejects.toThrow('inactive');
  expect(query).toHaveBeenCalledOnce();
  vi.restoreAllMocks();
});
