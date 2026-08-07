import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createSubscriptionController,
  detectSubscriptionProvider,
  formatReset,
  parseUsageSnapshot,
  prioritizeWindowsForModel,
  type SubscriptionUsageHost,
  type SubscriptionUsageHostResult,
} from '../src/subscription.js';

afterEach(() => vi.useRealTimers());

describe('subscription usage parsing', () => {
  it('normalizes Codex rate windows and additional limits', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-06T10:00:00.000Z'));

    const usage = parseUsageSnapshot('codex', {
      rate_limit: {
        primary_window: {
          limit_window_seconds: 10_800,
          used_percent: 25.4,
          reset_after_seconds: 7_200,
        },
        secondary_window: {
          limit_window_seconds: 604_800,
          used_percent: 41,
          reset_at: new Date('2026-08-11T18:00:00.000Z').getTime() / 1_000,
        },
      },
      additional_rate_limits: [{
        limit_name: 'GPT-5.6',
        rate_limit: {
          primary_window: { limit_window_seconds: 10_800, used_percent: 12 },
        },
      }],
    });

    expect(usage).toMatchObject({
      provider: 'codex',
      displayName: 'Codex Plan',
      windows: [
        { label: '3h', usedPercent: 25.4, resetAt: '2026-08-06T12:00:00.000Z' },
        { label: 'Week', usedPercent: 41, resetAt: '2026-08-11T18:00:00.000Z' },
        { label: 'GPT-5.6 3h', usedPercent: 12 },
      ],
    });
  });

  it('normalizes Claude windows and extra usage', () => {
    const usage = parseUsageSnapshot('anthropic', {
      five_hour: { utilization: 17, resets_at: '2026-08-06T12:00:00.000Z' },
      seven_day: { utilization: 59, resets_at: '2026-08-11T18:00:00.000Z' },
      extra_usage: {
        is_enabled: true,
        used_credits: 123,
        monthly_limit: 2_000,
        utilization: 6.15,
      },
    });

    expect(usage).toMatchObject({
      provider: 'anthropic',
      displayName: 'Claude Plan',
      fiveHourUsage: 17,
      extraUsageEnabled: true,
      windows: [
        { label: '5h', usedPercent: 17, resetAt: '2026-08-06T12:00:00.000Z' },
        { label: 'Week', usedPercent: 59, resetAt: '2026-08-11T18:00:00.000Z' },
        { label: 'Extra [on] $1.23/$20.00', usedPercent: 6.15 },
      ],
    });
  });

  it('detects supported providers and prioritizes model-specific windows', () => {
    expect(detectSubscriptionProvider({ provider: 'openai-codex', id: 'gpt-5.6-sol' })).toBe('codex');
    expect(detectSubscriptionProvider({ provider: 'anthropic', id: 'claude-opus-4-6' })).toBe('anthropic');
    expect(detectSubscriptionProvider({ provider: 'google', id: 'gemini-3' })).toBeUndefined();

    const windows = [
      { label: 'Week', usedPercent: 1 },
      { label: 'GPT-5.6 Week', usedPercent: 2 },
    ];
    expect(prioritizeWindowsForModel(windows, { id: 'gpt-5.6' })).toEqual([windows[1], windows[0]]);
  });

  it('formats reset durations compactly', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-06T10:00:00.000Z'));
    expect(formatReset(new Date('2026-08-11T18:00:00.000Z'))).toBe('5d8h');
  });
});

describe('subscription controller', () => {
  it('coalesces in-flight refreshes and commits the result', async () => {
    let resolve!: (result: SubscriptionUsageHostResult) => void;
    const host: SubscriptionUsageHost = {
      fetchUsage: vi.fn(() => new Promise((done) => { resolve = done; })),
    };
    const updates = vi.fn();
    const controller = createSubscriptionController(host, updates);
    const model = { provider: 'openai-codex', id: 'gpt-5.6-sol' };

    const first = controller.refresh(model);
    const second = controller.refresh(model);
    expect(host.fetchUsage).toHaveBeenCalledOnce();
    expect(controller.state.loading).toBe(true);

    resolve({ ok: true, data: { rate_limit: { primary_window: { used_percent: 20 } } } });
    await Promise.all([first, second]);

    expect(controller.state.loading).toBe(false);
    expect(controller.state.usage?.windows[0]).toMatchObject({ label: '3h', usedPercent: 20 });
    expect(updates).toHaveBeenCalled();
  });

  it('keeps successful windows when a later fetch fails', async () => {
    const host: SubscriptionUsageHost = {
      fetchUsage: vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          data: { rate_limit: { secondary_window: { limit_window_seconds: 604_800, used_percent: 41 } } },
        })
        .mockResolvedValueOnce({ ok: false, error: { code: 'HTTP_ERROR', httpStatus: 503 } }),
    };
    const controller = createSubscriptionController(host);
    const model = { provider: 'openai-codex', id: 'gpt-5.6-sol' };

    await controller.refresh(model);
    await controller.refresh(model, { force: true });

    expect(controller.state.usage).toMatchObject({
      windows: [{ label: 'Week', usedPercent: 41 }],
      error: { code: 'HTTP_ERROR', httpStatus: 503 },
    });
  });

  it('detaches stale requests and protects the latest provider cache', async () => {
    const pending: Array<{
      resolve: (result: SubscriptionUsageHostResult) => void;
      signal: AbortSignal;
    }> = [];
    const host: SubscriptionUsageHost = {
      fetchUsage: vi.fn((request) => new Promise((resolve) => {
        pending.push({ resolve, signal: request.signal });
      })),
    };
    const controller = createSubscriptionController(host);
    const codex = { provider: 'openai-codex', id: 'gpt-5.6-sol' };

    const stale = controller.refresh(codex);
    await controller.refresh({ provider: 'google', id: 'gemini-3' });
    expect(pending[0]?.signal.aborted).toBe(true);

    const latest = controller.refresh(codex, { force: true });
    expect(host.fetchUsage).toHaveBeenCalledTimes(2);
    expect(controller.state.loading).toBe(true);

    pending[1]!.resolve({
      ok: true,
      data: { rate_limit: { secondary_window: { limit_window_seconds: 604_800, used_percent: 20 } } },
    });
    await latest;
    expect(controller.state.loading).toBe(false);
    expect(controller.state.usage?.windows[0]?.usedPercent).toBe(20);

    pending[0]!.resolve({
      ok: true,
      data: { rate_limit: { secondary_window: { limit_window_seconds: 604_800, used_percent: 10 } } },
    });
    await stale;
    expect(controller.state.usage?.windows[0]?.usedPercent).toBe(20);

    const failed = controller.refresh(codex, { force: true });
    pending[2]!.resolve({ ok: false, error: { code: 'HTTP_ERROR', httpStatus: 503 } });
    await failed;
    expect(controller.state.usage).toMatchObject({
      windows: [{ usedPercent: 20 }],
      error: { code: 'HTTP_ERROR', httpStatus: 503 },
    });
  });

  it('aborts active host requests when cleared', async () => {
    let signal: AbortSignal | undefined;
    let resolve!: (result: SubscriptionUsageHostResult) => void;
    const host: SubscriptionUsageHost = {
      fetchUsage: vi.fn((request) => {
        signal = request.signal;
        return new Promise((done) => { resolve = done; });
      }),
    };
    const controller = createSubscriptionController(host);
    const refresh = controller.refresh({ provider: 'anthropic', id: 'claude-opus-4-6' });

    controller.clear();
    expect(signal?.aborted).toBe(true);
    resolve({ ok: false, error: { code: 'FETCH_FAILED' } });
    await refresh;
    expect(controller.state.provider).toBeUndefined();
    expect(controller.state.loading).toBe(false);
  });

  it('clears usage for unsupported models', async () => {
    const host: SubscriptionUsageHost = {
      fetchUsage: vi.fn().mockResolvedValue({ ok: false, error: { code: 'NO_CREDENTIALS' } }),
    };
    const controller = createSubscriptionController(host);
    await controller.refresh({ provider: 'openai-codex', id: 'gpt-5.6-sol' });
    expect(controller.state.provider).toBe('codex');

    await controller.refresh({ provider: 'google', id: 'gemini-3' });
    expect(controller.state.loading).toBe(false);
    expect(controller.state.provider).toBeUndefined();
    expect(controller.state.usage).toBeUndefined();
  });
});
