import { LocalMemoryStore as Store } from '../../src/local/store.js';
import type { LocalMemoryCoordinator } from './backend.js';
import { beforeEach as beforeMemoryTest } from "vitest";
import { createMemoryBackend } from './backend.js';
import type { LocalMemoryStore } from './backend.js';
let { LocalMemoryCoordinator, createDefaultLocalMemoryDreamRunner, acquireLocalMemoryLease, resolveLocalMemoryProject, LocalMemoryStore, faults } = createMemoryBackend();
beforeMemoryTest(() => { ({ LocalMemoryCoordinator, createDefaultLocalMemoryDreamRunner, acquireLocalMemoryLease, resolveLocalMemoryProject, LocalMemoryStore, faults } = createMemoryBackend()); });
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createEmptyMemoryArtifact,
  createMemorySnapshot,
  createSessionCheckpoint,
  digestActiveBranch,
  MEMORY_CONTEXT_CUSTOM_TYPE,
  removeMemoryContextEntries,
  type MemoryArtifact,
} from '@felan-ai/ext-memory';
import { SessionManager, type Api, type Model, type ModelsService } from '@felan-ai/agent-core';



import type { LocalMemoryDreamInput } from '../../src/local/dreamer.js';


import { localMemoryProjectDirectory } from './backend.js';




const temporaryPaths: string[] = [];
const memoryFixtureCleanups = new Set<() => Promise<void>>();

afterEach(async () => {
  const results = await Promise.allSettled([cleanupMemoryFixtures()]);
  results.push(...await Promise.allSettled(
    temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  ));
  throwCleanupFailures(results);
});

describe('LocalMemoryCoordinator', () => {
  it('drains an accepted memory run without aborting it or starting more work', async () => {
    const root = await temporaryDirectory(); const cwd = join(root, 'workspace'); await mkdir(cwd);
    const sessionFile = await writeSession(cwd, 'session-1'); const entered = deferred(); const release = deferred();
    let signal: AbortSignal | undefined; let calls = 0;
    const coordinator = new LocalMemoryCoordinator({ agentDir: join(root, 'agent'), models: {} as unknown as import('@felan-ai/agent-core').ModelsService, recover: false,
      dreamRunner: async input => { calls++; signal = input.signal; entered.resolve(); await release.promise; return updatedArtifact(); } });
    const fixture = trackMemoryFixture(coordinator, release.resolve);
    await coordinator.createSessionHost({ cwd, sessionStorageRoot: join(root, 'session-storage') }).recordCheckpoint(checkpointFor(sessionFile));
    const running = fixture.runNow(cwd); await waitForMemoryMilestone(entered.promise, running, 'runner entry');
    let settled = false; const draining = coordinator.drain().then(() => { settled = true; });
    await Promise.resolve(); expect(settled).toBe(false); expect(signal?.aborted).toBe(false);
    release.resolve(); await draining; await running;
    expect(signal?.aborted).toBe(false); expect(coordinator.isEnabled()).toBe(true);
    await coordinator.runNow(cwd); expect(calls).toBe(1); await fixture.cleanup();
  });

  it('preserves pending checkpoints while a drained coordinator refuses new processing', async () => {
    const root = await temporaryDirectory(); const cwd = join(root, 'workspace'); await mkdir(cwd);
    const sessionFile = await writeSession(cwd, 'session-1'); let calls = 0;
    const coordinator = new LocalMemoryCoordinator({ agentDir: join(root, 'agent'), models: {} as unknown as import('@felan-ai/agent-core').ModelsService, recover: false,
      dreamRunner: async () => { calls++; return updatedArtifact(); } });
    const fixture = trackMemoryFixture(coordinator);
    await coordinator.createSessionHost({ cwd, sessionStorageRoot: join(root, 'session-storage') }).recordCheckpoint(checkpointFor(sessionFile));
    await Promise.all([coordinator.drain(), coordinator.drain()]);
    expect(await coordinator.runNow(cwd)).toMatchObject({ pendingCheckpoints: 1 });
    expect(await coordinator.retryProject(cwd)).toMatchObject({ pendingCheckpoints: 1 });
    expect(calls).toBe(0); await fixture.cleanup();
  });

  it('rejects invalid batch sizes', () => {
    expect(() => new LocalMemoryCoordinator({
      agentDir: '/tmp/felan-memory-test',
      models: {} as unknown as import('@felan-ai/agent-core').ModelsService,
      batchSize: 0,
    })).toThrow('Memory batch size must be a positive safe integer');
  });

  it('passes the selected root-session model and model scope to the dream runner', async () => {
    const root = await temporaryDirectory();
    const cwd = join(root, 'workspace');
    await mkdir(cwd, { recursive: true });
    const sessionFile = await writeSession(cwd, 'session-1');
    const selectedModel = { provider: 'openai-codex', id: 'gpt-5.6-sol' } as Model<Api>;
    const lowTierModel = { provider: 'openai-codex', id: 'gpt-5.6-luna' } as Model<Api>;
    const classifier = { classify: async () => ({ answers: {} }) };
    let observedModel: Model<Api> | undefined;
    let observedScope: readonly Model<Api>[] | undefined;
    let observedClassifier: import('@felan-ai/agent-core').Classifier | undefined;
    const coordinator = new LocalMemoryCoordinator({
      agentDir: join(root, 'agent'),
      models: {} as unknown as import('@felan-ai/agent-core').ModelsService,
      recover: false,
      selectedModel,
      scopedModels: [selectedModel, lowTierModel],
      classifier,
      dreamRunner: async (input) => {
        observedModel = input.selectedModel;
        observedScope = input.scopedModels;
        observedClassifier = input.classifier;
        return updatedArtifact();
      },
    });
    const host = coordinator.createSessionHost({ cwd, sessionStorageRoot: join(root, 'session-storage') });
    await host.recordCheckpoint(checkpointFor(sessionFile));

    await expect(coordinator.runNow(cwd)).resolves.toMatchObject({ state: 'idle', pendingCheckpoints: 0 });
    expect(observedModel).toBe(selectedModel);
    expect(observedScope).toEqual([selectedModel, lowTierModel]);
    expect(observedClassifier).toBe(classifier);
    await coordinator.dispose();
  });

  it('notifies status subscribers when the pending count changes', async () => {
    const root = await temporaryDirectory();
    const cwd = join(root, 'workspace');
    await mkdir(cwd, { recursive: true });
    const sessionFile = await writeSession(cwd, 'session-1');
    const coordinator = new LocalMemoryCoordinator({
      agentDir: join(root, 'agent'),
      models: {} as unknown as import('@felan-ai/agent-core').ModelsService,
      recover: false,
      dreamRunner: async () => updatedArtifact(),
    });
    const statusChanged = vi.fn();
    const unsubscribe = coordinator.subscribeStatusChanges(statusChanged);
    const host = coordinator.createSessionHost({ cwd, sessionStorageRoot: join(root, 'session-storage') });

    await host.recordCheckpoint(checkpointFor(sessionFile));
    expect(statusChanged).toHaveBeenCalledTimes(1);
    await coordinator.runNow(cwd);
    expect(statusChanged).toHaveBeenCalledTimes(3);

    unsubscribe();
    await coordinator.dispose();
  });

  it('runs explicit processing and ignores duplicate cursors', async () => {
    const root = await temporaryDirectory();
    const cwd = join(root, 'workspace');
    await mkdir(cwd, { recursive: true });
    const sessionFile = await writeSession(cwd, 'session-1');
    let runs = 0;
    const coordinator = new LocalMemoryCoordinator({
      agentDir: join(root, 'agent'),
      models: {} as unknown as import('@felan-ai/agent-core').ModelsService,
      recover: false,
      dreamRunner: async () => {
        runs += 1;
        return updatedArtifact();
      },
    });
    const host = coordinator.createSessionHost({ cwd, sessionStorageRoot: join(root, 'session-storage') });
    const checkpoint = checkpointFor(sessionFile);
    await host.recordCheckpoint(checkpoint);
    await host.recordCheckpoint(checkpoint);

    await coordinator.runNow(cwd);
    expect(runs).toBe(1);

    await host.recordCheckpoint(checkpoint);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(runs).toBe(1);
    await coordinator.dispose();
  });

  it('waits for five accepted checkpoints and 24 hours after publication', async () => {
    const root = await temporaryDirectory();
    const cwd = join(root, 'workspace');
    await mkdir(cwd, { recursive: true });
    const firstSessionFile = await writeSession(cwd, 'first-session');
    let now = Date.now();
    let runs = 0;
    const coordinator = new LocalMemoryCoordinator({
      agentDir: join(root, 'agent'),
      models: {} as unknown as import('@felan-ai/agent-core').ModelsService,
      recover: false,
      now: () => now,
      monitorIntervalMs: 60 * 60 * 1_000,
      dreamRunner: async () => {
        runs += 1;
        return updatedArtifact();
      },
    });
    const host = coordinator.createSessionHost({ cwd, sessionStorageRoot: join(root, 'session-storage') });
    const intervalMs = 24 * 60 * 60 * 1_000;

    let entries = sessionEntries();
    const recordUpdates = async (count: number): Promise<void> => {
      for (let index = 0; index < count; index += 1) {
        const id = `update-${runs}-${index}`;
        entries = [...entries, {
          type: 'message', id, parentId: entries.at(-1)!.id,
          timestamp: `2026-01-01T00:01:${String(runs * 10 + index).padStart(2, '0')}.000Z`,
          message: { role: 'user', content: `accepted update ${runs}-${index}` },
        }];
        await writeFile(firstSessionFile, [
          JSON.stringify({ type: 'session', version: 3, id: 'first-session', cwd }),
          ...entries.map((entry) => JSON.stringify(entry)), '',
        ].join('\n'));
        await host.recordCheckpoint({
          sessionId: 'first-session', sessionFile: firstSessionFile, leafId: id,
          transcriptDigest: digestActiveBranch(removeMemoryContextEntries(entries)),
        });
      }
    };

    try {
      await recordUpdates(5);
      expect(await coordinator.status(cwd)).toMatchObject({ pendingCheckpoints: 1 });
      await coordinator.runNow(cwd);
      expect(runs).toBeGreaterThanOrEqual(1);
      now += intervalMs - 1;
      await recordUpdates(5);
      expect(await coordinator.status(cwd)).toMatchObject({ pendingCheckpoints: 1 });
      now += 1;
      await coordinator.runNow(cwd);
      expect(runs).toBeGreaterThanOrEqual(2);
      expect(await coordinator.status(cwd)).toMatchObject({ pendingCheckpoints: 1 });
    } finally {
      await coordinator.dispose();
    }
  });

  it('batches a root checkpoint, redacts/bounds evidence, publishes, and refreshes the projection', async () => {
    const root = await temporaryDirectory();
    const cwd = join(root, 'workspace');
    const agentDir = join(root, 'agent');
    const sessionStorageRoot = join(agentDir, 'storage', 'sessions', 'root-1');
    await mkdir(cwd, { recursive: true });
    const sessionFile = await writeSession(cwd, 'session-1');
    const entries = sessionEntries();
    const observed: { input?: LocalMemoryDreamInput; transcripts: string[] } = { transcripts: [] };
    const coordinator = new LocalMemoryCoordinator({
      agentDir,
      models: {} as unknown as import('@felan-ai/agent-core').ModelsService,
      recover: false,
      maxTranscriptBytes: 4 * 1024,
      dreamRunner: async (input) => {
        observed.input = input;
        const session = input.manifest.sessions[0]!;
        observed.transcripts.push(await readFile(join(input.inputDirectory, session.transcriptPath), 'utf8'));
        return updatedArtifact();
      },
    });
    const host = coordinator.createSessionHost({ cwd, sessionStorageRoot });
    await host.readCurrent();
    await host.recordCheckpoint({
      sessionId: 'session-1',
      sessionFile,
      leafId: 'entry-2',
      transcriptDigest: digestActiveBranch(removeMemoryContextEntries(entries)),
    });

    const status = await coordinator.runNow(cwd);
    expect(status).toMatchObject({ state: 'idle', pendingCheckpoints: 0 });
    expect(observed.input?.manifest.sessions).toHaveLength(1);
    expect(observed.transcripts[0]).toContain('[REDACTED_SECRET]');
    expect(observed.transcripts[0]).not.toContain('sk-super-secret-token');
    expect(observed.transcripts[0]).not.toContain(MEMORY_CONTEXT_CUSTOM_TYPE);
    expect(observed.transcripts[0]).not.toContain('old memory must not be ingested');
    expect(observed.transcripts[0]).not.toContain('abandoned branch');
    expect(Buffer.byteLength(observed.transcripts[0]!, 'utf8')).toBeLessThanOrEqual(4 * 1024);
    const refreshed = await host.readCurrent();
    expect(refreshed).toMatchObject({ files: expect.arrayContaining([
      { path: 'summary.md', content: 'The project prefers focused changes.' },
    ]) });
    const projectedIndex = refreshed!.files.find(({ path }) => path === 'index.md')?.content;
    const projectionPath = join(sessionStorageRoot, '.memory');
    expect(projectedIndex).toContain(`[Workflow](${projectionPath}/pages/workflows/index.md)`);
    await expect(access(join(cwd, '.memory'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(sessionStorageRoot, '.memory', 'summary.md'), 'utf8')).toBe('The project prefers focused changes.');
    expect(await readFile(join(sessionStorageRoot, '.memory', 'index.md'), 'utf8')).toContain(
      `[Workflow](${projectionPath}/pages/workflows/index.md)`,
    );

    await writeResumedSession(sessionFile, cwd);
    await host.recordCheckpoint(resumedCheckpointFor(sessionFile));
    await coordinator.runNow(cwd);
    expect(observed.transcripts[1]).toContain('new settled branch evidence');
    expect(observed.transcripts[1]).not.toContain('Focused changes are preferred');
    await coordinator.dispose();
  });

  it('keeps evidence pending and requires an explicit project retry to bypass backoff', async () => {
    const root = await temporaryDirectory();
    const cwd = join(root, 'workspace');
    await mkdir(cwd, { recursive: true });
    const sessionFile = await writeSession(cwd, 'session-1');
    let shouldFail = true;
    const coordinator = new LocalMemoryCoordinator({
      agentDir: join(root, 'agent'),
      models: {} as unknown as import('@felan-ai/agent-core').ModelsService,
      recover: false,
      dreamRunner: async () => {
        if (shouldFail) {
          shouldFail = false;
          throw new Error('model unavailable');
        }
        return updatedArtifact();
      },
    });
    const host = coordinator.createSessionHost({ cwd, sessionStorageRoot: join(root, 'session-storage') });
    await host.recordCheckpoint(checkpointFor(sessionFile));

    await expect(coordinator.runNow(cwd)).resolves.toMatchObject({ state: 'scheduled', pendingCheckpoints: 1, consecutiveFailures: 1 });
    await expect(coordinator.runNow(cwd)).resolves.toMatchObject({ state: 'idle', pendingCheckpoints: 0, consecutiveFailures: 0 });
    await expect(coordinator.retryProject(cwd)).resolves.toMatchObject({ state: 'idle', pendingCheckpoints: 0, consecutiveFailures: 0 });
    await coordinator.dispose();
  });

  it('aborts an active worker when the writer lease is compromised without crashing TUI', async () => {
    const root = await temporaryDirectory();
    const cwd = join(root, 'workspace');
    const agentDir = join(root, 'agent');
    await mkdir(cwd, { recursive: true });
    const sessionFile = await writeSession(cwd, 'session-1');
    const project = await resolveLocalMemoryProject(cwd);
    const writerLock = join(localMemoryProjectDirectory(agentDir, project), 'writer.lock');
    let workerSawAbort = false;
    const coordinator = new LocalMemoryCoordinator({
      agentDir,
      models: {} as unknown as import('@felan-ai/agent-core').ModelsService,
      recover: false,
      leaseOptions: { staleMs: 2_000, updateMs: 1_000 },
      dreamRunner: async ({ signal }) => {
        const changedAt = new Date(Date.now() + 5_000);
        await utimes(writerLock, changedAt, changedAt);
        await waitFor(() => signal.aborted);
        workerSawAbort = true;
        throw new Error('worker aborted after lease compromise');
      },
    });
    const host = coordinator.createSessionHost({ cwd, sessionStorageRoot: join(root, 'session-storage') });
    await host.recordCheckpoint(checkpointFor(sessionFile));

    await expect(coordinator.runNow(cwd)).resolves.toMatchObject({
      state: 'error',
      pendingCheckpoints: 1,
      message: 'Memory writer lease was lost; evidence remains pending',
    });
    expect(workerSawAbort).toBe(true);
    await coordinator.dispose();
  });

  it('processes valid checkpoints when another checkpoint has changed evidence', async () => {
    const root = await temporaryDirectory();
    const cwd = join(root, 'workspace');
    await mkdir(cwd, { recursive: true });
    const badSessionFile = await writeSession(cwd, 'bad-session');
    const validSessionFile = await writeSession(cwd, 'valid-session');
    const observedSessionIds: string[] = [];
    let runs = 0;
    const coordinator = new LocalMemoryCoordinator({
      agentDir: join(root, 'agent'),
      models: {} as unknown as import('@felan-ai/agent-core').ModelsService,
      recover: false,
      debounceMs: 0,
      dreamRunner: async (input) => {
        runs += 1;
        observedSessionIds.push(...input.manifest.sessions.map(({ checkpoint }) => checkpoint.sessionId));
        return updatedArtifact('valid-session');
      },
    });
    const host = coordinator.createSessionHost({ cwd, sessionStorageRoot: join(root, 'session-storage') });
    await host.recordCheckpoint({
      ...checkpointFor(badSessionFile, 'bad-session'),
      transcriptDigest: '0'.repeat(64),
    });
    await host.recordCheckpoint(checkpointFor(validSessionFile, 'valid-session'));

    await expect(coordinator.runNow(cwd)).resolves.toMatchObject({
      pendingCheckpoints: 1,
      state: 'blocked',
      message: 'Some memory checkpoints could not be materialized; evidence remains pending',
    });
    expect(runs).toBe(1);
    expect(observedSessionIds).toEqual(['valid-session']);

    await host.recordCheckpoint(checkpointFor(badSessionFile, 'bad-session'));
    await expect(coordinator.runNow(cwd)).resolves.toMatchObject({ pendingCheckpoints: 0 });
    expect(runs).toBe(2);
    await coordinator.dispose();
  });

  it('runs checkpoints recorded while a scheduled worker is active', async () => {
    const root = await temporaryDirectory();
    const cwd = join(root, 'workspace');
    await mkdir(cwd, { recursive: true });
    const firstSessionFile = await writeSession(cwd, 'first-session');
    const secondSessionFile = await writeSession(cwd, 'second-session');
    let firstStartedResolve!: () => void;
    let secondStartedResolve!: () => void;
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    const firstStarted = new Promise<void>((resolve) => { firstStartedResolve = resolve; });
    const secondStarted = new Promise<void>((resolve) => { secondStartedResolve = resolve; });
    const firstReleased = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const secondReleased = new Promise<void>((resolve) => { releaseSecond = resolve; });
    const observedSessionIds: string[] = [];
    let runs = 0;
    const coordinator = new LocalMemoryCoordinator({
      agentDir: join(root, 'agent'),
      models: {} as unknown as import('@felan-ai/agent-core').ModelsService,
      recover: false,
      debounceMs: 0,
      dreamRunner: async (input) => {
        runs += 1;
        const sessionId = input.manifest.sessions[0]!.checkpoint.sessionId;
        observedSessionIds.push(sessionId);
        if (runs === 1) {
          firstStartedResolve();
          await firstReleased;
        } else {
          secondStartedResolve();
          await secondReleased;
        }
        return updatedArtifact(sessionId);
      },
    });
    const host = coordinator.createSessionHost({ cwd, sessionStorageRoot: join(root, 'session-storage') });

    try {
      await host.recordCheckpoint(checkpointFor(firstSessionFile, 'first-session'));
      const firstRun = coordinator.runNow(cwd);
      await firstStarted;
      await host.recordCheckpoint(checkpointFor(secondSessionFile, 'second-session'));
      releaseFirst();

      await expect(firstRun).resolves.toMatchObject({ state: 'idle', pendingCheckpoints: 1 });
      const secondRun = coordinator.runNow(cwd);
      await secondStarted;
      releaseSecond();
      await secondRun;
      expect(runs).toBe(2);
      expect(observedSessionIds).toEqual(['first-session', 'second-session']);
    } finally {
      releaseFirst();
      releaseSecond();
      await coordinator.dispose();
    }
  });

  it('schedules checkpoints recorded while a forced worker is active', async () => {
    const root = await temporaryDirectory();
    const cwd = join(root, 'workspace');
    await mkdir(cwd, { recursive: true });
    const firstSessionFile = await writeSession(cwd, 'first-session');
    const secondSessionFile = await writeSession(cwd, 'second-session');
    let firstStartedResolve!: () => void;
    let releaseFirst!: () => void;
    const firstStarted = new Promise<void>((resolve) => { firstStartedResolve = resolve; });
    const firstReleased = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let runs = 0;
    const coordinator = new LocalMemoryCoordinator({
      agentDir: join(root, 'agent'),
      models: {} as unknown as import('@felan-ai/agent-core').ModelsService,
      recover: false,
      debounceMs: 60_000,
      dreamRunner: async (input) => {
        runs += 1;
        if (runs === 1) {
          firstStartedResolve();
          await firstReleased;
        }
        return updatedArtifact(input.manifest.sessions[0]!.checkpoint.sessionId);
      },
    });
    const host = coordinator.createSessionHost({ cwd, sessionStorageRoot: join(root, 'session-storage') });

    try {
      await host.recordCheckpoint(checkpointFor(firstSessionFile, 'first-session'));
      const firstRun = coordinator.runNow(cwd);
      await firstStarted;
      await host.recordCheckpoint(checkpointFor(secondSessionFile, 'second-session'));
      releaseFirst();

      await expect(firstRun).resolves.toMatchObject({ state: 'idle', pendingCheckpoints: 1 });
      await expect(coordinator.runNow(cwd)).resolves.toMatchObject({ state: 'idle', pendingCheckpoints: 0 });
      expect(runs).toBe(2);
    } finally {
      releaseFirst();
      await coordinator.dispose();
    }
  });

  it('suspends an all-invalid batch until its cursor changes', async () => {
    const root = await temporaryDirectory();
    const cwd = join(root, 'workspace');
    await mkdir(cwd, { recursive: true });
    const sessionFile = await writeSession(cwd, 'session-1');
    let runs = 0;
    const coordinator = new LocalMemoryCoordinator({
      agentDir: join(root, 'agent'),
      models: {} as unknown as import('@felan-ai/agent-core').ModelsService,
      recover: false,
      debounceMs: 0,
      dreamRunner: async () => {
        runs += 1;
        return updatedArtifact();
      },
    });
    const host = coordinator.createSessionHost({ cwd, sessionStorageRoot: join(root, 'session-storage') });
    await host.recordCheckpoint({
      ...checkpointFor(sessionFile),
      transcriptDigest: '0'.repeat(64),
    });

    await expect(coordinator.runNow(cwd)).resolves.toMatchObject({
      state: 'blocked',
      pendingCheckpoints: 1,
      message: 'Some memory checkpoints could not be materialized; evidence remains pending',
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(runs).toBe(0);

    await host.recordCheckpoint(checkpointFor(sessionFile));
    await vi.waitFor(async () => {
      expect(await coordinator.status(cwd)).toMatchObject({ pendingCheckpoints: 1 });
    }, { timeout: 4_000 });
    await expect(coordinator.runNow(cwd)).resolves.toMatchObject({ state: 'idle', pendingCheckpoints: 0 });
    expect(runs).toBe(1);
    await coordinator.dispose();
  });

  it('processes valid evidence alongside blocked checkpoints', async () => {
    const root = await temporaryDirectory();
    const cwd = join(root, 'workspace');
    await mkdir(cwd, { recursive: true });
    let runs = 0;
    const coordinator = new LocalMemoryCoordinator({
      agentDir: join(root, 'agent'),
      models: {} as unknown as import('@felan-ai/agent-core').ModelsService,
      recover: false,
      debounceMs: 100,
      batchSize: 8,
      dreamRunner: async (input) => {
        runs += 1;
        return updatedArtifact(input.manifest.sessions[0]!.checkpoint.sessionId);
      },
    });
    const host = coordinator.createSessionHost({ cwd, sessionStorageRoot: join(root, 'session-storage') });
    for (let index = 0; index < 7; index += 1) {
      const sessionId = `invalid-${index}`;
      const path = await writeSession(cwd, sessionId);
      await host.recordCheckpoint({ ...checkpointFor(path, sessionId), transcriptDigest: '0'.repeat(64) });
    }
    expect(await coordinator.runNow(cwd)).toMatchObject({ state: 'blocked', pendingCheckpoints: 7 });
    expect(runs).toBe(0);

    const valid = await writeSession(cwd, 'valid-session');
    await host.recordCheckpoint(checkpointFor(valid, 'valid-session'));
    await expect(coordinator.runNow(cwd)).resolves.toMatchObject({ state: 'blocked', pendingCheckpoints: 7 });
    expect(runs).toBe(1);
    await coordinator.dispose();
  });

  it('enforces the eight-session durable metadata bound', async () => {
    const root = await temporaryDirectory();
    const cwd = join(root, 'workspace');
    await mkdir(cwd, { recursive: true });
    let processedSessionIds: string[] = [];
    const coordinator = new LocalMemoryCoordinator({
      agentDir: join(root, 'agent'),
      models: {} as unknown as import('@felan-ai/agent-core').ModelsService,
      enabled: false,
      recover: false,
      batchSize: Number.MAX_SAFE_INTEGER,
      dreamRunner: async (input) => {
        processedSessionIds = input.manifest.sessions.map(({ checkpoint }) => checkpoint.sessionId);
        return updatedArtifact(processedSessionIds[0]!);
      },
    });
    const host = coordinator.createSessionHost({ cwd, sessionStorageRoot: join(root, 'session-storage') });
    const seedSessionFile = await writeSession(cwd, 'seed-session');
    await host.recordCheckpoint(checkpointFor(seedSessionFile, 'seed-session'));
    coordinator.setEnabled(true);
    await coordinator.runNow(cwd);
    coordinator.setEnabled(false);
    processedSessionIds = [];
    for (let index = 0; index < 9; index += 1) {
      const sessionId = `session-${index}`;
      const sessionFile = await writeSession(cwd, sessionId);
      await host.recordCheckpoint(checkpointFor(sessionFile, sessionId));
    }

    coordinator.setEnabled(true);
    await expect(coordinator.runNow(cwd)).resolves.toMatchObject({ state: 'idle', pendingCheckpoints: 1 });
    expect(processedSessionIds).toHaveLength(8);
    await coordinator.dispose();
  });

  it('stops after the crossing delta without charging failed materializations to the byte target', async () => {
    const root = await temporaryDirectory();
    const cwd = join(root, 'workspace');
    await mkdir(cwd, { recursive: true });
    let processedSessionIds: string[] = [];
    const coordinator = new LocalMemoryCoordinator({
      agentDir: join(root, 'agent'),
      models: {} as unknown as import('@felan-ai/agent-core').ModelsService,
      enabled: false,
      recover: false,
      maxInputBytes: 1,
      dreamRunner: async (input) => {
        processedSessionIds = input.manifest.sessions.map(({ checkpoint }) => checkpoint.sessionId);
        return updatedArtifact(processedSessionIds[0]!);
      },
    });
    const host = coordinator.createSessionHost({ cwd, sessionStorageRoot: join(root, 'session-storage') });
    const seedSessionFile = await writeSession(cwd, 'seed-session');
    await host.recordCheckpoint(checkpointFor(seedSessionFile, 'seed-session'));
    coordinator.setEnabled(true);
    await coordinator.runNow(cwd);
    coordinator.setEnabled(false);
    processedSessionIds = [];
    for (let index = 0; index < 3; index += 1) {
      const sessionId = `session-${index}`;
      const sessionFile = await writeSession(cwd, sessionId);
      const checkpoint = checkpointFor(sessionFile, sessionId);
      await host.recordCheckpoint(index === 0 ? { ...checkpoint, transcriptDigest: '0'.repeat(64) } : checkpoint);
    }

    coordinator.setEnabled(true);
    await expect(coordinator.runNow(cwd)).resolves.toMatchObject({ state: 'blocked', pendingCheckpoints: 2 });
    expect(processedSessionIds).toEqual(['session-1']);
    await coordinator.dispose();
  });

  it('does not acknowledge pending evidence when shutdown cancels the isolated worker', async () => {
    const root = await temporaryDirectory();
    const cwd = join(root, 'workspace');
    const agentDir = join(root, 'agent');
    const started = deferred();
    const aborted = deferred();
    const release = deferred();
    let workerFinished = false;
    const coordinator = new LocalMemoryCoordinator({
      agentDir,
      models: {} as unknown as import('@felan-ai/agent-core').ModelsService,
      recover: false,
      dreamRunner: async ({ signal }) => {
        signal.throwIfAborted();
        await new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => {
            aborted.resolve();
            resolve();
          }, { once: true });
          started.resolve();
        });
        await release.promise;
        workerFinished = true;
        return updatedArtifact();
      },
    });
    const fixture = trackMemoryFixture(coordinator, release.resolve);
    await mkdir(cwd, { recursive: true });
    const sessionFile = await writeSession(cwd, 'session-1');
    const host = coordinator.createSessionHost({ cwd, sessionStorageRoot: join(root, 'session-storage') });
    await host.recordCheckpoint(checkpointFor(sessionFile));
    const store = new LocalMemoryStore(agentDir, await resolveLocalMemoryProject(cwd));
    const before = await store.status();
    const running = fixture.runNow(cwd);
    let disposed = false;
    try {
      await waitForMemoryMilestone(started.promise, running, 'worker startup');
      const disposing = fixture.dispose().then(() => { disposed = true; });
      await waitForMemoryMilestone(aborted.promise, running, 'worker cancellation');
      expect(disposed).toBe(false);
      expect(workerFinished).toBe(false);
      release.resolve();
      await disposing;
      await running;
      expect(workerFinished).toBe(true);
      await expectCancelledMemoryRun(store, before);
    } finally {
      await fixture.cleanup();
    }

    const retryCoordinator = new LocalMemoryCoordinator({ agentDir, models: {} as unknown as import('@felan-ai/agent-core').ModelsService, recover: false });
    const retryFixture = trackMemoryFixture(retryCoordinator);
    try {
      await expect(retryCoordinator.status(cwd)).resolves.toMatchObject({ pendingCheckpoints: 1 });
    } finally {
      await retryFixture.cleanup();
    }
  });

  it('cancels before worker entry when shutdown overlaps persisted attempt creation', async () => {
    const root = await temporaryDirectory();
    const cwd = join(root, 'workspace');
    const agentDir = join(root, 'agent');
    const createSession = vi.fn();
    const dreamRunner = vi.fn(createDefaultLocalMemoryDreamRunner({ createSession }));
    let abortedAtEntry: boolean | undefined;
    const coordinator = new LocalMemoryCoordinator({
      agentDir,
      models: {
        getAvailable: () => [{
          provider: 'openai-codex', id: 'gpt-5.6-luna', input: ['text'],
        } as Model<Api>],
      } as unknown as import('@felan-ai/agent-core').ModelsService,
      recover: false,
      dreamRunner: async (input) => {
        abortedAtEntry = input.signal.aborted;
        return dreamRunner(input);
      },
    });
    const persisted = deferred();
    const release = deferred();
    const fixture = trackMemoryFixture(coordinator, release.resolve);
    await mkdir(cwd, { recursive: true });
    const sessionFile = await writeSession(cwd, 'session-1');
    await coordinator.recordCheckpoint(cwd, checkpointFor(sessionFile));
    const store = new LocalMemoryStore(agentDir, await resolveLocalMemoryProject(cwd));
    const before = await store.status();
    const beginAttempt = Store.prototype.beginAttempt;
    const begin = vi.spyOn(Store.prototype, 'beginAttempt').mockImplementation(async function (
      this: LocalMemoryStore,
      ...args
    ) {
      const attempt = await beginAttempt.apply(this, args);
      persisted.resolve();
      await release.promise;
      return attempt;
    });
    fixture.restoreWith(() => begin.mockRestore());
    const running = fixture.runNow(cwd);
    try {
      await waitForMemoryMilestone(persisted.promise, running, 'persisted attempt');
      const disposing = fixture.dispose();
      release.resolve();
      await disposing;
      await running;
      expect(abortedAtEntry).toBe(true);
      expect(dreamRunner).toHaveBeenCalledOnce();
      await expect(dreamRunner.mock.results[0]!.value).rejects.toThrow(/^Memory processing was cancelled$/);
      expect(createSession).not.toHaveBeenCalled();
      await expectCancelledMemoryRun(store, before);
    } finally {
      await fixture.cleanup();
    }
  });

  it('reports early run settlement instead of waiting for an unreachable lifecycle milestone', async () => {
    const root = await temporaryDirectory();
    const cwd = join(root, 'workspace');
    const coordinator = new LocalMemoryCoordinator({
      agentDir: join(root, 'agent'), models: {} as unknown as import('@felan-ai/agent-core').ModelsService, recover: false,
    });
    const fixture = trackMemoryFixture(coordinator);
    const originalDispose = coordinator.dispose.bind(coordinator);
    let disposals = 0;
    const dispose = vi.spyOn(coordinator, 'dispose').mockImplementation(async () => {
      disposals += 1;
      await originalDispose();
    });
    const originalBegin = Store.prototype.beginAttempt;
    const begin = vi.spyOn(Store.prototype, 'beginAttempt').mockRejectedValue(
      new Error('injected attempt creation failure'),
    );
    fixture.restoreWith(() => {
      begin.mockRestore();
      dispose.mockRestore();
    });
    await mkdir(cwd, { recursive: true });
    await coordinator.recordCheckpoint(cwd, checkpointFor(await writeSession(cwd, 'session-1')));
    const running = fixture.runNow(cwd);
    try {
      for (const milestone of ['worker startup', 'persisted attempt']) {
        await expect(waitForMemoryMilestone(deferred().promise, running, milestone)).rejects.toThrow(
          `Memory run settled before ${milestone}`,
        );
      }
      expect(begin).toHaveBeenCalledOnce();
      const failure = new Error('injected run rejection');
      await expect(waitForMemoryMilestone(deferred().promise, Promise.reject(failure), 'worker startup'))
        .rejects.toBe(failure);
    } finally {
      await fixture.cleanup();
    }
    await fixture.cleanup();
    expect(disposals).toBe(1);
    expect(Store.prototype.beginAttempt).toBe(originalBegin);
  });

  it('drains a suspended fixture and restores its spy even when disposal rejects', async () => {
    const released = deferred();
    const failure = new Error('injected disposal failure');
    const release = vi.fn(() => released.resolve());
    const dispose = vi.fn(async () => { throw failure; });
    const originalBegin = Store.prototype.beginAttempt;
    const fixture = trackMemoryFixture({ dispose, runNow: () => released.promise }, release);
    const begin = vi.spyOn(Store.prototype, 'beginAttempt');
    fixture.restoreWith(() => begin.mockRestore());
    let runSettled = false;
    const running = fixture.runNow('/unused').then(() => { runSettled = true; });

    expect(runSettled).toBe(false);
    await expect(cleanupMemoryFixtures()).rejects.toBeInstanceOf(AggregateError);
    await running;
    await expect(fixture.cleanup()).rejects.toMatchObject({ errors: [failure] });
    expect(runSettled).toBe(true);
    expect(release).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
    expect(Store.prototype.beginAttempt).toBe(originalBegin);
    expect(memoryFixtureCleanups.size).toBe(0);
  });

  it('leaves normal TUI startup usable when no local model is configured', async () => {
    const root = await temporaryDirectory();
    const cwd = join(root, 'workspace');
    await mkdir(cwd, { recursive: true });
    const sessionFile = await writeSession(cwd, 'session-1');
    const getAvailable = vi.fn(() => []);
    const coordinator = new LocalMemoryCoordinator({
      agentDir: join(root, 'agent'),
      models: { getAvailable } as unknown as import('@felan-ai/agent-core').ModelsService,
      recover: false,
      debounceMs: 60_000,
      monitorIntervalMs: 5,
    });
    const host = coordinator.createSessionHost({ cwd, sessionStorageRoot: join(root, 'session-storage') });
    await host.recordCheckpoint(checkpointFor(sessionFile));
    await expect(coordinator.runNow(cwd)).resolves.toMatchObject({
      state: 'blocked',
      pendingCheckpoints: 1,
      message: 'Low-tier memory model is unavailable; evidence remains pending',
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(getAvailable).toHaveBeenCalledTimes(1);
    await coordinator.dispose();
  });

  it('recovers stable root sessions on startup but does not scan child session paths', async () => {
    const root = await temporaryDirectory();
    const cwd = join(root, 'workspace');
    const agentDir = join(root, 'agent');
    const sessionDir = join(agentDir, 'sessions');
    await mkdir(cwd, { recursive: true });
    const sessionFile = await writeSession(cwd, 'recovered-root');
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(sessionDir, 'not-a-session.jsonl'), 'not a Pi session\n', 'utf8');
    const old = new Date(Date.now() - 60_000);
    await utimes(sessionFile, old, old);
    let runs = 0;
    const coordinator = new LocalMemoryCoordinator({
      agentDir,
      sessionDir: cwd,
      models: {} as unknown as import('@felan-ai/agent-core').ModelsService,
      recoveryStableMs: 0,
      debounceMs: 0,
      dreamRunner: async () => {
        runs += 1;
        return updatedArtifact('recovered-root');
      },
    });
    await coordinator.createSessionHost({ cwd, sessionStorageRoot: join(root, 'session-storage') }).readCurrent();
    await vi.waitFor(async () => {
      expect(await coordinator.status(cwd)).toMatchObject({ pendingCheckpoints: 1 });
    }, { timeout: 4_000 });
    await expect(coordinator.runNow(cwd)).resolves.toMatchObject({ state: 'idle', pendingCheckpoints: 0 });
    expect(runs).toBe(1);
    await coordinator.dispose();
  });

  it('skips a session whose history cannot be read without restarting recovery for the others', async () => {
    const root = await temporaryDirectory();
    const cwd = join(root, 'workspace');
    await mkdir(cwd, { recursive: true });
    const old = new Date(Date.now() - 60_000);
    await utimes(await writeSession(cwd, 'recovery-failing'), old, old);
    await utimes(await writeSession(cwd, 'recovery-healthy'), old, old);
    faults.failingHistory.add('recovery-failing');
    const coordinator = new LocalMemoryCoordinator({
      agentDir: join(root, 'agent'), sessionDir: cwd, models: {} as unknown as import('@felan-ai/agent-core').ModelsService,
      recoveryStableMs: 0, monitorIntervalMs: 5,
    });
    await coordinator.createSessionHost({ cwd, sessionStorageRoot: join(root, 'session-storage') }).readCurrent();
    await vi.waitFor(() => {
      expect(new Set(faults.historyReads)).toEqual(new Set(['recovery-failing', 'recovery-healthy']));
    }, { timeout: 4_000 });
    await vi.waitFor(async () => {
      expect(await coordinator.status(cwd)).toMatchObject({ pendingCheckpoints: 1 });
    }, { timeout: 4_000 });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(faults.historyReads.filter((id) => id === 'recovery-failing')).toHaveLength(1);
    expect(faults.listCalls).toBe(1);
    await coordinator.dispose();
  });

  it('retries a failed session listing once, then completes startup recovery', async () => {
    const root = await temporaryDirectory();
    const cwd = join(root, 'workspace');
    await mkdir(cwd, { recursive: true });
    faults.listFailures = Number.POSITIVE_INFINITY;
    const coordinator = new LocalMemoryCoordinator({
      agentDir: join(root, 'agent'), sessionDir: cwd, models: {} as unknown as import('@felan-ai/agent-core').ModelsService,
      recoveryStableMs: 0, recoveryRetryMs: 20, monitorIntervalMs: 5,
    });
    await coordinator.createSessionHost({ cwd, sessionStorageRoot: join(root, 'session-storage') }).readCurrent();
    await vi.waitFor(() => expect(faults.listCalls).toBe(2), { timeout: 4_000 });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(faults.listCalls).toBe(2);
    expect(faults.historyReads).toEqual([]);
    await coordinator.dispose();
  });

  it('records stable sessions when the retried session listing succeeds', async () => {
    const root = await temporaryDirectory();
    const cwd = join(root, 'workspace');
    await mkdir(cwd, { recursive: true });
    const old = new Date(Date.now() - 60_000);
    await utimes(await writeSession(cwd, 'recovery-after-retry'), old, old);
    faults.listFailures = 1;
    const coordinator = new LocalMemoryCoordinator({
      agentDir: join(root, 'agent'), sessionDir: cwd, models: {} as unknown as import('@felan-ai/agent-core').ModelsService,
      recoveryStableMs: 0, recoveryRetryMs: 20, monitorIntervalMs: 5,
    });
    await coordinator.createSessionHost({ cwd, sessionStorageRoot: join(root, 'session-storage') }).readCurrent();
    await vi.waitFor(async () => {
      expect(await coordinator.status(cwd)).toMatchObject({ pendingCheckpoints: 1 });
    }, { timeout: 4_000 });
    expect(faults.listCalls).toBe(2);
    await coordinator.dispose();
  });

  it('aborts an in-flight recovery read when processing is disabled and reruns it when re-enabled', async () => {
    const root = await temporaryDirectory();
    const cwd = join(root, 'workspace');
    await mkdir(cwd, { recursive: true });
    const old = new Date(Date.now() - 60_000);
    await utimes(await writeSession(cwd, 'recovery-held'), old, old);
    faults.heldHistory.add('recovery-held');
    const coordinator = new LocalMemoryCoordinator({
      agentDir: join(root, 'agent'), sessionDir: cwd, models: {} as unknown as import('@felan-ai/agent-core').ModelsService,
      recoveryStableMs: 0, monitorIntervalMs: 5,
    });
    await coordinator.createSessionHost({ cwd, sessionStorageRoot: join(root, 'session-storage') }).readCurrent();
    await vi.waitFor(() => expect(faults.historyReads).toContain('recovery-held'), { timeout: 4_000 });
    coordinator.setEnabled(false);
    await vi.waitFor(() => expect(faults.abortedReads).toEqual(['recovery-held']), { timeout: 4_000 });
    faults.heldHistory.clear();
    coordinator.setEnabled(true);
    await vi.waitFor(async () => {
      expect(await coordinator.status(cwd)).toMatchObject({ pendingCheckpoints: 1 });
    }, { timeout: 4_000 });
    expect(faults.historyReads.filter((id) => id === 'recovery-held').length).toBeGreaterThanOrEqual(2);
    await coordinator.dispose();
  });

  it('aborts an in-flight recovery read on dispose', async () => {
    const root = await temporaryDirectory();
    const cwd = join(root, 'workspace');
    await mkdir(cwd, { recursive: true });
    const old = new Date(Date.now() - 60_000);
    await utimes(await writeSession(cwd, 'recovery-disposed'), old, old);
    faults.heldHistory.add('recovery-disposed');
    const coordinator = new LocalMemoryCoordinator({
      agentDir: join(root, 'agent'), sessionDir: cwd, models: {} as unknown as import('@felan-ai/agent-core').ModelsService, recoveryStableMs: 0,
    });
    await coordinator.createSessionHost({ cwd, sessionStorageRoot: join(root, 'session-storage') }).readCurrent();
    await vi.waitFor(() => expect(faults.historyReads).toContain('recovery-disposed'), { timeout: 4_000 });
    await coordinator.dispose();
    expect(faults.abortedReads).toEqual(['recovery-disposed']);
  });

  it('records startup recovery checkpoints that match the live checkpoint, excluding memory context on the active branch', async () => {
    const root = await temporaryDirectory();
    const cwd = join(root, 'workspace');
    const agentDir = join(root, 'agent');
    await mkdir(cwd, { recursive: true });
    const file = join(cwd, 'recovery-parity.jsonl');
    await writeFile(file, [
      JSON.stringify({ type: 'session', version: 3, id: 'recovery-parity', timestamp: new Date().toISOString(), cwd }),
      ...sessionEntries().map((entry) => JSON.stringify(entry)),
      '',
    ].join('\n'), 'utf8');
    const old = new Date(Date.now() - 60_000);
    await utimes(file, old, old);
    const coordinator = new LocalMemoryCoordinator({
      agentDir, sessionDir: cwd, models: {} as unknown as import('@felan-ai/agent-core').ModelsService, recoveryStableMs: 0,
    });
    await coordinator.createSessionHost({ cwd, sessionStorageRoot: join(root, 'session-storage') }).readCurrent();
    const project = await resolveLocalMemoryProject(cwd);
    const statePath = join(localMemoryProjectDirectory(agentDir, project), 'state.json');
    await vi.waitFor(async () => {
      expect(JSON.parse(await readFile(statePath, 'utf8')).pending['recovery-parity']).toBeDefined();
    }, { timeout: 4_000 });
    const live = createSessionCheckpoint(SessionManager.open(file));
    const recovered = JSON.parse(await readFile(statePath, 'utf8')).pending['recovery-parity'];
    expect(recovered.checkpoint).toMatchObject({ leafId: live!.leafId, transcriptDigest: live!.transcriptDigest });
    await coordinator.createSessionHost({ cwd, sessionStorageRoot: join(root, 'session-storage') }).recordCheckpoint(live!);
    expect(JSON.parse(await readFile(statePath, 'utf8')).pending['recovery-parity'].acceptedUpdates).toBe(recovered.acceptedUpdates);
    await coordinator.dispose();
  });

  it('defers startup recovery until processing is enabled', async () => {
    const root = await temporaryDirectory();
    const cwd = join(root, 'workspace');
    await mkdir(cwd, { recursive: true });
    const sessionFile = await writeSession(cwd, 'deferred-root');
    const old = new Date(Date.now() - 60_000);
    await utimes(sessionFile, old, old);
    const coordinator = new LocalMemoryCoordinator({
      agentDir: join(root, 'agent'),
      sessionDir: cwd,
      models: {} as unknown as import('@felan-ai/agent-core').ModelsService,
      enabled: false,
      recoveryStableMs: 0,
      debounceMs: 60_000,
      dreamRunner: async () => updatedArtifact('deferred-root'),
    });
    await coordinator.createSessionHost({ cwd, sessionStorageRoot: join(root, 'session-storage') }).readCurrent();
    expect(await coordinator.status(cwd)).toMatchObject({ state: 'disabled', pendingCheckpoints: 0 });

    coordinator.setEnabled(true);
    await vi.waitFor(async () => {
      expect(await coordinator.status(cwd)).toMatchObject({ state: 'idle', pendingCheckpoints: 1 });
    }, { timeout: 4_000 });
    await coordinator.dispose();
  });

  it('drains startup recovery without recording evidence after disposal begins', async () => {
    const root = await temporaryDirectory();
    const cwd = join(root, 'workspace');
    const agentDir = join(root, 'agent');
    await mkdir(cwd, { recursive: true });
    const sessionFile = await writeSession(cwd, 'disposal-root');
    const old = new Date(Date.now() - 60_000);
    await utimes(sessionFile, old, old);
    const sessions = await SessionManager.list(cwd, cwd);
    let release!: () => void;
    let listing = false;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const list = vi.spyOn(SessionManager, 'list').mockImplementationOnce(async () => {
      listing = true;
      await gate;
      return sessions;
    });
    const coordinator = new LocalMemoryCoordinator({
      agentDir,
      sessionDir: cwd,
      models: {} as unknown as import('@felan-ai/agent-core').ModelsService,
      recoveryStableMs: 0,
      debounceMs: 60_000,
      dreamRunner: async () => updatedArtifact('disposal-root'),
    });
    await coordinator.createSessionHost({ cwd, sessionStorageRoot: join(root, 'session-storage') }).readCurrent();
    await expect.poll(() => listing).toBe(true);
    const disposing = coordinator.dispose();
    release();
    await disposing;
    list.mockRestore();

    const store = new LocalMemoryStore(agentDir, await resolveLocalMemoryProject(cwd));
    expect((await store.status()).pending).toEqual({});
  });

  it('pauses before model work when retained diagnostics cannot be safely accounted for', async () => {
    const root = await temporaryDirectory();
    const cwd = join(root, 'workspace');
    const agentDir = join(root, 'agent');
    await mkdir(cwd, { recursive: true });
    const sessionFile = await writeSession(cwd, 'session-1');
    let modelCalls = 0;
    const coordinator = new LocalMemoryCoordinator({
      agentDir,
      models: {} as unknown as import('@felan-ai/agent-core').ModelsService,
      recover: false,
      debounceMs: 60_000,
      dreamRunner: async (input) => { modelCalls += 1; return input.baseSnapshot; },
    });
    await coordinator.recordCheckpoint(cwd, checkpointFor(sessionFile));
    const store = new LocalMemoryStore(agentDir, await resolveLocalMemoryProject(cwd));
    const external = join(root, 'external-evidence');
    await mkdir(external);
    await writeFile(join(external, 'sentinel.txt'), 'preserve');
    await mkdir(join(store.projectDirectory, 'runs'), { recursive: true });
    await symlink(external, join(store.projectDirectory, 'runs', 'unsafe-run'));

    expect(await coordinator.runNow(cwd)).toMatchObject({ state: 'error', pendingCheckpoints: 1, consecutiveFailures: 0 });
    expect(modelCalls).toBe(0);
    expect(await readFile(join(external, 'sentinel.txt'), 'utf8')).toBe('preserve');
    expect((await store.readControl()).activeAttempt).toBeUndefined();
    await coordinator.dispose();
  });
});

async function writeSession(cwd: string, sessionId: string): Promise<string> {
  const path = join(cwd, `${sessionId}.jsonl`);
  await writeFile(path, [
    JSON.stringify({ type: 'session', version: 3, id: sessionId, timestamp: new Date().toISOString(), cwd }),
    ...persistedSessionEntries().map((entry) => JSON.stringify(entry)),
    '',
  ].join('\n'), 'utf8');
  return path;
}

async function writeResumedSession(path: string, cwd: string): Promise<void> {
  const resumed = {
    type: 'message',
    id: 'entry-3',
    parentId: 'entry-2',
    timestamp: '2026-01-01T00:00:03.000Z',
    message: { role: 'assistant', content: [{ type: 'text', text: 'new settled branch evidence' }] },
  };
  await writeFile(path, [
    JSON.stringify({ type: 'session', version: 3, id: 'session-1', timestamp: new Date().toISOString(), cwd }),
    ...persistedSessionEntries().map((entry) => JSON.stringify(entry)),
    JSON.stringify(resumed),
    '',
  ].join('\n'), 'utf8');
}

function sessionEntries(): Array<Record<string, unknown>> {
  return [
    {
      type: 'message',
      id: 'entry-1',
      parentId: null,
      timestamp: '2026-01-01T00:00:00.000Z',
      message: { role: 'user', content: 'Remember apiKey: secret-value and sk-super-secret-token' },
    },
    {
      type: 'custom_message',
      id: 'memory-context',
      parentId: 'entry-1',
      customType: MEMORY_CONTEXT_CUSTOM_TYPE,
      content: 'old memory must not be ingested',
      display: false,
    },
    {
      type: 'message',
      id: 'entry-2',
      parentId: 'memory-context',
      timestamp: '2026-01-01T00:00:01.000Z',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Focused changes are preferred.' }] },
    },
  ];
}

function persistedSessionEntries(): Array<Record<string, unknown>> {
  return [
    ...sessionEntries(),
    {
      type: 'message',
      id: 'abandoned-entry',
      parentId: 'entry-1',
      timestamp: '2026-01-01T00:00:02.000Z',
      message: { role: 'user', content: 'abandoned branch should not be ingested' },
    },
  ];
}

function checkpointFor(sessionFile: string, sessionId = 'session-1') {
  return {
    sessionId,
    sessionFile,
    leafId: 'entry-2',
    transcriptDigest: digestActiveBranch(removeMemoryContextEntries(sessionEntries())),
  } as const;
}

function resumedCheckpointFor(sessionFile: string) {
  const entries = [...sessionEntries(), {
    type: 'message',
    id: 'entry-3',
    parentId: 'entry-2',
    timestamp: '2026-01-01T00:00:03.000Z',
    message: { role: 'assistant', content: [{ type: 'text', text: 'new settled branch evidence' }] },
  }];
  return {
    sessionId: 'session-1',
    sessionFile,
    leafId: 'entry-3',
    transcriptDigest: digestActiveBranch(removeMemoryContextEntries(entries)),
  } as const;
}

function updatedArtifact(sourceSessionId = 'session-1'): MemoryArtifact {
  return {
    version: 1,
    files: [
      { path: 'summary.md', content: 'The project prefers focused changes.' },
      { path: 'index.md', content: '# Memory index\n\n## How to use this memory\n\n## Memory map\n- [Workflow](.memory/pages/workflows/index.md)\n' },
      { path: 'pages/workflows/index.md', content: '# workflows\n- [Focused changes](focused.md) — Keep changes focused.\n' },
      { path: 'pages/workflows/focused.md', content: `# Focused changes\n\n[Herdr discussion](https://github.com/herdrdev/herdr/discussions/3704) [Demo PR](https://github.com/mslavov/herdr/pull/1) [Missing](missing.md)\n\n## Sources\n- session:${sourceSessionId}\n` },
    ],
  };
}

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'felan-memory-coordinator-'));
  temporaryPaths.push(path);
  return path;
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => { resolve = settle; });
  return { promise, resolve };
}

function trackMemoryFixture(
  coordinator: { runNow(cwd: string): Promise<unknown>; dispose(): Promise<void> },
  release: () => void = () => {},
) {
  let running: Promise<unknown> | undefined;
  let disposing: Promise<void> | undefined;
  let cleaning: Promise<void> | undefined;
  let restore = () => {};
  const dispose = (): Promise<void> => disposing ??= (async () => { await coordinator.dispose(); })();
  const cleanup = (): Promise<void> => cleaning ??= (async () => {
    try {
      release();
      throwCleanupFailures(await Promise.allSettled([dispose(), ...(running ? [running] : [])]));
    } finally {
      restore();
    }
  })().finally(() => { memoryFixtureCleanups.delete(cleanup); });
  memoryFixtureCleanups.add(cleanup);
  return {
    dispose,
    cleanup,
    runNow(cwd: string): Promise<unknown> {
      running = coordinator.runNow(cwd);
      return running;
    },
    restoreWith(callback: () => void): void { restore = callback; },
  };
}

async function cleanupMemoryFixtures(): Promise<void> {
  throwCleanupFailures(await Promise.allSettled([...memoryFixtureCleanups].map((cleanup) => cleanup())));
}

function throwCleanupFailures(results: readonly PromiseSettledResult<unknown>[]): void {
  const errors = results.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
  if (errors.length > 0) throw new AggregateError(errors, 'Memory fixture cleanup failed');
}

async function waitForMemoryMilestone(
  milestone: Promise<void>,
  running: Promise<unknown>,
  label: string,
): Promise<void> {
  await Promise.race([
    milestone,
    running.then(() => { throw new Error(`Memory run settled before ${label}`); }),
  ]);
}

async function expectCancelledMemoryRun(
  store: LocalMemoryStore,
  before: Awaited<ReturnType<LocalMemoryStore['status']>>,
): Promise<void> {
  expect(await store.status()).toEqual(before);
  const control = await store.readControl();
  expect(control.activeAttempt).toBeUndefined();
  expect(control.lastOutcome).toMatchObject({ status: 'cancelled' });
  const runDirectory = join(store.projectDirectory, 'runs', control.lastOutcome!.runId);
  expect(JSON.parse(await readFile(join(runDirectory, 'manifest.json'), 'utf8'))).toMatchObject({ status: 'cancelled' });
  await expect(access(join(runDirectory, 'workspace'))).rejects.toMatchObject({ code: 'ENOENT' });
  const lease = await acquireLocalMemoryLease(store.projectDirectory);
  try {
    expect(lease).toBeDefined();
  } finally {
    await lease?.release();
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Condition was not reached before timeout');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
