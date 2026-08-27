import { describe, expect, it, vi } from 'vitest';
import { createSavingsController, type SavingsUsageHost } from '../src/savings.js';

describe('savings controller', () => {
  it('coalesces refreshes and publishes the result', async () => {
    let resolve!: (value: { savedCostUsd: number; hasUnpricedMeasurements: boolean }) => void;
    const host: SavingsUsageHost = { query: vi.fn(() => new Promise((done) => { resolve = done; })) };
    const updates = vi.fn();
    const controller = createSavingsController(host, updates);
    const first = controller.refresh(7);
    const second = controller.refresh(7);
    expect(host.query).toHaveBeenCalledOnce();
    resolve({ savedCostUsd: 1.25, hasUnpricedMeasurements: false });
    await Promise.all([first, second]);
    expect(controller.state).toEqual({ loading: false, result: { savedCostUsd: 1.25, hasUnpricedMeasurements: false } });
    expect(updates).toHaveBeenCalled();
  });

  it('clears and aborts an active request', async () => {
    let resolve!: () => void;
    let signal!: AbortSignal;
    const host: SavingsUsageHost = { query: vi.fn((request) => { signal = request.signal; return new Promise<void>((done) => { resolve = done; }); }) as never };
    const controller = createSavingsController(host);
    const refresh = controller.refresh(7);
    controller.clear();
    expect(signal.aborted).toBe(true);
    resolve();
    await refresh;
    expect(controller.state).toEqual({ loading: false });
  });
});
