import { join } from 'node:path';
import { mkdir, rm } from 'node:fs/promises';
import {
  createMemorySnapshot,
  createMemoryProjectionSnapshot,
  createSessionCheckpoint,
  extractSourceIds,
  hydrateMemoryDirectory,
  readMemoryDirectory,
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
  MemoryModelUnavailableError,
  materializeMemoryInput,
  type LocalMemoryDreamRunner,
} from './dreamer.js';
import {
  LocalMemoryStore,
  LocalMemoryControlError,
  type LocalMemoryAttempt,
  type LocalMemoryControl,
} from './store.js';
import { LocalMemoryRun, sanitizeMemoryDiagnostic } from './run.js';

interface ProjectContext {
  readonly project: LocalMemoryProject;
  readonly cwd: string;
  readonly sessionDir?: string;
  readonly store: LocalMemoryStore;
  ready: Promise<void> | undefined;
  initialized: boolean;
  recovery: Promise<void> | undefined;
  recoveryCompleted: boolean;
  diagnosticsReconciled: boolean;
  timer: ReturnType<typeof setTimeout> | undefined;
  timerDueAt: number | undefined;
  run: Promise<void> | undefined;
  readonly followUps: Set<Promise<void>>;
  abort: AbortController | undefined;
  attempt: LocalMemoryAttempt | undefined;
  storageBlocked: boolean;
  writerBlocked: boolean;
  statusSignature: string | undefined;
  blocked: Map<string, MemoryCheckpointCursor>;
  state: MemoryProcessingState;
  message: string | undefined;
}

interface MemoryCheckpointCursor {
  readonly leafId: string | null;
  readonly transcriptDigest: string;
}

const MEMORY_INPUT_BLOCKED_MESSAGE = 'Some memory checkpoints could not be materialized; evidence remains pending';
const MEMORY_AUTOMATIC_UPDATE_THRESHOLD = 5;
const MEMORY_AUTOMATIC_INTERVAL_MS = 24 * 60 * 60 * 1_000;

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
  readonly scopedModels?: readonly Model<Api>[];
  readonly leaseOptions?: LocalMemoryLeaseOptions;
  readonly retryDelaysMs?: readonly [number, number];
  readonly monitorIntervalMs?: number;
  readonly now?: () => number;
}

export interface LocalMemoryStatus extends MemoryStatus {
  readonly consecutiveFailures?: number;
  readonly nextRetryAt?: string;
  readonly autoDisabled?: LocalMemoryControl['autoDisabled'];
  readonly lastRunId?: string;
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
  #scopedModels: readonly Model<Api>[] | undefined;
  #disposed = false;
  #monitor: ReturnType<typeof setInterval> | undefined;
  #monitoring: Promise<void> | undefined;
  #enableVersion = 0;

  constructor(options: LocalMemoryCoordinatorOptions) {
    this.#options = options;
    this.#enabled = options.enabled !== false;
    this.#selectedModel = options.selectedModel;
    this.#scopedModels = options.scopedModels === undefined ? undefined : [...options.scopedModels];
    this.#dreamRunner = options.dreamRunner ?? createDefaultLocalMemoryDreamRunner();
    if (this.#enabled) this.#startMonitor();
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

  setModelSelection(model: Model<Api> | undefined, scopedModels: readonly Model<Api>[] | undefined): void {
    this.#scopedModels = scopedModels === undefined ? undefined : [...scopedModels];
    this.setSelectedModel(model);
  }

  setSelectedModel(model: Model<Api> | undefined): void {
    this.#selectedModel = model;
    for (const context of this.#contexts.values()) {
      context.blocked.clear();
      if (context.initialized) void this.#trackScheduleIfPending(context);
    }
  }

  setEnabled(enabled: boolean): void {
    this.#enableVersion += 1;
    this.#enabled = enabled;
    if (enabled) this.#startMonitor();
    else if (this.#monitor) {
      clearInterval(this.#monitor);
      this.#monitor = undefined;
    }
    for (const context of this.#contexts.values()) {
      if (!enabled) this.#cancelScheduledRun(context);
      if (!enabled) this.#cancelContext(context, 'Memory processing was disabled', true);
      if (enabled) {
        context.storageBlocked = false;
        context.writerBlocked = false;
        context.blocked.clear();
        if (context.initialized) this.#startRecovery(context);
      }
      context.state = enabled ? 'idle' : 'disabled';
    }
    if (enabled) {
      for (const context of this.#contexts.values()) {
        if (context.initialized) void this.#trackScheduleIfPending(context);
      }
    }
    this.#emitStatusChange();
  }

  async status(cwd: string): Promise<LocalMemoryStatus> {
    try {
      const context = await this.#context(cwd);
      const state = await context.store.status();
      const control = await context.store.readControl();
      const processed = Object.values(state.processed);
      const lastProcessedAt = processed
        .map((entry) => entry.processedAt)
        .sort()
        .at(-1);
      return {
        enabled: this.#enabled && !control.autoDisabled,
        state: !this.#enabled || control.autoDisabled ? 'disabled'
          : control.nextRetryAt && Date.parse(control.nextRetryAt) > this.#now() ? 'scheduled'
          : context.state === 'error' ? 'error'
          : control.activeAttempt ? 'processing' : context.state,
        pendingCheckpoints: Object.keys(state.pending).length,
        memoryFingerprint: state.memoryFingerprint,
        ...(lastProcessedAt === undefined ? {} : { lastProcessedAt }),
        ...(context.message === undefined ? {} : { message: context.message }),
        consecutiveFailures: control.consecutiveFailures,
        ...(control.nextRetryAt ? { nextRetryAt: control.nextRetryAt } : {}),
        ...(control.autoDisabled ? { autoDisabled: control.autoDisabled } : {}),
        ...(control.activeAttempt || control.lastOutcome ? {
          lastRunId: control.activeAttempt?.runId ?? control.lastOutcome!.runId,
        } : {}),
      };
    } catch (error) {
      return {
        enabled: this.#enabled,
        state: this.#enabled ? 'error' : 'disabled',
        pendingCheckpoints: 0,
        message: error instanceof LocalMemoryControlError ? error.message : 'Local memory storage is unavailable',
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
      context.blocked.delete(checkpoint.sessionId);
      await this.#trackScheduleIfPending(context);
      this.#emitStatusChange();
    }
  }

  async runNow(cwd: string): Promise<LocalMemoryStatus> {
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
    const run = this.#run(context, true);
    context.run = run;
    try {
      await run;
    } finally {
      if (context.run === run) context.run = undefined;
      await this.#trackScheduleIfPending(context);
    }
    return this.status(cwd);
  }

  async retryProject(cwd: string): Promise<LocalMemoryStatus> {
    if (!this.#enabled) return this.status(cwd);
    const context = await this.#context(cwd);
    if (!this.#enabled || this.#disposed) return this.status(cwd);
    const enableVersion = this.#enableVersion;
    this.#cancelScheduledRun(context);
    try {
      await context.store.resetProjectControl(
        this.#now(),
        () => this.#enabled && !this.#disposed && this.#enableVersion === enableVersion,
      );
    } catch (error) {
      throw error;
    }
    context.abort?.abort(new Error('Memory processing was explicitly retried'));
    if (context.run) await context.run;
    context.blocked.clear();
    context.storageBlocked = false;
    context.message = undefined;
    await this.runNow(cwd);
    return this.status(cwd);
  }

  async canonicalDirectory(cwd: string): Promise<string> {
    const context = await this.#context(cwd);
    return context.store.currentDirectory;
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    if (this.#monitor) clearInterval(this.#monitor);
    this.#monitor = undefined;
    for (const context of this.#contexts.values()) {
      this.#cancelScheduledRun(context);
      this.#cancelContext(context, 'Memory processing was cancelled during shutdown', false);
    }
    while (true) {
      const work = [...this.#contexts.values()].flatMap((context) => [
        ...(context.run ? [context.run] : []),
        ...(context.ready ? [context.ready] : []),
        ...(context.recovery ? [context.recovery] : []),
        ...context.followUps,
      ]);
      if (this.#monitoring) work.push(this.#monitoring);
      if (work.length === 0) break;
      await Promise.allSettled(work);
    }
    this.#statusListeners.clear();
  }

  async #context(cwd: string): Promise<ProjectContext> {
    if (this.#disposed) throw new Error('Local memory coordinator is closed');
    const project = await resolveLocalMemoryProject(cwd);
    if (this.#disposed) throw new Error('Local memory coordinator is closed');
    const existing = this.#contexts.get(project.key);
    if (existing) {
      await this.#initialize(existing);
      return existing;
    }
    const store = new LocalMemoryStore(this.#options.agentDir, project, {
      ...(this.#options.retryDelaysMs ? { retryDelaysMs: this.#options.retryDelaysMs } : {}),
    });
    const context: ProjectContext = {
      project,
      cwd,
      ...(this.#options.sessionDir === undefined ? {} : { sessionDir: this.#options.sessionDir }),
      store,
      ready: undefined,
      initialized: false,
      recovery: undefined,
      recoveryCompleted: false,
      diagnosticsReconciled: false,
      timer: undefined,
      timerDueAt: undefined,
      run: undefined,
      followUps: new Set(),
      abort: undefined,
      attempt: undefined,
      storageBlocked: false,
      writerBlocked: false,
      statusSignature: undefined,
      blocked: new Map(),
      state: this.#enabled ? 'idle' : 'disabled',
      message: undefined,
    };
    this.#contexts.set(project.key, context);
    await this.#initialize(context);
    return context;
  }

  async #initialize(context: ProjectContext): Promise<void> {
    if (context.ready) {
      await context.ready;
      return;
    }
    if (context.initialized && context.diagnosticsReconciled) {
      this.#startRecovery(context);
      return;
    }
    const ready = this.#initializeContext(context).finally(() => {
      if (context.ready === ready) context.ready = undefined;
    });
    context.ready = ready;
    await ready;
  }

  async #initializeContext(context: ProjectContext): Promise<void> {
    if (!context.initialized) {
      await context.store.initialize(this.#now()).then(() => {
        context.initialized = true;
        context.state = this.#enabled ? 'idle' : 'disabled';
        context.message = undefined;
      }).catch(async (error: unknown) => {
        if (!(error instanceof LocalMemoryControlError)) throw error;
        const current = await context.store.readCurrent();
        if (current.fingerprint !== (await context.store.status()).memoryFingerprint) throw error;
        context.message = error.message;
      });
    }
    if (!context.initialized) return;
    if (!context.diagnosticsReconciled) {
      try {
        const lease = await acquireLocalMemoryLease(context.store.projectDirectory, this.#options.leaseOptions);
        if (lease) {
          try {
            await this.#reconcileRunDiagnostics(context, lease);
            context.diagnosticsReconciled = true;
          } finally {
            await lease.release();
          }
        }
      } catch (error) {
        context.diagnosticsReconciled = true;
        context.storageBlocked = true;
        context.message = `Memory diagnostics recovery is blocked: ${sanitizeMemoryDiagnostic(error)}`;
      }
    }
    if (this.#disposed) return;
    if (this.#enabled) void this.#trackScheduleIfPending(context);
    this.#startRecovery(context);
  }

  #startRecovery(context: ProjectContext): void {
    if (this.#disposed || !this.#enabled || this.#options.recover === false
      || context.recoveryCompleted || context.recovery) return;
    const recovery = this.#recover(context).then((completed) => {
      if (completed) context.recoveryCompleted = true;
    }).catch(() => {
      context.message = 'Memory startup recovery could not complete';
    }).finally(() => {
      if (context.recovery === recovery) context.recovery = undefined;
    });
    context.recovery = recovery;
  }

  #now(): number { return this.#options.now?.() ?? Date.now(); }

  #startMonitor(): void {
    if (this.#disposed || this.#monitor) return;
    const interval = this.#options.monitorIntervalMs ?? 2_000;
    if (!Number.isFinite(interval) || interval < 1) throw new Error('Memory monitor interval must be positive');
    this.#monitor = setInterval(() => {
      if (this.#monitoring) return;
      this.#monitoring = this.#refresh().catch(() => {}).finally(() => { this.#monitoring = undefined; });
    }, interval);
    this.#monitor.unref?.();
  }

  async #refresh(): Promise<void> {
    if (this.#disposed) return;
    for (const context of this.#contexts.values()) {
      try {
        await this.#initialize(context);
        const observedAttempt = context.attempt;
        const control = await context.store.readControl();
        if (observedAttempt && context.attempt === observedAttempt && (!this.#enabled || control.autoDisabled
          || control.activeAttempt?.runId !== observedAttempt.runId
          || control.activeAttempt?.generation !== observedAttempt.generation)) {
          this.#cancelContext(context, 'Memory processing was cancelled by another session', true);
        }
        context.writerBlocked = false;
        if (context.initialized) await this.#trackScheduleIfPending(context);
        const signature = JSON.stringify([this.#enabled, context.state, context.message, control.updatedAt]);
        if (signature !== context.statusSignature) {
          context.statusSignature = signature;
          this.#emitStatusChange();
        }
      } catch (error) {
        context.state = 'error';
        context.message = sanitizeMemoryDiagnostic(error);
        context.abort?.abort(error);
        this.#emitStatusChange();
      }
    }
  }

  #cancelContext(context: ProjectContext, reason: string, cancelPersisted: boolean): void {
    const alreadyAborted = context.abort?.signal.aborted ?? false;
    context.abort?.abort(new Error(reason));
    if (alreadyAborted || !context.initialized || (!cancelPersisted && !context.attempt)) return;
    const cancellation = cancelPersisted
      ? context.store.cancelActiveAttempt(this.#now())
      : context.store.finishAttempt(undefined, context.attempt!, { status: 'cancelled', reason }, this.#now());
    const followUp = cancellation
      .then(() => {})
      .catch(() => {})
      .finally(() => { context.followUps.delete(followUp); });
    context.followUps.add(followUp);
  }

  async #schedule(context: ProjectContext, dueAt: number): Promise<void> {
    if (this.#disposed || !this.#enabled || context.run || context.storageBlocked) return;
    if (context.timer && context.timerDueAt === dueAt) return;
    this.#cancelScheduledRun(context);
    context.state = 'scheduled';
    const delay = Math.max(0, dueAt - this.#now());
    const timer = setTimeout(() => {
      if (context.timer !== timer) return;
      context.timer = undefined;
      context.timerDueAt = undefined;
      const run = this.#run(context).catch((error: unknown) => {
        context.state = 'error';
        context.storageBlocked = true;
        context.message = sanitizeMemoryDiagnostic(error);
        this.#emitStatusChange();
      }).finally(async () => {
        context.run = undefined;
        await this.#trackScheduleIfPending(context);
      });
      context.run = run;
    }, delay);
    context.timer = timer;
    context.timerDueAt = dueAt;
    timer.unref?.();
  }

  async #scheduleIfPending(context: ProjectContext): Promise<void> {
    if (!this.#enabled || this.#disposed) return;
    try {
      const control = await context.store.readControl();
      if (control.autoDisabled) {
        this.#cancelScheduledRun(context);
        context.state = 'disabled';
        return;
      }
      if (context.storageBlocked) return;
      if (context.writerBlocked) return;
      const state = await context.store.status();
      const pending = Object.values(state.pending);
      if (control.activeAttempt) {
        this.#cancelScheduledRun(context);
      } else if (pending.some(({ checkpoint }) => !isBlockedCheckpoint(context, checkpoint))) {
        const acceptedUpdates = await context.store.pendingAcceptedUpdates(
          (checkpoint) => !isBlockedCheckpoint(context, checkpoint),
        );
        if (acceptedUpdates < MEMORY_AUTOMATIC_UPDATE_THRESHOLD) {
          this.#cancelScheduledRun(context);
          if (context.state === 'scheduled') context.state = 'idle';
          return;
        }
        const processedAt = Object.values(state.processed)
          .map(({ processedAt }) => Date.parse(processedAt))
          .filter(Number.isFinite)
          .reduce((latest, at) => Math.max(latest, at), 0);
        const dueAt = control.nextRetryAt
          ? Date.parse(control.nextRetryAt)
          : processedAt === 0
            ? this.#now()
            : processedAt + (this.#options.debounceMs ?? MEMORY_AUTOMATIC_INTERVAL_MS);
        await this.#schedule(context, dueAt);
      } else if (pending.length > 0) {
        this.#cancelScheduledRun(context);
        const message = context.state === 'blocked' ? context.message : undefined;
        context.state = 'blocked';
        context.message = message ?? MEMORY_INPUT_BLOCKED_MESSAGE;
      } else {
        this.#cancelScheduledRun(context);
        if (context.state === 'scheduled') context.state = 'idle';
      }
    } catch {
      context.state = 'error';
      context.message = 'Local memory storage is unavailable';
    }
  }

  #trackScheduleIfPending(context: ProjectContext): Promise<void> {
    const followUp = this.#scheduleIfPending(context).finally(() => {
      context.followUps.delete(followUp);
    });
    context.followUps.add(followUp);
    return followUp;
  }

  async #run(context: ProjectContext, bypassRetryAt = false): Promise<void> {
    if (this.#disposed || !this.#enabled || context.storageBlocked) return;
    context.state = 'processing';
    context.message = undefined;
    let lease: LocalMemoryLease | undefined;
    try {
      lease = await acquireLocalMemoryLease(context.store.projectDirectory, this.#options.leaseOptions);
    } catch (error) {
      context.writerBlocked = true;
      context.state = 'error';
      context.message = safeProcessingMessage(error);
      return;
    }
    if (!lease) {
      context.writerBlocked = true;
      context.state = 'blocked';
      context.message = 'Another Felan Code process owns the memory writer';
      return;
    }
    context.writerBlocked = false;
    const abort = new AbortController();
    context.abort = abort;
    const abortOnLeaseCompromise = (): void => {
      abort.abort(new Error('Memory writer lease was lost'));
    };
    lease.compromised.addEventListener('abort', abortOnLeaseCompromise, { once: true });
    let staging: string | undefined;
    let retainedRun: LocalMemoryRun | undefined;
    let published = false;
    let attempt: LocalMemoryAttempt | undefined;
    try {
      const control = await this.#reconcileRunDiagnostics(context, lease);
      if (control.autoDisabled) {
        context.state = 'disabled';
        return;
      }
      if (!bypassRetryAt && control.nextRetryAt && Date.parse(control.nextRetryAt) > this.#now()) {
        context.state = 'scheduled';
        return;
      }
      const snapshot = await context.store.processingSnapshot(
        this.#options.batchSize ?? 8,
        (checkpoint) => !isBlockedCheckpoint(context, checkpoint),
      );
      if (snapshot.checkpoints.length === 0) {
        context.state = 'idle';
        return;
      }
      retainedRun = await LocalMemoryRun.create({
        projectDirectory: context.store.projectDirectory,
        sessionDirectory: join(this.#options.sessionDir ?? join(this.#options.agentDir, 'sessions'), 'memory'),
        projectKey: context.project.key,
        projectRoot: context.project.canonicalRoot,
        checkpoints: snapshot.checkpoints.map(({ checkpoint }) => checkpoint),
        baseFingerprint: snapshot.fingerprint,
        ...(control.lastDisabledRunId ? { protectedRunIds: [control.lastDisabledRunId] } : {}),
      });
      staging = retainedRun.workspace;
      const memoryDirectory = join(staging, '.memory');
      await hydrateMemoryDirectory(snapshot.artifact, memoryDirectory, { memoryPath: '.memory', mode: 'read' });
      const manifest = await materializeMemoryInput({
        stagingDirectory: staging,
        checkpoints: snapshot.checkpoints.map(({ checkpoint }) => checkpoint),
        previousCheckpoints: Object.fromEntries(
          Object.entries(snapshot.state.processed).map(([sessionId, entry]) => [sessionId, entry.checkpoint]),
        ),
        baseSnapshot: createMemorySnapshot(snapshot.artifact, '.memory', { mode: 'read' }),
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
        await retainedRun.finish('blocked', MEMORY_INPUT_BLOCKED_MESSAGE);
        return;
      }
      await retainedRun.record({ phase: 'model', checkpoints: processedCheckpoints.map(({ checkpoint }) => checkpoint) });
      if (abort.signal.aborted || !this.#enabled || this.#disposed) throw new Error('Memory processing was cancelled');
      attempt = await context.store.beginAttempt(lease, {
        runId: retainedRun.metadata.sessionId,
        baseFingerprint: snapshot.fingerprint,
        checkpoints: processedCheckpoints,
        ...(bypassRetryAt ? { bypassRetryAt: true } : {}),
      }, this.#now());
      if (!attempt) {
        await retainedRun.finish('cancelled', 'Memory inputs or processing policy changed before the attempt started');
        return;
      }
      context.attempt = attempt;
      this.#emitStatusChange();
      const result = await this.#dreamRunner({
        stagingDirectory: staging,
        memoryDirectory,
        inputDirectory: join(staging, '.dreaming', 'input'),
        baseSnapshot: createMemorySnapshot(snapshot.artifact, '.memory', { mode: 'read' }),
        manifest,
        modelRuntime: this.#options.modelRuntime,
        ...(this.#selectedModel === undefined ? {} : { selectedModel: this.#selectedModel }),
        ...(this.#scopedModels === undefined ? {} : { scopedModels: this.#scopedModels }),
        sessionDirectory: join(
          this.#options.sessionDir ?? join(this.#options.agentDir, 'sessions'),
          'memory',
        ),
        run: retainedRun,
        signal: abort.signal,
      });
      if (abort.signal.aborted || !this.#enabled || this.#disposed) throw new Error('Memory processing was cancelled');
      if (result) await hydrateMemoryDirectory(result, memoryDirectory, { replace: true, memoryPath: '.memory' });
      await retainedRun.record({ phase: 'validate' });
      const artifact = await readMemoryDirectory(memoryDirectory, {
        memoryPath: '.memory',
        sourceSessionIds: allowedSourceIds(snapshot, manifest),
        requireSources: true,
      });
      await retainedRun.record({
        phase: 'publish',
        outputFingerprint: createMemorySnapshot(artifact, '.memory').fingerprint,
      });
      await context.store.commit(
        lease,
        snapshot.fingerprint,
        artifact,
        processedCheckpoints,
        attempt,
      );
      published = true;
      await context.store.finishAttempt(lease, attempt, { status: 'success' }, this.#now());
      await retainedRun.finish('completed');
      if (manifest.failures.length > 0) {
        context.state = 'blocked';
        context.message = MEMORY_INPUT_BLOCKED_MESSAGE;
      } else {
        context.state = 'idle';
      }
      this.#emitStatusChange();
    } catch (error) {
      const leaseValid = await lease.verify();
      const explicitlyCancelled = !this.#enabled || this.#disposed
        || (abort.signal.aborted && !lease.compromised.aborted);
      const unavailableModel = error instanceof MemoryModelUnavailableError;
      const blockedBeforeInference = retainedRun !== undefined && attempt === undefined && !explicitlyCancelled;
      if (attempt && (leaseValid || explicitlyCancelled)) {
        try {
          const control = await context.store.finishAttempt(
            explicitlyCancelled || unavailableModel ? undefined : lease,
            attempt,
            explicitlyCancelled || unavailableModel ? { status: 'cancelled' }
              : { status: 'failure', reason: sanitizeMemoryDiagnostic(error) },
            this.#now(),
          );
          published ||= control.lastOutcome?.runId === attempt.runId && control.lastOutcome.status === 'success';
        } catch {
          context.storageBlocked = true;
        }
      }
      if (published) {
        context.state = 'idle';
        context.message = 'Memory was published, but its diagnostics could not be fully saved';
        this.#emitStatusChange();
        return;
      }
      context.state = 'error';
      context.message = !leaseValid
        ? safeProcessingMessage(new Error('Memory writer lease was lost'))
        : safeProcessingMessage(error);
      if (unavailableModel || blockedBeforeInference) {
        context.state = 'blocked';
        for (const checkpoint of retainedRun?.metadata.checkpoints ?? []) {
          context.blocked.set(checkpoint.sessionId, checkpoint);
        }
      }
      if (!retainedRun) {
        context.storageBlocked = true;
        context.message = `Memory processing is paused: ${sanitizeMemoryDiagnostic(error)}`;
      }
      await retainedRun?.finish(explicitlyCancelled ? 'cancelled'
        : unavailableModel || blockedBeforeInference ? 'blocked'
        : !leaseValid ? 'interrupted' : 'failed', error).catch(() => {
        context.storageBlocked = true;
        context.message = 'Memory diagnostics could not be saved; evidence remains pending';
      });
      this.#emitStatusChange();
    } finally {
      lease.compromised.removeEventListener('abort', abortOnLeaseCompromise);
      context.abort = undefined;
      context.attempt = undefined;
      if (staging) await rm(join(staging, '.pi-memory-runtime'), { recursive: true, force: true }).catch(() => {});
      await lease.release();
    }
  }

  async #reconcileRunDiagnostics(context: ProjectContext, lease: LocalMemoryLease): Promise<LocalMemoryControl> {
    let control = await context.store.readControl();
    control = await context.store.reconcileAbandonedAttempt(lease, this.#now());
    const options = {
      projectDirectory: context.store.projectDirectory,
      projectKey: context.project.key,
      sessionDirectory: join(this.#options.sessionDir ?? join(this.#options.agentDir, 'sessions'), 'memory'),
      ...(control.lastDisabledRunId ? { protectedRunIds: [control.lastDisabledRunId] } : {}),
    };
    if (control.lastOutcome) await LocalMemoryRun.reconcile(options, control.lastOutcome);
    await LocalMemoryRun.reconcileAbandoned(options, [
      ...(control.activeAttempt ? [control.activeAttempt.runId] : []),
      ...(control.lastOutcome ? [control.lastOutcome.runId] : []),
    ], this.#now());
    return control;
  }

  async #recover(context: ProjectContext): Promise<boolean> {
    const sessionDir = context.sessionDir ?? join(this.#options.agentDir, 'sessions');
    let sessions;
    try {
      sessions = await SessionManager.list(context.cwd, sessionDir);
    } catch {
      context.message = 'Memory startup recovery could not inspect sessions';
      return true;
    }
    if (this.#disposed || !this.#enabled) return false;
    let recovered = false;
    const stableAfter = this.#options.recoveryStableMs ?? 30_000;
    for (const info of sessions) {
      if (this.#disposed || !this.#enabled) return false;
      if (info.parentSessionPath || this.#now() - info.modified.getTime() < stableAfter) continue;
      try {
        const manager = SessionManager.open(info.path, sessionDir, context.cwd);
        const checkpoint = createSessionCheckpoint(manager);
        if (!checkpoint) continue;
        if (this.#disposed || !this.#enabled) return false;
        recovered = (await context.store.recordCheckpoint(checkpoint)) || recovered;
      } catch {}
    }
    if (recovered && !this.#disposed && this.#enabled) {
      await this.#trackScheduleIfPending(context);
      this.#emitStatusChange();
    }
    return true;
  }

  #emitStatusChange(): void {
    for (const listener of [...this.#statusListeners]) {
      try {
        listener();
      } catch {}
    }
  }

  #cancelScheduledRun(context: ProjectContext): void {
    if (context.timer) clearTimeout(context.timer);
    context.timer = undefined;
    context.timerDueAt = undefined;
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
  if (error instanceof MemoryModelUnavailableError) {
    return 'Low-tier memory model is unavailable; evidence remains pending';
  }
  if (error instanceof Error && error.message.includes('cancel')) return 'Memory processing was cancelled';
  if (error instanceof Error && error.message.includes('writer lease')) return 'Memory writer lease was lost; evidence remains pending';
  if (error instanceof Error && error.message.includes('changed')) return 'Memory changed during processing; evidence remains pending';
  return 'Memory processing failed; evidence remains pending';
}
