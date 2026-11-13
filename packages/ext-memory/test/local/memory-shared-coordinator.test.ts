import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HostAgentRuntime, SessionManager, type Api, type Model, type ModelsService, type SessionsService } from '@felan-ai/agent-core';
import { createSessionCheckpoint, digestActiveBranch, type SessionCheckpoint } from '../../src/index.js';
import type { LocalMemoryCoordinatorOptions } from '../../src/local/coordinator.js';
import type { LocalMemoryDreamInput } from '../../src/local/dreamer.js';
import * as leases from '../../src/local/lease.js';
import { acquireSharedLocalMemoryCoordinator } from '../../src/local/shared.js';
import { createMemoryBackend } from './backend.js';

const roots: string[] = [];
const cleanups: Array<() => Promise<void>> = [];
const releases: Array<() => void> = [];
const pendingWork: Array<Promise<PromiseSettledResult<unknown>[]>> = [];
const acquireLease = leases.acquireLocalMemoryLease;

afterEach(async () => {
  for (const release of releases.splice(0)) release();
  const results: PromiseSettledResult<unknown>[] = await Promise.allSettled(cleanups.splice(0).map(cleanup => cleanup()));
  results.push(...(await Promise.all(pendingWork.splice(0))).flat());
  vi.restoreAllMocks();
  results.push(...await Promise.allSettled(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))));
  const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
  if (errors.length) throw new AggregateError(errors, 'Shared memory fixture cleanup failed');
});

describe('shared local memory coordinator', () => {
  it('keys the registry by resolved directories and disposes only after the last idempotent release', async () => {
    const root = await temporaryDirectory();
    const agentDir = join(root, 'agent');
    const first = acquire({ agentDir });
    const second = acquire({ agentDir: join(agentDir, 'unused', '..'), sessionDir: join(agentDir, 'sessions', '.') });
    const otherAgent = acquire({ agentDir: join(root, 'other-agent') });
    const otherSessions = acquire({ agentDir, sessionDir: join(root, 'other-sessions') });
    expect(second.coordinator).toBe(first.coordinator);
    expect(otherAgent.coordinator).not.toBe(first.coordinator);
    expect(otherSessions.coordinator).not.toBe(first.coordinator);

    const dispose = first.coordinator.dispose.bind(first.coordinator);
    const disposed = vi.spyOn(first.coordinator, 'dispose');
    const releasingFirst = first.release();
    expect(first.release()).toBe(releasingFirst);
    await releasingFirst;
    expect(disposed).not.toHaveBeenCalled();
    const environment = sessionEnvironment(root, 'registry');
    expect(() => second.coordinator.attach({ environment, models: {} as ModelsService, scheduling: false })).not.toThrow();

    const gate = deferred();
    disposed.mockImplementationOnce(async () => { await gate.promise; await dispose(); });
    const releasingLast = second.release();
    expect(second.release()).toBe(releasingLast);
    expect(disposed).toHaveBeenCalledOnce();
    const replacement = acquire({ agentDir });
    expect(replacement.coordinator).not.toBe(first.coordinator);
    gate.resolve();
    await releasingLast;
    expect(() => first.coordinator.attach({ environment, models: {} as ModelsService, scheduling: false }))
      .toThrow('Local memory coordinator is closed');
    expect(() => replacement.coordinator.attach({ environment, models: {} as ModelsService, scheduling: false })).not.toThrow();
  });

  it('shares checkpoint status and schedules accepted updates through attachment events without polling', async () => {
    const interval = vi.spyOn(globalThis, 'setInterval');
    const entered = deferred();
    const gate = deferred();
    const dreamRunner = vi.fn(async (input: LocalMemoryDreamInput) => {
      entered.resolve();
      await gate.promise;
      return input.baseSnapshot;
    });
    const f = await fixture({ dreamRunner });
    const first = f.coordinator.attachSession();
    const second = f.coordinator.attachSession();
    await second.status(f.cwd);
    const changed = vi.fn();
    second.subscribeStatusChanges(changed);

    await f.record(first, 1);
    expect(changed).toHaveBeenCalledOnce();
    expect(await second.status(f.cwd)).toMatchObject({ pendingCheckpoints: 1, state: 'idle' });
    await f.record(first, 4);
    await entered.promise;
    expect(dreamRunner).toHaveBeenCalledOnce();
    expect(interval).not.toHaveBeenCalled();
    expect(await second.status(f.cwd)).toMatchObject({ pendingCheckpoints: 1, state: 'processing' });
    gate.resolve();
    await f.coordinator.drain();
    expect(await second.status(f.cwd)).toMatchObject({ pendingCheckpoints: 0, state: 'idle' });
    expect(changed.mock.calls.length).toBeGreaterThanOrEqual(7);
    expect(interval).not.toHaveBeenCalled();
  });

  it('pins the requesting driver environment and models, then preserves evidence on force settlement', async () => {
    const entered = deferred();
    const inputs: LocalMemoryDreamInput[] = [];
    const f = await fixture({ dreamRunner: async input => {
      inputs.push(input);
      if (inputs.length === 1) {
        const cancelled = waitForMemoryAbort(input.signal);
        entered.resolve();
        await cancelled;
      }
      return input.baseSnapshot;
    } });
    const environmentA = sessionEnvironment(f.cwd, 'driver-a');
    const environmentB = sessionEnvironment(f.cwd, 'driver-b');
    const writesA = vi.spyOn(environmentA.runtime, 'writeFile');
    const writesB = vi.spyOn(environmentB.runtime, 'writeFile');
    const modelsA = { getAvailable: vi.fn() } as unknown as ModelsService;
    const modelsB = { getAvailable: vi.fn() } as unknown as ModelsService;
    const selectedA = { provider: 'openai-codex', id: 'model-a' } as Model<Api>;
    const selectedB = { provider: 'openai-codex', id: 'model-b' } as Model<Api>;
    const classifierA = { classify: async () => ({ answers: {} }) };
    const first = f.coordinator.attach({ environment: environmentA, models: modelsA, scheduling: true,
      selectedModel: selectedA, scopedModels: [selectedA], classifier: classifierA });
    const second = f.coordinator.attach({ environment: environmentB, models: modelsB, scheduling: true,
      selectedModel: selectedB, scopedModels: [selectedB] });
    await second.status(f.cwd);
    await f.record(first, 1);
    const running = trackWork(first.runNow(f.cwd));
    await waitForMilestone(entered.promise, running);

    expect(first.busy()).toBe(true);
    expect(second.busy()).toBe(false);
    expect(inputs[0]).toMatchObject({ models: modelsA, selectedModel: selectedA, scopedModels: [selectedA], classifier: classifierA });
    expect(environmentA.sessions.history).toHaveBeenCalled();
    expect(environmentB.sessions.history).not.toHaveBeenCalled();
    expect(writesA.mock.calls.some(([path]) => path.endsWith(join('.dreaming', 'input', 'manifest.json')))).toBe(true);
    expect(writesB.mock.calls.some(([path]) => path.endsWith(join('.dreaming', 'input', 'manifest.json')))).toBe(false);

    await first.settle('force');
    await running;
    expect(inputs[0]!.signal.aborted).toBe(true);
    expect(first.busy()).toBe(false);
    expect(await second.status(f.cwd)).toMatchObject({ pendingCheckpoints: 1, consecutiveFailures: 0 });
    expect(await f.store.readControl()).toMatchObject({ lastOutcome: { status: 'cancelled' }, consecutiveFailures: 0 });
    await expect(second.runNow(f.cwd)).resolves.toMatchObject({ pendingCheckpoints: 0, consecutiveFailures: 0 });
    expect(inputs).toHaveLength(2);
    expect(inputs[1]!.models).toBe(modelsB);
    expect(inputs[1]!.selectedModel).toBe(selectedB);
    expect(inputs[1]!.scopedModels).toEqual([selectedB]);
    expect(inputs[1]!.classifier).toBeUndefined();
    expect(environmentB.sessions.history).toHaveBeenCalled();
    expect(writesB.mock.calls.some(([path]) => path.endsWith(join('.dreaming', 'input', 'manifest.json')))).toBe(true);
  });

  it('drains only the attached driver without aborting its accepted run or driving new work', async () => {
    const entered = deferred();
    const gate = deferred();
    const inputs: LocalMemoryDreamInput[] = [];
    const f = await fixture({ dreamRunner: async input => {
      inputs.push(input);
      entered.resolve();
      await gate.promise;
      return input.baseSnapshot;
    } });
    const first = f.coordinator.attachSession();
    const second = f.coordinator.attachSession();
    await second.status(f.cwd);
    await f.record(first, 1);
    const running = trackWork(first.runNow(f.cwd));
    await waitForMilestone(entered.promise, running);
    let settled = false;
    const settling = trackWork(first.settle('drain').then(() => { settled = true; }));
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(first.busy()).toBe(true);
    expect(second.busy()).toBe(false);
    expect(inputs[0]!.signal.aborted).toBe(false);
    gate.resolve();
    await settling;
    await running;
    expect(inputs[0]!.signal.aborted).toBe(false);
    expect(first.busy()).toBe(false);
    await f.record(first, 1);
    await expect(first.runNow(f.cwd)).resolves.toMatchObject({ pendingCheckpoints: 1 });
    expect(inputs).toHaveLength(1);
    await expect(second.runNow(f.cwd)).resolves.toMatchObject({ pendingCheckpoints: 0 });
    expect(inputs).toHaveLength(2);
  });

  it('uses the caller runtime after a newer reader runtime is sealed', async () => {
    const dreamRunner = vi.fn(async (input: LocalMemoryDreamInput) => input.baseSnapshot);
    const f = await fixture({ dreamRunner });
    const environmentA = sealableEnvironment(f.cwd, 'writer');
    const environmentC = sealableEnvironment(f.cwd, 'reader');
    const writer = f.coordinator.attach({ environment: environmentA, models: {} as ModelsService, scheduling: true });
    const reader = f.coordinator.attach({ environment: environmentC, models: {} as ModelsService, scheduling: false });
    await writer.status(f.cwd);
    await reader.readCurrent(f.cwd, join(f.root, 'reader-projection'));
    environmentC.seal();

    await f.record(writer, 1);
    await expect(writer.status(f.cwd)).resolves.toMatchObject({ state: 'idle', pendingCheckpoints: 1 });
    await expect(writer.readCurrent(f.cwd, join(f.root, 'writer-projection'))).resolves.toMatchObject({ files: expect.any(Array) });
    await expect(writer.canonicalDirectory(f.cwd)).resolves.toBe(f.store.currentDirectory);
    await expect(writer.runNow(f.cwd)).resolves.toMatchObject({ state: 'idle', pendingCheckpoints: 0 });
    await expect(writer.retryProject(f.cwd)).resolves.toMatchObject({ state: 'idle', consecutiveFailures: 0 });
    expect(dreamRunner).toHaveBeenCalledOnce();
    expect(environmentC.rejectedCalls).not.toHaveBeenCalled();
  });

  it('cancels a sealed closing driver through a live scheduling member without holding the writer lease', async () => {
    const entered = deferred();
    const inputs: LocalMemoryDreamInput[] = [];
    const f = await fixture({ writerRetryMs: 25, dreamRunner: async input => {
      inputs.push(input);
      if (inputs.length === 1) {
        const cancelled = waitForMemoryAbort(input.signal);
        entered.resolve();
        await cancelled;
      }
      return input.baseSnapshot;
    } });
    const environmentA = sealableEnvironment(f.cwd, 'driver-a');
    const environmentB = sealableEnvironment(f.cwd, 'driver-b');
    const environmentC = sealableEnvironment(f.cwd, 'reader-c');
    const first = f.coordinator.attach({ environment: environmentA, models: {} as ModelsService, scheduling: true });
    const second = f.coordinator.attach({ environment: environmentB, models: {} as ModelsService, scheduling: true });
    const reader = f.coordinator.attach({ environment: environmentC, models: {} as ModelsService, scheduling: false });
    await second.status(f.cwd);
    await reader.readCurrent(f.cwd, join(f.root, 'reader-projection'));
    environmentC.seal();
    await f.record(first, 1);
    const running = trackWork(first.runNow(f.cwd).catch(error => error));
    await waitForMilestone(entered.promise, running);

    environmentA.seal();
    await environmentA.withCleanup(() => first.settle('force'));
    await running;
    expect(await second.status(f.cwd)).toMatchObject({ state: 'idle', pendingCheckpoints: 1, consecutiveFailures: 0,
      message: 'Memory processing was cancelled during shutdown' });
    expect(await f.store.readControl()).toMatchObject({ lastOutcome: { status: 'cancelled' }, consecutiveFailures: 0 });
    const lease = await f.backend.acquireLocalMemoryLease(f.store.projectDirectory);
    expect(lease).toBeDefined();
    await lease!.release();
    await expect(second.runNow(f.cwd)).resolves.toMatchObject({ state: 'idle', pendingCheckpoints: 0, consecutiveFailures: 0 });
    expect(inputs).toHaveLength(2);
    expect(environmentB.sessions.history).toHaveBeenCalled();
    expect(environmentC.rejectedCalls).not.toHaveBeenCalled();
  });

  it('clears a sealed driver failure after its run ends before force settlement', async () => {
    const entered = deferred();
    const gate = deferred();
    const dreamRunner = vi.fn(async (input: LocalMemoryDreamInput) => {
      if (dreamRunner.mock.calls.length === 1) {
        entered.resolve();
        await gate.promise;
        throw new Error('Dream worker closed');
      }
      return input.baseSnapshot;
    });
    const f = await fixture({ dreamRunner, debounceMs: 0, writerRetryMs: 25,
      leaseOptions: { staleMs: 2_000, updateMs: 1_000 } });
    const environmentB = sealableEnvironment(f.cwd, 'driver-b');
    const second = f.coordinator.attach({ environment: environmentB, models: {} as ModelsService, scheduling: true });
    await second.status(f.cwd);
    const environmentA = sealableEnvironment(f.cwd, 'driver-a');
    const first = f.coordinator.attach({ environment: environmentA, models: {} as ModelsService, scheduling: true });
    await f.record(first, 1);
    const running = trackWork(first.runNow(f.cwd).catch(error => error));
    await waitForMilestone(entered.promise, running);

    environmentA.seal();
    gate.resolve();
    await running;
    expect(first.busy()).toBe(false);
    expect(environmentA.rejectedCalls).toHaveBeenCalled();
    expect(await f.store.readControl()).toMatchObject({ consecutiveFailures: 0 });

    await environmentA.withCleanup(() => first.settle('force'));
    const status = await second.status(f.cwd);
    expect(status.state).not.toBe('error');
    expect(status.message).toBeUndefined();
    expect(status.consecutiveFailures).toBe(0);
    await f.record(second, 4);
    await vi.waitFor(async () => {
      expect(dreamRunner).toHaveBeenCalledTimes(2);
      expect(second.busy()).toBe(false);
      expect(await second.status(f.cwd)).toMatchObject({ state: 'idle', pendingCheckpoints: 0, consecutiveFailures: 0 });
    }, { interval: 25, timeout: 8_000 });
    expect(environmentB.sessions.history).toHaveBeenCalled();
  }, 10_000);

  it('uses a checkpoint caller for scheduling reads while a newer driver is sealed', async () => {
    const f = await fixture();
    const environmentB = sealableEnvironment(f.cwd, 'driver-b');
    const second = f.coordinator.attach({ environment: environmentB, models: {} as ModelsService, scheduling: true });
    await second.status(f.cwd);
    const environmentA = sealableEnvironment(f.cwd, 'driver-a');
    const first = f.coordinator.attach({ environment: environmentA, models: {} as ModelsService, scheduling: true });
    await first.status(f.cwd);
    await vi.waitFor(() => expect(f.coordinator.hasActiveWork()).toBe(false), { interval: 10 });
    environmentA.seal();
    f.coordinator.setEnabled(true);
    await vi.waitFor(() => {
      expect(environmentA.rejectedCalls).toHaveBeenCalled();
      expect(f.coordinator.hasActiveWork()).toBe(false);
    }, { interval: 10 });
    const rejectedCalls = environmentA.rejectedCalls.mock.calls.length;

    await f.record(second, 1);
    second.setSelectedModel(undefined);
    expect(await second.status(f.cwd)).toMatchObject({ state: 'idle', pendingCheckpoints: 1 });
    await vi.waitFor(() => expect(f.coordinator.hasActiveWork()).toBe(false), { interval: 10 });
    expect(environmentA.rejectedCalls).toHaveBeenCalledTimes(rejectedCalls);
  });

  it('retries a sealed recovery driver store failure once through a live driver', async () => {
    const recoveryRetryMs = 100;
    const f = await fixture({ recover: true, recoveryStableMs: 0, recoveryRetryMs });
    await writeFile(join(f.cwd, 'stable.jsonl'), [
      JSON.stringify({ type: 'session', version: 3, id: 'stable', cwd: f.cwd }),
      JSON.stringify({ type: 'message', id: 'leaf', parentId: null, timestamp: new Date().toISOString(),
        message: { role: 'user', content: 'Recovered evidence' } }), '',
    ].join('\n'));
    const environmentB = sealableEnvironment(f.cwd, 'driver-b');
    const second = f.coordinator.attach({ environment: environmentB, models: {} as ModelsService, scheduling: true });
    const environmentA = sealableEnvironment(f.cwd, 'driver-a');
    const first = f.coordinator.attach({ environment: environmentA, models: {} as ModelsService, scheduling: true });
    const page = { items: [{ id: 'stable', root: 'stable', cwd: f.cwd, title: '', updatedAt: 0, state: 'closed' as const }] };
    const listA = vi.spyOn(environmentA.sessions, 'list').mockResolvedValue(page);
    let retriedAt = 0;
    const listB = vi.spyOn(environmentB.sessions, 'list').mockImplementation(async () => {
      retriedAt = Date.now();
      return page;
    });
    const entered = deferred();
    const gate = deferred();
    const history = environmentA.sessions.history;
    vi.spyOn(environmentA.sessions, 'history').mockImplementationOnce(async (...args) => {
      entered.resolve();
      await gate.promise;
      return history(...args);
    });
    await first.status(f.cwd);
    await entered.promise;
    await second.status(f.cwd);
    environmentA.seal();
    const releasedAt = Date.now();
    gate.resolve();
    await vi.waitFor(() => {
      expect(environmentA.rejectedCalls).toHaveBeenCalled();
      expect(first.busy()).toBe(false);
    }, { interval: 10 });
    await environmentA.withCleanup(() => first.settle('force'));

    await vi.waitFor(async () => {
      expect(await f.store.status()).toMatchObject({ pending: { stable: { checkpoint: { sessionId: 'stable' } } } });
      expect(second.busy()).toBe(false);
    }, { interval: 10 });
    expect(listA).toHaveBeenCalledOnce();
    expect(listB).toHaveBeenCalledOnce();
    expect(retriedAt - releasedAt).toBeGreaterThanOrEqual(recoveryRetryMs);
    expect(environmentB.sessions.history).toHaveBeenCalledOnce();
    expect(await second.status(f.cwd)).toMatchObject({ state: 'idle', pendingCheckpoints: 1, consecutiveFailures: 0 });
  });

  it('keeps explicit failures retryable, pauses automatic failures, and clears the pause for runNow', async () => {
    const dreamRunner = vi.fn(async (input: LocalMemoryDreamInput) => input.baseSnapshot);
    const f = await fixture({ dreamRunner, debounceMs: 0 });
    const attachment = f.coordinator.attachSession();
    await f.record(attachment, 1);
    failNextLeaseRelease(new Error('Unexpected explicit cleanup failure'));
    await expect(attachment.runNow(f.cwd)).rejects.toThrow('Unexpected explicit cleanup failure');

    await f.record(attachment, 5);
    await vi.waitFor(async () => {
      expect(dreamRunner).toHaveBeenCalledTimes(2);
      expect(attachment.busy()).toBe(false);
      expect(await attachment.status(f.cwd)).toMatchObject({ state: 'idle', pendingCheckpoints: 0 });
    }, { interval: 10, timeout: 10_000 });

    failNextLeaseRelease(new Error('Unexpected automatic cleanup failure'));
    await f.record(attachment, 5);
    await vi.waitFor(async () => {
      expect(dreamRunner).toHaveBeenCalledTimes(3);
      expect(attachment.busy()).toBe(false);
      expect(await attachment.status(f.cwd)).toMatchObject({ state: 'error', message: 'Unexpected automatic cleanup failure' });
    }, { interval: 10, timeout: 10_000 });
    await f.record(attachment, 5);
    expect(await attachment.status(f.cwd)).toMatchObject({ state: 'error', pendingCheckpoints: 1 });
    expect(dreamRunner).toHaveBeenCalledTimes(3);
    await expect(attachment.runNow(f.cwd)).resolves.toMatchObject({ state: 'idle', pendingCheckpoints: 0 });
    expect(dreamRunner).toHaveBeenCalledTimes(4);
  }, 30_000);

  it('drains an in-flight run that rejects during lease cleanup', async () => {
    const entered = deferred();
    const gate = deferred();
    const f = await fixture({ dreamRunner: async input => {
      entered.resolve();
      await gate.promise;
      return input.baseSnapshot;
    } });
    const attachment = f.coordinator.attachSession();
    await f.record(attachment, 1);
    failNextLeaseRelease(new Error('Unexpected cleanup failure'));
    const running = trackWork(attachment.runNow(f.cwd).catch(error => error));
    await waitForMilestone(entered.promise, running);
    const draining = trackWork(f.coordinator.drain());
    gate.resolve();
    await expect(draining).resolves.toBeUndefined();
    await expect(running).resolves.toEqual(new Error('Unexpected cleanup failure'));
  });

  it('retries a project when the in-flight run fails during lease cleanup', async () => {
    const entered = deferred();
    const gate = deferred();
    const inputs: LocalMemoryDreamInput[] = [];
    const f = await fixture({ dreamRunner: async input => {
      inputs.push(input);
      if (inputs.length === 1) {
        entered.resolve();
        await gate.promise;
      }
      return input.baseSnapshot;
    } });
    const attachment = f.coordinator.attachSession();
    await f.record(attachment, 1);
    failNextLeaseRelease(new Error('Unexpected cleanup failure'));
    const running = trackWork(attachment.runNow(f.cwd).catch(error => error));
    await waitForMilestone(entered.promise, running);
    const retrying = trackWork(attachment.retryProject(f.cwd));
    await vi.waitFor(() => expect(inputs[0]!.signal.aborted).toBe(true), { interval: 10 });
    gate.resolve();
    await expect(retrying).resolves.toMatchObject({ state: 'idle', pendingCheckpoints: 0, consecutiveFailures: 0 });
    await running;
    expect(inputs).toHaveLength(2);
  });

  it.each([undefined, 'Dream scheduling is unavailable on this host'])('keeps non-scheduling attachments readable without driving work: %s', async unavailableReason => {
    const dreamRunner = vi.fn(async (input: LocalMemoryDreamInput) => input.baseSnapshot);
    const f = await fixture({ dreamRunner, recover: true });
    const reader = f.coordinator.attachSession({ scheduling: false,
      ...(unavailableReason === undefined ? {} : { unavailableReason }) });
    await f.record(reader, 5);
    expect(await reader.status(f.cwd)).toMatchObject({ enabled: false, state: 'disabled', pendingCheckpoints: 1,
      ...(unavailableReason === undefined ? {} : { message: unavailableReason }) });
    await expect(reader.readCurrent(f.cwd, join(f.root, 'reader-projection'))).resolves.toMatchObject({ files: expect.any(Array) });
    await expect(reader.runNow(f.cwd)).resolves.toMatchObject({ state: 'disabled', pendingCheckpoints: 1 });
    await expect(reader.retryProject(f.cwd)).resolves.toMatchObject({ state: 'disabled', pendingCheckpoints: 1 });
    expect(reader.busy()).toBe(false);
    expect(f.backend.faults.listCalls).toBe(0);
    expect(dreamRunner).not.toHaveBeenCalled();
    const writer = f.coordinator.attachSession();
    await expect(writer.runNow(f.cwd)).resolves.toMatchObject({ enabled: true, pendingCheckpoints: 0 });
    expect(dreamRunner).toHaveBeenCalledOnce();
  });

  it('aborts another attachment in process when a project retry resets its active attempt', async () => {
    const entered = deferred();
    const aborted = deferred();
    const gate = deferred();
    const modelsA = {} as ModelsService;
    const modelsB = {} as ModelsService;
    const inputs: LocalMemoryDreamInput[] = [];
    const f = await fixture({ dreamRunner: async input => {
      inputs.push(input);
      if (inputs.length === 1) {
        const cancelled = waitForMemoryAbort(input.signal);
        entered.resolve();
        await cancelled;
        aborted.resolve();
        await gate.promise;
      }
      return input.baseSnapshot;
    } });
    const first = f.coordinator.attachSession({ models: modelsA });
    const second = f.coordinator.attachSession({ models: modelsB });
    await second.status(f.cwd);
    await f.record(first, 1);
    const running = trackWork(first.runNow(f.cwd));
    await waitForMilestone(entered.promise, running);
    const retrying = trackWork(second.retryProject(f.cwd));
    await waitForMilestone(aborted.promise, retrying);
    expect(first.busy()).toBe(true);
    expect(second.busy()).toBe(false);
    expect(inputs).toHaveLength(1);
    gate.resolve();
    await running;
    await expect(retrying).resolves.toMatchObject({ pendingCheckpoints: 0, consecutiveFailures: 0 });
    expect(inputs).toHaveLength(2);
    expect(inputs[0]!.models).toBe(modelsA);
    expect(inputs[1]!.models).toBe(modelsB);
    expect((await f.store.readControl()).activeAttempt).toBeUndefined();
  });

  it('retries an externally held writer lease after writerRetryMs without another attachment call', async () => {
    const entered = deferred();
    const gate = deferred();
    const dreamRunner = vi.fn(async (input: LocalMemoryDreamInput) => {
      entered.resolve();
      await gate.promise;
      return input.baseSnapshot;
    });
    const f = await fixture({ dreamRunner, writerRetryMs: 75 });
    const attachment = f.coordinator.attachSession();
    await attachment.status(f.cwd);
    const lease = await f.backend.acquireLocalMemoryLease(f.store.projectDirectory);
    expect(lease).toBeDefined();
    cleanups.push(async () => { await lease?.release(); });
    await f.record(attachment, 5);
    await expect.poll(() => attachment.status(f.cwd), { timeout: 10_000 }).toMatchObject({ state: 'blocked', pendingCheckpoints: 1,
      message: 'Another Felan Code process owns the memory writer' });
    expect(dreamRunner).not.toHaveBeenCalled();

    await lease!.release();
    await entered.promise;
    expect(dreamRunner).toHaveBeenCalledOnce();
    gate.resolve();
    await f.coordinator.drain();
    expect(await attachment.status(f.cwd)).toMatchObject({ state: 'idle', pendingCheckpoints: 0, consecutiveFailures: 0 });
  }, 30_000);

  it('removes only the detached attachment listeners and keeps surviving attachments usable', async () => {
    const f = await fixture();
    const first = f.coordinator.attachSession();
    const second = f.coordinator.attachSession();
    await second.status(f.cwd);
    const firstChanged = vi.fn();
    const secondChanged = vi.fn();
    first.subscribeStatusChanges(firstChanged);
    second.subscribeStatusChanges(secondChanged);
    await f.record(first, 1);
    expect(firstChanged).toHaveBeenCalledOnce();
    expect(secondChanged).toHaveBeenCalledOnce();

    const detaching = first.detach();
    expect(first.detach()).toBe(detaching);
    await detaching;
    firstChanged.mockClear();
    secondChanged.mockClear();
    const lateListener = vi.fn();
    first.subscribeStatusChanges(lateListener);
    await f.record(second, 1);
    expect(firstChanged).not.toHaveBeenCalled();
    expect(lateListener).not.toHaveBeenCalled();
    expect(secondChanged).toHaveBeenCalledOnce();
    await expect(second.runNow(f.cwd)).resolves.toMatchObject({ pendingCheckpoints: 0 });
    expect(firstChanged).not.toHaveBeenCalled();
    expect(lateListener).not.toHaveBeenCalled();
    expect(secondChanged.mock.calls.length).toBeGreaterThan(1);
  });
});

function acquire(options: LocalMemoryCoordinatorOptions) {
  const shared = acquireSharedLocalMemoryCoordinator(options);
  cleanups.push(() => shared.release());
  return shared;
}

async function temporaryDirectory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'felan-memory-shared-'));
  roots.push(root);
  return root;
}

async function fixture(options: Partial<LocalMemoryCoordinatorOptions> = {}) {
  const root = await temporaryDirectory();
  const cwd = join(root, 'workspace');
  const agentDir = join(root, 'agent');
  await mkdir(cwd);
  const backend = createMemoryBackend();
  const coordinator = new backend.LocalMemoryCoordinator({ agentDir, models: {} as ModelsService,
    recover: false, dreamRunner: async input => input.baseSnapshot, ...options });
  cleanups.push(() => coordinator.dispose());
  const store = new backend.LocalMemoryStore(agentDir, await backend.resolveLocalMemoryProject(cwd));
  const entries: Record<string, unknown>[] = [];
  const record = async (attachment: { recordCheckpoint(cwd: string, checkpoint: SessionCheckpoint): Promise<void> }, count: number) => {
    for (let index = 0; index < count; index += 1) {
      entries.push({ type: 'message', id: `entry-${entries.length}`, parentId: entries.at(-1)?.id ?? null,
        timestamp: new Date().toISOString(), message: { role: 'user', content: `Accepted update ${entries.length}` } });
      const sessionFile = join(cwd, 'source.jsonl');
      await writeFile(sessionFile, [JSON.stringify({ type: 'session', version: 3, id: 'source', cwd }),
        ...entries.map(entry => JSON.stringify(entry)), ''].join('\n'));
      await attachment.recordCheckpoint(cwd, createSessionCheckpoint(SessionManager.open(sessionFile))!);
    }
  };
  return { root, cwd, backend, coordinator, store, record };
}

function sessionEnvironment(cwd: string, id: string) {
  const runtime = new HostAgentRuntime(cwd, { pathAccess: 'host', sessionStorageRoot: join(cwd, id), agentStorageRoot: join(cwd, 'agent') });
  const checkpoint = vi.fn(async (sessionId: string) => {
    const path = join(cwd, `${sessionId}.jsonl`);
    const revision = await readFile(path, 'utf8');
    const manager = SessionManager.open(path);
    return { sessionId, revision, branch: manager.getLeafId(), transcriptDigest: digestActiveBranch(manager.getBranch()), byteLength: Buffer.byteLength(revision) };
  });
  const history = vi.fn(async (sessionId: string) => ({ ...await checkpoint(sessionId), entries: SessionManager.open(join(cwd, `${sessionId}.jsonl`)).getEntries() }));
  const sessions = { current: { id, root: id }, list: async () => ({ items: [] }), checkpoint, history } as unknown as SessionsService;
  return { runtime, sessions };
}

function sealableEnvironment(cwd: string, id: string) {
  const environment = sessionEnvironment(cwd, id);
  const cleanup = new AsyncLocalStorage<boolean>();
  const rejectedCalls = vi.fn();
  let sealed = false;
  const checked = <T extends object>(target: T): T => new Proxy(target, {
    get(target, key) {
      const value: unknown = Reflect.get(target, key, target);
      if (key === 'files' && value) return checked(value);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        if (sealed && !cleanup.getStore()) {
          rejectedCalls(key);
          throw new Error('Session runtime is closed to new work.');
        }
        const result: unknown = Reflect.apply(value, target, args);
        return key === 'storage' ? checked(result as object) : result;
      };
    },
  });
  return { ...environment, runtime: checked(environment.runtime), rejectedCalls,
    seal: () => { sealed = true; },
    withCleanup: <T>(operation: () => Promise<T>) => cleanup.run(true, operation) };
}

function failNextLeaseRelease(error: Error): void {
  vi.spyOn(leases, 'acquireLocalMemoryLease').mockImplementationOnce(async (...args) => {
    const lease = await acquireLease(...args);
    if (!lease) return lease;
    return { ...lease, release: async () => { await lease.release(); throw error; } };
  });
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(settle => { resolve = settle; });
  releases.push(resolve);
  return { promise, resolve };
}

function trackWork<T>(work: Promise<T>): Promise<T> {
  pendingWork.push(Promise.allSettled([work]));
  return work;
}

async function waitForMilestone(milestone: Promise<void>, work: Promise<unknown>): Promise<void> {
  await Promise.race([milestone, work.then(() => { throw new Error('Memory work settled before its fixture milestone'); })]);
}

function waitForMemoryAbort(signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
}
