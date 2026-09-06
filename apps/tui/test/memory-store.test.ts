import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { hydrateMemoryDirectory, memoryArtifactFingerprint, type MemoryArtifact } from '@felan-ai/ext-memory';
import { acquireLocalMemoryLease, type LocalMemoryLease } from '../src/memory/lease.js';
import { LocalMemoryStore, type LocalMemoryStoreOptions } from '../src/memory/store.js';

const temporaryPaths: string[] = [];
const leases: LocalMemoryLease[] = [];
const execFileAsync = promisify(execFile);
const faults = vi.hoisted(() => ({
  renameTarget: '',
  pauseRenameTarget: '',
  renamePaused: undefined as (() => void) | undefined,
  resumeRename: undefined as Promise<void> | undefined,
  rmTarget: '',
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    rename: async (...args: Parameters<typeof actual.rename>) => {
      if (faults.pauseRenameTarget && args[1] === faults.pauseRenameTarget) {
        faults.pauseRenameTarget = '';
        faults.renamePaused?.();
        await faults.resumeRename;
      }
      if (faults.renameTarget && args[1] === faults.renameTarget) {
        faults.renameTarget = '';
        throw new Error('Injected atomic-write failure');
      }
      return actual.rename(...args);
    },
    rm: async (...args: Parameters<typeof actual.rm>) => {
      if (faults.rmTarget && args[0] === faults.rmTarget) {
        faults.rmTarget = '';
        throw new Error('Injected recovery cleanup failure');
      }
      return actual.rm(...args);
    },
  };
});

afterEach(async () => {
  faults.renameTarget = '';
  faults.pauseRenameTarget = '';
  faults.renamePaused = undefined;
  faults.resumeRename = undefined;
  faults.rmTarget = '';
  await Promise.all(leases.splice(0).map((lease) => lease.release()));
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('local memory store', () => {
  it('initializes canonical current memory and records idempotent checkpoints', async () => {
    const { store } = await createStore();
    await expect(store.readCurrent()).resolves.toMatchObject({ files: expect.any(Array), fingerprint: expect.any(String) });
    const checkpoint = checkpointFor('session-1', 'a'.repeat(64));
    await expect(store.recordCheckpoint(checkpoint)).resolves.toBe(true);
    await expect(store.recordCheckpoint(checkpoint)).resolves.toBe(false);
    await expect(store.status()).resolves.toMatchObject({ pending: { 'session-1': { checkpoint } } });
  });

  it('restores project control when local eligibility changes during retry reset persistence', async () => {
    const { store } = await createStore();
    const before = await store.readControl();
    let eligible = true;
    let paused!: () => void;
    let resume!: () => void;
    const atRename = new Promise<void>((resolve) => { paused = resolve; });
    faults.resumeRename = new Promise<void>((resolve) => { resume = resolve; });
    faults.renamePaused = paused;
    faults.pauseRenameTarget = store.controlPath;

    const resetting = store.resetProjectControl(Date.now(), () => eligible);
    await atRename;
    eligible = false;
    resume();

    await expect(resetting).rejects.toThrow('Memory retry was cancelled');
    expect(await store.readControl()).toEqual(before);
  });

  it('projects current memory into session storage without making the projection authoritative', async () => {
    const { store, root } = await createStore();
    const sessionStorage = join(root, 'session-storage');
    const projection = await store.projectTo(sessionStorage);
    await expect(readFile(join(projection.memoryPath, 'summary.md'), 'utf8')).resolves.toBe('');
    await expect(readFile(join(projection.memoryPath, 'index.md'), 'utf8')).resolves.toContain(
      `Follow its ${projection.memoryPath} links`,
    );
    await writeFile(join(projection.memoryPath, 'summary.md'), 'agent edit', 'utf8');
    await expect(store.readCurrent()).resolves.toMatchObject({ files: expect.arrayContaining([{ path: 'summary.md', content: '' }]) });
    expect(store.currentDirectory).not.toContain(join('workspace', '.memory'));
  });

  it('keeps semantically broken memory readable and projectable', async () => {
    const { store, root } = await createStore();
    await writeFile(join(store.currentDirectory, 'summary.md'), '[Missing](pages/workflows/missing.md)', 'utf8');
    await writeFile(join(store.currentDirectory, 'index.md'), '# Incomplete index', 'utf8');
    await mkdir(join(store.currentDirectory, 'pages', 'workflows'), { recursive: true });
    await writeFile(
      join(store.currentDirectory, 'pages', 'workflows', 'release.md'),
      '# Release without navigation or provenance',
      'utf8',
    );

    await expect(store.readCurrent()).resolves.toMatchObject({
      files: expect.arrayContaining([
        { path: 'summary.md', content: '[Missing](pages/workflows/missing.md)' },
        { path: 'pages/workflows/release.md', content: '# Release without navigation or provenance' },
      ]),
    });
    await expect(store.projectTo(join(root, 'broken-memory-session'))).resolves.toMatchObject({
      memoryPath: expect.stringContaining('broken-memory-session'),
    });
  });

  it('publishes a validated artifact and acknowledges only matching pending cursors', async () => {
    const { store } = await createStore();
    const checkpoint = checkpointFor('session-1', 'b'.repeat(64));
    await store.recordCheckpoint(checkpoint);
    const processing = await store.processingSnapshot();
    const lease = await acquireLocalMemoryLease(store.projectDirectory);
    expect(lease).toBeDefined();
    const artifact = memoryArtifact();
    const fingerprint = await store.commit(lease!, processing.fingerprint, artifact, processing.checkpoints);
    expect(fingerprint).toMatch(/^[a-f0-9]{64}$/u);
    await lease!.release();

    const state = await store.status();
    expect(state.pending).toEqual({});
    expect(state.processed['session-1']).toMatchObject({ checkpoint, memoryFingerprint: fingerprint });
    await expect(store.readCurrent()).resolves.toMatchObject({
      fingerprint,
      files: [...artifact.files].sort((left, right) => left.path.localeCompare(right.path)),
    });
    expect(await store.status()).toMatchObject({ memoryFingerprint: fingerprint });
  });

  it('rejects a compare-and-swap commit when canonical memory changed', async () => {
    const { store } = await createStore();
    const processing = await store.processingSnapshot();
    const lease = await acquireLocalMemoryLease(store.projectDirectory);
    expect(lease).toBeDefined();
    await hydrateMemoryDirectory(memoryArtifact(), store.currentDirectory, { replace: true });
    await expect(store.commit(lease!, processing.fingerprint, memoryArtifact(), [])).rejects.toThrow(/changed/);
    await lease!.release();
    expect((await store.readCurrent()).files).toEqual(
      [...memoryArtifact().files].sort((left, right) => left.path.localeCompare(right.path)),
    );
  });

  it('does not acknowledge a newer cursor recorded while the artifact was being produced', async () => {
    const { store } = await createStore();
    const older = checkpointFor('session-1', 'a'.repeat(64));
    await store.recordCheckpoint(older);
    const processing = await store.processingSnapshot();
    const newer = checkpointFor('session-1', 'b'.repeat(64));
    await store.recordCheckpoint(newer);
    await store.commit(await writer(store), processing.fingerprint, memoryArtifact(), processing.checkpoints);
    expect((await store.status()).pending['session-1']?.checkpoint).toEqual(newer);
    expect((await store.status()).processed['session-1']?.checkpoint).toEqual(older);
  });

  it('preserves every pending cursor when recovering a legacy session-ID-only journal', async () => {
    const { store } = await createStore();
    await store.recordCheckpoint(checkpointFor('session-1', 'a'.repeat(64)));
    const old = await store.processingSnapshot();
    const directory = await store.createStagingDirectory();
    await hydrateMemoryDirectory(memoryArtifact(), join(directory, 'memory'));
    const fingerprint = memoryArtifactFingerprint(memoryArtifact());
    await writeFile(join(directory, 'commit.json'), JSON.stringify({
      version: 1, baseFingerprint: old.fingerprint, fingerprint, processed: ['session-1'],
    }));
    await rename(store.currentDirectory, join(directory, 'previous'));
    await rename(join(directory, 'memory'), store.currentDirectory);
    const newer = checkpointFor('session-1', 'b'.repeat(64));
    await store.recordCheckpoint(newer);
    await store.initialize();
    expect((await store.status()).pending['session-1']?.checkpoint).toEqual(newer);
    expect((await store.status()).processed).toEqual({});
    expect((await store.status()).memoryFingerprint).toBe(fingerprint);
    expect((await store.readCurrent()).fingerprint).toBe(fingerprint);
  });

  it('rolls back a state-write failure without acknowledging input or changing control', async () => {
    const { store } = await createStore();
    await store.recordCheckpoint(checkpointFor('session-1', 'a'.repeat(64)));
    const snapshot = await store.processingSnapshot();
    const lease = await writer(store);
    const active = await store.beginAttempt(lease, {
      runId: 'rollback', baseFingerprint: snapshot.fingerprint, checkpoints: snapshot.checkpoints,
    });
    const beforeControl = await store.readControl();
    const beforeState = await readFile(store.statePath, 'utf8');
    faults.renameTarget = store.statePath;
    await expect(store.commit(lease, snapshot.fingerprint, memoryArtifact(), snapshot.checkpoints, active)).rejects.toThrow('Injected');
    expect((await store.readCurrent()).fingerprint).toBe(snapshot.fingerprint);
    expect(await store.readControl()).toEqual(beforeControl);
    expect(await readFile(store.statePath, 'utf8')).toBe(beforeState);
    expect(await readdir(store.stagingDirectory)).toEqual([]);
  });

  it('preserves published journal evidence if control finalization fails after state acknowledgement', async () => {
    const { store } = await createStore();
    await store.recordCheckpoint(checkpointFor('session-1', 'a'.repeat(64)));
    const snapshot = await store.processingSnapshot();
    const lease = await writer(store);
    const active = await store.beginAttempt(lease, {
      runId: 'control-write-crash', baseFingerprint: snapshot.fingerprint, checkpoints: snapshot.checkpoints,
    });
    faults.renameTarget = store.controlPath;
    await expect(store.commit(lease, snapshot.fingerprint, memoryArtifact(), snapshot.checkpoints, active)).rejects.toThrow('Injected');
    const fingerprint = memoryArtifactFingerprint(memoryArtifact());
    expect((await store.readCurrent()).fingerprint).toBe(fingerprint);
    expect((await store.status()).pending).toEqual({});
    expect((await store.readControl()).activeAttempt?.published).toBeUndefined();
    const [directory] = await readdir(store.stagingDirectory);
    expect(JSON.parse(await readFile(join(store.stagingDirectory, directory!, 'commit.json'), 'utf8'))).toMatchObject({
      version: 2, phase: 'published', checkpoints: snapshot.checkpoints,
      attempt: { runId: active!.runId, generation: active!.generation, leaseToken: lease.token },
    });
    await lease.release();
    const recovered = await store.reconcileAbandonedAttempt(await writer(store));
    expect(recovered.lastOutcome?.status).toBe('success');
    expect(recovered.consecutiveFailures).toBe(0);
    expect(await readdir(store.stagingDirectory)).toEqual([]);
  });

  it('does not roll back a completed publication if reset occurs before journal cleanup recovery', async () => {
    const { store } = await createStore();
    await store.recordCheckpoint(checkpointFor('session-1', 'a'.repeat(64)));
    const snapshot = await store.processingSnapshot();
    const lease = await writer(store);
    const active = await store.beginAttempt(lease, {
      runId: 'reset-after-commit', baseFingerprint: snapshot.fingerprint, checkpoints: snapshot.checkpoints,
    });
    faults.renameTarget = store.controlPath;
    await expect(store.commit(lease, snapshot.fingerprint, memoryArtifact(), snapshot.checkpoints, active)).rejects.toThrow('Injected');
    const reset = await store.resetProjectControl();
    const newer = checkpointFor('session-1', 'b'.repeat(64));
    await store.recordCheckpoint(newer);
    await lease.release();
    const recovered = await store.reconcileAbandonedAttempt(await writer(store));
    expect(recovered).toEqual(reset);
    expect((await store.readCurrent()).fingerprint).toBe(memoryArtifactFingerprint(memoryArtifact()));
    expect((await store.status()).pending['session-1']?.checkpoint).toEqual(newer);
  });

  it.each(['cancel', 'reset'] as const)('recognizes committed success during %s without waiting for the writer lease', async (action) => {
    const { store } = await createStore({ retryDelaysMs: [0, 0] });
    await store.recordCheckpoint(checkpointFor('session-1', 'a'.repeat(64)));
    const snapshot = await store.processingSnapshot();
    const lease = await writer(store);
    const failed = await store.beginAttempt(lease, {
      runId: 'earlier-failure', baseFingerprint: snapshot.fingerprint, checkpoints: snapshot.checkpoints,
    });
    await store.finishAttempt(lease, failed!, { status: 'failure', reason: 'failed' });
    const active = await store.beginAttempt(lease, {
      runId: 'published-before-cancel', baseFingerprint: snapshot.fingerprint, checkpoints: snapshot.checkpoints,
    });
    faults.renameTarget = store.controlPath;
    await expect(store.commit(lease, snapshot.fingerprint, memoryArtifact(), snapshot.checkpoints, active)).rejects.toThrow('Injected');
    const other = new LocalMemoryStore(store.agentDir, store.project);
    const completed = action === 'cancel'
      ? await other.finishAttempt(undefined, active!, { status: 'cancelled' })
      : await other.resetProjectControl();
    expect(completed).toMatchObject({ consecutiveFailures: 0, generation: active!.generation + 1, lastOutcome: { status: 'success' } });
    expect(completed.nextRetryAt).toBeUndefined();
    expect(await lease.verify()).toBe(true);
    await lease.release();
    expect(await store.reconcileAbandonedAttempt(await writer(store))).toEqual(completed);
    expect((await store.readCurrent()).fingerprint).toBe(memoryArtifactFingerprint(memoryArtifact()));
  });

  it('recovers an interrupted failure-state write exactly once', async () => {
    const { store } = await createStore();
    await store.recordCheckpoint(checkpointFor('session-1', 'a'.repeat(64)));
    const snapshot = await store.processingSnapshot();
    const lease = await writer(store);
    const active = await store.beginAttempt(lease, {
      runId: 'failure-state-crash', baseFingerprint: snapshot.fingerprint, checkpoints: snapshot.checkpoints,
    });
    faults.renameTarget = store.controlPath;
    await expect(store.finishAttempt(lease, active!, { status: 'failure', reason: 'failed' })).rejects.toThrow('Injected');
    expect((await store.readControl()).consecutiveFailures).toBe(0);
    await lease.release();
    const nextLease = await writer(store);
    const recovered = await store.reconcileAbandonedAttempt(nextLease);
    expect(recovered.consecutiveFailures).toBe(0);
    expect(await store.reconcileAbandonedAttempt(nextLease)).toEqual(recovered);
    expect((await store.status()).pending).toEqual(snapshot.state.pending);
  });

  it('retains proof of commit when writing the success outcome fails', async () => {
    const { store } = await createStore();
    await store.recordCheckpoint(checkpointFor('session-1', 'a'.repeat(64)));
    const snapshot = await store.processingSnapshot();
    const lease = await writer(store);
    const active = await store.beginAttempt(lease, {
      runId: 'success-outcome-crash', baseFingerprint: snapshot.fingerprint, checkpoints: snapshot.checkpoints,
    });
    const fingerprint = await store.commit(lease, snapshot.fingerprint, memoryArtifact(), snapshot.checkpoints, active);
    faults.renameTarget = store.controlPath;
    await expect(store.finishAttempt(lease, active!, { status: 'success' })).rejects.toThrow('Injected');
    expect((await store.readControl()).activeAttempt?.published?.fingerprint).toBe(fingerprint);
    await lease.release();
    const nextLease = await writer(store);
    const recovered = await store.reconcileAbandonedAttempt(nextLease);
    expect(recovered).toMatchObject({ consecutiveFailures: 0, lastOutcome: { status: 'success' } });
    expect((await store.status()).pending).toEqual({});
    expect(await store.reconcileAbandonedAttempt(nextLease)).toEqual(recovered);
  });

  it('keeps lease-loss rollback fenced and leaves checkpoints pending', async () => {
    const { store } = await createStore();
    await store.recordCheckpoint(checkpointFor('session-1', 'a'.repeat(64)));
    const snapshot = await store.processingSnapshot();
    const lease = await writer(store);
    let verifications = 0;
    const compromised = { ...lease, verify: async () => ++verifications < 4 && await lease.verify() };
    await expect(store.commit(compromised, snapshot.fingerprint, memoryArtifact(), snapshot.checkpoints)).rejects.toThrow('after replacement');
    expect((await store.readCurrent()).fingerprint).toBe(snapshot.fingerprint);
    expect((await store.status()).pending).toEqual(snapshot.state.pending);
  });

  it('makes unchanged-output recovery idempotent before transaction cleanup', async () => {
    const { store } = await createStore();
    await store.recordCheckpoint(checkpointFor('session-1', 'a'.repeat(64)));
    const snapshot = await store.processingSnapshot();
    const lease = await writer(store);
    const active = await store.beginAttempt(lease, {
      runId: 'unchanged-recovery',
      baseFingerprint: snapshot.fingerprint,
      checkpoints: snapshot.checkpoints,
          });
    const staging = await store.createStagingDirectory();
    await hydrateMemoryDirectory(snapshot.artifact, join(staging, 'memory'));
    await writeFile(join(staging, 'commit.json'), JSON.stringify({
      version: 2,
      phase: 'published',
      baseFingerprint: snapshot.fingerprint,
      fingerprint: snapshot.fingerprint,
      checkpoints: snapshot.checkpoints,
      attempt: { ...active, leaseToken: lease.token },
    }));
    await rename(store.currentDirectory, join(staging, 'previous'));
    await rename(join(staging, 'memory'), store.currentDirectory);
    await lease.release();
    const recovered = new LocalMemoryStore(store.agentDir, store.project);
    faults.rmTarget = staging;

    await expect(recovered.initialize()).rejects.toThrow('Injected recovery cleanup failure');
    expect(JSON.parse(await readFile(join(staging, 'commit.json'), 'utf8'))).toMatchObject({ phase: 'published' });
    expect((await recovered.readCurrent()).fingerprint).toBe(snapshot.fingerprint);

    await expect(recovered.initialize()).resolves.toBeUndefined();
    expect(await readdir(recovered.stagingDirectory)).toEqual([]);
    expect(Object.keys((await recovered.status()).pending)).toHaveLength(1);
  });

  it.each(['{malformed', '{"version":2}', '{"version":1,"pending":{}}'])('preserves invalid canonical state rather than reinitializing %s', async (state) => {
    const { store } = await createStore();
    await writeFile(store.statePath, state);
    await expect(store.initialize()).rejects.toThrow();
    expect(await readFile(store.statePath, 'utf8')).toBe(state);
  });

  it.each(['{malformed', '{"version":3}', '{"version":1}'])('preserves unsupported or malformed journal evidence %s', async (journal) => {
    const { store } = await createStore();
    const directory = await store.createStagingDirectory();
    const path = join(directory, 'commit.json');
    await writeFile(path, journal);
    await expect(store.initialize()).rejects.toThrow('journal');
    expect(await readFile(path, 'utf8')).toBe(journal);
  });

  it('rejects symlinked transaction directories without mutating their targets or canonical memory', async () => {
    const { store, root } = await createStore();
    const original = await store.readCurrent();
    const external = join(root, 'external-transaction');
    const previous = join(external, 'previous');
    await mkdir(external);
    await hydrateMemoryDirectory({ version: 1, files: original.files }, previous);
    await writeFile(join(external, 'sentinel.txt'), 'outside storage');
    await writeFile(join(external, 'commit.json'), JSON.stringify({
      version: 2,
      phase: 'rolled_back',
      baseFingerprint: original.fingerprint,
      fingerprint: memoryArtifactFingerprint(memoryArtifact()),
      checkpoints: [],
    }));
    await hydrateMemoryDirectory(memoryArtifact(), store.currentDirectory, { replace: true });
    const changed = await store.readCurrent();
    await symlink(external, join(store.stagingDirectory, 'run-external'));

    await expect(store.initialize()).rejects.toThrow(/unsafe transaction/u);
    expect(await readFile(join(external, 'sentinel.txt'), 'utf8')).toBe('outside storage');
    await expect(readFile(join(previous, 'summary.md'), 'utf8')).resolves.toBe('');
    expect((await store.readCurrent()).fingerprint).toBe(changed.fingerprint);
  });

  it.skipIf(process.platform === 'win32')('rejects a FIFO commit journal without blocking recovery', async () => {
    const { store } = await createStore();
    const transaction = join(store.stagingDirectory, 'run-fifo');
    await mkdir(transaction);
    const journal = join(transaction, 'commit.json');
    await execFileAsync('mkfifo', [journal]);

    await expect(store.initialize()).rejects.toThrow('commit journal is unsafe');
    expect((await stat(journal)).isFIFO()).toBe(true);
  });
});

async function writer(store: LocalMemoryStore): Promise<LocalMemoryLease> {
  const lease = await acquireLocalMemoryLease(store.projectDirectory);
  expect(lease).toBeDefined();
  leases.push(lease!);
  return lease!;
}

async function createStore(options: LocalMemoryStoreOptions = {}): Promise<{ root: string; store: LocalMemoryStore }> {
  const root = await mkdtemp(join(tmpdir(), 'felan-memory-store-'));
  temporaryPaths.push(root);
  const project = { canonicalRoot: join(root, 'workspace'), key: '1'.repeat(64) };
  await mkdir(project.canonicalRoot, { recursive: true });
  const store = new LocalMemoryStore(join(root, 'agent'), project, options);
  await store.initialize();
  return { root, store };
}

function checkpointFor(sessionId: string, digest: string) {
  return {
    sessionId,
    sessionFile: `/sessions/${sessionId}.jsonl`,
    leafId: 'leaf-1',
    transcriptDigest: digest,
  } as const;
}

function memoryArtifact(): MemoryArtifact {
  return {
    version: 1,
    files: [
      { path: 'summary.md', content: 'Durable project preference.' },
      { path: 'index.md', content: '# Memory index\n\n## How to use this memory\n\n## Memory map\n- [Workflow](.memory/pages/workflows/index.md)\n' },
      { path: 'pages/workflows/index.md', content: '# workflows index\n- [Workflow](workflow.md) — Durable workflow.\n' },
      { path: 'pages/workflows/workflow.md', content: '# Workflow\n\n## Sources\n- session:session-1\n' },
    ],
  };
}
