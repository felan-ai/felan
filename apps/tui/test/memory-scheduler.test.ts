import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ModelRuntime } from '@felan-ai/agent-core';
import { digestActiveBranch } from '@felan-ai/ext-memory';
import { LocalMemoryCoordinator, type LocalMemoryCoordinatorOptions } from '../src/memory/coordinator.js';
import { LocalMemoryStore } from '../src/memory/store.js';
import { resolveLocalMemoryProject } from '../src/memory/project.js';
import { acquireLocalMemoryLease } from '../src/memory/lease.js';

const roots: string[] = [];
const coordinators: LocalMemoryCoordinator[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(coordinators.splice(0).map((coordinator) => coordinator.dispose()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'felan-memory-policy-'));
  roots.push(root);
  const cwd = join(root, 'workspace');
  const agentDir = join(root, 'agent');
  await mkdir(cwd);
  await mkdir(agentDir);
  const sessionFile = join(root, 'source.jsonl');
  const entries: Record<string, unknown>[] = [{
    type: 'message', id: 'leaf', parentId: null, timestamp: new Date().toISOString(),
    message: { role: 'user', content: 'Keep memory useful.' },
  }];
  const save = async () => {
    await writeFile(sessionFile, [
      JSON.stringify({ type: 'session', version: 3, id: 'source', cwd }),
      ...entries.map((entry) => JSON.stringify(entry)), '',
    ].join('\n'));
    return { sessionId: 'source', sessionFile, leafId: String(entries.at(-1)!.id), transcriptDigest: digestActiveBranch(entries) };
  };
  const checkpoint = await save();
  const create = (options: Partial<LocalMemoryCoordinatorOptions> = {}) => {
    const coordinator = new LocalMemoryCoordinator({
      agentDir, sessionDir: join(root, 'sessions'), modelRuntime: {} as ModelRuntime,
      recover: false, debounceMs: 60_000, monitorIntervalMs: 60_000,
      dreamRunner: async (input) => input.baseSnapshot,
      ...options,
    });
    coordinators.push(coordinator);
    return coordinator;
  };
  const store = new LocalMemoryStore(agentDir, await resolveLocalMemoryProject(cwd));
  return { root, cwd, agentDir, checkpoint, entries, save, create, store };
}

async function recordAcceptedUpdates(
  f: Awaited<ReturnType<typeof fixture>>,
  count: number,
): Promise<void> {
  await f.store.initialize();
  for (let index = 0; index < count; index += 1) {
    if (index > 0) {
      f.entries.push({
        type: 'message', id: `accepted-${Date.now()}-${index}`, parentId: String(f.entries.at(-1)!.id),
        timestamp: new Date().toISOString(), message: { role: 'user', content: `Accepted update ${index}` },
      });
    }
    await f.store.recordCheckpoint(index === 0 ? f.checkpoint : await f.save());
  }
}

describe('memory retry scheduling', () => {
  it('allows only one cross-process worker for the same project', async () => {
    const f = await fixture();
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const options: Partial<LocalMemoryCoordinatorOptions> = {
      dreamRunner: async (input) => { calls += 1; await gate; return input.baseSnapshot; },
    };
    const first = f.create(options);
    const second = f.create(options);
    await recordAcceptedUpdates(f, 5);
    const running = first.runNow(f.cwd);
    await expect.poll(() => calls).toBe(1);
    await expect(second.runNow(f.cwd)).resolves.toMatchObject({ state: 'processing', pendingCheckpoints: 1 });
    expect(calls).toBe(1);
    release();
    await expect(running).resolves.toMatchObject({ state: 'idle', pendingCheckpoints: 0 });
  });

  it('keeps the persisted publication deadline when another process records a newer checkpoint', async () => {
    const f = await fixture();
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const options: Partial<LocalMemoryCoordinatorOptions> = {
      debounceMs: 60_000,
      monitorIntervalMs: 100,
    };
    const first = f.create(options);
    const second = f.create(options);
    const longTimerCalls = () => setTimeoutSpy.mock.calls
      .filter(([, delay]) => typeof delay === 'number' && delay > 50_000)
      .length;

    await recordAcceptedUpdates(f, 5);
    await first.runNow(f.cwd);
    await recordAcceptedUpdates(f, 5);
    await second.status(f.cwd);
    await expect.poll(longTimerCalls).toBeGreaterThanOrEqual(2);
    await new Promise((resolve) => setTimeout(resolve, 10));

    f.entries.push({
      type: 'message', id: 'new-leaf', parentId: String(f.entries.at(-1)!.id), timestamp: new Date().toISOString(),
      message: { role: 'user', content: 'Newer evidence.' },
    });
    await first.recordCheckpoint(f.cwd, await f.save());
    const beforeSecondRefresh = longTimerCalls();

    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(longTimerCalls()).toBe(beforeSecondRefresh);
    expect(await second.status(f.cwd)).toMatchObject({ state: 'scheduled', pendingCheckpoints: 1 });
  });

  it('defaults the automatic publication interval to 24 hours', async () => {
    const f = await fixture();
    let now = Date.now();
    const intervalMs = 24 * 60 * 60 * 1_000;
    const first = f.create({ debounceMs: undefined, now: () => now });
    await recordAcceptedUpdates(f, 5);
    await first.runNow(f.cwd);
    now = Date.parse(Object.values((await f.store.status()).processed)[0]!.processedAt);
    await first.dispose();

    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    await recordAcceptedUpdates(f, 6);
    const restarted = f.create({ debounceMs: undefined, now: () => now });

    await restarted.status(f.cwd);
    await expect.poll(() => setTimeoutSpy.mock.calls.some(([, delay]) => delay === intervalMs)).toBe(true);
    expect(await restarted.status(f.cwd)).toMatchObject({ state: 'scheduled', pendingCheckpoints: 1 });
  });

  it('waits for the monitor before retrying writer lease contention', async () => {
    const f = await fixture();
    await f.store.initialize();
    const lease = await acquireLocalMemoryLease(f.store.projectDirectory);
    expect(lease).toBeDefined();
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const coordinator = f.create({ debounceMs: 0, monitorIntervalMs: 200 });
    const zeroDelayTimers = () => setTimeoutSpy.mock.calls
      .filter(([, delay]) => delay === 0)
      .length;

    try {
      await recordAcceptedUpdates(f, 5);
      await expect.poll(() => coordinator.status(f.cwd)).toMatchObject({
        state: 'blocked',
        message: 'Another Felan Code process owns the memory writer',
      });
      const attempts = zeroDelayTimers();

      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(zeroDelayTimers()).toBeLessThanOrEqual(attempts + 1);
    } finally {
      await lease!.release();
    }
  });

  it('keeps retry control isolated by project', async () => {
    const f = await fixture();
    const otherCwd = join(f.root, 'other-workspace');
    await mkdir(otherCwd);
    let fail = true;
    const coordinator = f.create({ dreamRunner: async (input) => {
      if (fail) {
        fail = false;
        throw new Error('First project failed');
      }
      return input.baseSnapshot;
    } });
    await recordAcceptedUpdates(f, 5);
    expect(await coordinator.runNow(f.cwd)).toMatchObject({ consecutiveFailures: 1, pendingCheckpoints: 1 });

    const otherSession = join(f.root, 'other.jsonl');
    const entries = [{
      type: 'message', id: 'other-leaf', parentId: null, timestamp: new Date().toISOString(),
      message: { role: 'user', content: 'Other project evidence.' },
    }];
    await writeFile(otherSession, [
      JSON.stringify({ type: 'session', version: 3, id: 'other', cwd: otherCwd }),
      ...entries.map((entry) => JSON.stringify(entry)), '',
    ].join('\n'));
    await coordinator.recordCheckpoint(otherCwd, {
      sessionId: 'other', sessionFile: otherSession, leafId: 'other-leaf', transcriptDigest: digestActiveBranch(entries),
    });
    expect(await coordinator.runNow(otherCwd)).toMatchObject({ consecutiveFailures: 0, pendingCheckpoints: 0, state: 'idle' });
    expect(await coordinator.status(f.cwd)).toMatchObject({ consecutiveFailures: 1, pendingCheckpoints: 1 });
  });

  it('keeps retry state durable across explicit runs and new checkpoints', async () => {
    const f = await fixture();
    let now = Date.now();
    let calls = 0;
    const coordinator = f.create({ now: () => now, dreamRunner: async () => { calls += 1; throw new Error('Provider failed'); } });
    await recordAcceptedUpdates(f, 5);
    const first = await coordinator.runNow(f.cwd);
    expect(first).toMatchObject({ consecutiveFailures: 1, state: 'scheduled' });
    expect(Date.parse(first.nextRetryAt!)).toBe(now + 60_000);
    now += 59_999;
    f.entries.push({ type: 'message', id: 'new-leaf', parentId: String(f.entries.at(-1)!.id), message: { role: 'user', content: 'New evidence.' } });
    await coordinator.recordCheckpoint(f.cwd, await f.save());
    expect((await coordinator.runNow(f.cwd)).consecutiveFailures).toBe(2);
    expect(calls).toBe(2);
    const second = await coordinator.runNow(f.cwd);
    expect(second.consecutiveFailures).toBe(3);
    expect(second.autoDisabled).toBeDefined();
    now += 300_000;
    expect(await coordinator.runNow(f.cwd)).toMatchObject({ state: 'disabled', enabled: false, consecutiveFailures: 3 });
    expect(calls).toBe(3);
  });

  it('does not stretch retries to the automatic idle delay', async () => {
    const f = await fixture();
    let calls = 0;
    const coordinator = f.create({
      debounceMs: 60_000,
      monitorIntervalMs: 60_000,
      retryDelaysMs: [200, 400],
      dreamRunner: async (input) => {
        calls += 1;
        if (calls === 1) throw new Error('Provider failed');
        return input.baseSnapshot;
      },
    });
    await recordAcceptedUpdates(f, 5);

    expect(await coordinator.runNow(f.cwd)).toMatchObject({ consecutiveFailures: 1 });
    expect(await coordinator.runNow(f.cwd)).toMatchObject({ state: 'idle', consecutiveFailures: 0, pendingCheckpoints: 0 });
    expect(calls).toBe(2);
  });

  it('allows an explicit run to bypass retry backoff without resetting failures', async () => {
    const f = await fixture();
    let calls = 0;
    const coordinator = f.create({
      retryDelaysMs: [60_000, 300_000],
      dreamRunner: async (input) => {
        calls += 1;
        if (calls === 1) throw new Error('Provider failed');
        return input.baseSnapshot;
      },
    });
    await recordAcceptedUpdates(f, 5);

    await expect(coordinator.runNow(f.cwd)).resolves.toMatchObject({ consecutiveFailures: 1, pendingCheckpoints: 1 });
    await expect(coordinator.runNow(f.cwd)).resolves.toMatchObject({ state: 'idle', consecutiveFailures: 0, pendingCheckpoints: 0 });
    expect(calls).toBe(2);
  });

  it('resets persisted failures after a successful publication', async () => {
    const f = await fixture();
    let now = Date.now();
    let fail = true;
    const coordinator = f.create({
      now: () => now,
      dreamRunner: async (input) => {
        if (fail) throw new Error('Provider failed');
        return input.baseSnapshot;
      },
    });
    await coordinator.recordCheckpoint(f.cwd, f.checkpoint);
    expect(await coordinator.runNow(f.cwd)).toMatchObject({ consecutiveFailures: 1, pendingCheckpoints: 1 });
    now += 60_000;
    fail = false;
    expect(await coordinator.runNow(f.cwd)).toMatchObject({ consecutiveFailures: 0, pendingCheckpoints: 0, state: 'idle' });
    expect((await f.store.readControl()).nextRetryAt).toBeUndefined();
  });

  it('shares an automatic three-attempt ceiling, survives restart, and recovers explicitly', async () => {
    const f = await fixture();
    let calls = 0;
    let fail = true;
    const options: Partial<LocalMemoryCoordinatorOptions> = {
      debounceMs: 1, monitorIntervalMs: 5, retryDelaysMs: [10, 20],
      dreamRunner: async (input) => { calls += 1; if (fail) throw new Error('Provider failed'); return input.baseSnapshot; },
    };
    const first = f.create(options);
    const second = f.create(options);
    await recordAcceptedUpdates(f, 5);
    await second.status(f.cwd);
    await expect.poll(() => first.status(f.cwd), { timeout: 3_000, interval: 10 }).toMatchObject({
      state: 'disabled', consecutiveFailures: 3, pendingCheckpoints: 1,
    });
    expect(calls).toBe(3);
    await second.runNow(f.cwd);
    second.setEnabled(false);
    second.setEnabled(true);
    expect((await second.status(f.cwd)).state).toBe('disabled');
    await first.dispose();
    await second.dispose();
    const restarted = f.create(options);
    expect((await restarted.runNow(f.cwd)).state).toBe('disabled');
    expect(calls).toBe(3);
    const disabledRun = (await f.store.readControl()).lastDisabledRunId;
    fail = false;
    expect(await restarted.retryProject(f.cwd)).toMatchObject({ state: 'idle', consecutiveFailures: 0, pendingCheckpoints: 0 });
    expect(calls).toBe(4);
    expect((await f.store.readControl()).lastDisabledRunId).toBe(disabledRun);
  });

  it('cancels active work when another process resets the project generation', async () => {
    const f = await fixture();
    let started = false;
    let aborted = false;
    const first = f.create({ monitorIntervalMs: 5, dreamRunner: async (input) => {
      started = true;
      await new Promise<void>((resolve) => input.signal.addEventListener('abort', () => { aborted = true; resolve(); }, { once: true }));
      return input.baseSnapshot;
    } });
    let replacementCalls = 0;
    const second = f.create({ monitorIntervalMs: 5, dreamRunner: async (input) => {
      replacementCalls += 1;
      return input.baseSnapshot;
    } });
    await recordAcceptedUpdates(f, 5);
    const running = first.runNow(f.cwd);
    await expect.poll(() => started).toBe(true);
    await second.retryProject(f.cwd);
    const callsBeforeRelease = replacementCalls;
    await running;

    expect(aborted).toBe(true);
    expect(callsBeforeRelease).toBeLessThanOrEqual(1);
    expect(await second.status(f.cwd)).toMatchObject({ consecutiveFailures: 0 });
    expect((await second.status(f.cwd)).pendingCheckpoints).toBeLessThanOrEqual(1);
  });

  it('rechecks local eligibility after project context initialization before retry reset', async () => {
    const f = await fixture();
    const initialize = LocalMemoryStore.prototype.initialize;
    let entered = false;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(LocalMemoryStore.prototype, 'initialize').mockImplementationOnce(async function (...args) {
      entered = true;
      await gate;
      return initialize.apply(this, args);
    });
    const reset = vi.spyOn(LocalMemoryStore.prototype, 'resetProjectControl');
    const coordinator = f.create();
    const retry = coordinator.retryProject(f.cwd);
    await expect.poll(() => entered).toBe(true);
    coordinator.setEnabled(false);
    release();

    expect(await retry).toMatchObject({ state: 'disabled' });
    expect(reset).not.toHaveBeenCalled();
  });

  it('rolls back a breaker reset when local processing is disabled while reset waits', async () => {
    const f = await fixture();
    const coordinator = f.create({
      retryDelaysMs: [0, 0],
      dreamRunner: async () => { throw new Error('fixture failure'); },
    });
    await recordAcceptedUpdates(f, 5);
    await coordinator.runNow(f.cwd);
    await coordinator.runNow(f.cwd);
    await coordinator.runNow(f.cwd);
    const before = await f.store.readControl();
    expect(before).toMatchObject({ consecutiveFailures: 3, autoDisabled: { runId: expect.any(String) } });
    const readControl = LocalMemoryStore.prototype.readControl;
    let entered = false;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(LocalMemoryStore.prototype, 'readControl').mockImplementation(async function () {
      const control = await readControl.call(this);
      if (!entered && control.autoDisabled) {
        entered = true;
        await gate;
      }
      return control;
    });

    const retry = coordinator.retryProject(f.cwd);
    await expect.poll(() => entered).toBe(true);
    coordinator.setEnabled(false);
    release();

    await expect(retry).rejects.toThrow('Memory retry was cancelled');
    expect(await f.store.readControl()).toEqual(before);
  });

  it('keeps recall available but processing blocked when control metadata is corrupt', async () => {
    const f = await fixture();
    await f.store.initialize();
    await writeFile(f.store.controlPath, '{invalid');
    let calls = 0;
    const coordinator = f.create({ dreamRunner: async () => { calls += 1; } });
    await expect(coordinator.readCurrent(f.cwd, join(f.root, 'projection'))).resolves.toMatchObject({ files: expect.any(Array) });
    expect((await coordinator.runNow(f.cwd)).state).toBe('error');
    expect(calls).toBe(0);
    expect(await readFile(f.store.controlPath, 'utf8')).toBe('{invalid');
  });

  it('retries initialization after another writer releases recovery ownership', async () => {
    const f = await fixture();
    const lease = await acquireLocalMemoryLease(f.store.projectDirectory);
    expect(lease).toBeDefined();
    const coordinator = f.create({ monitorIntervalMs: 5 });
    expect(await coordinator.status(f.cwd)).toMatchObject({ state: 'error', message: 'Local memory storage is unavailable' });

    await lease!.release();
    await expect.poll(() => coordinator.status(f.cwd)).toMatchObject({ state: 'idle', pendingCheckpoints: 0 });
    await expect(f.store.readCurrent()).resolves.toMatchObject({ fingerprint: expect.any(String) });
  });
});
