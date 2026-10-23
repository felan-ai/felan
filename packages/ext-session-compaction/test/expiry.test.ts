import { createLogger, type ExtensionContext, type FelanExtensionAPI, type LogRecord, type Model, type SessionEntry } from '@felan-ai/agent-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerCacheExpiryCompaction, type CacheExpiryCompactionOptions } from '../src/expiry.js';

const refreshedAt = Date.parse('2026-01-01T00:00:00.000Z');

describe('cache-expiry compaction', () => {
  afterEach(() => vi.restoreAllMocks());

  it('registers nothing when disabled', () => {
    const installed = install({ enabled: false });
    expect(installed.handlers.size).toBe(0);
    expect(installed.scheduler.takeTrigger()).toBe(false);
    expect(installed.scheduler.takeTrigger()).toBe(false);
    expect(installed.setTimer).not.toHaveBeenCalled();
  });

  it('does not schedule unknown lifetimes or uncached contexts', () => {
    const installed = install();
    installed.ctx.model = model(false);
    installed.emit('session_start');
    expect(installed.timers.size).toBe(0);
    expect(installed.logs.at(-1)?.fields.reason).toBe('cache-expiry-unknown');
    installed.ctx.model = model();
    installed.entries.length = 0;
    installed.emit('agent_settled');
    expect(installed.setTimer).not.toHaveBeenCalled();
  });

  it('compacts an idle, large, eligible context in the default lead window', () => {
    const installed = install();
    installed.emit('session_start');
    expect(installed.setTimer).toHaveBeenLastCalledWith(expect.any(Function), 40_000);
    expect(installed.scheduler.takeTrigger()).toBe(false);
    installed.fireNext();
    expect(installed.canCompact).toHaveBeenCalledWith(installed.ctx);
    expect(installed.ctx.compact).toHaveBeenCalledOnce();
    expect(installed.ctx.ui.notify).toHaveBeenCalledWith('Prompt cache expires in 20s; compacting the idle session so the next request starts smaller.', 'info');
    expect(installed.logs.at(-1)).toMatchObject({
      level: 'debug',
      fields: { component: 'session-compaction', sessionId: 'session-1', secondsLeft: 20, contextTokens: 30_000, reason: 'compact' },
    });
    expect(installed.timers.size).toBe(0);
    expect(installed.scheduler.takeTrigger()).toBe(true);
    expect(installed.scheduler.takeTrigger()).toBe(false);
  });

  it('uses a custom lead time and schedules immediately inside its window', () => {
    const installed = install({ leadMs: 10_000 });
    installed.emit('session_start');
    expect(installed.setTimer).toHaveBeenLastCalledWith(expect.any(Function), 50_000);
    installed.setNow(refreshedAt + 55_000);
    installed.emit('agent_settled');
    expect(installed.timers.size).toBe(1);
    expect(installed.setTimer).toHaveBeenLastCalledWith(expect.any(Function), 0);
    installed.fireNext();
    expect(installed.ctx.compact).toHaveBeenCalledOnce();
    expect(installed.ctx.ui.notify).toHaveBeenCalledWith('Prompt cache expires in 5s; compacting the idle session so the next request starts smaller.', 'info');
  });

  it.each(['session_start', 'agent_settled', 'session_tree', 'model_select'])('schedules on %s and replaces the previous timer', (event) => {
    const installed = install();
    installed.emit('session_start');
    const staleCallback = installed.timers.values().next().value!.fn;
    installed.emit(event);
    expect(installed.timers.size).toBe(1);
    expect(installed.clearTimer).toHaveBeenCalledOnce();
    staleCallback();
    expect(installed.ctx.compact).not.toHaveBeenCalled();
  });

  it.each(['agent_start', 'session_compact', 'session_shutdown', 'session_before_switch', 'session_before_fork'])('cancels on %s', (event) => {
    const installed = install();
    installed.emit('session_start');
    const staleCallback = installed.timers.values().next().value!.fn;
    installed.emit(event);
    expect(installed.timers.size).toBe(0);
    staleCallback();
    expect(installed.ctx.compact).not.toHaveBeenCalled();
  });

  it.each([
    ['auto-compaction-disabled', (installed: Installed) => { installed.getSettings.mockReturnValue({ compaction: { enabled: false } }); }],
    ['agent-busy', (installed: Installed) => { installed.ctx.isIdle.mockReturnValue(false); }],
    ['pending-messages', (installed: Installed) => { installed.ctx.hasPendingMessages.mockReturnValue(true); }],
    ['context-usage-unavailable', (installed: Installed) => { installed.ctx.getContextUsage.mockReturnValue(undefined); }],
    ['context-usage-unavailable', (installed: Installed) => { installed.ctx.getContextUsage.mockReturnValue({ tokens: null, contextWindow: 100_000, percent: null }); }],
    ['context-usage-unavailable', (installed: Installed) => { installed.ctx.getContextUsage.mockReturnValue({ tokens: NaN, contextWindow: 100_000, percent: null }); }],
    ['context-too-small', (installed: Installed) => { installed.ctx.getContextUsage.mockReturnValue({ tokens: 29_999, contextWindow: 100_000, percent: 30 }); }],
    ['not-eligible', (installed: Installed) => { installed.canCompact.mockReturnValue({ ok: false, reason: 'not-eligible' }); }],
  ] as const)('skips for %s without retrying from the timer', (reason, configure) => {
    const installed = install();
    installed.emit('session_start');
    configure(installed);
    installed.fireNext();
    expect(installed.ctx.compact).not.toHaveBeenCalled();
    expect(installed.logs.at(-1)?.fields.reason).toBe(reason);
    expect(installed.timers.size).toBe(0);
    expect(installed.scheduler.takeTrigger()).toBe(false);
  });

  it('checks auto-compaction, idle state, pending messages, usage, and eligibility in order', () => {
    const installed = install();
    installed.getSettings.mockReturnValue({ compaction: { enabled: false } });
    installed.ctx.isIdle.mockReturnValue(false);
    installed.ctx.hasPendingMessages.mockReturnValue(true);
    installed.ctx.getContextUsage.mockReturnValue(undefined);
    installed.emit('session_start');
    installed.fireNext();
    expect(installed.ctx.isIdle).not.toHaveBeenCalled();
    expect(installed.logs.at(-1)?.fields.reason).toBe('auto-compaction-disabled');

    installed.getSettings.mockReturnValue({});
    installed.emit('agent_settled');
    installed.fireNext();
    expect(installed.ctx.hasPendingMessages).not.toHaveBeenCalled();
    expect(installed.logs.at(-1)?.fields.reason).toBe('agent-busy');

    installed.ctx.isIdle.mockReturnValue(true);
    installed.emit('agent_settled');
    installed.fireNext();
    expect(installed.ctx.getContextUsage).not.toHaveBeenCalled();
    expect(installed.logs.at(-1)?.fields.reason).toBe('pending-messages');

    installed.ctx.hasPendingMessages.mockReturnValue(false);
    installed.emit('agent_settled');
    installed.fireNext();
    expect(installed.canCompact).not.toHaveBeenCalled();
    expect(installed.logs.at(-1)?.fields.reason).toBe('context-usage-unavailable');
  });

  it('reschedules when a cache warmer extends expiry beyond the lead window tolerance', () => {
    const installed = install();
    installed.emit('session_start');
    installed.entries.push(cacheWarm(refreshedAt + 30_000));
    installed.fireNext();
    expect(installed.ctx.compact).not.toHaveBeenCalled();
    expect(installed.timers.size).toBe(1);
    expect(installed.setTimer).toHaveBeenLastCalledWith(expect.any(Function), 30_000);
    installed.fireNext();
    expect(installed.ctx.compact).toHaveBeenCalledOnce();
  });

  it('accepts a warmer extension within the one-second tolerance', () => {
    const installed = install();
    installed.emit('session_start');
    installed.entries.push(cacheWarm(refreshedAt + 1_000));
    installed.fireNext();
    expect(installed.ctx.compact).toHaveBeenCalledOnce();
    expect(installed.setTimer).toHaveBeenCalledOnce();
  });

  it('stops when the cache expires before scheduling or before the timer fires', () => {
    const installed = install();
    installed.setNow(refreshedAt + 60_000);
    installed.emit('session_start');
    expect(installed.timers.size).toBe(0);
    installed.setNow(refreshedAt);
    installed.emit('agent_settled');
    installed.fireNext(refreshedAt + 60_000);
    expect(installed.ctx.compact).not.toHaveBeenCalled();
    expect(installed.logs.at(-1)?.fields.reason).toBe('cache-expired');
    expect(installed.timers.size).toBe(0);
  });

  it('rechecks cache presence when the timer fires', () => {
    const installed = install();
    installed.emit('session_start');
    installed.entries.length = 0;
    installed.fireNext();
    expect(installed.ctx.compact).not.toHaveBeenCalled();
    expect(installed.logs.at(-1)?.fields.reason).toBe('cache-expiry-unknown');
  });

  it.each(['onComplete', 'onError'] as const)('clears an unconsumed trigger on %s without retrying the same expiry', (callback) => {
    const installed = install();
    installed.emit('session_start');
    installed.fireNext();
    const callbacks = installed.ctx.compact.mock.calls[0]![0]!;
    if (callback === 'onComplete') callbacks.onComplete!({ summary: 'summary', firstKeptEntryId: 'keep', tokensBefore: 30_000 });
    else callbacks.onError!(new Error('failed'));
    expect(installed.scheduler.takeTrigger()).toBe(false);
    expect(installed.timers.size).toBe(0);
    expect(installed.setTimer).toHaveBeenCalledOnce();
    installed.emit('agent_settled');
    installed.fireNext();
    expect(installed.ctx.compact).toHaveBeenCalledTimes(2);
  });

  it.each([
    [Object.assign(new Error('operation aborted'), { name: 'AbortError' }), 'compaction-cancelled'],
    [new Error('Compaction cancelled'), 'compaction-cancelled'],
    [new Error('CANCELED by the user'), 'compaction-cancelled'],
    [new Error('provider unavailable'), 'compaction-failed'],
  ])('logs %s as %s', (error, reason) => {
    const installed = install();
    installed.emit('session_start');
    installed.fireNext();

    installed.ctx.compact.mock.calls[0]![0]!.onError!(error);

    expect(installed.logs.at(-1)?.fields.reason).toBe(reason);
    expect(installed.scheduler.takeTrigger()).toBe(false);
    expect(installed.timers.size).toBe(0);
  });

  it('does not overlap attempts, even after the trigger has been consumed', () => {
    const installed = install();
    installed.emit('session_start');
    installed.fireNext();
    expect(installed.scheduler.takeTrigger()).toBe(true);
    installed.emit('agent_settled');
    expect(installed.logs.at(-1)?.fields.reason).toBe('compaction-in-progress');
    expect(installed.timers.size).toBe(0);
  });

  it('does not let a stale callback clear the next attempt trigger after a session change', () => {
    const installed = install();
    installed.emit('session_start');
    installed.fireNext();
    const oldCallback = installed.ctx.compact.mock.calls[0]![0]!.onError!;
    installed.emit('session_before_switch');
    expect(installed.scheduler.takeTrigger()).toBe(false);
    installed.emit('session_start');
    installed.fireNext();
    oldCallback(new Error('old failure'));
    expect(installed.scheduler.takeTrigger()).toBe(true);
    expect(installed.scheduler.takeTrigger()).toBe(false);
  });

  it('tolerates notification and logging failures', () => {
    const installed = install();
    installed.ctx.ui.notify.mockImplementation(() => { throw new Error('unavailable'); });
    vi.spyOn(installed.pi.runtime.logger, 'child').mockImplementation(() => { throw new Error('unavailable'); });
    expect(() => installed.emit('session_start')).not.toThrow();
    expect(() => installed.fireNext()).not.toThrow();
    expect(installed.ctx.compact).toHaveBeenCalledOnce();
    expect(installed.scheduler.takeTrigger()).toBe(true);
  });

  it('clears the trigger and does not retry if compact throws', () => {
    const installed = install();
    installed.ctx.compact.mockImplementation(() => { throw new Error('failed'); });
    installed.emit('session_start');
    expect(() => installed.fireNext()).not.toThrow();
    expect(installed.scheduler.takeTrigger()).toBe(false);
    expect(installed.timers.size).toBe(0);
    expect(installed.logs.at(-1)?.fields.reason).toBe('compaction-failed');
  });

  it('swallows failures while reading state, scheduling, evaluating eligibility, and cancelling', () => {
    const installed = install();
    installed.ctx.sessionManager.getBranch.mockImplementationOnce(() => { throw new Error('failed'); });
    expect(() => installed.emit('session_start')).not.toThrow();
    installed.setTimer.mockImplementationOnce(() => { throw new Error('failed'); });
    expect(() => installed.emit('agent_settled')).not.toThrow();
    installed.canCompact.mockImplementationOnce(() => { throw new Error('failed'); });
    installed.emit('agent_settled');
    expect(() => installed.fireNext()).not.toThrow();
    expect(installed.scheduler.takeTrigger()).toBe(false);
    installed.emit('agent_settled');
    const staleCallback = installed.timers.values().next().value!.fn;
    installed.clearTimer.mockImplementationOnce(() => { throw new Error('failed'); });
    expect(() => installed.emit('agent_start')).not.toThrow();
    staleCallback();
    expect(installed.ctx.compact).not.toHaveBeenCalled();
  });

  it('bounds diagnostic text and logs only scheduler metadata', () => {
    const installed = install();
    installed.ctx.sessionManager.getSessionId.mockReturnValue('s'.repeat(1_000));
    installed.canCompact.mockReturnValue({ ok: false, reason: 'r'.repeat(1_000) });
    installed.emit('session_start');
    installed.fireNext();
    expect(installed.logs.at(-1)?.fields).toEqual({
      component: 'session-compaction', sessionId: 's'.repeat(256), reason: 'r'.repeat(256), secondsLeft: 20, contextTokens: 30_000,
    });
  });

  it('unrefs and cancels the default timer', () => {
    const unref = vi.fn();
    const timer = { unref: () => { unref(); return timer; } };
    vi.spyOn(globalThis, 'setTimeout').mockReturnValue(timer as unknown as ReturnType<typeof setTimeout>);
    const clearTimeout = vi.spyOn(globalThis, 'clearTimeout').mockImplementation(() => {});
    const installed = install({}, { nativeTimers: true });
    installed.emit('session_start');
    expect(unref).toHaveBeenCalledOnce();
    installed.emit('agent_start');
    expect(clearTimeout).toHaveBeenCalledWith(timer);
  });
});

type Installed = ReturnType<typeof install>;

function install(overrides: Partial<CacheExpiryCompactionOptions> = {}, { nativeTimers = false } = {}) {
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => void>();
  const logs: LogRecord[] = [];
  const entries = [assistant()];
  const timers = new Map<number, { fn: () => void; at: number }>();
  let time = refreshedAt;
  let nextTimerId = 0;
  const setTimer = vi.fn((fn: () => void, ms: number) => {
    const id = ++nextTimerId;
    timers.set(id, { fn, at: time + ms });
    return id;
  });
  const clearTimer = vi.fn((handle: unknown) => { timers.delete(handle as number); });
  const canCompact = vi.fn<CacheExpiryCompactionOptions['canCompact']>().mockReturnValue({ ok: true });
  const getSettings = vi.fn<() => { compaction?: { enabled: boolean } }>().mockReturnValue({});
  const pi = {
    on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => void) => { handlers.set(name, handler); },
    getSettings,
    runtime: { logger: createLogger({ level: 'debug', destination: { write: (record) => { logs.push(record); } } }) },
  } as unknown as FelanExtensionAPI;
  const ctx = {
    model: model() as Model<any> | undefined,
    sessionManager: { getBranch: vi.fn(() => entries), getSessionId: vi.fn(() => 'session-1') },
    ui: { notify: vi.fn() },
    isIdle: vi.fn(() => true),
    hasPendingMessages: vi.fn(() => false),
    getContextUsage: vi.fn<ExtensionContext['getContextUsage']>().mockReturnValue({ tokens: 30_000, contextWindow: 100_000, percent: 30 }),
    compact: vi.fn<ExtensionContext['compact']>(),
  };
  const scheduler = registerCacheExpiryCompaction(pi, {
    enabled: true, minContextTokens: 30_000, canCompact, now: () => time,
    ...(nativeTimers ? {} : { setTimer, clearTimer }), ...overrides,
  });
  return {
    scheduler, handlers, timers, logs, entries, ctx, pi, setTimer, clearTimer, canCompact, getSettings,
    setNow: (value: number) => { time = value; },
    emit: (event: string) => { handlers.get(event)!({}, ctx as unknown as ExtensionContext); },
    fireNext: (at?: number) => {
      const [id, pending] = [...timers.entries()].sort((left, right) => left[1].at - right[1].at)[0]!;
      timers.delete(id);
      time = at ?? pending.at;
      pending.fn();
    },
  };
}

function model(declared = true): Model<any> {
  return {
    id: 'test', name: 'Test', api: 'openai-responses', provider: 'test', baseUrl: 'https://example.test',
    input: ['text'], reasoning: false, contextWindow: 100_000, maxTokens: 1_000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    ...(declared ? { promptCache: { short: 60 } } : {}),
  };
}

function assistant(): SessionEntry {
  return {
    type: 'message', id: 'reply', parentId: null, timestamp: new Date(refreshedAt).toISOString(),
    message: {
      role: 'assistant', api: 'openai-responses', provider: 'test', model: 'test', content: [],
      timestamp: refreshedAt, stopReason: 'stop',
      usage: {
        input: 0, output: 0, totalTokens: 1, cacheRead: 1, cacheWrite: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    },
  };
}

function cacheWarm(timestamp: number): SessionEntry {
  return {
    type: 'usage', id: 'warm', parentId: null, timestamp: new Date(timestamp).toISOString(),
    kind: 'cache_warm', provider: 'test', model: 'test',
    usage: { input: 0, output: 0, totalTokens: 1, cacheRead: 1, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  };
}
