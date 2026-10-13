import { expect, it, vi } from 'vitest';
import { USAGE_SERVICE, createExtensionServiceAccess, createFelanServiceRegistry, type UsageService } from '../src/index.js';

it('exposes savings summaries through the declared core usage contract', async () => {
  const services = createFelanServiceRegistry();
  const access = createExtensionServiceAccess(services, { optional: [USAGE_SERVICE] });
  expect(USAGE_SERVICE.key).toBe('felan.usage@1');
  expect(access.get(USAGE_SERVICE)).toBeUndefined();
  const querySavings = vi.fn<UsageService['querySavings']>().mockResolvedValue({ savedCostUsd: 2, hasUnpricedMeasurements: true });
  services.set(USAGE_SERVICE, { querySavings });
  const request = { from: new Date('2026-10-01'), to: new Date('2026-10-07'), signal: new AbortController().signal };
  await expect(access.get(USAGE_SERVICE)!.querySavings(request)).resolves.toEqual({ savedCostUsd: 2, hasUnpricedMeasurements: true });
  expect(querySavings).toHaveBeenCalledWith(request);
});
