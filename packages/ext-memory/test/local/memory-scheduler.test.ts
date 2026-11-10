import { LocalMemoryStore as Store } from '../../src/local/store.js';
import type { LocalMemoryCoordinator } from './backend.js';
import { beforeEach as beforeMemoryTest } from "vitest";
import { createMemoryBackend } from './backend.js';
import type { LocalMemoryStore } from './backend.js';
let { LocalMemoryCoordinator, LocalMemoryStore, resolveLocalMemoryProject, acquireLocalMemoryLease } = createMemoryBackend();
beforeMemoryTest(() => { ({ LocalMemoryCoordinator, LocalMemoryStore, resolveLocalMemoryProject, acquireLocalMemoryLease } = createMemoryBackend()); });
import { access, mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { digestActiveBranch } from '@felan-ai/ext-memory';

import type { LocalMemoryCoordinatorOptions } from '../../src/local/coordinator.js';
import type { LocalMemoryDreamInput } from '../../src/local/dreamer.js';







const roots: string[] = [];
const coordinators: LocalMemoryCoordinator[] = [];
const releases: Array<() => void> = [];
const pendingWork: Array<Promise<PromiseSettledResult<unknown>[]>> = [];
afterEach(async () => {
  const results = await Promise.allSettled([drainMemoryFixtures()]);
  vi.restoreAllMocks();
  results.push(...await Promise.allSettled(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));
  throwCleanupFailures(results);
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
  const create = (options: Partial<Omit<LocalMemoryCoordinatorOptions, 'debounceMs'>> & { debounceMs?: number | undefined } = {}) => {
    const coordinator = new LocalMemoryCoordinator({
      agentDir, sessionDir: join(root, 'sessions'), models: {} as unknown as import('@felan-ai/agent-core').ModelsService,
      recover: false,
      ...(Object.hasOwn(options, 'debounceMs') ? options.debounceMs === undefined ? {} : { debounceMs: options.debounceMs } : { debounceMs: 60_000 }),
      dreamRunner: async (input) => input.baseSnapshot,
      ...Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined)),
    });
    const dispose = coordinator.dispose.bind(coordinator);
    let disposing: Promise<void> | undefined;
    coordinator.dispose = () => disposing ??= dispose();
    coordinators.push(coordinator);
    return coordinator;
  };
  const store = new LocalMemoryStore(agentDir, await resolveLocalMemoryProject(cwd));
  return { root, cwd, agentDir, checkpoint, entries, save, create, store };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => { resolve = settle; });
  return { promise, resolve };
}

function cleanupGate() {
  const gate = deferred();
  releases.push(gate.resolve);
  return { gate: gate.promise, release: gate.resolve };
}

function trackWork<T>(work: Promise<T>, expectedError?: string): Promise<T> {
  pendingWork.push(Promise.allSettled([
    expectedError === undefined ? work : expect(work).rejects.toThrow(expectedError),
  ]));
  return work;
}

async function drainMemoryFixtures(): Promise<void> {
  const results: PromiseSettledResult<unknown>[] = [];
  while (coordinators.length > 0 || pendingWork.length > 0 || releases.length > 0) {
    const disposing = coordinators.splice(0).map(async (coordinator) => coordinator.dispose());
    for (const release of releases.splice(0)) release();
    results.push(...await Promise.allSettled(disposing));
    results.push(...(await Promise.all(pendingWork.splice(0))).flat());
  }
  throwCleanupFailures(results);
}

function throwCleanupFailures(results: readonly PromiseSettledResult<unknown>[]): void {
  const errors = results.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
  if (errors.length > 0) throw new AggregateError(errors, 'Memory scheduler fixture cleanup failed');
}

async function waitForMilestone(milestone: Promise<void>, work: Promise<unknown>): Promise<void> {
  await Promise.race([
    milestone,
    work.then(() => { throw new Error('Memory work settled before its fixture milestone'); }),
  ]);
}

function waitForMemoryAbort(signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
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
    const { gate, release } = cleanupGate();
    const started = deferred();
    const options: Partial<LocalMemoryCoordinatorOptions> = {
      dreamRunner: async (input) => { calls += 1; started.resolve(); await gate; return input.baseSnapshot; },
    };
    const first = f.create(options);
    const second = f.create(options);
    await recordAcceptedUpdates(f, 5);
    const running = trackWork(first.runNow(f.cwd));
    await waitForMilestone(started.promise, running);
    expect(calls).toBe(1);
    await expect(second.runNow(f.cwd)).resolves.toMatchObject({ state: 'processing', pendingCheckpoints: 1 });
    expect(calls).toBe(1);
    release();
    await expect(running).resolves.toMatchObject({ state: 'idle', pendingCheckpoints: 0 });
  });

  it('derives the persisted publication deadline when a separate process next checks status', async () => {
    const f = await fixture();
    let now = Date.now();
    const options: Partial<LocalMemoryCoordinatorOptions> = {
      debounceMs: 60_000,
      now: () => now,
    };
    const first = f.create(options);
    const second = f.create(options);

    await recordAcceptedUpdates(f, 5);
    await first.runNow(f.cwd);
    const publishedAt = Date.parse(Object.values((await f.store.status()).processed)[0]!.processedAt);
    now = publishedAt + 1_000;
    await second.status(f.cwd);

    await recordAcceptedUpdates(f, 5);
    await expect.poll(() => first.status(f.cwd), { timeout: 10_000 }).toMatchObject({ state: 'scheduled', pendingCheckpoints: 1 });
    await expect.poll(() => second.status(f.cwd), { timeout: 10_000 }).toMatchObject({ state: 'scheduled', pendingCheckpoints: 1 });

    f.entries.push({
      type: 'message', id: 'new-leaf', parentId: String(f.entries.at(-1)!.id), timestamp: new Date().toISOString(),
      message: { role: 'user', content: 'Newer evidence.' },
    });
    await first.recordCheckpoint(f.cwd, await f.save());
    expect(await second.status(f.cwd)).toMatchObject({ state: 'scheduled', pendingCheckpoints: 1 });
    await expect.poll(() => first.hasActiveWork() || second.hasActiveWork(), { timeout: 10_000 }).toBe(false);
  }, 30_000);

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

  it('retries writer lease contention on its targeted timer and processes pending evidence after release', async () => {
    const f = await fixture();
    await f.store.initialize();
    const lease = await acquireLocalMemoryLease(f.store.projectDirectory);
    expect(lease).toBeDefined();
    let calls = 0;
    const writerRetryMs = 100;
    const coordinator = f.create({ debounceMs: 0, writerRetryMs, dreamRunner: async (input) => {
      calls += 1;
      return input.baseSnapshot;
    } });
    try {
      await recordAcceptedUpdates(f, 5);
      await expect(coordinator.runNow(f.cwd)).resolves.toMatchObject({
        state: 'blocked',
        message: 'Another Felan Code process owns the memory writer',
      });
      expect(calls).toBe(0);
      await lease!.release();
      await expect.poll(() => f.store.readControl(), { timeout: 10_000 })
        .toMatchObject({ consecutiveFailures: 0, lastOutcome: { status: 'success' } });
      expect(await f.store.status()).toMatchObject({ pending: {}, processed: { source: { checkpoint: expect.any(Object) } } });
      expect(calls).toBe(1);
    } finally {
      await lease!.release();
    }
  }, 30_000);

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

  it('retries automatically at the persisted backoff deadline instead of the publication interval', async () => {
    const f = await fixture();
    let calls = 0;
    const coordinator = f.create({
      debounceMs: 60_000,
      retryDelaysMs: [200, 400],
      dreamRunner: async (input) => {
        calls += 1;
        if (calls === 1) throw new Error('Provider failed');
        return input.baseSnapshot;
      },
    });
    await recordAcceptedUpdates(f, 5);

    expect(await coordinator.runNow(f.cwd)).toMatchObject({ consecutiveFailures: 1 });
    await expect.poll(() => f.store.readControl(), { timeout: 10_000, interval: 10 }).toMatchObject({
      consecutiveFailures: 0, lastOutcome: { status: 'success' },
    });
    expect(await f.store.status()).toMatchObject({ pending: {}, processed: { source: { checkpoint: expect.any(Object) } } });
    expect(calls).toBe(2);
  }, 30_000);

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

  it('shares an automatic three-attempt ceiling across attachments, survives restart, and recovers explicitly', async () => {
    const f = await fixture();
    let calls = 0;
    let fail = true;
    const options: Partial<LocalMemoryCoordinatorOptions> = {
      debounceMs: 1, retryDelaysMs: [10, 20],
      dreamRunner: async (input) => { calls += 1; if (fail) throw new Error('Provider failed'); return input.baseSnapshot; },
    };
    const first = f.create(options);
    const second = first.attachSession();
    await recordAcceptedUpdates(f, 5);
    await second.status(f.cwd);
    await expect.poll(() => f.store.readControl(), { timeout: 10_000, interval: 10 }).toMatchObject({
      consecutiveFailures: 3, autoDisabled: { runId: expect.any(String) },
    });
    expect(await first.status(f.cwd)).toMatchObject({ state: 'disabled', pendingCheckpoints: 1 });
    expect(calls).toBe(3);
    await second.runNow(f.cwd);
    first.setEnabled(false);
    first.setEnabled(true);
    expect((await second.status(f.cwd)).state).toBe('disabled');
    await first.dispose();
    const restarted = f.create(options);
    expect((await restarted.runNow(f.cwd)).state).toBe('disabled');
    expect(calls).toBe(3);
    const disabledRun = (await f.store.readControl()).lastDisabledRunId;
    fail = false;
    expect(await restarted.retryProject(f.cwd)).toMatchObject({ state: 'idle', consecutiveFailures: 0, pendingCheckpoints: 0 });
    expect(calls).toBe(4);
    expect((await f.store.readControl()).lastDisabledRunId).toBe(disabledRun);
  }, 30_000);

  it('cancels active work immediately when another attachment resets the project generation', async () => {
    const f = await fixture();
    const started = deferred();
    const aborted = deferred();
    let signal: AbortSignal | undefined;
    let calls = 0;
    const first = f.create({ dreamRunner: async (input) => {
      calls += 1;
      if (calls === 1) {
        signal = input.signal;
        const cancellation = waitForMemoryAbort(input.signal);
        started.resolve();
        await cancellation;
        aborted.resolve();
      }
      return input.baseSnapshot;
    } });
    const second = first.attachSession();
    await first.recordCheckpoint(f.cwd, f.checkpoint);
    const running = trackWork(first.runNow(f.cwd));
    await waitForMilestone(started.promise, running);
    const generation = (await f.store.readControl()).generation;
    const retrying = trackWork(second.retryProject(f.cwd));
    await waitForMilestone(aborted.promise, retrying);
    expect(signal?.aborted).toBe(true);
    await expect(retrying).resolves.toMatchObject({ state: 'idle', consecutiveFailures: 0, pendingCheckpoints: 0 });
    await running;

    expect(calls).toBe(2);
    expect(await f.store.readControl()).toMatchObject({ generation: generation + 1, consecutiveFailures: 0, lastOutcome: { status: 'success' } });
  });

  it('fences publication without consuming a failure when a separate process resets an active attempt', async () => {
    const f = await fixture();
    const started = deferred();
    const { gate, release } = cleanupGate();
    let signal: AbortSignal | undefined;
    const first = f.create({ dreamRunner: async (input) => {
      signal = input.signal;
      started.resolve();
      await gate;
      return input.baseSnapshot;
    } });
    const second = f.create();
    const commit = vi.spyOn(Store.prototype, 'commit');
    await first.recordCheckpoint(f.cwd, f.checkpoint);
    const before = await f.store.status();
    const running = trackWork(first.runNow(f.cwd));
    await waitForMilestone(started.promise, running);
    const generation = (await f.store.readControl()).generation;

    await expect(second.retryProject(f.cwd)).resolves.toMatchObject({ state: 'blocked', consecutiveFailures: 0, pendingCheckpoints: 1 });
    const resetControl = await f.store.readControl();
    expect(resetControl).toMatchObject({ generation: generation + 1, consecutiveFailures: 0 });
    expect(resetControl.activeAttempt).toBeUndefined();
    expect(signal?.aborted).toBe(false);
    release();
    await expect(running).resolves.toMatchObject({ state: 'error', consecutiveFailures: 0, pendingCheckpoints: 1 });

    expect(signal?.aborted).toBe(false);
    expect(commit).toHaveBeenCalledOnce();
    await expect(commit.mock.results[0]!.value).rejects.toThrow('Memory publication is disabled or the attempt was fenced');
    expect(await f.store.status()).toEqual(before);
    expect(await f.store.readControl()).toEqual(resetControl);
    await expect(second.runNow(f.cwd)).resolves.toMatchObject({ state: 'idle', consecutiveFailures: 0, pendingCheckpoints: 0 });
  });

  it('cancels a queued automatic worker when shutdown precedes runner entry', async () => {
    const f = await fixture();
    const { gate, release } = cleanupGate();
    const persisted = deferred();
    const beginAttempt = Store.prototype.beginAttempt;
    let automaticAttempt = false;
    vi.spyOn(Store.prototype, 'beginAttempt').mockImplementation(async function (this: import('../../src/local/store.js').LocalMemoryStore, ...args) {
      const attempt = await beginAttempt.apply(this, args);
      automaticAttempt = args[1].bypassRetryAt === undefined && attempt !== undefined;
      persisted.resolve();
      await gate;
      return attempt;
    });
    let abortedAtEntry: boolean | undefined;
    let completed = false;
    const worker = vi.fn(async (input: LocalMemoryDreamInput) => {
      abortedAtEntry = input.signal.aborted;
      await waitForMemoryAbort(input.signal);
      completed = true;
      return input.baseSnapshot;
    });
    const coordinator = f.create({ dreamRunner: worker });
    await recordAcceptedUpdates(f, 5);
    const before = await f.store.status();
    await coordinator.status(f.cwd);
    await persisted.promise;
    const disposing = coordinator.dispose();
    release();
    await disposing;

    expect(automaticAttempt).toBe(true);
    expect(abortedAtEntry).toBe(true);
    expect(worker).toHaveBeenCalledOnce();
    await expect(worker.mock.results[0]!.value).rejects.toThrow('Memory processing was cancelled during shutdown');
    expect(completed).toBe(false);
    expect(await f.store.status()).toEqual(before);
    const control = await f.store.readControl();
    expect(control).toMatchObject({ consecutiveFailures: 0, lastOutcome: { status: 'cancelled' } });
    expect(control.activeAttempt).toBeUndefined();
    const directory = join(f.store.projectDirectory, 'runs', control.lastOutcome!.runId);
    expect(JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'))).toMatchObject({ status: 'cancelled' });
    await expect(access(join(directory, 'workspace'))).rejects.toMatchObject({ code: 'ENOENT' });
    const lease = await acquireLocalMemoryLease(f.store.projectDirectory);
    try {
      expect(lease).toBeDefined();
    } finally {
      await lease?.release();
    }
  });

  it('rechecks local eligibility after project context initialization before retry reset', async () => {
    const f = await fixture();
    const initialize = Store.prototype.initialize;
    const entered = deferred();
    const { gate, release } = cleanupGate();
    vi.spyOn(Store.prototype, 'initialize').mockImplementationOnce(async function (this: import('../../src/local/store.js').LocalMemoryStore, ...args) {
      entered.resolve();
      await gate;
      return initialize.apply(this, args);
    });
    const reset = vi.spyOn(Store.prototype, 'resetProjectControl');
    const coordinator = f.create();
    const retry = trackWork(coordinator.retryProject(f.cwd));
    await waitForMilestone(entered.promise, retry);
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
    const readControl = Store.prototype.readControl;
    let entered = false;
    const waiting = deferred();
    const { gate, release } = cleanupGate();
    vi.spyOn(Store.prototype, 'readControl').mockImplementation(async function (this: import('../../src/local/store.js').LocalMemoryStore) {
      const control = await readControl.call(this);
      if (!entered && control.autoDisabled) {
        entered = true;
        waiting.resolve();
        await gate;
      }
      return control;
    });

    const retry = trackWork(coordinator.retryProject(f.cwd), 'Memory retry was cancelled');
    await waitForMilestone(waiting.promise, retry);
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

  it('retries initialization on the next attachment call after another writer releases ownership', async () => {
    const f = await fixture();
    const lease = await acquireLocalMemoryLease(f.store.projectDirectory);
    expect(lease).toBeDefined();
    const initialize = vi.spyOn(Store.prototype, 'initialize');
    const coordinator = f.create();
    expect(await coordinator.status(f.cwd)).toMatchObject({ state: 'error', message: 'Local memory storage is unavailable' });
    expect(initialize).toHaveBeenCalledOnce();

    await lease!.release();
    expect(await coordinator.status(f.cwd)).toMatchObject({ state: 'idle', pendingCheckpoints: 0 });
    expect(initialize).toHaveBeenCalledTimes(2);
    await expect(f.store.readCurrent()).resolves.toMatchObject({ fingerprint: expect.any(String) });
  });
});
