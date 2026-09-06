import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { hydrateMemoryDirectory, memoryArtifactFingerprint, type MemoryArtifact } from '@felan-ai/ext-memory';
import { acquireLocalMemoryLease, type LocalMemoryLease } from '../src/memory/lease.js';
import {
  LocalMemoryControlError,
  LocalMemoryStore,
  MEMORY_ATTEMPT_TIMEOUT_MS,
  type LocalMemoryAttempt,
  type LocalMemoryStoreOptions,
} from '../src/memory/store.js';

const roots: string[] = [];
const leases: LocalMemoryLease[] = [];
const NOW = Date.parse('2026-09-05T12:00:00.000Z');

afterEach(async () => {
  await Promise.all(leases.splice(0).map((lease) => lease.release()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('durable project memory control', () => {
  it('creates private, separately versioned control without changing valid v1 state', async () => {
    const store = await createStore();
    const before = await readFile(store.statePath, 'utf8');
    await rm(store.controlPath);
    const restarted = new LocalMemoryStore(store.agentDir, store.project);
    await restarted.initialize(NOW + 1);
    expect(await readFile(store.statePath, 'utf8')).toBe(before);
    expect(await restarted.readControl()).toEqual({
      version: 1, generation: 0, consecutiveFailures: 0, updatedAt: iso(NOW + 1),
    });
    expect((await stat(store.controlPath)).mode & 0o777).toBe(0o600);
  });

  it('persists 60s/300s backoff, then disables across checkpoints, projects and restarts', async () => {
    const store = await createStore();
    const stateBefore = await store.status();
    const lease = await writer(store);
    const first = await begin(store, lease, 'run-1', NOW);
    expect(first).toMatchObject({
      leaseToken: lease.token, startedAt: iso(NOW), deadlineAt: iso(NOW + MEMORY_ATTEMPT_TIMEOUT_MS),
      checkpoints: Object.values(stateBefore.pending),
    });
    const failed1 = await store.finishAttempt(lease, first, { status: 'failure', reason: 'model failure' }, NOW);
    expect(failed1).toMatchObject({ consecutiveFailures: 1, nextRetryAt: iso(NOW + 60_000) });
    expect(await store.finishAttempt(lease, first, { status: 'failure', reason: 'duplicate' }, NOW + 1)).toEqual(failed1);
    await store.recordCheckpoint(checkpoint('session-2'));
    await lease.release();

    const restarted = new LocalMemoryStore(store.agentDir, store.project);
    await restarted.initialize(NOW + 1);
    const nextLease = await writer(restarted);
    expect(await tryBegin(restarted, nextLease, 'early', NOW + 59_999)).toBeUndefined();
    const second = await begin(restarted, nextLease, 'run-2', NOW + 60_000);
    const failed2 = await restarted.finishAttempt(nextLease, second, { status: 'failure', reason: 'invalid output' }, NOW + 60_000);
    expect(failed2).toMatchObject({ consecutiveFailures: 2, nextRetryAt: iso(NOW + 360_000) });
    expect(await tryBegin(restarted, nextLease, 'early-again', NOW + 359_999)).toBeUndefined();
    const third = await begin(restarted, nextLease, 'run-3', NOW + 360_000);
    const failed3 = await restarted.finishAttempt(nextLease, third, { status: 'failure', reason: 'timeout' }, NOW + 360_000);
    expect(failed3).toMatchObject({
      consecutiveFailures: 3, generation: 1,
      autoDisabled: { runId: 'run-3', at: iso(NOW + 360_000), reason: expect.any(String) },
      lastDisabledRunId: 'run-3',
    });
    expect(failed3.nextRetryAt).toBeUndefined();
    await restarted.recordCheckpoint(checkpoint('session-3'));
    await nextLease.release();
    const disabled = new LocalMemoryStore(store.agentDir, store.project);
    await disabled.initialize(NOW + 1_000_000);
    const disabledLease = await writer(disabled);
    expect(await tryBegin(disabled, disabledLease, 'disabled', NOW + 1_000_000)).toBeUndefined();
    expect(await disabled.readControl()).toEqual(failed3);
    expect(Object.keys((await disabled.status()).pending)).toHaveLength(3);
    const independent = await createStore();
    expect(await independent.readControl()).toMatchObject({ consecutiveFailures: 0, generation: 0 });
  });

  it('resets failures only after a proven successful publication', async () => {
    const store = await createStore({ retryDelaysMs: [10, 20] });
    const lease = await writer(store);
    const first = await begin(store, lease, 'failed', NOW);
    await store.finishAttempt(lease, first, { status: 'failure', reason: 'failure' }, NOW);
    const second = await begin(store, lease, 'success', NOW + 10);
    await expect(store.finishAttempt(lease, second, { status: 'success' }, NOW + 11)).rejects.toThrow('has not published');
    const fingerprint = await store.commit(lease, second.baseFingerprint, artifact(), second.checkpoints, second);
    expect((await store.readControl()).activeAttempt?.published?.fingerprint).toBe(fingerprint);
    const completed = await store.finishAttempt(lease, second, { status: 'success' }, NOW + 12);
    expect(completed.consecutiveFailures).toBe(0);
    expect(completed.nextRetryAt).toBeUndefined();
    expect(completed.autoDisabled).toBeUndefined();
    expect(completed.activeAttempt).toBeUndefined();
    expect(completed.lastOutcome).toMatchObject({ runId: second.runId, status: 'success' });
  });

  it('does not charge cancelled/blocked work, missing input or lease contention', async () => {
    const store = await createStore({ retryDelaysMs: [10, 20] });
    const lease = await writer(store);
    expect(await acquireLocalMemoryLease(store.projectDirectory)).toBeUndefined();
    expect(await store.beginAttempt(lease, { runId: 'missing', baseFingerprint: 'a'.repeat(64), checkpoints: [] }, NOW)).toBeUndefined();
    expect((await store.readControl()).consecutiveFailures).toBe(0);
    const failed = await begin(store, lease, 'failed', NOW);
    const backoff = await store.finishAttempt(lease, failed, { status: 'failure', reason: 'failed' }, NOW);
    const blocked = await begin(store, lease, 'blocked', NOW + 10);
    const control = await store.finishAttempt(undefined, blocked, { status: 'cancelled', reason: 'auth unavailable' }, NOW + 11);
    expect(control.consecutiveFailures).toBe(1);
    expect(control.nextRetryAt).toBe(backoff.nextRetryAt);
    expect(control.generation).toBe(1);
    expect(control.lastOutcome).toMatchObject({ runId: 'blocked', status: 'cancelled' });
    expect(Object.keys((await store.status()).pending)).toEqual(['session-1']);
  });

  it('cancels and resets from another store while the writer lease is still held', async () => {
    const store = await createStore();
    const lease = await writer(store);
    const active = await begin(store, lease, 'active', NOW);
    const other = new LocalMemoryStore(store.agentDir, store.project);
    const cancelled = await other.finishAttempt(undefined, active, { status: 'cancelled' }, NOW + 1);
    expect(cancelled.generation).toBe(active.generation + 1);
    expect(await lease.verify()).toBe(true);
    await expect(store.commit(lease, active.baseFingerprint, artifact(), active.checkpoints, active)).rejects.toThrow('fenced');
    const resetActive = await begin(store, lease, 'reset-active', NOW + 2);
    const reset = await other.resetProjectControl(NOW + 3);
    expect(reset.generation).toBe(resetActive.generation + 1);
    expect(reset.activeAttempt).toBeUndefined();
    expect(reset.lastOutcome).toMatchObject({ runId: 'reset-active', status: 'cancelled' });
    await expect(store.commit(lease, resetActive.baseFingerprint, artifact(), resetActive.checkpoints, resetActive)).rejects.toThrow('fenced');
    expect(await store.finishAttempt(lease, resetActive, { status: 'failure', reason: 'late failure' }, NOW + 4)).toEqual(reset);
    expect((await store.readCurrent()).fingerprint).toBe(active.baseFingerprint);
  });

  it('requires current exclusive ownership and exact active input for publication', async () => {
    const store = await createStore();
    const lease = await writer(store);
    const active = await begin(store, lease, 'active', NOW);
    expect(await tryBegin(store, lease, 'overlap', NOW + 1)).toBeUndefined();
    await expect(store.commit(lease, active.baseFingerprint, artifact(), active.checkpoints)).rejects.toThrow('fenced');
    await expect(store.commit(lease, active.baseFingerprint, artifact(), [], active)).rejects.toThrow('input');
    await expect(store.commit(lease, active.baseFingerprint, artifact(), active.checkpoints, { ...active, runId: 'wrong' })).rejects.toThrow('fenced');
    await lease.release();
    await expect(store.commit(lease, active.baseFingerprint, artifact(), active.checkpoints, active)).rejects.toThrow('lease');
    await expect(store.finishAttempt(lease, active, { status: 'failure', reason: 'lost lease' }, NOW + 2)).rejects.toThrow('lease');
    expect((await store.readControl()).consecutiveFailures).toBe(0);
  });

  it('explicitly resets durable disable without removing pending evidence or last-run reference', async () => {
    const store = await createStore({ retryDelaysMs: [0, 0] });
    const lease = await writer(store);
    for (let i = 0; i < 3; i += 1) {
      const active = await begin(store, lease, `failure-${i}`, NOW + i);
      await store.finishAttempt(lease, active, { status: 'failure', reason: 'failed' }, NOW + i);
    }
    const snapshot = await store.processingSnapshot();
    await expect(store.commit(lease, snapshot.fingerprint, artifact(), snapshot.checkpoints)).rejects.toThrow('disabled');
    const before = await readFile(store.statePath, 'utf8');
    const reset = await store.resetProjectControl(NOW + 4);
    expect(reset).toMatchObject({
      generation: 2, consecutiveFailures: 0, lastOutcome: { runId: 'failure-2' }, lastDisabledRunId: 'failure-2',
    });
    expect(reset.autoDisabled).toBeUndefined();
    expect(await readFile(store.statePath, 'utf8')).toBe(before);
    const success = await begin(store, lease, 're-enabled', NOW + 4);
    await store.commit(lease, success.baseFingerprint, artifact(), success.checkpoints, success);
    expect((await store.finishAttempt(lease, success, { status: 'success' }, NOW + 5)).lastDisabledRunId).toBe('failure-2');
    expect((await store.resetProjectControl(NOW + 6)).lastDisabledRunId).toBe('failure-2');
    await lease.release();
    const restarted = new LocalMemoryStore(store.agentDir, store.project, { retryDelaysMs: [0, 0] });
    await restarted.initialize(NOW + 7);
    expect((await restarted.readControl()).lastDisabledRunId).toBe('failure-2');
    await restarted.recordCheckpoint(checkpoint('session-2'));
    const nextLease = await writer(restarted);
    for (let i = 0; i < 3; i += 1) {
      const active = await begin(restarted, nextLease, `later-failure-${i}`, NOW + 8 + i);
      await restarted.finishAttempt(nextLease, active, { status: 'failure', reason: 'failed' }, NOW + 8 + i);
    }
    expect((await restarted.readControl()).lastDisabledRunId).toBe('later-failure-2');
  });

  it.each([
    '{invalid',
    JSON.stringify({ version: 2, generation: 0, consecutiveFailures: 0, updatedAt: iso(NOW) }),
    JSON.stringify({ version: 1, generation: 0, consecutiveFailures: 3, updatedAt: iso(NOW) }),
    JSON.stringify({ version: 1, generation: -1, consecutiveFailures: 0, updatedAt: iso(NOW) }),
    JSON.stringify({ version: 1, generation: 0, consecutiveFailures: 1, nextRetryAt: 'never', updatedAt: iso(NOW) }),
    JSON.stringify({ version: 1, generation: 0, consecutiveFailures: 0, updatedAt: iso(NOW), lastDisabledRunId: '../run' }),
  ])('fails closed and preserves malformed or newer control: %s', async (contents) => {
    const store = await createStore();
    const before = await readFile(store.statePath, 'utf8');
    await writeFile(store.controlPath, contents);
    await expect(store.readControl()).rejects.toBeInstanceOf(LocalMemoryControlError);
    await expect(store.initialize(NOW)).rejects.toBeInstanceOf(LocalMemoryControlError);
    const lease = await writer(store);
    await expect(tryBegin(store, lease, 'blocked', NOW)).rejects.toBeInstanceOf(LocalMemoryControlError);
    await expect(store.reconcileAbandonedAttempt(lease, NOW)).rejects.toBeInstanceOf(LocalMemoryControlError);
    await expect(store.resetProjectControl(NOW)).rejects.toBeInstanceOf(LocalMemoryControlError);
    expect(await readFile(store.controlPath, 'utf8')).toBe(contents);
    expect(await readFile(store.statePath, 'utf8')).toBe(before);
    await expect(store.readCurrent()).resolves.toBeDefined();
  });

  it('rejects inconsistent active generation, cursors and timing rather than discarding ownership', async () => {
    const store = await createStore();
    const lease = await writer(store);
    const active = await begin(store, lease, 'active', NOW);
    const valid = await store.readControl();
    for (const update of [{ generation: 9 }, { checkpoints: [] }, { deadlineAt: active.startedAt }, { checkpoints: [{}] }]) {
      const malformed = JSON.stringify({ ...valid, activeAttempt: { ...active, ...update } });
      await writeFile(store.controlPath, malformed);
      await expect(store.readControl()).rejects.toBeInstanceOf(LocalMemoryControlError);
      expect(await readFile(store.controlPath, 'utf8')).toBe(malformed);
    }
  });

  it('rejects oversized control metadata without loading or replacing it', async () => {
    const store = await createStore();
    const oversized = JSON.stringify({ ...await store.readControl(), unexpected: 'x'.repeat(64 * 1_024) });
    await writeFile(store.controlPath, oversized);
    await expect(store.readControl()).rejects.toBeInstanceOf(LocalMemoryControlError);
    expect(await readFile(store.controlPath, 'utf8')).toBe(oversized);
  });
});

describe('memory attempt crash reconciliation', () => {
  it('cancels an abandoned prior lease without consuming the retry budget', async () => {
    const store = await createStore();
    const lease = await writer(store);
    const active = await begin(store, lease, 'abandoned', NOW);
    const before = await readFile(store.statePath, 'utf8');
    expect((await store.reconcileAbandonedAttempt(lease, NOW + 1)).activeAttempt).toEqual(active);
    await lease.release();
    const nextLease = await writer(store);
    const reconciled = await store.reconcileAbandonedAttempt(nextLease, NOW + 1);
    expect(reconciled).toMatchObject({
      consecutiveFailures: 0,
      lastOutcome: { runId: active.runId, status: 'cancelled' },
    });
    expect(reconciled.activeAttempt).toBeUndefined();
    expect(await store.reconcileAbandonedAttempt(nextLease, NOW + 2)).toEqual(reconciled);
    expect(await readFile(store.statePath, 'utf8')).toBe(before);
  });

  it('accounts for an expired current attempt once without a turn cap', async () => {
    const store = await createStore();
    const lease = await writer(store);
    const active = await begin(store, lease, 'expired', NOW);
    expect((await store.reconcileAbandonedAttempt(lease, NOW + MEMORY_ATTEMPT_TIMEOUT_MS - 1)).activeAttempt).toEqual(active);
    const reconciled = await store.reconcileAbandonedAttempt(lease, NOW + MEMORY_ATTEMPT_TIMEOUT_MS);
    expect(reconciled.consecutiveFailures).toBe(0);
    expect(reconciled.lastOutcome?.status).toBe('cancelled');
    expect(await store.reconcileAbandonedAttempt(lease, NOW + MEMORY_ATTEMPT_TIMEOUT_MS + 1)).toEqual(reconciled);
  });

  it('recovers a committed attempt after journal cleanup as success, not paid work again', async () => {
    const store = await createStore();
    const lease = await writer(store);
    const active = await begin(store, lease, 'committed', NOW);
    await store.commit(lease, active.baseFingerprint, artifact(), active.checkpoints, active);
    expect(await readdir(store.stagingDirectory)).toEqual([]);
    await lease.release();
    const nextLease = await writer(store);
    const reconciled = await store.reconcileAbandonedAttempt(nextLease, NOW + 2);
    expect(reconciled).toMatchObject({ consecutiveFailures: 0, lastOutcome: { runId: active.runId, status: 'success' } });
    expect((await store.status()).pending).toEqual({});
    expect(await store.reconcileAbandonedAttempt(nextLease, NOW + 3)).toEqual(reconciled);
  });

  it.each(['prepared', 'published'] as const)('recovers output replacement with %s journal and exact cursors', async (phase) => {
    const store = await createStore();
    const lease = await writer(store);
    const active = await begin(store, lease, 'published', NOW);
    await journalCrash(store, active, phase, 'replaced');
    const newer = checkpoint('session-1', 'digest-2');
    await store.recordCheckpoint(newer);
    await lease.release();
    const nextLease = await writer(store);
    const reconciled = await store.reconcileAbandonedAttempt(nextLease, NOW + 1);
    expect(reconciled.lastOutcome).toMatchObject({ runId: active.runId, status: 'cancelled' });
    const state = await store.status();
    expect(state.pending['session-1']?.checkpoint).toEqual(newer);
    expect(state.pending['session-1']?.checkpoint).not.toEqual(active.checkpoints[0]?.checkpoint);
    expect(state.processed['session-1']).toBeUndefined();
    expect(await readdir(store.stagingDirectory)).toEqual([]);
  });

  it.each(['staged', 'moved-previous'] as const)('restores the last canonical artifact when interrupted at %s', async (stage) => {
    const store = await createStore();
    const lease = await writer(store);
    const active = await begin(store, lease, 'interrupted', NOW);
    const before = await readFile(store.statePath, 'utf8');
    await journalCrash(store, active, 'prepared', stage);
    await lease.release();
    const reconciled = await store.reconcileAbandonedAttempt(await writer(store), NOW + 1);
    expect(reconciled.consecutiveFailures).toBe(0);
    expect(reconciled.lastOutcome?.status).toBe('cancelled');
    expect((await store.readCurrent()).fingerprint).toBe(active.baseFingerprint);
    expect(await readFile(store.statePath, 'utf8')).toBe(before);
  });

  it('never creates empty canonical memory while an unreleased writer has recovery evidence', async () => {
    const store = await createStore();
    const lease = await writer(store);
    const initial = await store.processingSnapshot();
    const retained = await store.commit(lease, initial.fingerprint, artifact(), initial.checkpoints);
    await store.recordCheckpoint(checkpoint('session-2'));
    const active = await begin(store, lease, 'interrupted-replacement', NOW);
    const beforeState = await readFile(store.statePath, 'utf8');
    await journalCrash(store, active, 'prepared', 'moved-previous');
    const other = new LocalMemoryStore(store.agentDir, store.project);
    await expect(other.initialize(NOW + 1)).rejects.toThrow('writer ownership');
    await expect(stat(store.currentDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(store.statePath, 'utf8')).toBe(beforeState);
    const [directory] = await readdir(store.stagingDirectory);
    expect(await readFile(join(store.stagingDirectory, directory!, 'previous', 'summary.md'), 'utf8')).toBe('Verified project preference.');
    await lease.release();
    await other.initialize(NOW + 2);
    expect((await other.readCurrent()).fingerprint).toBe(retained);
    expect(await readFile(store.statePath, 'utf8')).toBe(beforeState);
  });

  it('never repairs a publication fingerprint without acquiring writer ownership', async () => {
    const store = await createStore();
    const lease = await writer(store);
    const active = await begin(store, lease, 'unacknowledged', NOW);
    const beforeState = await readFile(store.statePath, 'utf8');
    await journalCrash(store, active, 'published', 'replaced');
    await expect(new LocalMemoryStore(store.agentDir, store.project).initialize(NOW + 1)).rejects.toThrow('writer ownership');
    expect(await readFile(store.statePath, 'utf8')).toBe(beforeState);
    expect(await readdir(store.stagingDirectory)).toHaveLength(1);
    await lease.release();
    await store.initialize(NOW + 2);
    expect(Object.keys((await store.status()).pending)).toHaveLength(1);
    expect((await store.readControl()).activeAttempt).toBeDefined();
  });

  it('rolls back an unacknowledged stale generation instead of publishing after reset', async () => {
    const store = await createStore();
    const lease = await writer(store);
    const active = await begin(store, lease, 'fenced-crash', NOW);
    await journalCrash(store, active, 'published', 'replaced');
    const reset = await store.resetProjectControl(NOW + 1);
    await lease.release();
    expect(await store.reconcileAbandonedAttempt(await writer(store), NOW + 2)).toEqual(reset);
    expect((await store.readCurrent()).fingerprint).toBe(active.baseFingerprint);
    expect((await store.status()).pending['session-1']?.checkpoint).toEqual(active.checkpoints[0]?.checkpoint);
  });

  it('treats late failure after successful publication as success', async () => {
    const store = await createStore();
    const lease = await writer(store);
    const active = await begin(store, lease, 'published-before-error', NOW);
    await store.commit(lease, active.baseFingerprint, artifact(), active.checkpoints, active);
    const finished = await store.finishAttempt(lease, active, { status: 'failure', reason: 'cleanup interrupted' }, NOW + 1);
    expect(finished).toMatchObject({ consecutiveFailures: 0, lastOutcome: { status: 'success' } });
  });

  it('requires processed-cursor evidence in addition to a pre-publication run manifest', async () => {
    const store = await createStore();
    const lease = await writer(store);
    const active = await begin(store, lease, 'manifest-before-commit', NOW);
    await manifest(store, active, active.baseFingerprint);
    await lease.release();
    const reconciled = await store.reconcileAbandonedAttempt(await writer(store), NOW + 1);
    expect(reconciled.consecutiveFailures).toBe(0);
    expect(reconciled.lastOutcome?.status).toBe('cancelled');
    expect(Object.keys((await store.status()).pending)).toHaveLength(1);
  });

  it('uses retained run output and exact committed state if outcome evidence was interrupted', async () => {
    const store = await createStore();
    const lease = await writer(store);
    const active = await begin(store, lease, 'manifest-committed', NOW);
    const fingerprint = await store.commit(lease, active.baseFingerprint, artifact(), active.checkpoints, active);
    await manifest(store, active, fingerprint);
    await writeFile(store.controlPath, JSON.stringify({ ...await store.readControl(), activeAttempt: active }));
    await lease.release();
    const reconciled = await store.reconcileAbandonedAttempt(await writer(store), NOW + 1);
    expect(reconciled).toMatchObject({ consecutiveFailures: 0, lastOutcome: { status: 'success' } });
  });

  it('distinguishes an unchanged staged artifact from an unchanged published artifact', async () => {
    const store = await createStore();
    const lease = await writer(store);
    const active = await begin(store, lease, 'unchanged-staged', NOW);
    const unchanged = (await store.processingSnapshot()).artifact;
    await journalCrash(store, active, 'prepared', 'staged', unchanged);
    await lease.release();
    const nextLease = await writer(store);
    expect((await store.reconcileAbandonedAttempt(nextLease, NOW + 1)).consecutiveFailures).toBe(0);
    const next = await begin(store, nextLease, 'unchanged-published', NOW + 60_001);
    await journalCrash(store, next, 'prepared', 'replaced', unchanged);
    await nextLease.release();
    expect((await store.reconcileAbandonedAttempt(await writer(store), NOW + 60_002)).lastOutcome?.status).toBe('cancelled');
    expect(Object.keys((await store.status()).pending)).toHaveLength(1);
  });
});

async function createStore(options: LocalMemoryStoreOptions = {}): Promise<LocalMemoryStore> {
  const root = await mkdtemp(join(tmpdir(), 'felan-memory-control-'));
  roots.push(root);
  const project = { canonicalRoot: join(root, 'workspace'), key: '1'.repeat(64) };
  await mkdir(project.canonicalRoot);
  const store = new LocalMemoryStore(join(root, 'agent'), project, options);
  await store.initialize(NOW);
  await store.recordCheckpoint(checkpoint('session-1'));
  return store;
}

async function writer(store: LocalMemoryStore): Promise<LocalMemoryLease> {
  const lease = await acquireLocalMemoryLease(store.projectDirectory);
  expect(lease).toBeDefined();
  leases.push(lease!);
  return lease!;
}

async function tryBegin(store: LocalMemoryStore, lease: LocalMemoryLease, runId: string, now: number) {
  const snapshot = await store.processingSnapshot();
  return store.beginAttempt(lease, { runId, baseFingerprint: snapshot.fingerprint, checkpoints: snapshot.checkpoints }, now);
}

async function begin(store: LocalMemoryStore, lease: LocalMemoryLease, runId: string, now: number): Promise<LocalMemoryAttempt> {
  const attempt = await tryBegin(store, lease, runId, now);
  expect(attempt).toBeDefined();
  return attempt!;
}

async function journalCrash(
  store: LocalMemoryStore,
  active: LocalMemoryAttempt,
  phase: 'prepared' | 'published',
  stage: 'staged' | 'moved-previous' | 'replaced',
  output = artifact(),
): Promise<void> {
  const directory = await store.createStagingDirectory();
  await hydrateMemoryDirectory(output, join(directory, 'memory'));
  await writeFile(join(directory, 'commit.json'), JSON.stringify({
    version: 2, phase, baseFingerprint: active.baseFingerprint, fingerprint: memoryArtifactFingerprint(output),
    checkpoints: active.checkpoints,
    attempt: { runId: active.runId, generation: active.generation, leaseToken: active.leaseToken },
    ...(phase === 'published' ? { publishedAt: iso(NOW) } : {}),
  }));
  if (stage === 'staged') return;
  await rename(store.currentDirectory, join(directory, 'previous'));
  if (stage === 'replaced') await rename(join(directory, 'memory'), store.currentDirectory);
}

async function manifest(store: LocalMemoryStore, active: LocalMemoryAttempt, outputFingerprint: string): Promise<void> {
  const path = join(store.projectDirectory, 'runs', active.runId);
  await mkdir(path, { recursive: true });
  await writeFile(join(path, 'manifest.json'), JSON.stringify({
    version: 1, kind: 'memory', phase: 'publish', sessionId: active.runId, projectKey: store.project.key,
    startedAt: active.startedAt, baseFingerprint: active.baseFingerprint, outputFingerprint,
    checkpoints: active.checkpoints.map((entry) => entry.checkpoint),
  }));
}

function checkpoint(sessionId: string, transcriptDigest = 'digest-1') {
  return { sessionId, sessionFile: `/sessions/${sessionId}.jsonl`, leafId: 'leaf-1', transcriptDigest };
}

function artifact(): MemoryArtifact {
  return {
    version: 1,
    files: [
      { path: 'summary.md', content: 'Verified project preference.' },
      { path: 'index.md', content: '# Memory index\n\n## How to use this memory\n\n## Memory map\n- [Project](.memory/pages/project/index.md)\n' },
      { path: 'pages/project/index.md', content: '# Project\n- [Preference](preference.md) — Project preference.\n' },
      { path: 'pages/project/preference.md', content: '# Preference\n\n## Sources\n- session:session-1\n' },
    ],
  };
}

function iso(now: number): string {
  return new Date(now).toISOString();
}
