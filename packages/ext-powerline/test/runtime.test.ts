import { afterEach, expect, it, vi } from 'vitest';
import { createSilentLogger, type ExtensionContext, type FelanExtensionAPI } from '@felan-ai/agent-core';
import { createPowerlineRuntimeExtension, type PowerlinePresentationHost } from '../src/runtime.js';
import type { PowerlineData } from '../src/view.js';

afterEach(() => vi.useRealTimers());
function harness() {
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => void | Promise<void>>();
  const exec = vi.fn(async (_command: string, args: string[]) => ({ code: 0, killed: false, stderr: '', stdout: args.includes('--show-toplevel') ? '/fixture' : args.includes('--porcelain=v2') ? '# branch.head main\n' : '' }));
  let available = false; let listener = () => {}; let status = 'first';
  const values: PowerlineData[] = []; const clear = vi.fn(); const unsubscribe = vi.fn();
  const host: PowerlinePresentationHost = { available: () => available, subscribe: next => { listener = next; return unsubscribe; },
    statuses: () => new Map([['one', status]]), publish(data) { values.push(data); return true; }, clear };
  const pi = { config: {}, runtime: { logger: createSilentLogger() }, exec,
    on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => void | Promise<void>) => handlers.set(name, handler) } as unknown as FelanExtensionAPI;
  const context = { mode: 'rpc', cwd: '/fixture', model: { id: 'claude-fixture', provider: 'anthropic', contextWindow: 8192 }, thinkingLevel: 'off',
    getContextUsage: () => ({ tokens: 10, percent: 1, contextWindow: 8192 }), sessionManager: { getEntries: () => [] },
    modelRegistry: { getAvailable: () => [{ provider: 'anthropic' }] } } as unknown as ExtensionContext;
  return { pi, context, handlers, exec, values, clear, unsubscribe, host,
    show(value: boolean) { available = value; listener(); }, setStatus(value: string) { status = value; listener(); },
    emit(name: string) { return handlers.get(name)?.({}, context); } };
}

it('does no work without a TUI observer and projects status and usage only while observed', async () => {
  const h = harness(); const fetchUsage = vi.fn(async () => ({ ok: true as const, data: {} }));
  createPowerlineRuntimeExtension({ fetchUsage }, {}, h.host)(h.pi);
  try {
    await h.emit('session_start'); expect(h.exec).not.toHaveBeenCalled(); expect(fetchUsage).not.toHaveBeenCalled();
    h.show(true); await vi.waitFor(() => expect(h.values.length).toBeGreaterThan(0));
    expect(h.exec).toHaveBeenCalled(); expect(fetchUsage).toHaveBeenCalledOnce();
    h.setStatus('updated'); await vi.waitFor(() => expect(JSON.stringify(h.values.at(-1))).toContain('updated'));
    h.show(false); expect(h.clear).toHaveBeenCalled();
    const count = h.values.length; await h.emit('turn_end'); expect(h.values).toHaveLength(count);
    h.show(true); await vi.waitFor(() => expect(h.values.length).toBeGreaterThan(count));
  } finally { await h.emit('session_shutdown'); }
  expect(h.unsubscribe).toHaveBeenCalledOnce();
});

it('joins an outstanding Git probe before restarting and during shutdown', async () => {
  const h = harness(); let release = () => {};
  h.exec.mockImplementationOnce(async () => { await new Promise<void>(resolve => { release = resolve; }); return { code: 0, killed: false, stdout: '', stderr: '' }; });
  createPowerlineRuntimeExtension(undefined, {}, h.host)(h.pi);
  let shutdown: Promise<void> | undefined;
  try {
    await h.emit('session_start'); h.show(true); await vi.waitFor(() => expect(h.exec).toHaveBeenCalledOnce());
    h.show(false); h.show(true); await Promise.resolve(); expect(h.exec).toHaveBeenCalledOnce();
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
    await h.emit('session_start'); h.show(true); await vi.advanceTimersByTimeAsync(0);
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
    await h.emit('session_start'); h.show(true); await vi.waitFor(() => expect(h.values.length).toBeGreaterThan(0));
    let done = false; shutdown = Promise.resolve(h.emit('session_shutdown')).then(() => { done = true; });
    await vi.waitFor(() => expect(settle).toHaveBeenCalledOnce()); expect(done).toBe(false);
    release(); await shutdown;
  } finally { release(); await (shutdown ?? h.emit('session_shutdown')); }
});
