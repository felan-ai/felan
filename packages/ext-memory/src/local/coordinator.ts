import { createDefaultLocalMemoryDreamRunner, materializeMemoryInput } from './dreamer.js';
import { LocalMemoryRun } from './run.js';
import { readMemorySessionCheckpoint } from '../session-history.js';
import { LocalMemoryStore } from './store.js';
import { acquireLocalMemoryLease } from './lease.js';
import { resolveLocalMemoryProject } from './project.js';
import { hydrateMemoryDirectory, readMemoryDirectory } from './hydration.js';
import type { MemoryContext } from './context.js';
import { join } from 'node:path';
import { createMemorySnapshot, createMemoryProjectionSnapshot, extractSourceIds, type MemoryHost, type MemoryProcessingState, type MemorySnapshot, type MemoryStatus, type SessionCheckpoint } from '../index.js';

import {
  type ModelsService,
  type Api,
  type Classifier,
  type Model,
} from '@felan-ai/agent-core';
import type { LocalMemoryLease } from './lease.js';
import type { LocalMemoryLeaseOptions } from './lease.js';
import type { LocalMemoryProject } from './project.js';
import { MemoryModelUnavailableError } from './dreamer.js';
import type { LocalMemoryDreamRunner } from './dreamer.js';
import { LocalMemoryControlError } from './store.js';
import type { LocalMemoryAttempt } from './store.js';
import type { LocalMemoryControl } from './store.js';
import { sanitizeMemoryDiagnostic } from '../diagnostics.js';


interface ProjectContext {
  readonly project: LocalMemoryProject;
  readonly stores: WeakMap<MemoryContext, LocalMemoryStore>;
  readonly attachments: Set<AttachmentState>;
  driver: AttachmentState | undefined;
  failedDriver: AttachmentState | undefined;
  recoveryDriver: AttachmentState | undefined;
  ready: Promise<void> | undefined;
  initialized: boolean;
  recovery: Promise<void> | undefined;
  recoveryAbort: AbortController | undefined;
  recoveryRetryAt: number | undefined;
  recoveryTimer: ReturnType<typeof setTimeout> | undefined;
  recoveryCompleted: boolean;
  diagnosticsReconciled: boolean;
  timer: ReturnType<typeof setTimeout> | undefined;
  timerDueAt: number | undefined;
  run: Promise<void> | undefined;
  runEnvironment: MemoryContext | undefined;
  readonly followUps: Set<Promise<void>>;
  abort: AbortController | undefined;
  attempt: LocalMemoryAttempt | undefined;
  storageBlocked: boolean;
  writerBlocked: boolean;
  writerTimer: ReturnType<typeof setTimeout> | undefined;
  blocked: Map<string, MemoryCheckpointCursor>;
  state: MemoryProcessingState;
  message: string | undefined;
}


interface MemoryCheckpointCursor {
  readonly leafId: string | null;
  readonly transcriptDigest: string;
}


export interface LocalMemoryCoordinatorOptions {
  readonly agentDir: string;
  readonly sessionDir?: string;
  readonly enabled?: boolean;
  readonly debounceMs?: number;
  readonly batchSize?: number;
  readonly maxInputBytes?: number;
  readonly maxTranscriptBytes?: number;
  readonly recoveryStableMs?: number;
  /** Delay before the single retry of a startup recovery whose session listing failed. */
  readonly recoveryRetryMs?: number;
  readonly recover?: boolean;
  readonly dreamRunner?: LocalMemoryDreamRunner;
  readonly leaseOptions?: LocalMemoryLeaseOptions;
  readonly retryDelaysMs?: readonly [number, number];
  readonly writerRetryMs?: number;
  readonly now?: () => number;
}


export interface LocalMemoryAttachmentOptions {
  readonly environment: MemoryContext;
  readonly models: ModelsService;
  readonly scheduling: boolean;
  readonly unavailableReason?: string;
  readonly selectedModel?: Model<Api>;
  readonly scopedModels?: readonly Model<Api>[];
  readonly classifier?: Classifier;
}


export interface LocalMemoryAttachment {
  createSessionHost(options: LocalMemorySessionHostOptions): MemoryHost;
  readCurrent(cwd: string, sessionStorageRoot: string): Promise<MemorySnapshot>;
  recordCheckpoint(cwd: string, checkpoint: SessionCheckpoint): Promise<void>;
  status(cwd: string): Promise<LocalMemoryStatus>;
  runNow(cwd: string): Promise<LocalMemoryStatus>;
  retryProject(cwd: string): Promise<LocalMemoryStatus>;
  canonicalDirectory(cwd: string): Promise<string>;
  setSelectedModel(model: Model<Api> | undefined): void;
  setModelSelection(model: Model<Api> | undefined, scopedModels: readonly Model<Api>[] | undefined, classifier?: Classifier): void;
  subscribeStatusChanges(listener: () => void): () => void;
  busy(): boolean;
  settle(mode: 'drain' | 'force'): Promise<void>;
  detach(): Promise<void>;
}


interface AttachmentState extends Omit<LocalMemoryAttachmentOptions, 'selectedModel' | 'scopedModels' | 'classifier'> {
  selectedModel: Model<Api> | undefined;
  scopedModels: readonly Model<Api>[] | undefined;
  classifier: Classifier | undefined;
  readonly projections: Map<string, string>;
  readonly listeners: Set<() => void>;
  draining: boolean;
  closing: boolean;
  detached: boolean;
  detaching: Promise<void> | undefined;
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


interface LocalMemoryProcessingSnapshotLike {
  readonly artifact: { readonly files: readonly { readonly content: string }[] };
}


const MEMORY_INPUT_BLOCKED_MESSAGE = 'Memory checkpoints are paused after a failed run; evidence remains pending';

const MEMORY_AUTOMATIC_UPDATE_THRESHOLD = 5;

const MEMORY_AUTOMATIC_INTERVAL_MS = 24 * 60 * 60 * 1_000;

const MEMORY_DREAM_INPUT_MAX_BYTES = 10 * 1024 * 1024;

const MEMORY_MAX_BATCH_SESSIONS = 8;


export class LocalMemoryCoordinator {
  readonly #options: LocalMemoryCoordinatorOptions;
  readonly #contexts = new Map<string, ProjectContext>();
  readonly #attachments = new Set<AttachmentState>();
  readonly #statusListeners = new Set<() => void>();
  readonly #batchSize: number;
  #enabled: boolean;
  #disposed = false;
  #disposal: Promise<void> | undefined;
  #draining = false;
  #enableVersion = 0;

  constructor(options: LocalMemoryCoordinatorOptions) {
    this.#options = options;
    this.#batchSize = boundedMemoryBatchSize(options.batchSize);
    this.#enabled = options.enabled !== false;
  }

  attach(options: LocalMemoryAttachmentOptions): LocalMemoryAttachment {
    if (this.#disposed) throw new Error('Local memory coordinator is closed');
    const state: AttachmentState = {
      ...options,
      selectedModel: options.selectedModel,
      scopedModels: options.scopedModels === undefined ? undefined : [...options.scopedModels],
      classifier: options.classifier,
      projections: new Map(),
      listeners: new Set(),
      draining: false,
      closing: false,
      detached: false,
      detaching: undefined,
    };
    this.#attachments.add(state);
    const attachment: LocalMemoryAttachment = {
      createSessionHost: options => new LocalMemorySessionHost(attachment, options),
      readCurrent: (cwd, root) => this.#readCurrent(state, cwd, root),
      recordCheckpoint: (cwd, checkpoint) => this.#recordCheckpoint(state, cwd, checkpoint),
      status: cwd => this.#status(state, cwd),
      runNow: cwd => this.#runNow(state, cwd),
      retryProject: cwd => this.#retryProject(state, cwd),
      canonicalDirectory: async cwd => this.#store(await this.#context(state, cwd), state.environment).currentDirectory,
      setSelectedModel: model => this.#setModelSelection(state, model, state.scopedModels, state.classifier),
      setModelSelection: (model, scopedModels, classifier) => this.#setModelSelection(state, model, scopedModels, classifier),
      subscribeStatusChanges: listener => {
        if (state.detached || this.#disposed) return () => {};
        state.listeners.add(listener);
        return () => { state.listeners.delete(listener); };
      },
      busy: () => [...this.#contexts.values()].some(context => context.driver === state || context.recoveryDriver === state),
      settle: mode => this.#settleAttachment(state, mode),
      detach: () => {
        state.detaching ??= this.#detach(state);
        return state.detaching;
      },
    };
    return attachment;
  }

  isEnabled(): boolean {
    return this.#enabled;
  }

  hasActiveWork(): boolean {
    return [...this.#contexts.values()].some(context => !!context.run || !!context.ready || !!context.recovery || context.followUps.size > 0);
  }

  subscribeStatusChanges(listener: () => void): () => void {
    if (this.#disposed) return () => {};
    this.#statusListeners.add(listener);
    return () => this.#statusListeners.delete(listener);
  }

  #setModelSelection(
    attachment: AttachmentState,
    model: Model<Api> | undefined,
    scopedModels: readonly Model<Api>[] | undefined,
    classifier?: Classifier,
  ): void {
    if (attachment.detached || this.#disposed) return;
    attachment.selectedModel = model;
    attachment.scopedModels = scopedModels === undefined ? undefined : [...scopedModels];
    attachment.classifier = classifier;
    for (const context of this.#contexts.values()) {
      if (!context.attachments.has(attachment)) continue;
      context.blocked.clear();
      if (context.initialized) void this.#trackScheduleIfPending(context, attachment.environment);
    }
  }

  setEnabled(enabled: boolean): void {
    this.#enableVersion += 1;
    this.#enabled = enabled;
    for (const context of this.#contexts.values()) {
      if (!enabled) context.recoveryAbort?.abort();
      if (!enabled) this.#cancelTimers(context);
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

  async #status(attachment: AttachmentState, cwd: string): Promise<LocalMemoryStatus> {
    try {
      const context = await this.#context(attachment, cwd);
      const store = this.#store(context, attachment.environment);
      const state = await store.status();
      const control = await store.readControl();
      const processed = Object.values(state.processed);
      const lastProcessedAt = processed
        .map((entry) => entry.processedAt)
        .sort()
        .at(-1);
      return {
        enabled: this.#enabled && attachment.scheduling && !control.autoDisabled,
        state: !this.#enabled || !attachment.scheduling || control.autoDisabled ? 'disabled'
          : control.nextRetryAt && Date.parse(control.nextRetryAt) > this.#now() ? 'scheduled'
          : context.state === 'error' ? 'error'
          : control.activeAttempt ? 'processing' : context.state,
        pendingCheckpoints: Object.keys(state.pending).length,
        memoryFingerprint: state.memoryFingerprint,
        ...(lastProcessedAt === undefined ? {} : { lastProcessedAt }),
        ...(context.message || attachment.unavailableReason ? { message: context.message ?? attachment.unavailableReason! } : {}),
        consecutiveFailures: control.consecutiveFailures,
        ...(control.nextRetryAt ? { nextRetryAt: control.nextRetryAt } : {}),
        ...(control.autoDisabled ? { autoDisabled: control.autoDisabled } : {}),
        ...(control.activeAttempt || control.lastOutcome ? {
          lastRunId: control.activeAttempt?.runId ?? control.lastOutcome!.runId,
        } : {}),
      };
    } catch (error) {
      return {
        enabled: this.#enabled && attachment.scheduling,
        state: this.#enabled && attachment.scheduling ? 'error' : 'disabled',
        pendingCheckpoints: 0,
        message: error instanceof LocalMemoryControlError ? error.message : 'Local memory storage is unavailable',
      };
    }
  }

  async #readCurrent(attachment: AttachmentState, cwd: string, sessionStorageRoot: string): Promise<MemorySnapshot> {
    const context = await this.#context(attachment, cwd);
    const store = this.#store(context, attachment.environment);
    const snapshot = await store.readCurrent();
    const projectionKey = `${context.project.key}:${sessionStorageRoot}`;
    const memoryPath = join(sessionStorageRoot, store.projectionName);
    if (attachment.projections.get(projectionKey) !== snapshot.fingerprint) {
      const projection = await store.projectTo(sessionStorageRoot, snapshot);
      if (!attachment.detached) attachment.projections.set(projectionKey, snapshot.fingerprint);
      return projection;
    }
    return createMemoryProjectionSnapshot(snapshot, memoryPath);
  }

  async #recordCheckpoint(attachment: AttachmentState, cwd: string, checkpoint: SessionCheckpoint): Promise<void> {
    const context = await this.#context(attachment, cwd);
    if (await this.#store(context, attachment.environment).recordCheckpoint(checkpoint)) {
      context.blocked.delete(checkpoint.sessionId);
      await this.#trackScheduleIfPending(context, attachment.environment);
      this.#emitStatusChange();
    }
  }

  async #runNow(attachment: AttachmentState, cwd: string): Promise<LocalMemoryStatus> {
    if (!this.#eligible(attachment)) return this.#status(attachment, cwd);
    const context = await this.#context(attachment, cwd);
    this.#cancelScheduledRun(context);
    while (context.run || context.followUps.size > 0) {
      await Promise.allSettled([
        ...(context.run ? [context.run] : []),
        ...context.followUps,
      ]);
      this.#cancelScheduledRun(context);
    }
    context.blocked.clear();
    context.storageBlocked = false;
    context.message = undefined;
    await this.#launchRun(context, true, attachment);
    return this.#status(attachment, cwd);
  }

  async #retryProject(attachment: AttachmentState, cwd: string): Promise<LocalMemoryStatus> {
    if (!this.#eligible(attachment)) return this.#status(attachment, cwd);
    const context = await this.#context(attachment, cwd);
    if (!this.#eligible(attachment)) return this.#status(attachment, cwd);
    const enableVersion = this.#enableVersion;
    this.#cancelScheduledRun(context);
    await this.#store(context, attachment.environment).resetProjectControl(
      this.#now(),
      () => this.#eligible(attachment) && this.#enableVersion === enableVersion,
    );
    this.#emitStatusChange();
    context.abort?.abort(new Error('Memory processing was explicitly retried'));
    if (context.run) await context.run;
    context.blocked.clear();
    context.storageBlocked = false;
    context.message = undefined;
    await this.#runNow(attachment, cwd);
    return this.#status(attachment, cwd);
  }

  #eligible(attachment: AttachmentState): boolean {
    return this.#enabled && !this.#disposed && !this.#draining
      && attachment.scheduling && !attachment.draining && !attachment.closing && !attachment.detached;
  }

  #driver(context: ProjectContext, preferred?: AttachmentState): AttachmentState | undefined {
    if (preferred && context.attachments.has(preferred) && this.#eligible(preferred)) return preferred;
    return [...this.#attachments].reverse().find(attachment => context.attachments.has(attachment) && this.#eligible(attachment));
  }

  #liveMember(context: ProjectContext): AttachmentState | undefined {
    return [...this.#attachments].reverse().find(attachment => context.attachments.has(attachment)
      && attachment.scheduling && !attachment.draining && !attachment.closing && !attachment.detached);
  }

  #runEnvironment(context: ProjectContext, driver: AttachmentState): MemoryContext {
    // The daemon seals closing runtimes outside their own cleanup async context.
    const current = () => (driver.closing || driver.detached ? this.#liveMember(context) ?? driver : driver).environment;
    const environment: MemoryContext = {
      get runtime() { return current().runtime; },
      get sessions() { return current().sessions; },
    };
    Object.defineProperty(environment, 'openWorker', { get: () => current().openWorker });
    return environment;
  }

  async #settleAttachment(attachment: AttachmentState, mode: 'drain' | 'force'): Promise<void> {
    attachment.draining = true;
    if (mode === 'force') attachment.closing = true;
    for (const context of this.#contexts.values()) {
      if (context.recoveryDriver === attachment) context.recoveryAbort?.abort();
      if (mode === 'force' && context.driver === attachment) {
        this.#cancelContext(context, 'Memory processing was cancelled during shutdown', false);
      }
      if (!this.#driver(context)) this.#cancelTimers(context);
    }
    while (true) {
      const work = [...this.#contexts.values()].flatMap(context => [
        ...(context.driver === attachment ? [...(context.run ? [context.run] : []), ...context.followUps] : []),
        ...(context.recoveryDriver === attachment && context.recovery ? [context.recovery] : []),
      ]);
      if (!work.length) break;
      await Promise.allSettled(work);
    }
    for (const context of this.#contexts.values()) {
      if (mode === 'force' && context.failedDriver === attachment) {
        context.storageBlocked = false;
        context.blocked.clear();
        if (context.state === 'error' || context.state === 'blocked') context.state = 'idle';
        context.message = undefined;
        context.failedDriver = undefined;
      }
      if (!context.attachments.has(attachment) || !context.initialized) continue;
      this.#startRecovery(context);
      void this.#trackScheduleIfPending(context);
    }
  }

  async #detach(attachment: AttachmentState): Promise<void> {
    attachment.closing = true;
    await this.#settleAttachment(attachment, 'force');
    attachment.detached = true;
    this.#attachments.delete(attachment);
    attachment.listeners.clear();
    attachment.projections.clear();
    for (const context of this.#contexts.values()) {
      context.attachments.delete(attachment);
      if (!this.#driver(context)) this.#cancelTimers(context);
    }
  }

  async drain(): Promise<void> {
    this.#draining = true;
    for (const context of this.#contexts.values()) {
      context.recoveryAbort?.abort();
      this.#cancelTimers(context);
    }
    while (true) {
      const work = [...this.#contexts.values()].flatMap(context => [
        ...(context.run ? [context.run] : []), ...(context.ready ? [context.ready] : []),
        ...(context.recovery ? [context.recovery] : []), ...context.followUps,
      ]);
      if (!work.length) return;
      const results = await Promise.allSettled(work);
      const failures = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
      if (failures.length) throw new AggregateError(failures, 'Memory drain could not settle all work.');
    }
  }

  dispose(): Promise<void> {
    this.#disposal ??= this.#dispose();
    return this.#disposal;
  }

  async #dispose(): Promise<void> {
    this.#disposed = true;
    for (const context of this.#contexts.values()) {
      context.recoveryAbort?.abort();
      this.#cancelTimers(context);
      this.#cancelContext(context, 'Memory processing was cancelled during shutdown', false);
    }
    while (true) {
      const work = [...this.#contexts.values()].flatMap(context => [
        ...(context.run ? [context.run] : []),
        ...(context.ready ? [context.ready] : []),
        ...(context.recovery ? [context.recovery] : []),
        ...context.followUps,
      ]);
      if (!work.length) break;
      await Promise.allSettled(work);
    }
    for (const attachment of this.#attachments) {
      attachment.detached = true;
      attachment.listeners.clear();
      attachment.projections.clear();
    }
    this.#attachments.clear();
    this.#statusListeners.clear();
  }

  async #context(attachment: AttachmentState, cwd: string): Promise<ProjectContext> {
    if (this.#disposed || attachment.detached) throw new Error('Local memory coordinator is closed');
    const project = await resolveLocalMemoryProject(attachment.environment, cwd);
    if (this.#disposed || attachment.detached) throw new Error('Local memory coordinator is closed');
    const existing = this.#contexts.get(project.key);
    if (existing) {
      existing.attachments.add(attachment);
      await this.#initialize(existing, attachment);
      return existing;
    }
    const context: ProjectContext = {
      project,
      stores: new WeakMap(),
      attachments: new Set([attachment]),
      driver: undefined,
      failedDriver: undefined,
      recoveryDriver: undefined,
      ready: undefined,
      initialized: false,
      recovery: undefined,
      recoveryAbort: undefined,
      recoveryRetryAt: undefined,
      recoveryTimer: undefined,
      recoveryCompleted: false,
      diagnosticsReconciled: false,
      timer: undefined,
      timerDueAt: undefined,
      run: undefined,
      runEnvironment: undefined,
      followUps: new Set(),
      abort: undefined,
      attempt: undefined,
      storageBlocked: false,
      writerBlocked: false,
      writerTimer: undefined,
      blocked: new Map(),
      state: this.#enabled ? 'idle' : 'disabled',
      message: undefined,
    };
    this.#contexts.set(project.key, context);
    await this.#initialize(context, attachment);
    return context;
  }

  #store(context: ProjectContext, environment: MemoryContext): LocalMemoryStore {
    let store = context.stores.get(environment);
    if (!store) {
      store = new LocalMemoryStore(environment, this.#options.agentDir, context.project, {
        ...(this.#options.retryDelaysMs ? { retryDelaysMs: this.#options.retryDelaysMs } : {}),
      });
      context.stores.set(environment, store);
    }
    return store;
  }

  async #initialize(context: ProjectContext, attachment: AttachmentState): Promise<void> {
    if (context.ready) {
      await context.ready;
      return;
    }
    if (context.initialized && context.diagnosticsReconciled) {
      this.#startRecovery(context);
      void this.#trackScheduleIfPending(context, attachment.environment);
      return;
    }
    const ready = this.#initializeContext(context, attachment).finally(() => {
      if (context.ready === ready) context.ready = undefined;
    });
    context.ready = ready;
    await ready;
  }

  async #initializeContext(context: ProjectContext, attachment: AttachmentState): Promise<void> {
    const environment = attachment.environment;
    const store = this.#store(context, environment);
    if (!context.initialized) {
      await store.initialize(this.#now()).then(() => {
        context.initialized = true;
        context.state = this.#enabled ? 'idle' : 'disabled';
        context.message = undefined;
      }).catch(async (error: unknown) => {
        if (!(error instanceof LocalMemoryControlError)) throw error;
        const current = await store.readCurrent();
        if (current.fingerprint !== (await store.status()).memoryFingerprint) throw error;
        context.message = error.message;
      });
    }
    if (!context.initialized) return;
    if (!context.diagnosticsReconciled) {
      try {
        const lease = await acquireLocalMemoryLease(environment, store.projectDirectory, this.#options.leaseOptions);
        if (lease) {
          try {
            await this.#reconcileRunDiagnostics(context, environment, lease);
            context.diagnosticsReconciled = true;
            context.storageBlocked = false;
            context.failedDriver = undefined;
            context.message = undefined;
          } finally {
            await lease.release();
          }
        }
      } catch (error) {
        context.storageBlocked = true;
        context.failedDriver = attachment;
        context.message = `Memory diagnostics recovery is blocked: ${sanitizeMemoryDiagnostic(error)}`;
      }
    }
    if (this.#disposed) return;
    if (this.#enabled) void this.#trackScheduleIfPending(context, environment);
    this.#startRecovery(context);
  }

  #startRecovery(context: ProjectContext): void {
    if (this.#options.recover === false || context.recoveryCompleted || context.recovery) return;
    const driver = this.#driver(context);
    if (!driver) return;
    if (context.recoveryRetryAt !== undefined && this.#now() < context.recoveryRetryAt) {
      this.#scheduleRecoveryRetry(context);
      return;
    }
    if (context.recoveryTimer) clearTimeout(context.recoveryTimer);
    context.recoveryTimer = undefined;
    context.recoveryDriver = driver;
    const abort = new AbortController();
    context.recoveryAbort = abort;
    const recovery = this.#recover(context, driver, abort.signal).then(completed => {
      if (completed) context.recoveryCompleted = true;
    }).catch(() => {
      context.message = 'Memory startup recovery could not complete';
    }).finally(() => {
      if (context.recovery === recovery) {
        context.recovery = undefined;
        context.recoveryAbort = undefined;
        context.recoveryDriver = undefined;
      }
      if (abort.signal.aborted) this.#startRecovery(context);
      else this.#scheduleRecoveryRetry(context);
      this.#emitStatusChange();
    });
    context.recovery = recovery;
  }

  #scheduleRecoveryRetry(context: ProjectContext): void {
    if (context.recoveryTimer || context.recoveryCompleted || context.recoveryRetryAt === undefined || !this.#driver(context)) return;
    const timer = setTimeout(() => {
      if (context.recoveryTimer !== timer) return;
      context.recoveryTimer = undefined;
      this.#startRecovery(context);
    }, Math.max(0, context.recoveryRetryAt - this.#now()));
    context.recoveryTimer = timer;
    timer.unref?.();
  }

  #scheduleWriterRetry(context: ProjectContext): void {
    if (context.writerTimer || !this.#driver(context)) return;
    context.writerBlocked = true;
    const timer = setTimeout(() => {
      if (context.writerTimer !== timer) return;
      context.writerTimer = undefined;
      context.writerBlocked = false;
      if (context.run) {
        void this.#trackScheduleIfPending(context);
        return;
      }
      context.diagnosticsReconciled = false;
      const driver = this.#driver(context);
      if (driver) void this.#initialize(context, driver).catch(() => {});
    }, this.#options.writerRetryMs ?? 30_000);
    context.writerTimer = timer;
    timer.unref?.();
  }

  #now(): number { return this.#options.now?.() ?? Date.now(); }

  #cancelContext(context: ProjectContext, reason: string, cancelPersisted: boolean): void {
    const alreadyAborted = context.abort?.signal.aborted ?? false;
    context.abort?.abort(new Error(reason));
    if (alreadyAborted || !context.initialized || (!cancelPersisted && !context.attempt)) return;
    const environment = context.runEnvironment ?? this.#liveMember(context)?.environment;
    if (!environment) return;
    const store = this.#store(context, environment);
    const cancellation = cancelPersisted
      ? store.cancelActiveAttempt(this.#now())
      : store.finishAttempt(undefined, context.attempt!, { status: 'cancelled', reason }, this.#now());
    const followUp = cancellation
      .then(() => { this.#emitStatusChange(); })
      .catch(() => {})
      .finally(() => { context.followUps.delete(followUp); });
    context.followUps.add(followUp);
  }

  async #schedule(context: ProjectContext, dueAt: number): Promise<void> {
    if (!this.#driver(context) || context.run || context.storageBlocked) return;
    if (context.timer && context.timerDueAt === dueAt) return;
    this.#cancelScheduledRun(context);
    context.state = 'scheduled';
    const delay = Math.max(0, dueAt - this.#now());
    const timer = setTimeout(() => {
      if (context.timer !== timer) return;
      context.timer = undefined;
      context.timerDueAt = undefined;
      void this.#launchRun(context)?.catch(() => {});
    }, delay);
    context.timer = timer;
    context.timerDueAt = dueAt;
    timer.unref?.();
  }

  async #scheduleIfPending(context: ProjectContext, environment?: MemoryContext): Promise<void> {
    const driver = this.#driver(context);
    if (!driver) {
      this.#cancelTimers(context);
      return;
    }
    try {
      const store = this.#store(context, environment ?? driver.environment);
      const control = await store.readControl();
      if (control.autoDisabled) {
        this.#cancelTimers(context);
        context.state = 'disabled';
        return;
      }
      if (context.storageBlocked) return;
      if (context.writerBlocked) return;
      const state = await store.status();
      if (context.state === 'error' && context.message === 'Local memory storage is unavailable') {
        context.state = 'idle';
        context.message = undefined;
      }
      const pending = Object.values(state.pending);
      if (!this.#driver(context)) return;
      if (control.activeAttempt) {
        this.#cancelScheduledRun(context);
        if (!context.run) this.#scheduleWriterRetry(context);
      } else if (pending.some(({ checkpoint }) => !isBlockedCheckpoint(context, checkpoint))) {
        const acceptedUpdates = await store.pendingAcceptedUpdates(
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

  #trackScheduleIfPending(context: ProjectContext, environment?: MemoryContext): Promise<void> {
    const followUp = this.#scheduleIfPending(context, environment).finally(() => {
      context.followUps.delete(followUp);
    });
    context.followUps.add(followUp);
    return followUp;
  }

  #launchRun(context: ProjectContext, bypassRetryAt = false, preferred?: AttachmentState): Promise<void> | undefined {
    if (context.run || context.storageBlocked || preferred && !this.#eligible(preferred)) return;
    const driver = this.#driver(context, preferred);
    if (!driver) return;
    context.driver = driver;
    context.failedDriver = undefined;
    const environment = this.#runEnvironment(context, driver);
    context.runEnvironment = environment;
    const run = this.#run(context, driver, environment, bypassRetryAt).catch((error: unknown) => {
      context.state = 'error';
      context.failedDriver = driver;
      if (!bypassRetryAt && !driver.closing && !driver.detached) context.storageBlocked = true;
      context.message = sanitizeMemoryDiagnostic(error);
      throw error;
    }).finally(async () => {
      if (context.run === settled) {
        context.run = undefined;
        context.driver = undefined;
        context.runEnvironment = undefined;
        context.abort = undefined;
      }
      await this.#trackScheduleIfPending(context);
      this.#emitStatusChange();
    });
    const settled = run.catch(() => {});
    context.run = settled;
    return run;
  }

  async #run(context: ProjectContext, driver: AttachmentState, environment: MemoryContext, bypassRetryAt: boolean): Promise<void> {
    if (this.#disposed || this.#draining || !this.#enabled || context.storageBlocked) return;
    context.state = 'processing';
    context.message = undefined;
    const abort = new AbortController();
    context.abort = abort;
    const store = this.#store(context, environment);
    let lease: LocalMemoryLease | undefined;
    const cancelled = () => driver.closing || driver.detached || !this.#enabled || this.#disposed
      || abort.signal.aborted && !lease?.compromised.aborted;
    try {
      lease = await acquireLocalMemoryLease(environment, store.projectDirectory, this.#options.leaseOptions);
    } catch (error) {
      if (cancelled()) {
        context.state = 'idle';
        context.message = driver.closing || driver.detached || this.#disposed
          ? 'Memory processing was cancelled during shutdown' : 'Memory processing was cancelled';
        return;
      }
      this.#scheduleWriterRetry(context);
      context.state = 'error';
      context.failedDriver = driver;
      context.message = safeProcessingMessage(error);
      return;
    }
    if (!lease) {
      this.#scheduleWriterRetry(context);
      context.state = 'blocked';
      context.failedDriver = driver;
      context.message = 'Another Felan Code process owns the memory writer';
      return;
    }
    context.writerBlocked = false;
    if (context.writerTimer) clearTimeout(context.writerTimer);
    context.writerTimer = undefined;
    const abortOnLeaseCompromise = (): void => {
      abort.abort(new Error('Memory writer lease was lost'));
    };
    lease.compromised.addEventListener('abort', abortOnLeaseCompromise, { once: true });
    let staging: string | undefined;
    let retainedRun: LocalMemoryRun | undefined;
    let published = false;
    let attempt: LocalMemoryAttempt | undefined;
    try {
      if (abort.signal.aborted || !this.#enabled || this.#disposed) return;
      const control = await this.#reconcileRunDiagnostics(context, environment, lease);
      if (control.autoDisabled) {
        context.state = 'disabled';
        return;
      }
      if (!bypassRetryAt && control.nextRetryAt && Date.parse(control.nextRetryAt) > this.#now()) {
        context.state = 'scheduled';
        return;
      }
      // Every pending checkpoint is a candidate so unreadable ones cannot occupy the batch.
      const snapshot = await store.processingSnapshot(
        Number.POSITIVE_INFINITY,
        (checkpoint) => !isBlockedCheckpoint(context, checkpoint),
      );
      if (snapshot.checkpoints.length === 0) {
        context.state = 'idle';
        return;
      }
      retainedRun = await LocalMemoryRun.create(environment, {
        projectDirectory: store.projectDirectory,
        sessionDirectory: join(this.#options.sessionDir ?? join(this.#options.agentDir, 'sessions'), 'memory'),
        projectKey: context.project.key,
        projectRoot: context.project.canonicalRoot,
        checkpoints: snapshot.checkpoints.slice(0, this.#batchSize).map(({ checkpoint }) => checkpoint),
        baseFingerprint: snapshot.fingerprint,
        ...(control.lastDisabledRunId ? { protectedRunIds: [control.lastDisabledRunId] } : {}),
      });
      staging = retainedRun.workspace;
      const memoryDirectory = join(staging, '.memory');
      await hydrateMemoryDirectory(environment, snapshot.artifact, memoryDirectory, { memoryPath: '.memory', mode: 'read' });
      const manifest = await materializeMemoryInput(environment, {
        stagingDirectory: staging,
        checkpoints: snapshot.checkpoints.map(({ checkpoint }) => checkpoint),
        previousCheckpoints: Object.fromEntries(
          Object.entries(snapshot.state.processed).map(([sessionId, entry]) => [sessionId, entry.checkpoint]),
        ),
        baseSnapshot: createMemorySnapshot(snapshot.artifact, '.memory', { mode: 'read' }),
        maxInputBytes: this.#options.maxInputBytes ?? MEMORY_DREAM_INPUT_MAX_BYTES,
        ...(this.#options.maxTranscriptBytes === undefined
          ? {}
          : { maxTranscriptBytes: this.#options.maxTranscriptBytes }),
        maxSessions: this.#batchSize,
        signal: abort.signal,
      });
      // A cancelled read reports as a failure; it must not drop evidence.
      if (abort.signal.aborted || !this.#enabled || this.#disposed) throw new Error('Memory processing was cancelled');
      // A reachable Sessions service shows the failures belong to the checkpoints, not to the service.
      if (manifest.failures.length > 0) await environment.sessions.list({ scope: 'project' }, { limit: 1, signal: abort.signal });
      const dropped = manifest.failures.length === 0 ? 0 : await store.dropCheckpoints(
        lease,
        manifest.failures.map(({ checkpoint, code }) => ({ checkpoint, reason: code })),
        this.#now(),
      );
      const droppedMessage = dropped === 0 ? undefined : droppedCheckpointsMessage(dropped);
      const processedCheckpoints = snapshot.checkpoints.filter(({ checkpoint }) =>
        manifest.sessions.some((session) =>
          session.checkpoint.sessionId === checkpoint.sessionId
          && sameCheckpointCursor(session.checkpoint, checkpoint),
        ),
      );
      if (processedCheckpoints.length === 0) {
        context.state = 'idle';
        context.message = droppedMessage;
        await retainedRun.finish('blocked', droppedMessage ?? 'Memory checkpoints changed before they could be read');
        return;
      }
      await retainedRun.record({ phase: 'model', checkpoints: processedCheckpoints.map(({ checkpoint }) => checkpoint) });
      if (abort.signal.aborted || !this.#enabled || this.#disposed) throw new Error('Memory processing was cancelled');
      attempt = await store.beginAttempt(lease, {
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
      const result = await (this.#options.dreamRunner ?? createDefaultLocalMemoryDreamRunner(environment))({
        stagingDirectory: staging,
        memoryDirectory,
        inputDirectory: join(staging, '.dreaming', 'input'),
        baseSnapshot: createMemorySnapshot(snapshot.artifact, '.memory', { mode: 'read' }),
        manifest,
        models: driver.models,
        ...(driver.selectedModel === undefined ? {} : { selectedModel: driver.selectedModel }),
        ...(driver.scopedModels === undefined ? {} : { scopedModels: driver.scopedModels }),
        ...(driver.classifier === undefined ? {} : { classifier: driver.classifier }),
        sessionDirectory: join(
          this.#options.sessionDir ?? join(this.#options.agentDir, 'sessions'),
          'memory',
        ),
        run: retainedRun,
        signal: abort.signal,
      });
      if (abort.signal.aborted || !this.#enabled || this.#disposed) throw new Error('Memory processing was cancelled');
      if (result) await hydrateMemoryDirectory(environment, result, memoryDirectory, { replace: true, memoryPath: '.memory' });
      await retainedRun.record({ phase: 'validate' });
      const artifact = await readMemoryDirectory(environment, memoryDirectory, {
        memoryPath: '.memory',
        sourceSessionIds: allowedSourceIds(snapshot, manifest),
        requireSources: true,
      });
      await retainedRun.record({
        phase: 'publish',
        outputFingerprint: createMemorySnapshot(artifact, '.memory').fingerprint,
      });
      await store.commit(
        lease,
        snapshot.fingerprint,
        artifact,
        processedCheckpoints,
        attempt,
      );
      published = true;
      await store.finishAttempt(lease, attempt, { status: 'success' }, this.#now());
      await retainedRun.finish('completed');
      context.state = 'idle';
      context.failedDriver = undefined;
      context.message = droppedMessage;
    } catch (error) {
      const leaseValid = await lease.verify().catch(() => false);
      const explicitlyCancelled = cancelled();
      const unavailableModel = error instanceof MemoryModelUnavailableError;
      const blockedBeforeInference = retainedRun !== undefined && attempt === undefined && !explicitlyCancelled;
      if (attempt && (leaseValid || explicitlyCancelled)) {
        try {
          const control = await store.finishAttempt(
            explicitlyCancelled || unavailableModel ? undefined : lease,
            attempt,
            explicitlyCancelled || unavailableModel ? { status: 'cancelled' }
              : { status: 'failure', reason: sanitizeMemoryDiagnostic(error) },
            this.#now(),
          );
          published ||= control.lastOutcome?.runId === attempt.runId && control.lastOutcome.status === 'success';
        } catch {
          if (!explicitlyCancelled) context.storageBlocked = true;
        }
      }
      if (explicitlyCancelled) {
        context.state = 'idle';
        context.message = driver.closing || driver.detached || this.#disposed
          ? 'Memory processing was cancelled during shutdown' : 'Memory processing was cancelled';
        await retainedRun?.finish('cancelled', error).catch(() => {});
        return;
      }
      if (published) {
        context.state = 'idle';
        context.failedDriver = context.storageBlocked ? driver : undefined;
        context.message = 'Memory was published, but its diagnostics could not be fully saved';
        return;
      }
      context.state = 'error';
      context.failedDriver = driver;
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
      await retainedRun?.finish(unavailableModel || blockedBeforeInference ? 'blocked'
        : !leaseValid ? 'interrupted' : 'failed', error).catch(() => {
        context.storageBlocked = true;
        context.message = 'Memory diagnostics could not be saved; evidence remains pending';
      });
    } finally {
      lease.compromised.removeEventListener('abort', abortOnLeaseCompromise);
      context.attempt = undefined;
      await lease.release().catch(error => {
        if (!cancelled()) throw error;
      });
    }
  }

  async #reconcileRunDiagnostics(context: ProjectContext, environment: MemoryContext, lease: LocalMemoryLease): Promise<LocalMemoryControl> {
    const store = this.#store(context, environment);
    const previous = await store.readControl();
    const control = await store.reconcileAbandonedAttempt(lease, this.#now());
    if (previous.updatedAt !== control.updatedAt) this.#emitStatusChange();
    const options = {
      projectDirectory: store.projectDirectory,
      projectKey: context.project.key,
      sessionDirectory: join(this.#options.sessionDir ?? join(this.#options.agentDir, 'sessions'), 'memory'),
      ...(control.lastDisabledRunId ? { protectedRunIds: [control.lastDisabledRunId] } : {}),
    };
    if (control.lastOutcome) await LocalMemoryRun.reconcile(environment, options, control.lastOutcome);
    await LocalMemoryRun.reconcileAbandoned(environment, options, [
      ...(control.activeAttempt ? [control.activeAttempt.runId] : []),
      ...(control.lastOutcome ? [control.lastOutcome.runId] : []),
    ], this.#now());
    return control;
  }

  async #recover(context: ProjectContext, driver: AttachmentState, signal: AbortSignal): Promise<boolean> {
    let cursor: string | undefined;
    let recovered = false;
    const stableAfter = this.#options.recoveryStableMs ?? 30_000;
    const store = this.#store(context, driver.environment);
    const stopped = () => this.#disposed || this.#draining || !this.#enabled || signal.aborted;
    try {
      do {
        const page = await driver.environment.sessions.list({ scope: 'project' }, { ...(cursor ? { cursor } : {}), signal });
        for (const info of page.items) {
          if (stopped()) return false;
          if (info.parent || this.#now() - info.updatedAt < stableAfter) continue;
          let checkpoint: SessionCheckpoint;
          try {
            checkpoint = await readMemorySessionCheckpoint(driver.environment.sessions, info.id, signal);
          } catch {
            if (stopped()) return false;
            // A session that cannot be read now is skipped; its live checkpoint or a later run records it.
            continue;
          }
          if (stopped()) return false;
          recovered = (await store.recordCheckpoint(checkpoint)) || recovered;
        }
        cursor = page.nextCursor;
      } while (cursor);
    } catch {
      if (stopped()) return false;
      if (context.recoveryRetryAt === undefined) {
        context.recoveryRetryAt = this.#now() + (this.#options.recoveryRetryMs ?? 30_000);
        return false;
      }
      context.message = 'Memory startup recovery could not inspect sessions';
      return true;
    }
    if (recovered && !this.#disposed && this.#enabled) {
      await this.#trackScheduleIfPending(context);
      this.#emitStatusChange();
    }
    return true;
  }

  #emitStatusChange(): void {
    for (const listener of [...this.#statusListeners, ...[...this.#attachments].flatMap(attachment => [...attachment.listeners])]) {
      try {
        listener();
      } catch {}
    }
  }

  #cancelTimers(context: ProjectContext): void {
    this.#cancelScheduledRun(context);
    if (context.recoveryTimer) clearTimeout(context.recoveryTimer);
    if (context.writerTimer) clearTimeout(context.writerTimer);
    context.recoveryTimer = undefined;
    context.writerTimer = undefined;
    context.writerBlocked = false;
  }

  #cancelScheduledRun(context: ProjectContext): void {
    if (context.timer) clearTimeout(context.timer);
    context.timer = undefined;
    context.timerDueAt = undefined;
  }
}


class LocalMemorySessionHost implements MemoryHost {
  readonly #coordinator: LocalMemoryAttachment;
  readonly #cwd: string;
  readonly #sessionStorageRoot: string;

  constructor(coordinator: LocalMemoryAttachment, options: LocalMemorySessionHostOptions) {
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


function boundedMemoryBatchSize(requested: number | undefined): number {
  if (requested === undefined) return MEMORY_MAX_BATCH_SESSIONS;
  if (!Number.isSafeInteger(requested) || requested <= 0) {
    throw new Error('Memory batch size must be a positive safe integer');
  }
  return Math.min(requested, MEMORY_MAX_BATCH_SESSIONS);
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


function droppedCheckpointsMessage(count: number): string {
  return `Dropped ${count} memory checkpoint${count === 1 ? '' : 's'} that could not be read`;
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

