import { readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { HostAgentRuntime, SessionManager, type SessionsService } from '@felan-ai/agent-core';
import { digestActiveBranch, type SessionCheckpoint } from '../../src/index.js';
import { LocalMemoryCoordinator as Coordinator, type LocalMemoryCoordinatorOptions } from '../../src/local/coordinator.js';
import { materializeMemoryInput as rawMaterializeMemoryInput, createDefaultLocalMemoryDreamRunner as rawCreateDefaultLocalMemoryDreamRunner, type MaterializeMemoryInputOptions, type LocalMemoryDreamRunnerOptions } from '../../src/local/dreamer.js';
import { LocalMemoryStore as Store, type LocalMemoryStoreOptions } from '../../src/local/store.js';
import { LocalMemoryRun as Run, memoryRunUsage as rawMemoryRunUsage, type CreateMemoryRunOptions } from '../../src/local/run.js';
import { localMemoryProjectDirectory as rawLocalMemoryProjectDirectory, resolveLocalMemoryProject as rawResolveLocalMemoryProject } from '../../src/local/project.js';
import { acquireLocalMemoryLease as rawAcquireLocalMemoryLease, type LocalMemoryLeaseOptions } from '../../src/local/lease.js';
import { pruneMemoryRuns as rawPruneMemoryRuns, type MemoryRunRetentionOptions } from '../../src/local/run-retention.js';
import { readMemoryDirectory as rawReadMemoryDirectory, hydrateMemoryDirectory as rawHydrateMemoryDirectory, hydrateMemorySnapshot as rawHydrateMemorySnapshot } from '../../src/local/hydration.js';
import { listLocalSessionHistory as rawListLocalSessionHistory, readMemoryHistorySnapshot as rawReadMemoryHistorySnapshot, safeMemoryText as rawSafeMemoryText, validMemoryRunId as rawValidMemoryRunId, type MemoryHistoryOptions, type MemoryHistorySession } from '../../src/local/history.js';
import type { LocalMemoryProject } from '../../src/local/project.js';
import type { MemoryHydrationOptions, MemoryArtifact, MemoryFile, MemorySnapshot } from '../../src/contracts.js';

export function createMemoryBackend() {
  function registerCheckpoint(checkpoint: SessionCheckpoint) {
    if (checkpoint.sessionFile !== checkpoint.sessionId) sources.set(checkpoint.sessionId, checkpoint.sessionFile);
  }
  const sources = new Map<string, string>();
  const directories = new Set<string>();
  let historyCwd: string | undefined;
  const runtime = new HostAgentRuntime('/', { pathAccess: 'host', sessionStorageRoot: tmpdir(), agentStorageRoot: tmpdir() });
  const sessions: SessionsService = {
    current: { id: 'test', root: 'test' },
    async list() {
      const rows = (await Promise.all([...directories].map(directory => SessionManager.list(historyCwd ?? directory, directory)))).flat();
      return { items: rows.map(row => {
        sources.set(row.id, row.path);
        return { id: row.id, root: row.id, ...(row.parentSessionPath ? { parent: row.parentSessionPath } : {}),
          cwd: row.cwd, title: row.name ?? '', updatedAt: row.modified.getTime(), state: 'closed' as const };
      }) };
    },
    async checkpoint(id: string) {
      const path = sources.get(id);
      if (!path) throw new Error('Missing test source');
      const text = await readFile(path, 'utf8');
      const manager = SessionManager.open(path);
      return { sessionId: id, revision: text, branch: manager.getLeafId(), transcriptDigest: digestActiveBranch(manager.getBranch()), byteLength: (await stat(path)).size };
    },
    async history(id: string, options: { at?: { revision: string } } = {}) {
      const snapshot = await sessions.checkpoint(id);
      if (options.at && options.at.revision !== snapshot.revision) throw new Error('Stale test history');
      return { ...snapshot, entries: SessionManager.open(sources.get(id)!).getEntries() };
    },
    async setTitleIfMissing() { throw new Error('Not supported by memory history fixture'); },
    async create() { throw new Error('Not supported by memory history fixture'); },
    async executions() { throw new Error('Not supported by memory history fixture'); },
    async execution() { throw new Error('Not supported by memory history fixture'); },
    async steer() { throw new Error('Not supported by memory history fixture'); },
    async cancel() { throw new Error('Not supported by memory history fixture'); },
    subscribe() { throw new Error('Not supported by memory history fixture'); },
  };
  const environment = { runtime, sessions };
  const backend = {
    LocalMemoryStore: class extends Store {
      constructor(agentDir: string, project: LocalMemoryProject, options?: LocalMemoryStoreOptions) { super(environment, agentDir, project, options); }
      override recordCheckpoint(checkpoint: SessionCheckpoint) {
        registerCheckpoint(checkpoint);
        return super.recordCheckpoint(checkpoint);
      }
    },
    LocalMemoryRun: {
      prototype: Run.prototype,
      create: (options: CreateMemoryRunOptions) => Run.create(environment, options),
      reconcile: (options: Parameters<typeof Run.reconcile>[1], outcome: Parameters<typeof Run.reconcile>[2]) => Run.reconcile(environment, options, outcome),
    },
    memoryRunUsage: rawMemoryRunUsage,
    createDefaultLocalMemoryDreamRunner: (options?: LocalMemoryDreamRunnerOptions) => rawCreateDefaultLocalMemoryDreamRunner(environment, options),
    localMemoryProjectDirectory: rawLocalMemoryProjectDirectory,
    resolveLocalMemoryProject: (cwd: string) => rawResolveLocalMemoryProject(environment, cwd),
    acquireLocalMemoryLease: (path: string, options?: LocalMemoryLeaseOptions) => rawAcquireLocalMemoryLease(environment, path, options),
    pruneMemoryRuns: (options: MemoryRunRetentionOptions) => rawPruneMemoryRuns(environment, options),
    readMemoryDirectory: (path: string, options?: MemoryHydrationOptions) => rawReadMemoryDirectory(environment, path, options),
    hydrateMemoryDirectory: (artifact: MemoryArtifact | readonly MemoryFile[], path: string, options?: MemoryHydrationOptions) => rawHydrateMemoryDirectory(environment, artifact, path, options),
    hydrateMemorySnapshot: (snapshot: MemorySnapshot, path: string, options?: MemoryHydrationOptions) => rawHydrateMemorySnapshot(environment, snapshot, path, options),
    materializeMemoryInput: (options: MaterializeMemoryInputOptions) => rawMaterializeMemoryInput(environment, options),
    listLocalSessionHistory: (options: MemoryHistoryOptions) => rawListLocalSessionHistory(environment, options),
    readMemoryHistorySnapshot: (session: MemoryHistorySession) => rawReadMemoryHistorySnapshot(environment, session),
    safeMemoryText: rawSafeMemoryText, validMemoryRunId: rawValidMemoryRunId,
  };
  class LocalMemoryCoordinator extends Coordinator {
    constructor(options: LocalMemoryCoordinatorOptions) {
      super(environment, options);
      directories.add(options.sessionDir ?? `${options.agentDir}/sessions`);
    }
    override recordCheckpoint(cwd: string, checkpoint: SessionCheckpoint) {
      registerCheckpoint(checkpoint);
      return super.recordCheckpoint(cwd, checkpoint);
    }
  }
  function materializeMemoryInput(options: MaterializeMemoryInputOptions) {
    for (const checkpoint of options.checkpoints) registerCheckpoint(checkpoint);
    return backend.materializeMemoryInput(options);
  }
  function listLocalSessionHistory(options: import('../../src/local/history.js').MemoryHistoryOptions) {
    historyCwd = options.cwd;
    directories.add(options.sessionDir); return backend.listLocalSessionHistory(options);
  }

  return { ...backend, LocalMemoryCoordinator, materializeMemoryInput, listLocalSessionHistory };
}

export { LocalMemoryControlError } from '../../src/local/store.js';
export { sanitizeMemoryDiagnostic } from '../../src/diagnostics.js';
export { MEMORY_RUN_ENTRY } from '../../src/local/run.js';
export { createMemoryControlExtension } from '../../src/local/control.js';

export type LocalMemoryStore = import('../../src/local/store.js').LocalMemoryStore;
export type LocalMemoryRun = import('../../src/local/run.js').LocalMemoryRun;
export { MEMORY_ATTEMPT_TIMEOUT_MS } from '../../src/local/store.js';


export { safeMemoryText, validMemoryRunId } from '../../src/local/history.js';
export { localMemoryProjectDirectory } from '../../src/local/project.js';
export { memoryRunUsage } from '../../src/local/run.js';

export type LocalMemoryCoordinator = import('../../src/local/coordinator.js').LocalMemoryCoordinator;
