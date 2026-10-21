import { afterEach, expect, it, vi } from 'vitest';
import { createSilentLogger, type ExtensionContext, type FelanExtensionAPI } from '@felan-ai/agent-core';
import { createPowerlineRuntimeExtension, type PowerlinePresentationHost } from '../src/runtime.js';
import type { PowerlineData } from '../src/data.js';

afterEach(() => vi.useRealTimers());
function harness() {
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => void | Promise<void>>();
  const exec = vi.fn(async (_command: string, args: string[]) => ({ code: 0, killed: false, stderr: '', stdout: args.includes('--show-toplevel') ? '/fixture' : args.includes('--porcelain=v2') ? '# branch.head main\n' : '' }));
  const values: PowerlineData[] = []; const clear = vi.fn();
  const host: PowerlinePresentationHost = { publish(data) { values.push(data); return true; }, clear };
  const pi = { config: {}, runtime: { logger: createSilentLogger() }, exec,
    on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => void | Promise<void>) => handlers.set(name, handler) } as unknown as FelanExtensionAPI;
  const context = { mode: 'rpc', cwd: '/fixture', model: { id: 'claude-fixture', provider: 'anthropic', contextWindow: 8192 }, thinkingLevel: 'off',
    getContextUsage: () => ({ tokens: 10, percent: 1, contextWindow: 8192 }), sessionManager: { getEntries: () => [] },
    modelRegistry: { getAvailable: () => [{ provider: 'anthropic' }] } } as unknown as ExtensionContext;
  return { pi, context, handlers, exec, values, clear, host,
    emit(name: string, event: unknown = {}) { return handlers.get(name)?.(event, context); } };
}

it('publishes data in non-TUI sessions without an observer or footer', async () => {
  const h = harness(); const fetchUsage = vi.fn(async () => ({ ok: true as const, data: {} }));
  createPowerlineRuntimeExtension({ fetchUsage }, {}, h.host)(h.pi);
  try {
    await h.emit('session_start'); await vi.waitFor(() => expect(h.values.length).toBeGreaterThan(0));
    expect(h.exec).toHaveBeenCalled(); expect(fetchUsage).toHaveBeenCalledOnce();
    await h.emit('turn_end');
    expect(h.clear).not.toHaveBeenCalled();
  } finally { await h.emit('session_shutdown'); }
  expect(h.clear).toHaveBeenCalledOnce();
});

it.each([true, false])('publishes Claude Code response usage with host service %s without fetching', async withHost => {
  const h = harness();
  Object.assign(h.context, { model: { id: 'opus', provider: 'claude-code', contextWindow: 8192 } });
  const fetchUsage = vi.fn(async () => ({ ok: false as const, error: { code: 'NO_CREDENTIALS' as const } }));
  createPowerlineRuntimeExtension(withHost ? { fetchUsage } : undefined, {}, h.host)(h.pi);
  const subscription = () => h.values.at(-1)?.segments.find(segment => segment.name === 'subscription')?.values;
  try {
    await h.emit('session_start');
    await vi.waitFor(() => expect(subscription()).toEqual({ provider: 'anthropic', loading: false, windows: [] }));
    await h.emit('after_provider_response', { type: 'after_provider_response', status: 200, headers: {
      'anthropic-ratelimit-unified-5h-utilization': '0.14',
      'anthropic-ratelimit-unified-7d-utilization': '0.35',
    } });
    await vi.waitFor(() => expect(subscription()).toEqual({ provider: 'anthropic', loading: false, windows: [
      { label: '5h', usedPercent: 14 }, { label: 'Week', usedPercent: 35 },
    ] }));
    await h.emit('after_provider_response', { type: 'after_provider_response', status: 200, headers: {
      'anthropic-ratelimit-unified-5h-utilization': '0.27',
    } });
    await vi.waitFor(() => expect(subscription()).toMatchObject({ windows: [{ label: '5h', usedPercent: 27 }] }));
    await h.emit('model_select');
    expect(fetchUsage).not.toHaveBeenCalled();
  } finally { await h.emit('session_shutdown'); }
  const count = h.values.length;
  await h.emit('after_provider_response', { headers: { 'anthropic-ratelimit-unified-5h-utilization': '0.99' } });
  expect(h.values).toHaveLength(count);
});

it('leaves host-backed Claude usage unchanged by provider response headers', async () => {
  const h = harness();
  const fetchUsage = vi.fn(async () => ({ ok: true as const, data: { five_hour: { utilization: 40 } } }));
  createPowerlineRuntimeExtension({ fetchUsage }, {}, h.host)(h.pi);
  const subscription = () => h.values.at(-1)?.segments.find(segment => segment.name === 'subscription')?.values;
  try {
    await h.emit('session_start');
    await vi.waitFor(() => expect(subscription()).toMatchObject({ windows: [{ label: '5h', usedPercent: 40 }] }));
    await h.emit('after_provider_response', { status: 200, headers: { 'anthropic-ratelimit-unified-5h-utilization': '0.99' } });
    await Promise.resolve();
    expect(subscription()).toMatchObject({ windows: [{ label: '5h', usedPercent: 40 }] });
    expect(fetchUsage).toHaveBeenCalledOnce();
  } finally { await h.emit('session_shutdown'); }
});

it('joins an outstanding Git probe before restarting and during shutdown', async () => {
  const h = harness(); let release = () => {};
  h.exec.mockImplementationOnce(async () => { await new Promise<void>(resolve => { release = resolve; }); return { code: 0, killed: false, stdout: '', stderr: '' }; });
  createPowerlineRuntimeExtension(undefined, {}, h.host)(h.pi);
  let shutdown: Promise<void> | undefined;
  try {
    await h.emit('session_start'); await vi.waitFor(() => expect(h.exec).toHaveBeenCalledOnce());
    await h.emit('turn_end'); await Promise.resolve(); expect(h.exec).toHaveBeenCalledOnce();
    let stopped = false; shutdown = Promise.resolve(h.emit('session_shutdown')).then(() => { stopped = true; });
    await Promise.resolve(); expect(stopped).toBe(false); release(); await shutdown;
    expect(h.exec).toHaveBeenCalledOnce();
  } finally { release(); await (shutdown ?? h.emit('session_shutdown')); }
});

it('retries an uncommitted data projection without polling Git again', async () => {
  vi.useFakeTimers(); const h = harness(); let accept = false;
  const publish = vi.spyOn(h.host, 'publish').mockImplementation(() => accept);
  createPowerlineRuntimeExtension(undefined, {}, h.host)(h.pi);
  try {
    await h.emit('session_start'); await vi.advanceTimersByTimeAsync(0);
    const count = h.exec.mock.calls.length; expect(publish).toHaveBeenCalled(); accept = true;
    await vi.advanceTimersByTimeAsync(1_000); expect(h.exec).toHaveBeenCalledTimes(count); expect(publish.mock.results.at(-1)?.value).toBe(true);
  } finally { await h.emit('session_shutdown'); }
});

it('joins host lease cleanup before shutdown finishes', async () => {
  const h = harness(); let release = () => {};
  const settle = vi.fn(async () => { await new Promise<void>(resolve => { release = resolve; }); });
  createPowerlineRuntimeExtension({ fetchUsage: async () => ({ ok: true, data: {} }), settle }, {}, h.host)(h.pi);
  let shutdown: Promise<void> | undefined;
  try {
    await h.emit('session_start'); await vi.waitFor(() => expect(h.values.length).toBeGreaterThan(0));
    let done = false; shutdown = Promise.resolve(h.emit('session_shutdown')).then(() => { done = true; });
    await vi.waitFor(() => expect(settle).toHaveBeenCalledOnce()); expect(done).toBe(false);
    release(); await shutdown;
  } finally { release(); await (shutdown ?? h.emit('session_shutdown')); }
});

it('collects independently of display and respects behavior settings', async () => {
  const h = harness();
  Object.assign(h.pi, { config: { showWorkingTree: false, showStashCount: false, periodDays: 14, maxWindows: 1 } });
  const query = vi.fn(async () => ({ savedCostUsd: 3, hasUnpricedMeasurements: false }));
  createPowerlineRuntimeExtension(undefined, { savingsHost: { query } }, h.host)(h.pi);
  try {
    await h.emit('session_start');
    await vi.waitFor(() => expect(query).toHaveBeenCalled());
    expect(query).toHaveBeenCalledWith(expect.objectContaining({ periodDays: 14 }));
    expect(h.exec.mock.calls.some(([, args]) => args[0] === 'status' || args[0] === 'stash')).toBe(false);
    const data = h.values.at(-1)!;
    expect(data).not.toHaveProperty('style');
    expect(data).not.toHaveProperty('lines');
    expect(data.segments.some(segment => segment.name === 'session')).toBe(true);
  } finally { await h.emit('session_shutdown'); }
});

it.each([2, 3])('keeps shared Codex windows before applying maxWindows %s for Spark', async maxWindows => {
  const h = harness();
  Object.assign(h.pi, { config: { maxWindows } });
  Object.assign(h.context, { model: { provider: 'openai-codex', id: 'gpt-5.3-codex-spark', contextWindow: 8192 } });
  const rate_limit = { primary_window: { limit_window_seconds: 18000, used_percent: 20 }, secondary_window: { limit_window_seconds: 604800, used_percent: 30 } };
  createPowerlineRuntimeExtension({ fetchUsage: async () => ({ ok: true, data: { rate_limit,
    additional_rate_limits: [{ limit_name: 'GPT-5.3-Codex-Spark', rate_limit }] } }) }, {}, h.host)(h.pi);
  try {
    await h.emit('session_start');
    await vi.waitFor(() => expect(h.values.at(-1)?.segments.find(segment => segment.name === 'subscription')?.values)
      .toMatchObject({ loading: false, windows: [{ label: '5h' }, { label: 'Week' }] }));
  } finally { await h.emit('session_shutdown'); }
});
