import { join } from 'node:path';
import { mkdir, rm } from 'node:fs/promises';
import {
  createMemorySnapshot,
  createMemoryProjectionSnapshot,
  createSessionCheckpoint,
  extractSourceIds,
  hydrateMemoryDirectory,
  readMemoryDirectory,
  validateMemoryArtifact,
  type MemoryHost,
  type MemoryProcessingState,
  type MemorySnapshot,
  type MemoryStatus,
  type SessionCheckpoint,
} from '@felan-ai/ext-memory';
import {
  ModelRuntime,
  SessionManager,
  type AgentSession,
  type Api,
  type Model,
} from '@felan-ai/agent-core';
import {
  acquireLocalMemoryLease,
  type LocalMemoryLease,
  type LocalMemoryLeaseOptions,
} from './lease.js';
import { resolveLocalMemoryProject, type LocalMemoryProject } from './project.js';
import {
  createDefaultLocalMemoryDreamRunner,
  materializeMemoryInput,
  type LocalMemoryDreamRunner,
} from './dreamer.js';
import {
  LocalMemoryStore,
} from './store.js';

interface ProjectContext {
  readonly project: LocalMemoryProject;
  readonly cwd: string;
  readonly sessionDir?: string;
  readonly store: LocalMemoryStore;
  readonly ready: Promise<void>;
  recoveryStarted: boolean;
  timer: ReturnType<typeof setTimeout> | undefined;
  run: Promise<void> | undefined;
  readonly followUps: Set<Promise<void>>;
  abort: AbortController | undefined;
  blocked: Map<string, MemoryCheckpointCursor>;
  checkpointVersion: number;
  state: MemoryProcessingState;
  message: string | undefined;
}

interface MemoryCheckpointCursor {
  readonly leafId: string | null;
  readonly transcriptDigest: string;
}

const MEMORY_INPUT_BLOCKED_MESSAGE = 'Some memory checkpoints could not be materialized; evidence remains pending';

export interface LocalMemoryCoordinatorOptions {
  readonly agentDir: string;
  readonly modelRuntime: ModelRuntime;
  readonly sessionDir?: string;
  readonly enabled?: boolean;
  readonly debounceMs?: number;
  readonly batchSize?: number;
  readonly maxTranscriptBytes?: number;
  readonly recoveryStableMs?: number;
  readonly recover?: boolean;
  readonly dreamRunner?: LocalMemoryDreamRunner;
  readonly selectedModel?: Model<Api>;
  readonly leaseOptions?: LocalMemoryLeaseOptions;
}

export interface LocalMemorySessionHostOptions {
  readonly cwd: string;
  readonly sessionStorageRoot: string;
}

export class LocalMemoryCoordinator {
  readonly #options: LocalMemoryCoordinatorOptions;
  readonly #contexts = new Map<string, ProjectContext>();
  readonly #projections = new Map<string, string>();
  readonly #statusListeners = new Set<() => void>();
  readonly #dreamRunner: LocalMemoryDreamRunner;
  #enabled: boolean;
  #selectedModel: Model<Api> | undefined;
  #disposed = false;

  constructor(options: LocalMemoryCoordinatorOptions) {
    this.#options = options;
    this.#enabled = options.enabled !== false;
    this.#selectedModel = options.selectedModel;
    this.#dreamRunner = options.dreamRunner ?? createDefaultLocalMemoryDreamRunner();
  }

  createSessionHost(options: LocalMemorySessionHostOptions): MemoryHost {
    return new LocalMemorySessionHost(this, options);
  }

  isEnabled(): boolean {
    return this.#enabled;
  }

  subscribeStatusChanges(listener: () => void): () => void {
    if (this.#disposed) return () => {};
    this.#statusListeners.add(listener);
    return () => this.#statusListeners.delete(listener);
  }

  setSelectedModel(model: Model<Api> | undefined): void {
    this.#selectedModel = model;
  }

  setEnabled(enabled: boolean): void {
    this.#enabled = enabled;
    for (const context of this.#contexts.values()) {
      if (!enabled && context.timer) {
        clearTimeout(context.timer);
        context.timer = undefined;
      }
      context.state = enabled ? 'idle' : 'disabled';
    }
    if (enabled) {
      for (const context of this.#contexts.values()) {
        void this.#trackScheduleIfPending(context, 0);
      }
    }
    this.#emitStatusChange();
  }

  async status(cwd: string): Promise<MemoryStatus> {
    try {
      const context = await this.#context(cwd);
      const state = await context.store.status();
      const processed = Object.values(state.processed);
      const lastProcessedAt = processed
        .map((entry) => entry.processedAt)
        .sort()
        .at(-1);
      return {
        enabled: this.#enabled,
        state: this.#enabled ? context.state : 'disabled',
        pendingCheckpoints: Object.keys(state.pending).length,
        memoryFingerprint: state.memoryFingerprint,
        ...(lastProcessedAt === undefined ? {} : { lastProcessedAt }),
        ...(context.message === undefined ? {} : { message: context.message }),
      };
    } catch {
      return {
        enabled: this.#enabled,
        state: this.#enabled ? 'error' : 'disabled',
        pendingCheckpoints: 0,
        message: 'Local memory storage is unavailable',
      };
    }
  }

  async readCurrent(cwd: string, sessionStorageRoot: string): Promise<MemorySnapshot> {
    const context = await this.#context(cwd);
    const snapshot = await context.store.readCurrent();
    const projectionKey = `${context.project.key}:${sessionStorageRoot}`;
    const memoryPath = join(sessionStorageRoot, context.store.projectionName);
    if (this.#projections.get(projectionKey) !== snapshot.fingerprint) {
      const projection = await context.store.projectTo(sessionStorageRoot, snapshot);
      this.#projections.set(projectionKey, snapshot.fingerprint);
      return projection;
    }
    return createMemoryProjectionSnapshot(snapshot, memoryPath);
  }

  async recordCheckpoint(cwd: string, checkpoint: SessionCheckpoint): Promise<void> {
    const context = await this.#context(cwd);
    if (await context.store.recordCheckpoint(checkpoint)) {
      context.checkpointVersion += 1;
      context.blocked.delete(checkpoint.sessionId);
      await this.#schedule(context);
      this.#emitStatusChange();
    }
  }

  async runNow(cwd: string): Promise<MemoryStatus> {
    if (!this.#enabled) return this.status(cwd);
    const context = await this.#context(cwd);
    this.#cancelScheduledRun(context);
    while (context.run || context.followUps.size > 0) {
      await Promise.allSettled([
        ...(context.run ? [context.run] : []),
        ...context.followUps,
      ]);
      this.#cancelScheduledRun(context);
    }
    context.blocked.clear();
    const checkpointVersion = context.checkpointVersion;
    const run = this.#run(context);
    context.run = run;
    try {
      await run;
    } finally {
      if (context.run === run) context.run = undefined;
      if (context.checkpointVersion !== checkpointVersion) {
        await this.#trackScheduleIfPending(context);
      }
    }
    return this.status(cwd);
  }

  async canonicalDirectory(cwd: string): Promise<string> {
    const context = await this.#context(cwd);
    return context.store.currentDirectory;
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const context of this.#contexts.values()) {
      if (context.timer) clearTimeout(context.timer);
      context.timer = undefined;
      context.abort?.abort();
    }
    while (true) {
      const work = [...this.#contexts.values()].flatMap((context) => [
        ...(context.run ? [context.run] : []),
        ...context.followUps,
      ]);
      if (work.length === 0) break;
      await Promise.allSettled(work);
    }
    this.#statusListeners.clear();
  }

  async #context(cwd: string): Promise<ProjectContext> {
    if (this.#disposed) throw new Error('Local memory coordinator is closed');
    const project = await resolveLocalMemoryProject(cwd);
    const existing = this.#contexts.get(project.key);
    if (existing) return existing;
    const store = new LocalMemoryStore(this.#options.agentDir, project);
    const context: ProjectContext = {
      project,
      cwd,
      ...(this.#options.sessionDir === undefined ? {} : { sessionDir: this.#options.sessionDir }),
      store,
      ready: store.initialize(),
      recoveryStarted: false,
      timer: undefined,
      run: undefined,
      followUps: new Set(),
      abort: undefined,
      blocked: new Map(),
      checkpointVersion: 0,
      state: this.#enabled ? 'idle' : 'disabled',
      message: undefined,
    };
    this.#contexts.set(project.key, context);
    await context.ready;
    if (this.#enabled) void this.#trackScheduleIfPending(context);
    if (this.#options.recover !== false && !context.recoveryStarted) {
      context.recoveryStarted = true;
      void this.#recover(context).catch(() => {
        context.message = 'Memory startup recovery could not complete';
      });
    }
    return context;
  }

  async #schedule(context: ProjectContext, delay = this.#options.debounceMs ?? 2_000): Promise<void> {
    if (this.#disposed || !this.#enabled || context.run || context.timer) return;
    context.state = 'scheduled';
    const timer = setTimeout(() => {
      if (context.timer !== timer) return;
      context.timer = undefined;
      const run = this.#run(context).finally(async () => {
        context.run = undefined;
        await this.#trackScheduleIfPending(context);
      });
      context.run = run;
    }, delay);
    context.timer = timer;
    timer.unref?.();
  }

  async #scheduleIfPending(context: ProjectContext, delay = this.#options.debounceMs ?? 2_000): Promise<void> {
    if (!this.#enabled || this.#disposed) return;
    try {
      const state = await context.store.status();
      const pending = Object.values(state.pending);
      if (pending.some(({ checkpoint }) => !isBlockedCheckpoint(context, checkpoint))) {
        await this.#schedule(context, delay);
      } else if (pending.length > 0) {
        context.state = 'blocked';
        context.message = MEMORY_INPUT_BLOCKED_MESSAGE;
      }
    } catch {
      context.state = 'error';
      context.message = 'Local memory storage is unavailable';
    }
  }

  #trackScheduleIfPending(
    context: ProjectContext,
    delay = this.#options.debounceMs ?? 2_000,
  ): Promise<void> {
    const followUp = this.#scheduleIfPending(context, delay).finally(() => {
      context.followUps.delete(followUp);
    });
    context.followUps.add(followUp);
    return followUp;
  }

  async #run(context: ProjectContext): Promise<void> {
    if (this.#disposed || !this.#enabled) return;
    context.state = 'processing';
    context.message = undefined;
    let lease: LocalMemoryLease | undefined;
    try {
      lease = await acquireLocalMemoryLease(context.store.projectDirectory, this.#options.leaseOptions);
    } catch (error) {
      context.state = 'error';
      context.message = safeProcessingMessage(error);
      return;
    }
    if (!lease) {
      context.state = 'blocked';
      context.message = 'Another Felan process owns the memory writer';
      return;
    }
    const abort = new AbortController();
    context.abort = abort;
    const abortOnLeaseCompromise = (): void => {
      abort.abort(new Error('Memory writer lease was lost'));
    };
    lease.compromised.addEventListener('abort', abortOnLeaseCompromise, { once: true });
    let staging: string | undefined;
    try {
      const snapshot = await context.store.processingSnapshot(this.#options.batchSize ?? 8);
      if (snapshot.checkpoints.length === 0) {
        context.state = 'idle';
        return;
      }
      staging = await context.store.createStagingDirectory();
      const memoryDirectory = join(staging, '.memory');
      await hydrateMemoryDirectory(snapshot.artifact, memoryDirectory, { memoryPath: '.memory' });
      const manifest = await materializeMemoryInput({
        stagingDirectory: staging,
        checkpoints: snapshot.checkpoints.map(({ checkpoint }) => checkpoint),
        previousCheckpoints: Object.fromEntries(
          Object.entries(snapshot.state.processed).map(([sessionId, entry]) => [sessionId, entry.checkpoint]),
        ),
        baseSnapshot: createMemorySnapshot(snapshot.artifact, '.memory'),
        maxTranscriptBytes: this.#options.maxTranscriptBytes ?? 256 * 1024,
        signal: abort.signal,
      });
      for (const failure of manifest.failures) {
        context.blocked.set(failure.checkpoint.sessionId, {
          leafId: failure.checkpoint.leafId,
          transcriptDigest: failure.checkpoint.transcriptDigest,
        });
      }
      const processedCheckpoints = snapshot.checkpoints.filter(({ checkpoint }) =>
        manifest.sessions.some((session) =>
          session.checkpoint.sessionId === checkpoint.sessionId
          && sameCheckpointCursor(session.checkpoint, checkpoint),
        ),
      );
      if (processedCheckpoints.length === 0) {
        context.state = 'blocked';
        context.message = MEMORY_INPUT_BLOCKED_MESSAGE;
        return;
      }
      const result = await this.#dreamRunner({
        stagingDirectory: staging,
        memoryDirectory,
        inputDirectory: join(staging, '.dreaming', 'input'),
        baseSnapshot: createMemorySnapshot(snapshot.artifact, '.memory'),
        manifest,
        modelRuntime: this.#options.modelRuntime,
        ...(this.#selectedModel === undefined ? {} : { selectedModel: this.#selectedModel }),
        signal: abort.signal,
      });
      if (result) await hydrateMemoryDirectory(result, memoryDirectory, { replace: true, memoryPath: '.memory' });
      const artifact = await readMemoryDirectory(memoryDirectory, {
        memoryPath: '.memory',
        sourceSessionIds: allowedSourceIds(snapshot, manifest),
      });
      const validation = validateMemoryArtifact(artifact, {
        memoryPath: '.memory',
        sourceSessionIds: allowedSourceIds(snapshot, manifest),
      });
      if (!validation.ok || !validation.artifact) throw new Error('Memory output validation failed');
      await context.store.commit(lease, snapshot.fingerprint, validation.artifact, processedCheckpoints);
      if (manifest.failures.length > 0) {
        context.state = 'blocked';
        context.message = MEMORY_INPUT_BLOCKED_MESSAGE;
      } else {
        context.state = 'idle';
      }
      this.#emitStatusChange();
    } catch (error) {
      context.state = 'error';
      context.message = !await lease.verify()
        ? safeProcessingMessage(new Error('Memory writer lease was lost'))
        : safeProcessingMessage(error);
    } finally {
      lease.compromised.removeEventListener('abort', abortOnLeaseCompromise);
      context.abort = undefined;
      if (staging) await rm(staging, { recursive: true, force: true }).catch(() => {});
      await lease.release();
    }
  }

  async #recover(context: ProjectContext): Promise<void> {
    if (!this.#enabled) return;
    const sessionDir = context.sessionDir ?? join(this.#options.agentDir, 'sessions');
    let sessions;
    try {
      sessions = await SessionManager.list(context.cwd, sessionDir);
    } catch {
      context.message = 'Memory startup recovery could not inspect sessions';
      return;
    }
    let recovered = false;
    const stableAfter = this.#options.recoveryStableMs ?? 30_000;
    for (const info of sessions) {
      if (info.parentSessionPath || Date.now() - info.modified.getTime() < stableAfter) continue;
      try {
        const manager = SessionManager.open(info.path, sessionDir, context.cwd);
        const checkpoint = createSessionCheckpoint(manager);
        if (!checkpoint) continue;
        recovered = (await context.store.recordCheckpoint(checkpoint)) || recovered;
      } catch {}
    }
    if (recovered) {
      await this.#schedule(context);
      this.#emitStatusChange();
    }
  }

  #emitStatusChange(): void {
    for (const listener of [...this.#statusListeners]) {
      try {
        listener();
      } catch {}
    }
  }

  #cancelScheduledRun(context: ProjectContext): void {
    if (!context.timer) return;
    clearTimeout(context.timer);
    context.timer = undefined;
  }
}

class LocalMemorySessionHost implements MemoryHost {
  readonly #coordinator: LocalMemoryCoordinator;
  readonly #cwd: string;
  readonly #sessionStorageRoot: string;

  constructor(coordinator: LocalMemoryCoordinator, options: LocalMemorySessionHostOptions) {
    this.#coordinator = coordinator;
    this.#cwd = options.cwd;
    this.#sessionStorageRoot = options.sessionStorageRoot;
  }

  readCurrent(): Promise<MemorySnapshot> {
    return this.#coordinator.readCurrent(this.#cwd, this.#sessionStorageRoot);
  }

  async recordCheckpoint(checkpoint: SessionCheckpoint): Promise<void> {
    await this.#coordinator.recordCheckpoint(this.#cwd, checkpoint);
  }

  status(): Promise<MemoryStatus> {
    return this.#coordinator.status(this.#cwd);
  }
}

function isBlockedCheckpoint(context: ProjectContext, checkpoint: SessionCheckpoint): boolean {
  const blocked = context.blocked.get(checkpoint.sessionId);
  return blocked !== undefined && sameCheckpointCursor(blocked, checkpoint);
}

function sameCheckpointCursor(
  left: Pick<SessionCheckpoint, 'leafId' | 'transcriptDigest'>,
  right: Pick<SessionCheckpoint, 'leafId' | 'transcriptDigest'>,
): boolean {
  return left.leafId === right.leafId && left.transcriptDigest === right.transcriptDigest;
}

function allowedSourceIds(
  snapshot: LocalMemoryProcessingSnapshotLike,
  manifest: { readonly sessions: readonly { readonly checkpoint: SessionCheckpoint }[] },
): readonly string[] {
  return [...new Set([
    ...snapshot.artifact.files.flatMap(({ content }) => extractSourceIds(content)),
    ...manifest.sessions.map(({ checkpoint }) => checkpoint.sessionId),
  ])];
}

interface LocalMemoryProcessingSnapshotLike {
  readonly artifact: { readonly files: readonly { readonly content: string }[] };
}

function safeProcessingMessage(error: unknown): string {
  if (error instanceof Error && error.message.includes('No authenticated local memory model')) {
    return 'Memory model is unavailable; evidence remains pending';
  }
  if (error instanceof Error && error.message.includes('cancel')) return 'Memory processing was cancelled';
  if (error instanceof Error && error.message.includes('writer lease')) return 'Memory writer lease was lost; evidence remains pending';
  if (error instanceof Error && error.message.includes('changed')) return 'Memory changed during processing; evidence remains pending';
  return 'Memory processing failed; evidence remains pending';
}
