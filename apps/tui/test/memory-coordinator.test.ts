import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createEmptyMemoryArtifact,
  createMemorySnapshot,
  digestActiveBranch,
  MEMORY_CONTEXT_CUSTOM_TYPE,
  removeMemoryContextEntries,
  type MemoryArtifact,
} from '@felan-ai/ext-memory';
import type { Api, Model, ModelRuntime } from '@felan-ai/agent-core';
import { LocalMemoryCoordinator } from '../src/memory/coordinator.js';
import type { LocalMemoryDreamInput } from '../src/memory/dreamer.js';
import { localMemoryProjectDirectory, resolveLocalMemoryProject } from '../src/memory/project.js';

const temporaryPaths: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('LocalMemoryCoordinator', () => {
  it('passes the selected root-session model to the dream runner', async () => {
    const root = await temporaryDirectory();
    const cwd = join(root, 'workspace');
    await mkdir(cwd, { recursive: true });
    const sessionFile = await writeSession(cwd, 'session-1');
    const selectedModel = { provider: 'openai-codex', id: 'gpt-5.6-sol' } as Model<Api>;
    let observedModel: Model<Api> | undefined;
    const coordinator = new LocalMemoryCoordinator({
      agentDir: join(root, 'agent'),
      modelRuntime: {} as ModelRuntime,
      recover: false,
      selectedModel,
      dreamRunner: async (input) => {
        observedModel = input.selectedModel;
        return updatedArtifact();
      },
    });
    const host = coordinator.createSessionHost({ cwd, sessionStorageRoot: join(root, 'session-storage') });
    await host.recordCheckpoint(checkpointFor(sessionFile));

    await expect(coordinator.runNow(cwd)).resolves.toMatchObject({ state: 'idle', pendingCheckpoints: 0 });
    expect(observedModel).toBe(selectedModel);
    await coordinator.dispose();
  });

  it('notifies status subscribers when the pending count changes', async () => {
    const root = await temporaryDirectory();
    const cwd = join(root, 'workspace');
    await mkdir(cwd, { recursive: true });
    const sessionFile = await writeSession(cwd, 'session-1');
    const coordinator = new LocalMemoryCoordinator({
      agentDir: join(root, 'agent'),
      modelRuntime: {} as ModelRuntime,
      recover: false,
      dreamRunner: async () => updatedArtifact(),
    });
    const statusChanged = vi.fn();
    const unsubscribe = coordinator.subscribeStatusChanges(statusChanged);
    const host = coordinator.createSessionHost({ cwd, sessionStorageRoot: join(root, 'session-storage') });

    await host.recordCheckpoint(checkpointFor(sessionFile));
    expect(statusChanged).toHaveBeenCalledTimes(1);
    await coordinator.runNow(cwd);
    expect(statusChanged).toHaveBeenCalledTimes(2);

    unsubscribe();
    await coordinator.dispose();
  });

  it('schedules newly recorded checkpoints and ignores duplicate cursors', async () => {
    const root = await temporaryDirectory();
    const cwd = join(root, 'workspace');
    await mkdir(cwd, { recursive: true });
    const sessionFile = await writeSession(cwd, 'session-1');
    let runs = 0;
    const coordinator = new LocalMemoryCoordinator({
      agentDir: join(root, 'agent'),
      modelRuntime: {} as ModelRuntime,
      recover: false,
      debounceMs: 0,
      dreamRunner: async () => {
        runs += 1;
        return updatedArtifact();
      },
    });
    const host = coordinator.createSessionHost({ cwd, sessionStorageRoot: join(root, 'session-storage') });
    const checkpoint = checkpointFor(sessionFile);
    await host.recordCheckpoint(checkpoint);
    await host.recordCheckpoint(checkpoint);

    for (let attempt = 0; attempt < 100 && runs === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(runs).toBe(1);

    await host.recordCheckpoint(checkpoint);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(runs).toBe(1);
    await coordinator.dispose();
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
      cwd,
      agentDir,
      modelRuntime: {} as ModelRuntime,
      recover: false,
      maxTranscriptBytes: 256,
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
    expect(Buffer.byteLength(observed.transcripts[0]!, 'utf8')).toBeLessThanOrEqual(256);
    const refreshed = await host.readCurrent();
    expect(refreshed).toMatchObject({ files: expect.arrayContaining([
      { path: 'summary.md', content: 'The project prefers focused changes.' },
    ]) });
    const projectedIndex = refreshed.files.find(({ path }) => path === 'index.md')?.content;
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

  it('keeps evidence pending after a worker failure and retries it later', async () => {
    const root = await temporaryDirectory();
    const cwd = join(root, 'workspace');
    await mkdir(cwd, { recursive: true });
    const sessionFile = await writeSession(cwd, 'session-1');
    let shouldFail = true;
    const coordinator = new LocalMemoryCoordinator({
      agentDir: join(root, 'agent'),
      modelRuntime: {} as ModelRuntime,
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

    await expect(coordinator.runNow(cwd)).resolves.toMatchObject({ state: 'error', pendingCheckpoints: 1 });
    await expect(coordinator.runNow(cwd)).resolves.toMatchObject({ state: 'idle', pendingCheckpoints: 0 });
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
      modelRuntime: {} as ModelRuntime,
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
      modelRuntime: {} as ModelRuntime,
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
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(runs).toBe(1);

    await host.recordCheckpoint(checkpointFor(badSessionFile, 'bad-session'));
    await expect(coordinator.runNow(cwd)).resolves.toMatchObject({ pendingCheckpoints: 0 });
    expect(runs).toBe(2);
    await coordinator.dispose();
  });

  it('suspends an all-invalid batch until its cursor changes', async () => {
    const root = await temporaryDirectory();
    const cwd = join(root, 'workspace');
    await mkdir(cwd, { recursive: true });
    const sessionFile = await writeSession(cwd, 'session-1');
    let runs = 0;
    const coordinator = new LocalMemoryCoordinator({
      agentDir: join(root, 'agent'),
      modelRuntime: {} as ModelRuntime,
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

    await vi.waitFor(async () => {
      expect(await coordinator.status(cwd)).toMatchObject({
        state: 'blocked',
        pendingCheckpoints: 1,
        message: 'Some memory checkpoints could not be materialized; evidence remains pending',
      });
    }, { timeout: 4_000 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(runs).toBe(0);

    await host.recordCheckpoint(checkpointFor(sessionFile));
    await vi.waitFor(async () => {
      expect(runs).toBe(1);
      expect(await coordinator.status(cwd)).toMatchObject({ state: 'idle', pendingCheckpoints: 0 });
    }, { timeout: 4_000 });
    await coordinator.dispose();
  });

  it('does not acknowledge pending evidence when shutdown cancels the isolated worker', async () => {
    const root = await temporaryDirectory();
    const cwd = join(root, 'workspace');
    await mkdir(cwd, { recursive: true });
    const sessionFile = await writeSession(cwd, 'session-1');
    let started = false;
    const coordinator = new LocalMemoryCoordinator({
      agentDir: join(root, 'agent'),
      modelRuntime: {} as ModelRuntime,
      recover: false,
      dreamRunner: async ({ signal }) => {
        started = true;
        await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
        throw new Error('cancelled');
      },
    });
    const host = coordinator.createSessionHost({ cwd, sessionStorageRoot: join(root, 'session-storage') });
    await host.recordCheckpoint(checkpointFor(sessionFile));
    const running = coordinator.runNow(cwd);
    for (let attempt = 0; attempt < 50 && !started; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 0));
    await coordinator.dispose();
    await running;

    const retryCoordinator = new LocalMemoryCoordinator({ agentDir: join(root, 'agent'), modelRuntime: {} as ModelRuntime, recover: false });
    await expect(retryCoordinator.status(cwd)).resolves.toMatchObject({ pendingCheckpoints: 1 });
    await retryCoordinator.dispose();
  });

  it('leaves normal TUI startup usable when no local model is configured', async () => {
    const root = await temporaryDirectory();
    const cwd = join(root, 'workspace');
    await mkdir(cwd, { recursive: true });
    const sessionFile = await writeSession(cwd, 'session-1');
    const coordinator = new LocalMemoryCoordinator({
      agentDir: join(root, 'agent'),
      modelRuntime: { getAvailableSnapshot: () => [] } as unknown as ModelRuntime,
      recover: false,
    });
    const host = coordinator.createSessionHost({ cwd, sessionStorageRoot: join(root, 'session-storage') });
    await host.recordCheckpoint(checkpointFor(sessionFile));
    await expect(coordinator.runNow(cwd)).resolves.toMatchObject({
      state: 'error',
      pendingCheckpoints: 1,
      message: 'Memory model is unavailable; evidence remains pending',
    });
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
      modelRuntime: {} as ModelRuntime,
      recoveryStableMs: 0,
      debounceMs: 0,
      dreamRunner: async () => {
        runs += 1;
        return updatedArtifact('recovered-root');
      },
    });
    await coordinator.createSessionHost({ cwd, sessionStorageRoot: join(root, 'session-storage') }).readCurrent();
    await vi.waitFor(async () => {
      expect(runs).toBe(1);
      expect(await coordinator.status(cwd)).toMatchObject({ state: 'idle', pendingCheckpoints: 0 });
    }, { timeout: 4_000 });
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
      { path: 'pages/workflows/focused.md', content: `# Focused changes\n\n## Sources\n- session:${sourceSessionId}\n` },
    ],
  };
}

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'felan-memory-coordinator-'));
  temporaryPaths.push(path);
  return path;
}

async function waitFor(predicate: () => boolean, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Condition was not reached before timeout');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
