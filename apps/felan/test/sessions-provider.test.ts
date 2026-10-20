import { describe, expect, it, vi } from 'vitest';
import { createFelanServiceRegistry, SESSIONS_HISTORY_SERVICE, SESSIONS_SERVICE, HOST_WORKERS_SERVICE, RUNTIME_LIFETIME_SERVICE, type HostWorkerLauncher, type RuntimeLifetime, type AgentRuntime, type ModelRuntime, type SessionsHistory, type SessionsService } from '@felan-ai/agent-core';
import provider from '../src/providers/sessions.js';

function port(): SessionsService {
  return { current: { id: 'child', root: 'root', parent: 'root' },
    list: vi.fn(async () => ({ items: [] })), history: vi.fn(async () => ({ sessionId: 'child', entries: [], revision: 'digest', branch: null })),
    checkpoint: vi.fn(async () => ({ sessionId: 'child', revision: 'digest', branch: null, byteLength: 0, transcriptDigest: 'digest' })),
    setTitleIfMissing: vi.fn(async () => false), create: vi.fn(), executions: vi.fn(async () => ({ items: [] })),
    execution: vi.fn(), steer: vi.fn(async () => {}), cancel: vi.fn(async () => {}), subscribe: vi.fn(() => () => {}),
  };
}

async function fixture(sessions = port(), openWorker?: HostWorkerLauncher) {
  const signal = new AbortController();
  const instance = await provider.create({ runtime: {} as AgentRuntime, modelRuntime: {} as ModelRuntime,
    secretStorage: { read: async () => undefined, write: async () => {}, remove: async () => {} },
    services: createFelanServiceRegistry(), options: undefined, signal: signal.signal,
    sessionId: 'child', rootSessionId: 'root', allowedModels: undefined, sessions, ...(openWorker ? { openWorker } : {}) });
  return { instance, sessions, signal, service: instance.implementations[0]!.value as SessionsService };
}

describe('configured Sessions provider', () => {
  it('uses the canonical scoped port only after activation', async () => {
    const f = await fixture();
    expect(provider.provides).toEqual([SESSIONS_SERVICE, SESSIONS_HISTORY_SERVICE, HOST_WORKERS_SERVICE, RUNTIME_LIFETIME_SERVICE]);
    expect(f.service).not.toHaveProperty('openWorker');
    expect(f.service).not.toHaveProperty('registerLifecycle');
    expect(f.instance.implementations.some(row => row.contract.key === HOST_WORKERS_SERVICE.key)).toBe(false);
    expect(f.service.current).toEqual({ id: 'child', root: 'root', parent: 'root' });
    await expect(f.service.list({ scope: 'visible' })).rejects.toMatchObject({ code: 'inaccessible' });
    expect(f.sessions.list).not.toHaveBeenCalled();
    await f.instance.activate!();
    await f.service.list({ scope: 'root' }, { limit: 7 });
    expect(f.sessions.list).toHaveBeenCalledWith({ scope: 'root' }, { limit: 7, signal: expect.any(AbortSignal) });
    await f.service.setTitleIfMissing('title', 'request');
    expect(f.sessions.setTitleIfMissing).toHaveBeenCalledWith('title', 'request', { signal: expect.any(AbortSignal) });
    await f.instance.dispose();
    await expect(f.service.executions()).rejects.toMatchObject({ code: 'inaccessible' });
  });

  it('owns extension lifetimes independently of portable Sessions', async () => {
    const f = await fixture();
    const lifetime = f.instance.implementations.find(row => row.contract.key === RUNTIME_LIFETIME_SERVICE.key)!.value as RuntimeLifetime;
    const lifecycle = { busy: () => true, settle: vi.fn(async () => {}), dispose: vi.fn(async () => {}) };
    const release = lifetime.register(lifecycle);
    expect(f.instance.busy!()).toBe(true);
    await f.instance.activate!();
    await f.instance.settle!('drain');
    expect(lifecycle.settle).toHaveBeenCalledWith('drain');
    await f.instance.dispose();
    expect(lifecycle.dispose).toHaveBeenCalledOnce();
    release();
    expect(() => lifetime.register(lifecycle)).toThrow();
  });

  it('publishes a distinct frozen history facade without execution methods', async () => {
    const f = await fixture();
    const history = f.instance.implementations.find(item => item.contract.key === SESSIONS_HISTORY_SERVICE.key)!.value as SessionsHistory;
    expect(history).not.toBe(f.service);
    expect(Object.isFrozen(history)).toBe(true);
    expect(Object.keys(history).sort()).toEqual(['checkpoint', 'current', 'history', 'list']);
    await expect(history.list({ scope: 'root' })).rejects.toMatchObject({ code: 'inaccessible' });
    await f.instance.activate!();
    await history.list({ scope: 'visible' });
    expect(f.sessions.list).toHaveBeenCalledOnce();
    await f.instance.dispose();
  });

  it('joins an in-flight canonical operation and releases subscriptions during disposal', async () => {
    const f = await fixture();
    let finish!: () => void;
    const stop = vi.fn();
    vi.mocked(f.sessions.subscribe).mockReturnValue(stop);
    vi.mocked(f.sessions.steer).mockImplementation(async () => new Promise<void>(resolve => { finish = resolve; }));
    await f.instance.activate!();
    f.service.subscribe(() => {});
    const steering = f.service.steer('execution', 'next');
    const passed = vi.mocked(f.sessions.steer).mock.calls[0]![2]!.signal!;
    let disposed = false;
    const cleanup = f.instance.dispose().then(() => { disposed = true; });
    expect(passed.aborted).toBe(true);
    expect(stop).toHaveBeenCalledOnce();
    expect(disposed).toBe(false);
    finish(); await steering; await cleanup;
    expect(disposed).toBe(true);
  });

  it('refuses a port bound to another session before any operation', async () => {
    const sessions = port();
    const foreign = { ...sessions, current: { id: 'different', root: 'root' } };
    await expect(fixture(foreign)).rejects.toMatchObject({ code: 'inaccessible' });
    expect(sessions.create).not.toHaveBeenCalled();
  });
});
