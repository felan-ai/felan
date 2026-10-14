import { AsyncLocalStorage } from 'node:async_hooks';
import { closeSync, constants, existsSync, fsyncSync, openSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AgentRuntime, AgentSession } from '@felan-ai/agent-core';
import { canonicalRequestPayload, parseInteraction, parseSchema, type Interaction, type InteractionAnswer, type KnownSessionChange, type OperationParams, type Origin, type Policy, type SessionSnapshot } from '@felan-ai/session-protocol';
import { RegistryExecutions, ExecutionHost } from './executions.js';
import type { ExecutionMetadata } from './control-state.js';
import type { ProcessAdapter } from './process-adapter.js';
import type { ControlCommit, DaemonControlStore } from './control-store.js';
import { SessionProfileSchema, type ControlSession, type SessionProfile } from './control-state.js';
import { discoverLegacySessions, readTranscriptPreview, transcriptPreview, type LegacySession } from './legacy-sessions.js';
import type { DaemonOwnership } from './ownership.js';
import type { SessionLifecycle, DaemonSessionServices, SessionOpenRequest, SessionResources, SessionBinding, SessionTargetIdentity, SessionExecutionPolicy } from './session-lifecycle-contracts.js';
import { profilePolicy, SessionProjection, type ProjectionOutput } from './projection.js';
import { RegistryProcesses } from './processes.js';
import { guardOwnedPaths, sha256 } from './persistence.js';
import { prepareTranscriptDeletion } from './session-files.js';
import { assertTargetIdentity, canonicalProspectivePath, pathInside } from './target.js';
import { sessionTip } from './session-cursor.js';
import type { createUiVocabulary } from './ui-vocabulary.js';

export interface RegistryOpenRequest extends Omit<SessionOpenRequest, 'resources' | 'ownership' | 'services' | 'policy'> {
  cwd: string;
  sessionDir?: string;
  policy?: SessionExecutionPolicy;
  systemPromptAppend?: string;
  clientRoot?: true;
  providerContext?: unknown;
  execution?: ExecutionMetadata;
}
export interface RegistryService {
  readonly disposeWhenIdle?: boolean;
  busy(): boolean;
  settle(mode?: 'drain' | 'force'): Promise<void>;
  dispose(): Promise<void>;
}
export interface RegistryOptions {
  owner: DaemonOwnership;
  store: DaemonControlStore;
  lifecycle: SessionLifecycle;
  services(context: { request: RegistryOpenRequest; getExecutionPolicy(): SessionExecutionPolicy }): DaemonSessionServices;
  now?: () => number;
  idleMs?: number;
  processAdapter?: ProcessAdapter;
  commandAvailable?(session: string, name: string): boolean;
  onViewCancellationDiagnostic?(event: { session: string; elementId: string; reason: 'failed' | 'timeout' | 'limit' }): void;
}
export interface RegistryMutationContext {
  readonly session: AgentSession;
  assertCurrent(): void;
}
const nonRunMutations = new Set(['set_model', 'set_thinking', 'session.rename', 'session.entry.label', 'session.branch.select', 'session.export', 'command.invoke', 'shell.execute', 'processes.write', 'processes.stop', 'steer', 'follow_up', 'executions.steer', 'executions.cancel', 'ui.action']);
interface Entry {
  binding: SessionBinding;
  projection: SessionProjection;
  attachments: Map<string, { principal: string; kind: 'tui' | 'acp' | 'headless' }>;
  services: Set<RegistryService>;
  prepareUiAction?: ReturnType<typeof createUiVocabulary>['prepareAction'];
  dispatches: Set<string>;
  writers: Set<Promise<void>>;
  host?: ExecutionHost;
  lastDetached: number;
  disposing?: Promise<void>;
  runtimeDisposed?: boolean;
  cancelling?: Promise<void>;
  cancellingViews?: Promise<void>;
  viewActions?: Set<AbortController>;
  viewCancellation?: { attempted: Set<string>; rounds: number };
  command?: { runId: string; views: Set<string> };
}
class RegistryOpeningCancelled extends Error {}

export class SessionRegistry {
  readonly processes: RegistryProcesses;
  readonly recovery: ReturnType<DaemonControlStore['recover']>['value'] | undefined;
  private readonly entries = new Map<string, Entry>();
  private readonly executionManagers = new Map<string, RegistryExecutions>();
  private readonly runtimeOpening = new AsyncLocalStorage<{ scope?: { session: string; root: string } }>();
  private readonly bindingActivation = new AsyncLocalStorage<{ binding: SessionBinding; active: boolean }>();
  private readonly opening = new Map<string, Promise<SessionBinding>>();
  private readonly pathClaims = new Set<string>();
  private readonly copyClaims = new Set<string>();
  private readonly reservations = new Map<string, { token: symbol; id: string }>();
  private readonly lifecycleWriters = new Set<Promise<unknown>>();
  private readonly reloadAttachments = new Map<string, Entry['attachments']>();
  private readonly invalidationListeners = new Set<(revisions: Readonly<Record<string, number>>) => void>();
  private readonly listeners = new Map<string, Set<(event: ProjectionOutput) => void>>();
  private readonly interactionListeners = new Set<(interaction: Interaction) => void>();
  private readonly retainedServices = new Map<string, Set<RegistryService>>();
  private readonly closing = new Set<string>();
  private readonly closes = new Map<string, Promise<void>>();
  private readonly now: () => number;
  private legacyListing: { cwd: string | undefined; expires: number; value: Promise<LegacySession[]> } | undefined;
  private readonly previews = new Map<string, string>();
  private stopping = false;
  private draining = false;
  private failure?: unknown;
  private failureSettlement: Promise<void> | undefined;
  private readonly cancellationFailures = new Set<unknown>();
  private readonly lossUnsubscribe: () => void;
  private commandDispatcher: ((session: string, name: string) => boolean) | undefined;

  constructor(readonly options: RegistryOptions) {
    options.owner.assertCurrent();
    if (options.store.owner !== options.owner) throw new Error('Registry and store require the same held ownership.');
    this.now = options.now ?? Date.now;
    this.recovery = options.store.needsRecovery ? options.store.recover().value : undefined;
    this.processes = new RegistryProcesses({ ...(options.processAdapter ? { processAdapter: options.processAdapter } : {}), store: options.store, now: this.now, assertCurrent: () => options.owner.assertCurrent(),
      changed: (id, process, rev) => this.publish({ v: 1, session: id, rev, change: { type: 'process.updated', process } }) });
    this.lossUnsubscribe = options.owner.onLost(error => { this.fence(error); });
  }

  wrapOpeningRuntime(runtime: AgentRuntime, root: string): AgentRuntime {
    const opening = this.runtimeOpening.getStore();
    if (!opening) throw new Error('Runtime factories must run inside lifecycle.openSession.');
    const scope = { session: '', root };
    opening.scope = scope;
    return this.processes.wrap(runtime, scope);
  }

  assertAdmission(): void {
    this.options.owner.assertCurrent(); this.options.store.snapshot();
    if (this.failure) throw new Error('Registry is not admitting work.');
    if (this.stopping) throw new RegistryOpeningCancelled('Registry is not admitting work.');
  }

  assertDispatch(id: string): void {
    this.assertSessionAccess(id, false);
  }
  /** A binding's own services run while its open or reload still holds the session reservation. */
  assertServiceAccess(id: string): void {
    this.assertSessionAccess(id, this.opening.has(id));
  }

  private assertSessionAccess(id: string, activatingBinding: boolean): void {
    this.assertAdmission();
    const session = this.options.store.session(id);
    if (session.deletedAt !== undefined) throw registryError('not_found', 'Session was deleted.');
    if (this.reservations.has(session.piPath) && !activatingBinding) throw registryError('busy', 'Session has a lifecycle operation in progress.');
    if (session.state !== 'open' || this.entries.get(id)?.disposing || this.entries.get(id)?.cancelling || this.closing.has(id) || this.closing.has(session.root) || this.copyClaims.has(session.piPath)) throw new Error('Session is closing, cancelling or has a pinned copy in progress.');
  }

  assertNewWork(): void {
    this.assertAdmission();
    if (this.draining) throw registryError('busy', 'Daemon is draining.');
  }

  failExecution(error: unknown): void { this.fence(error); }

  beginDrain(): void {
    if (this.draining && this.stopping && !this.failure) { this.options.owner.assertCurrent(); this.options.store.snapshot(); return; }
    this.assertAdmission(); this.draining = true;
  }

  /** Reopens admission after an abandoned drain; a registry that started shutting down cannot resume. */
  endDrain(): void {
    this.assertAdmission();
    this.draining = false;
  }

  async waitForDrain(): Promise<void> {
    this.assertAdmission();
    if (!this.draining) throw new Error('Drain must be started before waiting.');
    await this.join([...this.entries.keys()].map(id => this.cancelViews(id)));
    await this.join([...this.opening.values(), ...this.closes.values(), ...this.lifecycleWriters], undefined, true);
    for (const entry of this.entries.values()) {
      await entry.host?.settle();
      await entry.cancelling;
      await this.join([...entry.writers]);
      for (const service of entry.services) await service.settle('drain');
    }
    this.assertAdmission();
    if (await this.activeWork()) throw registryError('busy', 'Daemon still owns active processes or work. Explicit force is required to interrupt it.');
  }

  /** Units of work a drain waits for and a forced stop interrupts: busy resident sessions (including child executions) and live processes. Detached jobs survive a restart and are excluded. */
  async activeWork(): Promise<number> {
    this.options.owner.assertCurrent();
    const interruptible = await this.processes.interruptibleCount();
    const busy = [...this.entries.values()].filter(entry => !entry.binding.runtime.session.isIdle || entry.dispatches.size || entry.writers.size
      || entry.host?.hasPendingWork() || entry.host?.hasActiveJobs() || [...entry.services].some(service => service.busy())).length;
    return busy + interruptible;
  }

  create(request: RegistryOpenRequest): Promise<SessionBinding> {
    this.assertNewWork();
    if (request.parentSessionId && (this.closing.has(request.parentSessionId) || this.closing.has(request.rootSessionId!))) throw new Error('Parent session is closing.');
    if (request.target.kind === 'resume') throw new Error('Restore registered sessions by ID.');
    if (request.parentSessionId && request.rootSessionId && request.extensionConfigOverrides === undefined) {
      const overrides = this.options.store.session(request.rootSessionId).profile?.extensionConfigOverrides;
      if (overrides) request = { ...request, extensionConfigOverrides: overrides };
    }
    const key = randomUUID();
    const opening = this.open(request);
    this.opening.set(key, opening);
    void opening.then(() => this.opening.delete(key), () => this.opening.delete(key));
    return opening;
  }

  async openWorker(parent: string, worker: import('./session-lifecycle-contracts.js').SessionWorkerConfiguration): Promise<SessionBinding> {
    this.assertNewWork(); this.assertDispatch(parent);
    const owner = this.options.store.session(parent);
    const root = this.require(owner.root).binding;
    const manager = worker.sessionManager;
    const file = manager.getSessionFile();
    if (!file || this.list().some(row => row.id === manager.getSessionId())) throw registryError('invalid_request', 'Worker transcript must have a fresh identity.');
    const path = this.options.owner.assertOwnsPath(file);
    if (!pathInside(root.resources.sessionDir, path)) throw registryError('forbidden', 'Worker transcript is outside the root session directory.');
    const workspace = this.options.owner.assertOwnsPath(worker.runtime.cwd);
    if (!(root.resources.workerRoots ?? []).some(directory => pathInside(directory, workspace))) {
      throw registryError('forbidden', 'Worker workspace is outside managed staging storage.');
    }
    const tools = new Set(['read', 'ls', 'grep', 'edit', 'write', ...(worker.customTools ?? []).map(tool => tool.name)]);
    if (!worker.allowedTools.length || worker.allowedTools.some(name => !tools.has(name) || name === 'bash')) {
      throw registryError('forbidden', 'Worker tools exceed the staged-artifact policy.');
    }
    const key = randomUUID();
    const opening = this.open({ cwd: manager.getCwd(), sessionDir: dirname(path), target: { kind: 'resume', sessionFile: path },
      parentSessionId: parent, rootSessionId: owner.root, policy: this.getPolicy(parent), source: 'headless', worker });
    this.opening.set(key, opening);
    try { return await opening; } finally { this.opening.delete(key); }
  }

  async runWorker<T>(id: string, operation: () => Promise<T>): Promise<T> {
    this.assertNewWork(); this.assertDispatch(id);
    const entry = this.require(id);
    if (!entry.binding.runtime.session.isIdle || entry.writers.size) throw registryError('busy', 'Worker is already running.');
    const work = Promise.resolve().then(() => { this.assertDispatch(id); return operation(); });
    const settled = work.then(() => {}, () => {});
    entry.writers.add(settled);
    try { return await work; }
    finally { entry.writers.delete(settled); entry.projection.refresh(); }
  }

  async validateConfiguration(request: RegistryOpenRequest, resources?: SessionResources): Promise<void> {
    if (!request.extensionConfigOverrides?.length) return;
    this.assertAdmission();
    if (!this.options.lifecycle.validateConfiguration) throw registryError('unavailable', 'The lifecycle cannot validate session configuration before execution.');
    const resolved = resources ?? await this.options.lifecycle.resolveResources({ cwd: request.cwd, ...(request.sessionDir ? { sessionDir: request.sessionDir } : {}) });
    const services = this.options.services({ request, getExecutionPolicy: () => request.policy ?? { mode: 'host-default', generation: 0 } });
    await this.options.lifecycle.validateConfiguration(resolved, request.extensionConfigOverrides, packages => services.extensions.configuration(packages));
    this.assertAdmission();
  }

  /** A custom session directory becomes an owned, remembered store root only once a request using it has been validated. */
  async ownSessionDirectory(resources: SessionResources): Promise<void> {
    await this.options.owner.ownRoot(resources.sessionDir);
    this.assertAdmission();
  }

  assertClientSessionDirectory(resources: SessionResources): void {
    this.assertAdmission();
    const path = canonicalProspectivePath(resources.sessionDir);
    const reserved = [this.options.store.directory, this.options.owner.target.runtimeDirectory,
      resources.sessionStorageBase, resources.agentStorageRoot,
      ...resources.writableRoots.filter(root => root !== resources.sessionDir)];
    if (path === resources.agentDir || reserved.some(root => pathInside(root, path))) throw registryError('forbidden', 'Client session directory is reserved for daemon state.');
  }

  restore(id: string, context: Pick<RegistryOpenRequest, 'systemPromptAppend' | 'providerContext'> = {}): Promise<SessionBinding> {
    this.assertAdmission();
    const stored = this.options.store.snapshot().sessions.find(session => session.id === id);
    if (!stored) throw registryError('not_found', 'Session is not registered.');
    if (stored.deletedAt !== undefined) throw registryError('not_found', 'Session was deleted.');
    if (this.reloadAttachments.has(id) && this.opening.has(id)) return this.opening.get(id)!;
    if (this.closing.has(id)) throw new Error('Session is closing.');
    const entry = this.entries.get(id);
    if (entry?.disposing) return entry.disposing.then(() => this.restore(id, context));
    if (entry) return Promise.resolve(entry.binding);
    const pending = this.opening.get(id);
    if (pending) return pending;
    const reopening = stored.state === 'closed';
    if (reopening) this.options.store.updateSession(id, { state: 'open' });
    const operation = this.open({ cwd: stored.cwd, sessionDir: directoryOf(stored.piPath), target: { kind: 'resume', sessionFile: stored.piPath },
      rootSessionId: stored.root, ...(stored.parent ? { parentSessionId: stored.parent } : {}), policy: profilePolicy(stored), ...profileOptions(stored.profile), ...context }, stored)
      .catch(error => {
        // A failed reopen leaves the session closed, as it was before.
        if (reopening && !this.failure && !this.entries.has(id) && this.options.store.session(id).state === 'open') this.options.store.transitionSessionForSafety(id, 'closed');
        throw error;
      });
    this.opening.set(id, operation);
    void operation.then(() => this.opening.delete(id), () => this.opening.delete(id));
    return operation;
  }

  /** Unregistered pre-daemon transcripts that `adopt` can register in place. */
  async legacySessions(cwd?: string, fresh = false): Promise<LegacySession[]> {
    this.assertAdmission();
    const sessions = this.options.store.snapshot().sessions; const now = Date.now();
    // Paged listings repeat discovery per page; a short-lived result keeps pages consistent and bounded.
    if (fresh || !this.legacyListing || this.legacyListing.cwd !== cwd || this.legacyListing.expires <= now) {
      this.legacyListing = { cwd, expires: now + 2_000, value: discoverLegacySessions(this.options.owner, sessions, cwd) };
    }
    const rows = await this.legacyListing.value;
    const current = this.options.store.snapshot().sessions;
    const ids = new Set(current.map(session => session.id)); const paths = new Set(current.map(session => session.piPath));
    return rows.filter(row => !ids.has(row.id) && !paths.has(row.path));
  }

  /** Registers a discovered pre-daemon transcript under its existing ID and file; later turns append to that file. */
  adopt(id: string, profile: Pick<RegistryOpenRequest, 'source' | 'interactiveExtensions' | 'policy'>): Promise<SessionBinding> {
    this.assertNewWork();
    if (this.options.store.snapshot().sessions.some(session => session.id === id)) return this.restore(id);
    const pending = this.opening.get(id);
    if (pending) return pending;
    const operation = (async () => {
      const legacy = (await this.legacySessions(undefined, true)).find(row => row.id === id);
      if (!legacy) throw registryError('not_found', 'Session is not registered.');
      this.assertNewWork();
      return this.open({ cwd: legacy.cwd, sessionDir: dirname(legacy.path), target: { kind: 'resume', sessionFile: legacy.path }, clientRoot: true, ...profile });
    })();
    this.opening.set(id, operation);
    void operation.then(() => this.opening.delete(id), () => this.opening.delete(id));
    return operation;
  }

  /** First user message for session listings. Transcripts only grow, so a found preview is cached for the daemon's lifetime. */
  async preview(session: Pick<ControlSession, 'id' | 'piPath'>): Promise<string> {
    const cached = this.previews.get(session.id);
    if (cached) return cached;
    const live = this.entries.get(session.id)?.binding.runtime.session.sessionManager;
    const preview = live ? transcriptPreview(live.getEntries()) : await readTranscriptPreview(session.piPath);
    if (preview) this.previews.set(session.id, preview);
    return preview;
  }

  list(): ControlSession[] { this.options.owner.assertCurrent(); return this.options.store.snapshot().sessions.filter(session => session.deletedAt === undefined); }
  binding(id: string): SessionBinding | undefined { return this.entries.get(id)?.binding; }
  projection(id: string): SessionProjection { return this.require(id).projection; }
  async refreshModelAvailability(signal: AbortSignal): Promise<void> {
    this.assertAdmission(); signal.throwIfAborted();
    const work = [...this.entries].filter(([id, entry]) => !this.closing.has(id) && !entry.disposing).map(async ([, entry]) => {
      const refresh = entry.binding.runtime.session.modelRuntime.getAvailable(undefined, { signal });
      const settled = refresh.then(() => {}, () => {});
      entry.writers.add(settled);
      try {
        await refresh;
        signal.throwIfAborted(); this.options.owner.assertCurrent();
        entry.projection.refresh();
      } finally { entry.writers.delete(settled); }
    });
    const results = await Promise.allSettled(work);
    const failure = results.find(result => result.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
  }
  recordResource(resource: Parameters<DaemonControlStore['putResource']>[0], change?: KnownSessionChange): void {
    const commit = this.options.store.putResource(resource);
    if (change) this.publish({ v: 1, session: commit.value.session, rev: commit.revisions[commit.value.session]!, change });
  }
  getPolicy(id: string): SessionExecutionPolicy { return profilePolicy(this.options.store.session(id)); }

  bindCommandDispatcher(available: (session: string, name: string) => boolean): () => void {
    if (this.commandDispatcher) throw new Error('A command dispatcher is already bound.');
    this.commandDispatcher = available;
    try { for (const entry of this.entries.values()) entry.projection.refresh(); }
    catch (error) { this.commandDispatcher = undefined; throw error; }
    return () => { if (this.commandDispatcher === available) this.commandDispatcher = undefined; };
  }

  async attach(id: string, metadata: { principal: string; kind: 'tui' | 'acp' | 'headless' }): Promise<{ attachment: string; snapshot: SessionSnapshot }> {
    await this.restore(id); this.assertAdmission();
    const entry = this.require(id); const attachment = randomUUID();
    const snapshot = entry.projection.snapshot();
    entry.attachments.set(attachment, { ...metadata });
    return { attachment, snapshot };
  }
  detach(id: string, attachment: string): void {
    const entry = this.entries.get(id);
    if (!entry) { this.reloadAttachments.get(id)?.delete(attachment); return; }
    const kind = entry.attachments.get(attachment)?.kind;
    if (entry.attachments.delete(attachment) && !entry.attachments.size) entry.lastDetached = this.now();
    if (kind === 'acp' && !this.stopping && !this.failure) this.relaxPolicy(this.options.store.session(id).root);
  }
  attachmentCount(id: string): number { return this.entries.get(id)?.attachments.size ?? this.reloadAttachments.get(id)?.size ?? 0; }
  subscribe(id: string, listener: (event: ProjectionOutput) => void): () => void {
    this.require(id).projection.refresh();
    const listeners = this.listeners.get(id) ?? new Set(); listeners.add(listener); this.listeners.set(id, listeners);
    return () => { listeners.delete(listener); if (!listeners.size) this.listeners.delete(id); };
  }
  registerService(id: string, service: RegistryService): () => void {
    const entry = this.require(id); entry.services.add(service);
    return () => entry.services.delete(service);
  }
  registerUiActions(id: string, prepare: ReturnType<typeof createUiVocabulary>['prepareAction']): () => void {
    const entry = this.require(id);
    if (entry.prepareUiAction) throw new Error('Session UI actions are already bound.');
    entry.prepareUiAction = prepare;
    return () => { if (entry.prepareUiAction === prepare) delete entry.prepareUiAction; };
  }
  prepareUiAction(id: string, request: OperationParams<'ui.action'>) {
    const entry = this.require(id);
    const prepare = entry.prepareUiAction;
    if (!prepare) throw registryError('unavailable', 'Session UI actions are unavailable.');
    const execute = prepare(request);
    if (request.outcome !== 'cancel') return execute;
    return async (context: Parameters<typeof execute>[0]) => {
      const controller = new AbortController();
      const signal = AbortSignal.any([context.signal, controller.signal]);
      const actions = entry.viewActions ??= new Set();
      actions.add(controller);
      let onAbort!: () => void;
      const aborted = new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(signal.reason);
        signal.addEventListener('abort', onAbort, { once: true });
      });
      try {
        signal.throwIfAborted();
        await Promise.race([execute({ ...context, signal }), aborted]);
      } finally {
        signal.removeEventListener('abort', onAbort);
        actions.delete(controller);
      }
    };
  }
  executionHost(id: string): ExecutionHost {
    const existing = this.entries.get(id)?.host;
    if (existing instanceof ExecutionHost) return existing;
    const root = this.options.store.session(id).root;
    let manager = this.executionManagers.get(root);
    if (!manager) { manager = new RegistryExecutions(this, root); this.executionManagers.set(root, manager); }
    return manager.host(id);
  }
  async runAdmitted<T>(requestId: string, id: string, origin: Origin, effect: (session: AgentSession) => Promise<T>): Promise<T> {
    this.assertNewWork();
    this.assertDispatch(id);
    const entry = this.require(id); const stored = this.options.store.session(id);
    if (stored.state !== 'open' || stored.execution && !stored.execution.completedAt || this.closing.has(id) || this.copyClaims.has(stored.piPath) || this.running(id)) throw registryError('busy', 'Wait for the current run to finish.');
    const request = this.options.store.snapshot().requests.find(item => item.id === requestId);
    if (request?.session !== id) throw new Error('Admitted request belongs to another session.');
    const run = { state: 'running' as const, id: randomUUID(), origin };
    let finish!: () => void;
    const writer = new Promise<void>(resolve => { finish = resolve; });
    entry.writers.add(writer);
    entry.dispatches.add(requestId); entry.projection.setOrigin(origin);
    if (request.op === 'command.invoke') entry.command = { runId: run.id, views: new Set() };
    try {
      entry.projection.syncCursor();
      this.commitDispatch(requestId, id);
      entry.projection.publish({ type: 'run.updated', run }, { run });
      this.assertDispatch(id);
      return await effect(entry.binding.runtime.session);
    }
    finally {
      try {
        entry.dispatches.delete(requestId);
        if (entry.command?.runId === run.id) delete entry.command;
        if (!this.failure) {
          if (!entry.cancelling) entry.projection.settleRun(run.id);
          entry.projection.refresh();
        }
      } catch (error) { this.fence(error); throw error; }
      finally { entry.writers.delete(writer); finish(); }
    }
  }

  async resumeInteraction(id: string, answer: InteractionAnswer, continuationId: string, dispatch: () => void): Promise<void> {
    await this.restore(id);
    this.assertDispatch(id);
    const entry = this.require(id);
    const stored = this.options.store.session(id);
    if (this.closing.has(id) || this.copyClaims.has(stored.piPath) || this.running(id)) throw registryError('busy', 'Session is busy.');
    const continuation = this.options.store.snapshot().continuations.find(item => item.id === continuationId);
    if (!continuation || continuation.session !== id || continuation.phase !== 'ready') throw registryError('already_resolved', 'Continuation is no longer ready.');
    const origin: Origin = { kind: 'automation', source: `interaction:${continuation.interaction}` };
    const run = { state: 'running' as const, id: continuationId, origin };
    let finish!: () => void;
    const writer = new Promise<void>(resolve => { finish = resolve; });
    entry.writers.add(writer); entry.dispatches.add(continuationId); entry.projection.setOrigin(origin);
    try {
      entry.projection.syncCursor();
      dispatch();
      entry.projection.publish({ type: 'run.updated', run }, { run });
      this.assertDispatch(id);
      await entry.binding.runtime.session.prompt(`A previously deferred question was answered:\n${JSON.stringify(answer)}`);
    } finally {
      try {
        entry.dispatches.delete(continuationId);
        if (!this.failure) {
          if (!entry.cancelling) entry.projection.settleRun(run.id);
          entry.projection.refresh();
        }
      } catch (error) { this.fence(error); throw error; }
      finally { entry.writers.delete(writer); finish(); }
    }
  }

  async mutateAdmitted<T>(requestId: string, id: string, effect: (context: RegistryMutationContext) => Promise<T>): Promise<T> {
    const entry = this.require(id);
    const request = this.options.store.snapshot().requests.find(item => item.id === requestId);
    if (request?.session !== id || !nonRunMutations.has(request.op)) throw new Error('Request is not a supported non-run mutation for this session.');
    let active = true;
    const assertCurrent = () => {
      if (!active) throw new Error('Mutation dispatch has settled.');
      this.assertDispatch(id);
      if (this.entries.get(id) !== entry) throw new Error('Session runtime changed.');
    };
    assertCurrent();
    if (entry.dispatches.has(requestId)) throw new Error('Request is already executing.');
    let finish!: () => void;
    const writer = new Promise<void>(resolve => { finish = resolve; });
    entry.writers.add(writer); entry.dispatches.add(requestId);
    try {
      this.commitDispatch(requestId, id);
      assertCurrent();
      return await effect({ session: entry.binding.runtime.session, assertCurrent });
    } finally {
      active = false;
      entry.dispatches.delete(requestId);
      try {
        if (!this.failure) {
          if (!entry.cancelling) entry.projection.settleRun(this.options.store.session(id).run.id);
          entry.projection.refresh();
        }
      }
      catch (error) { this.fence(error); throw error; }
      finally { entry.writers.delete(writer); finish(); }
    }
  }

  private commitDispatch(requestId: string, id: string): void {
    const commit: ControlCommit<unknown> = this.options.store.markDispatched(requestId);
    const stored = this.options.store.session(id);
    if (commit.revisions[id] !== stored.revision || Object.keys(commit.revisions).some(session => session !== id)) {
      throw new Error('Dispatch checkpoint does not match the committed session revision.');
    }
    // Dispatch intent advances the revision before execution changes the run state.
    this.publish({ v: 1, session: id, rev: stored.revision, change: { type: 'run.updated', run: stored.run } });
  }

  publishCommitted(revisions: Readonly<Record<string, number>>): void {
    for (const [id, revision] of Object.entries(revisions)) {
      const stored = this.options.store.session(id);
      if (stored.revision !== revision) throw new Error('Checkpoint differs from the committed revision.');
      if (this.entries.has(id)) this.publish({ v: 1, session: id, rev: revision, change: { type: 'run.updated', run: stored.run } });
    }
  }

  subscribeInteractions(listener: (interaction: Interaction) => void): () => void {
    this.interactionListeners.add(listener);
    return () => this.interactionListeners.delete(listener);
  }

  publishInteraction(interaction: Interaction, revisions: Readonly<Record<string, number>>): void {
    if (interaction.scope.kind === 'host') {
      for (const listener of this.interactionListeners) listener(structuredClone(interaction));
      return;
    }
    const id = interaction.scope.session;
    const revision = revisions[id];
    if (revision !== this.options.store.session(id).revision) throw new Error('Interaction differs from its committed revision.');
    this.publish({ v: 1, session: id, rev: revision, change: {
      type: interaction.state === 'waiting' || interaction.state === 'deferred' ? 'interaction.requested' : 'interaction.resolved', interaction,
    } });
  }

  subscribeInvalidation(listener: (revisions: Readonly<Record<string, number>>) => void): () => void {
    this.invalidationListeners.add(listener); return () => { this.invalidationListeners.delete(listener); };
  }

  /** Closes the session tree if needed, then deletes every transcript in it and records tombstones for request retries. */
  deleteAdmitted(requestId: string, id: string): Promise<void> {
    this.assertAdmission();
    const tree = this.descendants(id).map(session => this.options.store.session(session));
    const paths = tree.map(session => session.piPath);
    if (paths.some(path => this.reservations.has(path))) throw registryError('busy', 'Session has a lifecycle operation in progress.');
    const token = Symbol('deletion');
    for (const path of paths) this.reservations.set(path, { token, id });
    const work = (async () => {
      await this.close(id);
      this.assertAdmission();
      const removals = paths.map(path => prepareTranscriptDeletion(this.options.owner, path));
      const commit = this.options.store.markSessionDeleted(requestId);
      for (const session of tree) this.previews.delete(session.id);
      this.publishCommitted(commit.revisions);
      for (const remove of removals) remove();
    })().finally(() => { for (const path of paths) if (this.reservations.get(path)?.token === token) this.reservations.delete(path); });
    return this.trackLifecycle(work);
  }

  /** The session and every registered descendant, parents before children. */
  private descendants(id: string): string[] {
    const rows = this.list(); const tree = [id];
    for (let index = 0; index < tree.length; index++) for (const row of rows) if (row.parent === tree[index] && !tree.includes(row.id)) tree.push(row.id);
    return tree;
  }

  /** Applies session configuration now when the root can reload; otherwise persists it for the next reload or resume. */
  configureAdmitted(requestId: string, id: string, configuration: { values: OperationParams<'config.set'>['values']; overrides: NonNullable<SessionProfile['extensionConfigOverrides']> }): Promise<void> {
    try { return this.reloadAdmitted(requestId, id, configuration).then(() => undefined); }
    catch (error) {
      if (!['busy', 'unavailable'].includes((error as { code?: unknown }).code as string)) throw error;
    }
    this.assertAdmission();
    const commit = this.options.store.configureSession(requestId, configuration.values, configuration.overrides);
    this.publishCommitted(commit.revisions);
    return Promise.resolve();
  }

  reloadAdmitted(requestId: string, id: string, configuration?: { values: OperationParams<'config.set'>['values']; overrides: NonNullable<SessionProfile['extensionConfigOverrides']> }): Promise<SessionBinding> {
    this.assertDispatch(id); const stored = this.options.store.session(id); const entry = this.entries.get(id);
    const request = this.options.store.snapshot().requests.find(item => item.id === requestId);
    if (request?.op !== (configuration ? 'config.set' : 'session.reload') || request.session !== id || request.phase !== 'intent') throw registryError('request_conflict', 'Reload request differs.');
    if (stored.parent) throw registryError('unavailable', 'Only root sessions can reload.');
    if (!['idle', 'interrupted'].includes(stored.run.state) || entry && this.running(id)) throw registryError('busy', 'Wait for the current run to finish before reloading.');
    if (this.opening.has(id) || entry?.disposing || entry?.cancelling || entry?.writers.size) throw registryError('busy', 'Session has a lifecycle operation in progress.');
    const token = Symbol('reload'); this.reservations.set(stored.piPath, { token, id });
    const attachments = entry?.attachments ?? new Map(); this.reloadAttachments.set(id, attachments);
    const work = (async () => {
      try {
        if (configuration) this.options.store.configureSession(requestId, configuration.values, configuration.overrides);
        else this.commitDispatch(requestId, id);
        this.settleInteractions(id, 'cancel');
        // Like Pi's /reload, only the root runtime reloads: busy children and queued executions keep running and deliver to the next root runtime.
        for (const [child, value] of [...this.entries]) {
          if (child !== id && value.binding.rootSessionId === id && !value.disposing && !this.childBusy(child, value)) await this.disposeEntry(child, false, { keepTerminals: true });
        }
        if (entry) await this.disposeEntry(id, false, { preserveView: true, keepTerminals: true, keepExecutions: true });
        this.assertAdmission();
        if (this.closing.has(id) || this.options.store.session(id).state !== 'open') throw new RegistryOpeningCancelled('Session closed during reload.');
        this.pathClaims.add(stored.piPath);
        const current = this.options.store.session(id);
        const binding = await this.open({ cwd: current.cwd, sessionDir: dirname(current.piPath), target: { kind: 'resume', sessionFile: current.piPath },
          rootSessionId: current.root, policy: profilePolicy(current), ...profileOptions(current.profile) }, current, undefined, token);
        const reloaded = this.require(id); reloaded.attachments = attachments; reloaded.host?.resumeQueued();
        const revisions = { [id]: this.options.store.session(id).revision };
        for (const listener of this.invalidationListeners) listener(revisions);
        return binding;
      } catch (error) {
        if (!this.entries.has(id) && !this.failure) {
          try {
            const current = this.options.store.session(id);
            if (current.state === 'open' && current.residency !== 'evicted') this.options.store.transitionSessionForSafety(id, 'evicted');
          } catch (cleanup) { this.fence(cleanup); throw new AggregateError([error, cleanup], 'Reload failed while restoring evicted state.'); }
        }
        throw error;
      } finally {
        this.reloadAttachments.delete(id); this.reservations.delete(stored.piPath);
        if (!this.entries.has(id)) this.pathClaims.delete(stored.piPath);
      }
    })();
    this.opening.set(id, work);
    void work.then(() => this.opening.delete(id), () => this.opening.delete(id));
    return this.trackLifecycle(work);
  }

  private trackLifecycle<T>(work: Promise<T>): Promise<T> {
    this.lifecycleWriters.add(work);
    void work.then(() => this.lifecycleWriters.delete(work), () => this.lifecycleWriters.delete(work));
    return work;
  }

  cancelAdmitted(requestId: string, id: string, runId?: string): Promise<void> {
    this.assertAdmission();
    if (!this.entries.has(id)) throw registryError('not_found', 'Cancel session is not resident.');
    const request = this.options.store.snapshot().requests.find(item => item.id === requestId);
    if (request?.session !== id || request.op !== 'cancel') throw registryError('request_conflict', 'Cancel request belongs to another operation or session.');
    if (runId && this.options.store.session(id).run.id !== runId) throw registryError('not_found', 'Run not found.');
    this.commitDispatch(requestId, id);
    return this.cancel(id, runId);
  }

  closeAdmitted(requestId: string, id: string): Promise<void> {
    this.assertAdmission();
    const request = this.options.store.snapshot().requests.find(item => item.id === requestId);
    if (request?.session !== id || request.op !== 'close') throw new Error('Close request belongs to another operation or session.');
    this.commitDispatch(requestId, id);
    return this.close(id);
  }

  async forkAdmitted(requestId: string, id: string, from: OperationParams<'fork'>['from']): Promise<SessionBinding> {
    return this.copyAdmitted(requestId, id, from);
  }

  async cloneAdmitted(requestId: string, id: string): Promise<SessionBinding> {
    return this.copyAdmitted(requestId, id);
  }

  private async copyAdmitted(requestId: string, id: string, from?: OperationParams<'fork'>['from']): Promise<SessionBinding> {
    await this.restore(id);
    this.assertDispatch(id);
    const source = this.require(id);
    const stored = this.options.store.session(id);
    const request = this.options.store.snapshot().requests.find(item => item.id === requestId);
    if (request?.session !== id || request.op !== (from ? 'fork' : 'session.clone')) throw new Error('Copy request belongs to another operation or session.');
    const path = this.options.owner.assertOwnsPath(stored.piPath);
    this.copyClaims.add(path);
    let finish!: () => void;
    const writer = new Promise<void>(resolve => { finish = resolve; });
    source.writers.add(writer); source.dispatches.add(requestId);
    try {
      let target: RegistryOpenRequest['target'] = { kind: 'clone', sourceSessionFile: path };
      if (from) {
        const choices = source.binding.runtime.session.getUserMessagesForForking();
        const choice = from.kind === 'entry' ? choices.find(item => item.entryId === from.entryId)
          : Number.isSafeInteger(from.position) && from.position >= 0 ? choices[from.position] : undefined;
        if (!choice) throw new Error('Fork selector does not identify a stored user message.');
        target = { kind: 'fork', sourceSessionFile: path, entryId: choice.entryId, position: 'before' };
      }
      this.commitDispatch(requestId, id);
      this.assertAdmission();
      if (this.closing.has(id) || this.closing.has(stored.root)) throw new Error('Source session is closing.');
      const key = randomUUID();
      const opening = this.open({ cwd: stored.cwd, sessionDir: directoryOf(path), ...profileOptions(stored.profile),
        target }, undefined, path);
      this.opening.set(key, opening);
      try { return await opening; }
      finally { this.opening.delete(key); }
    } finally {
      this.copyClaims.delete(path); source.dispatches.delete(requestId); source.writers.delete(writer); finish();
    }
  }

  async cancel(id: string, runId?: string): Promise<void> {
    this.assertAdmission();
    const entry = this.require(id);
    if (entry.disposing) throw new Error('Session runtime is being evicted.');
    const stored = this.options.store.session(id);
    if (runId && stored.run.id !== runId) throw registryError('not_found', 'Run not found.');
    if (entry.cancelling) return entry.cancelling;
    if (['idle', 'interrupted'].includes(stored.run.state) && entry.binding.runtime.session.isIdle) return;
    const operation = Promise.resolve().then(async () => {
      entry.projection.transitionForSafety('cancelling', stored.run.id);
      this.settleInteractions(id, 'cancel');
      await this.cancelViews(id);
      await entry.binding.runtime.session.abort();
      await this.processes.cancelForeground(id);
      await this.join([...entry.writers]);
      this.options.owner.assertCurrent();
      if (!entry.binding.runtime.session.isIdle) throw new Error('Cancelled session has not settled.');
      entry.projection.transitionForSafety('idle', stored.run.id);
      entry.projection.refresh();
    });
    entry.cancelling = operation;
    try { await operation; }
    catch (error) { this.cancellationFailures.add(error); throw error; }
    finally {
      delete entry.cancelling;
      if (!this.draining && !this.stopping && !this.closing.has(id)) delete entry.viewCancellation;
    }
    if (!this.stopping && !this.failure && !this.closing.has(id) && !this.closing.has(stored.root)) this.entries.get(stored.root)?.host?.resumeQueued();
  }

  /** Applies ACP approval policy to the open session tree; running tool calls keep the approvals they already had. */
  tightenPolicy(root: string): void { this.setPolicy(root, 'acp-strict'); }
  /** Returns the session tree to host defaults once no ACP client is attached to it. */
  relaxPolicy(root: string): void {
    const tree = this.list().filter(item => item.root === root);
    if (tree.some(item => [...this.entries.get(item.id)?.attachments.values() ?? []].some(attachment => attachment.kind === 'acp'))) return;
    this.setPolicy(root, 'host-default');
  }
  private setPolicy(root: string, effective: Policy['effective']): void {
    this.assertAdmission();
    for (const stored of this.list().filter(item => item.root === root && item.state === 'open')) {
      if (stored.policy.effective !== effective) this.policyUpdate(stored.id, { effective, generation: stored.policy.generation + 1 });
    }
  }

  async evictIdle(): Promise<string[]> {
    this.assertAdmission(); const evicted: string[] = [];
    for (const [id, entry] of this.entries) {
      if (this.closing.has(id) || entry.disposing || entry.attachments.size || this.hasWarmChildren(id) || this.now() - entry.lastDetached < (this.options.idleMs ?? 60_000) || this.busy(id)) continue;
      await this.disposeEntry(id, false); evicted.push(id);
    }
    return evicted;
  }

  close(id: string): Promise<void> {
    this.options.owner.assertCurrent();
    const stored = this.options.store.session(id);
    const pending = this.closes.get(id);
    if (pending) return pending;
    if (stored.state === 'closed') return Promise.resolve();
    this.closing.add(id);
    const rows = this.list(); const descendants = new Set([id]);
    for (let changed = true; changed;) {
      changed = false;
      for (const row of rows) if (row.parent && descendants.has(row.parent) && !descendants.has(row.id)) { descendants.add(row.id); changed = true; }
    }
    for (const descendant of descendants) this.processes.seal(descendant);
    const operation = this.processes.withCleanup([...descendants], () => this.performClose(id));
    this.closes.set(id, operation);
    void operation.then(() => { this.closes.delete(id); this.closing.delete(id); }, () => {});
    return operation;
  }

  private async performClose(id: string): Promise<void> {
    await this.join([...this.opening.values()], undefined, true);
    await this.entries.get(id)?.disposing;
    const stored = this.options.store.session(id);
    if (stored.state === 'closed') return;
    const descendants = this.list().filter(item => item.parent === id && item.state === 'open');
    // Host shutdown cancels its full descendant tree and waits beyond terminal status records.
    const entry = this.entries.get(id);
    this.settleInteractions(id, 'close');
    if (entry) await this.cancelViews(id);
    await entry?.host?.shutdown();
    for (const child of descendants) await this.close(child.id);
    if (entry) {
      await entry.cancelling;
      await entry.binding.runtime.session.abort();
      await this.processes.cancelForeground(id);
      await Promise.all(entry.writers);
      entry.projection.settleRun(this.options.store.session(id).run.id);
      await this.processes.settle(stored.root, false, id === stored.root ? undefined : new Set([id]));
      for (const service of entry.services) await this.processes.withCleanup(id, () => service.settle());
      await this.disposeEntry(id, true);
    } else {
      this.options.store.transitionSessionForSafety(id, 'closed');
    }
  }

  async shutdown(options: { interrupt?: boolean } = {}): Promise<void> {
    const interrupted = options.interrupt ? this.list().filter(row => row.state === 'open' && ['running', 'waiting', 'cancelling'].includes(row.run.state) && row.run.id)
      .map(row => ({ id: row.id, run: row.run.id! })) : [];
    this.stopping = true;
    if (this.failure) { await this.failureSettlement; throw new Error('Registry is fenced; verify settlement before releasing ownership.'); }
    const cancellations = [...this.entries].map(([id, entry]) => {
      if (!options.interrupt) return this.cancelViews(id);
      this.closing.add(id);
      this.settleInteractions(id, 'shutdown');
      return this.join([this.cancelViews(id), entry.host?.shutdown() ?? Promise.resolve(), entry.binding.runtime.session.abort()]);
    });
    await this.join([...cancellations, ...this.opening.values(), ...this.closes.values(), ...this.lifecycleWriters], undefined, true);
    for (const [id, entry] of this.entries) {
      this.closing.add(id);
      this.settleInteractions(id, 'shutdown');
      if (!options.interrupt) {
        await this.cancelViews(id);
        await entry.host?.shutdown();
        await entry.cancelling;
        await entry.binding.runtime.session.abort();
      }
      await this.processes.cancelForeground(id);
      if (!options.interrupt) await Promise.all(entry.writers);
      await this.processes.settle(entry.binding.rootSessionId);
      for (const service of entry.services) await this.processes.withCleanup(id, async () => { await service.settle(); await service.dispose(); });
      entry.services.clear();
      if (options.interrupt) {
        await this.processes.withCleanup(id, () => entry.binding.runtime.dispose());
        entry.runtimeDisposed = true;
        await entry.cancelling;
        await Promise.all(entry.writers);
      }
      entry.projection.settleRun(this.options.store.session(id).run.id);
      await this.disposeEntry(id, false);
    }
    // A failed reload leaves its kept PTYs without a resident root.
    for (const root of this.processes.liveRoots()) await this.processes.settle(root);
    for (const services of this.retainedServices.values()) for (const service of services) { await service.settle(); await service.dispose(); }
    for (const row of interrupted) if (this.options.store.session(row.id).state === 'open') this.options.store.interruptSessionRun(row.id, row.run);
    this.retainedServices.clear(); this.lossUnsubscribe(); this.listeners.clear();
    // The caller closes the store/profile and releases ownership only after this resolves.
  }

  private busy(id: string): boolean {
    const entry = this.require(id); const stored = this.options.store.session(id);
    return this.copyClaims.has(stored.piPath) || this.reservations.has(stored.piPath) || !entry.binding.runtime.session.isIdle || entry.binding.runtime.session.pendingMessageCount > 0 || entry.dispatches.size > 0
      || ['running', 'waiting', 'cancelling'].includes(stored.run.state) || !!entry.host?.hasPendingWork() || !!entry.host?.hasActiveJobs() || !!entry.host?.hasExecutingJobs()
      || [...entry.services].some(service => !service.disposeWhenIdle || service.busy()) || this.processes.blocksEviction(stored.root)
      || this.options.store.snapshot().interactions.some(item => item.scope.kind === 'session' && item.scope.root === stored.root && item.state === 'waiting');
  }

  /** Whether a turn or admitted run is in progress, the condition Pi itself uses to defer conflicting work. */
  running(id: string): boolean {
    const entry = this.entries.get(id);
    return !!entry && (!entry.binding.runtime.session.isIdle || entry.dispatches.size > 0);
  }

  private childBusy(id: string, entry: Entry): boolean {
    return this.running(id) || entry.writers.size > 0 || !!entry.host?.hasPendingWork() || !!entry.host?.hasActiveJobs()
      || !['idle', 'interrupted'].includes(this.options.store.session(id).run.state);
  }

  private hasWarmChildren(id: string): boolean { return [...this.entries].some(([child, value]) => child !== id && value.binding.rootSessionId === id); }

  private async open(request: RegistryOpenRequest, restored?: ControlSession, copySource?: string, reservation?: symbol): Promise<SessionBinding> {
    const resources = await this.options.lifecycle.resolveResources({ cwd: request.cwd, ...(request.sessionDir ? { sessionDir: request.sessionDir } : {}) });
    this.assertAdmission();
    if (request.clientRoot) this.assertClientSessionDirectory(resources);
    await this.ownSessionDirectory(resources);
    for (const path of resources.writableRoots) this.options.owner.assertOwnsPath(path);
    const sourcePath = request.target.kind === 'clone' || request.target.kind === 'fork' ? this.options.owner.assertOwnsPath(request.target.sourceSessionFile) : undefined;
    const source = sourcePath ? this.list().find(item => item.piPath === sourcePath) : undefined;
    const initialPolicy = request.parentSessionId ? this.getPolicy(request.rootSessionId!) : source ? profilePolicy(source) : request.policy ?? { mode: 'host-default', generation: 0 };
    let binding: SessionBinding | undefined;
    let claim: string | undefined;
    let borrowed: string | undefined;
    const openingPolicy = () => request.parentSessionId ? this.getPolicy(request.rootSessionId!) : source ? this.getPolicy(source.id) : initialPolicy;
    const externalServices = this.options.services({ request, getExecutionPolicy: () => binding && this.entries.has(binding.sessionId) ? this.getPolicy(binding.sessionId) : openingPolicy() });
    const services: DaemonSessionServices = { ...externalServices, extensions: {
      configuration: packages => externalServices.extensions.configuration(packages),
      ...(externalServices.extensions.executionPort ? { executionPort: externalServices.extensions.executionPort } : {}),
      bind: async (context, port) => {
        const scope = this.runtimeOpening.getStore()?.scope;
        if (scope) { scope.session = context.sessionManager.getSessionId(); scope.root = context.rootSessionId; }
        const bindings = await externalServices.extensions.bind(context, port);
        return { ...bindings, inlineExtensions: [...(bindings.inlineExtensions ?? []), ...(request.systemPromptAppend ? [{
          name: '@felan-ai/daemon/child-instructions',
          factory: (pi: import('@felan-ai/agent-core').ExtensionAPI) => { pi.on('before_agent_start', event => ({ systemPrompt: `${event.systemPrompt}\n\n${request.systemPromptAppend}` })); },
        }] : [])] };
      },
    } };
    const ownership = { assertOwned: (resolved: SessionResources, target: SessionTargetIdentity) => {
      this.assertAdmission();
      if (request.clientRoot) this.assertClientSessionDirectory({ ...resolved, sessionDir: target.destinationDirectory });
      for (const path of resolved.writableRoots) this.options.owner.assertOwnsPath(path);
      this.options.owner.assertOwnsPath(target.destinationDirectory);
      if (target.sourceSessionFile) {
        const source = this.options.owner.assertOwnsPath(target.sourceSessionFile);
        if (claim === source || borrowed === source) return;
        const held = this.reservations.get(source);
        if (held) {
          if (held.token !== reservation) throw registryError('busy', 'Source has a lifecycle reservation.');
          claim = source; this.pathClaims.add(source); return;
        }
        if (source === copySource && this.copyClaims.has(source) && (target.kind === 'fork' || target.kind === 'clone')) { borrowed = source; return; }
        if (this.pathClaims.has(source)) throw new Error('Session transcript already has a live writer.');
        this.pathClaims.add(source); claim = source;
      }
    } };
    try {
      const target = restored?.branch && request.target.kind === 'resume' ? { ...request.target, cursor: {
        branch: restored.branch, ...(restored.observedTip === undefined ? {} : { observedTip: restored.observedTip }),
      } } : request.target;
      binding = await this.runtimeOpening.run({}, () => this.options.lifecycle.openSession({ ...request, target, resources, ownership, policy: initialPolicy, services }));
      this.assertAdmission();
      if (restored && this.closing.has(restored.id) || request.parentSessionId && (this.closing.has(request.parentSessionId) || this.closing.has(request.rootSessionId!))) throw new RegistryOpeningCancelled('Session is closing.');
      let manager = binding.runtime.session.sessionManager;
      const initialPath = manager.getSessionFile();
      if (initialPath && !existsSync(this.options.owner.assertOwnsPath(initialPath))) {
        const path = this.options.owner.assertOwnsPath(initialPath);
        const header = manager.getHeader();
        if (!header || header.id !== binding.sessionId) throw new Error('Missing Pi session header.');
        await binding.runtime.dispose(); this.processes.revokeRuntime(binding.agentRuntime);
        this.assertAdmission();
        if (!existsSync(this.options.owner.assertOwnsPath(path))) {
        const rows = [header, ...manager.getEntries()];
        if (manager.getEntries().some(row => row.type === 'message' && ['user', 'assistant'].includes(row.message.role))) throw new Error('Conversation transcript was not persisted.');
        const bytes = rows.map(row => JSON.stringify(row)).join('\n') + '\n';
        const fd = openSync(this.options.owner.assertOwnsPath(path), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        try { this.options.owner.assertCurrent(); writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
        const directory = openSync(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        try { fsyncSync(directory); } finally { closeSync(directory); }
        }
        if (claim && claim !== path) this.pathClaims.delete(claim);
        claim = path; this.pathClaims.add(path);
        binding = await this.runtimeOpening.run({}, () => this.options.lifecycle.openSession({ ...request, resources, ownership, policy: initialPolicy, services, target: { kind: 'resume', sessionFile: path },
          rootSessionId: binding!.rootSessionId, ...(binding!.parentSessionId ? { parentSessionId: binding!.parentSessionId } : {}) }));
        this.assertAdmission(); manager = binding.runtime.session.sessionManager;
      }
      const actualPath = manager.getSessionFile();
      if (!actualPath || manager.getSessionId() !== binding.sessionId || manager.getCwd() !== resources.cwd) throw new Error('Lifecycle returned inconsistent session identity.');
      const path = this.options.owner.assertOwnsPath(actualPath);
      if (restored && (binding.sessionId !== restored.id || path !== restored.piPath || binding.rootSessionId !== restored.root)) throw new Error('Restored session identity changed.');
      if (this.entries.has(binding.sessionId) || (this.pathClaims.has(path) && claim !== path)) throw new Error('Session already has a live writer.');
      if (claim && claim !== path) this.pathClaims.delete(claim);
      claim = path; this.pathClaims.add(path);
      const effectivePolicy = openingPolicy();
      if (!restored) this.options.store.createSession({ id: binding.sessionId, root: binding.rootSessionId, ...(binding.parentSessionId ? { parent: binding.parentSessionId } : {}),
        ...(request.execution ? { execution: request.execution } : {}),
        cwd: resources.cwd, piPath: path, title: manager.getSessionName() ?? '', state: 'open', residency: 'warm', run: { state: 'idle' },
        policy: { effective: effectivePolicy.mode, generation: effectivePolicy.generation },
        branch: manager.getLeafId() ?? binding.sessionId, observedTip: sessionTip(manager),
        ...(binding.runtime.session.model ? { model: { provider: binding.runtime.session.model.provider, id: binding.runtime.session.model.id } } : {}), thinking: binding.runtime.session.thinkingLevel,
        ...(request.source !== undefined || request.interactiveExtensions !== undefined || request.extensionPaths?.length || request.extensionConfigOverrides?.length ? { profile: parseSchema(SessionProfileSchema, {
          source: request.source ?? 'headless', ...(request.interactiveExtensions === undefined ? {} : { interactiveExtensions: request.interactiveExtensions }), ...(request.extensionPaths?.length ? { extensionPaths: request.extensionPaths } : {}),
          ...(request.extensionConfigOverrides?.length ? { extensionConfigOverrides: request.extensionConfigOverrides } : {}),
        }) } : {}),
      });
      else this.options.store.updateSession(binding.sessionId, { residency: 'warm' });
      const projection = new SessionProjection({ binding, store: this.options.store, extras: () => this.extras(binding!.sessionId), publish: event => this.publish(event), onError: error => { this.fence(error); },
        commandAvailable: name => this.options.commandAvailable?.(binding!.sessionId, name) === false ? false
          : this.commandDispatcher?.(binding!.sessionId, name) ?? this.options.commandAvailable?.(binding!.sessionId, name) ?? false,
        canSettle: () => { const current = this.entries.get(binding!.sessionId); return !current?.dispatches.size && !current?.cancelling; },
        onRefresh: () => {
          const current = this.entries.get(binding!.sessionId);
          if (current) this.updateCommandState(current);
        },
      });
      const entry: Entry = { binding, projection, attachments: new Map(), dispatches: new Set(), writers: new Set(), services: this.retainedServices.get(binding.sessionId) ?? new Set(), lastDetached: this.now() };
      this.retainedServices.delete(binding.sessionId); this.entries.set(binding.sessionId, entry);
      const host = this.executionHost(binding.sessionId);
      host.activate();
      entry.host = host;
      const activation = { binding, active: true };
      try { await this.bindingActivation.run(activation, () => binding!.activate?.()); }
      finally { activation.active = false; }
      this.assertAdmission();
      if (this.closing.has(binding.sessionId) || request.parentSessionId && this.closing.has(request.parentSessionId)) throw new RegistryOpeningCancelled('Session closed during activation.');
      // A restored root rediscovers jobs that outlived its previous runtime or daemon.
      if (restored && !binding.parentSessionId) await this.processes.refresh(binding.rootSessionId).catch(error => { this.fence(error); throw error; });
      projection.refresh(); if (borrowed) this.copyClaims.delete(borrowed); return binding;
    } catch (error) {
      if (binding) {
        const installed = this.entries.get(binding.sessionId);
        if (installed && installed.binding === binding) { this.closing.add(binding.sessionId); installed.projection.dispose(); }
        try {
          await this.processes.withCleanup(binding.sessionId, async () => {
            if (installed && installed.binding === binding) {
              this.settleInteractions(binding!.sessionId, 'cancel');
              await installed.host?.shutdown(); await installed.cancelling;
            }
            await binding!.runtime.session.abort();
            if (installed && installed.binding === binding) {
              await this.join([...installed.writers]);
              await this.processes.settle(binding!.rootSessionId, false, new Set([binding!.sessionId]));
              for (const service of installed.services) { await service.settle(); await service.dispose(); }
            }
            await binding!.runtime.dispose();
          });
          this.processes.revokeRuntime(binding.agentRuntime);
          if (installed && installed.binding === binding) {
            this.options.store.transitionSessionForSafety(binding.sessionId, 'idle');
            this.options.store.transitionSessionForSafety(binding.sessionId, 'evicted');
            this.entries.delete(binding.sessionId); this.closing.delete(binding.sessionId);
          }
        }
        catch (cleanup) { this.fence(cleanup); throw new AggregateError([error, cleanup], 'Registry opening cleanup failed; ownership remains held.'); }
      }
      if (claim) this.pathClaims.delete(claim);
      if (borrowed) this.copyClaims.delete(borrowed);
      throw error;
    }
  }
  private settleInteractions(id: string, reason: 'cancel' | 'close' | 'shutdown'): void {
    for (const interaction of this.options.store.snapshot().interactions) {
      if (interaction.scope.kind !== 'session' || interaction.scope.session !== id || !['waiting', 'deferred'].includes(interaction.state)) continue;
      const commit = reason === 'shutdown' && interaction.deferrable
        ? this.options.store.deferInteraction(interaction.id)
        : this.options.store.cancelInteraction(interaction.id, reason === 'shutdown' ? 'drain' : 'abort');
      this.publish({ v: 1, session: id, rev: commit.revisions[id]!, change: { type: commit.value.state === 'deferred' ? 'interaction.requested' : 'interaction.resolved', interaction: commit.value } });
    }
  }

  private cancelViews(id: string): Promise<void> {
    const entry = this.require(id);
    if (entry.cancellingViews) return entry.cancellingViews;
    for (const controller of entry.viewActions ?? []) controller.abort();
    const cancellation = entry.viewCancellation ??= { attempted: new Set(), rounds: 0 };
    const work = Promise.resolve().then(async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 250);
      let aborted!: () => void;
      const deadline = new Promise<void>(resolve => { aborted = resolve; });
      controller.signal.addEventListener('abort', aborted, { once: true });
      try {
        for (;;) {
          const actions = entry.projection.presentations().flatMap(element => {
            if (element.kind !== 'view' && element.kind !== 'document' && element.kind !== 'progress') return [];
            const action = element.actions.find(action => action.target === 'element' && action.outcome === 'cancel');
            const key = JSON.stringify([element.id, element.revision]);
            if (!action || cancellation.attempted.has(key)) return [];
            cancellation.attempted.add(key);
            return [{ elementId: element.id, revision: element.revision, actionId: action.id, outcome: action.outcome, values: {} }];
          });
          if (!actions.length) return;
          if (cancellation.rounds++ >= 8 || controller.signal.aborted) {
            for (const action of actions) this.viewCancellationDiagnostic(id, action.elementId, controller.signal.aborted ? 'timeout' : 'limit');
            return;
          }
          await Promise.all(actions.map(async action => {
            try {
              const execute = this.prepareUiAction(id, action);
              await Promise.race([execute({ requestId: randomUUID(), signal: controller.signal }), deadline]);
              if (controller.signal.aborted) this.viewCancellationDiagnostic(id, action.elementId, 'timeout');
            } catch (error) {
              if ((error as { code?: string } | null)?.code !== 'stale_request') this.viewCancellationDiagnostic(id, action.elementId, controller.signal.aborted ? 'timeout' : 'failed');
            }
          }));
        }
      } finally {
        clearTimeout(timer);
        controller.signal.removeEventListener('abort', aborted);
        controller.abort();
        delete entry.cancellingViews;
        entry.writers.delete(work);
      }
    });
    entry.cancellingViews = work;
    entry.writers.add(work);
    return work;
  }

  private viewCancellationDiagnostic(session: string, elementId: string, reason: 'failed' | 'timeout' | 'limit'): void {
    try { this.options.onViewCancellationDiagnostic?.({ session, elementId, reason }); } catch { /* Diagnostics cannot block best-effort cancellation. */ }
  }

  private updateCommandState(entry: Entry): void {
    if (!entry.command) return;
    const run = this.options.store.session(entry.binding.sessionId).run;
    if (run.id !== entry.command.runId || run.state !== 'running' && run.state !== 'waiting') return;
    const state = entry.command.views.size && entry.binding.runtime.session.isIdle ? 'waiting' : 'running';
    if (state !== run.state) entry.projection.publish({ type: 'run.updated', run: { ...run, state } }, { run: { ...run, state } });
  }

  private extras(id: string): { children: SessionSnapshot['children']; processes: SessionSnapshot['processes']; interactions: SessionSnapshot['interactions'] } {
    const state = this.options.store.snapshot(); const session = this.options.store.session(id);
    return { children: state.sessions.filter(item => item.parent === id && item.deletedAt === undefined).map(item => ({ session: item.id, parent: id, root: item.root, title: item.title, state: item.state, run: item.run })),
      processes: this.processes.list(session.root).slice(0, 256), interactions: state.interactions.filter(item => item.scope.kind === 'session' && item.scope.session === id && (item.state === 'waiting' || item.state === 'deferred')) };
  }
  private publish(event: ProjectionOutput): void {
    if ('change' in event && 'interaction' in event.change && (event.change.type === 'interaction.requested' || event.change.type === 'interaction.resolved')) {
      const interaction = parseInteraction(event.change.interaction);
      for (const listener of this.interactionListeners) listener(structuredClone(interaction));
    }
    for (const listener of this.listeners.get(event.session) ?? []) { try { listener(structuredClone(event)); } catch { /* A client observer does not own runtime lifetime. */ } }
    const entry = this.entries.get(event.session);
    if (!entry || !('change' in event)) return;
    const change = event.change;
    if (change.type === 'run.updated') { this.updateCommandState(entry); return; }
    if (change.type !== 'presentation.updated' && change.type !== 'presentation.removed') return;
    if (entry.command) {
      if (change.type === 'presentation.removed' && 'id' in change) entry.command.views.delete(change.id);
      else if ('presentation' in change) {
        const element = change.presentation;
        if ((element.kind === 'view' || element.kind === 'document') && element.actions.some(action => action.target === 'element' && action.outcome === 'cancel')) entry.command.views.add(element.id);
        else entry.command.views.delete(element.id);
      }
      this.updateCommandState(entry);
    }
    if (change.type === 'presentation.updated' && 'presentation' in change && (this.draining || this.stopping || this.closing.has(event.session) || entry.cancelling)) {
      void Promise.resolve().then(() => {
        if (this.entries.get(event.session) === entry) return this.cancelViews(event.session);
      }).catch(() => this.viewCancellationDiagnostic(event.session, change.presentation.id, 'failed'));
    }
  }
  private policyUpdate(id: string, policy: Policy): void {
    const projection = this.entries.get(id)?.projection;
    if (projection) projection.publish({ type: 'policy.updated', policy }, { policy });
    else this.options.store.updateSession(id, { policy });
  }
  private require(id: string): Entry { const entry = this.entries.get(id); if (!entry) throw new Error('Session runtime is not resident.'); return entry; }
  /** Reload keeps the root's PTYs running (its next runtime reattaches them by ID) and keeps the root's executions running. */
  private async disposeEntry(id: string, close: boolean, { preserveView = false, keepTerminals = false, keepExecutions = false } = {}): Promise<void> {
    const entry = this.require(id);
    if (entry.disposing) return entry.disposing;
    entry.disposing = (async () => {
      entry.projection.refresh();
      if (close) this.processes.seal(id);
      for (const service of [...entry.services]) if (service.disposeWhenIdle) {
        await this.processes.withCleanup(id, async () => { await service.settle(close ? 'force' : 'drain'); await service.dispose(); });
        entry.services.delete(service);
      }
      if (!close) this.processes.seal(id);
      if (close) for (const service of entry.services) await this.processes.withCleanup(id, () => service.dispose());
      if (!keepExecutions) await entry.host?.shutdown();
      await this.processes.settle(entry.binding.rootSessionId, false, new Set([id]), keepTerminals);
      if (!entry.runtimeDisposed) await this.processes.withCleanup(id, () => entry.binding.runtime.dispose());
      this.processes.revoke(id);
      this.options.owner.assertCurrent();
      const stored = this.options.store.session(id);
      const closed = close || this.closes.has(id);
      entry.projection.transitionForSafety(closed ? 'closed' : 'evicted');
      entry.projection.dispose(); this.entries.delete(id); if (!preserveView) this.listeners.delete(id); this.pathClaims.delete(stored.piPath);
      if (!close && entry.services.size) this.retainedServices.set(id, entry.services);
    })();
    try { await entry.disposing; } catch (error) { delete entry.disposing; this.fence(error); throw error; }
  }
  private fence(error: unknown): void {
    this.failure = error;
    this.processes.sealAll();
    for (const entry of this.entries.values()) entry.projection.dispose();
    this.failureSettlement ??= Promise.resolve().then(() => this.settleAfterLoss());
    void this.failureSettlement.catch(() => {});
  }
  async settleWriters(): Promise<void> {
    if (this.failureSettlement) await this.failureSettlement;
    else {
      const failures: unknown[] = [];
      do { await this.join(this.pendingWriters(), failures); }
      while (this.hasPendingWriters());
      for (const error of this.cancellationFailures) if (!failures.includes(error)) failures.push(error);
      if (failures.length) throw new AggregateError(failures, 'Registry writers did not settle cleanly; ownership must remain held.');
    }
  }
  private async settleAfterLoss(): Promise<void> {
    const failures: unknown[] = [];
    const roots = new Set([...this.entries.values()].map(entry => entry.binding.rootSessionId).concat([...this.processes.liveRoots()]));
    const pending: Promise<unknown>[] = [...this.opening.values(), ...this.closes.values(), ...[...roots].map(root => this.processes.settle(root, true))];
    for (const entry of this.entries.values()) {
      pending.push(entry.binding.runtime.session.abort(), ...(entry.disposing ? [entry.disposing] : []), ...(entry.cancelling ? [entry.cancelling] : []));
      if (entry.host) pending.push((async () => {
        try { await entry.host!.shutdown(); } finally { await entry.host!.settle(); }
      })());
      for (const service of entry.services) pending.push(service.settle());
    }
    for (const services of this.retainedServices.values()) for (const service of services) pending.push(service.settle());
    await this.join(pending, failures);
    do { await this.join(this.pendingWriters(), failures); }
    while (this.hasPendingWriters());
    for (const error of this.cancellationFailures) if (!failures.includes(error)) failures.push(error);
    if (failures.length) throw new AggregateError(failures, 'Registry writers did not settle cleanly; ownership must remain held.');
  }

  private pendingWriters(): Promise<unknown>[] {
    return [...this.opening.values(), ...this.lifecycleWriters, ...[...this.entries.values()].flatMap(entry => [...entry.writers, ...(entry.cancelling ? [entry.cancelling] : [])])];
  }

  private hasPendingWriters(): boolean {
    return this.opening.size > 0 || this.lifecycleWriters.size > 0 || [...this.entries.values()].some(entry => entry.writers.size > 0 || entry.cancelling !== undefined);
  }

  private async join(operations: readonly Promise<unknown>[], failures?: unknown[], allowCancelled = false): Promise<void> {
    const errors = failures ?? [];
    for (const result of await Promise.allSettled(operations)) if (result.status === 'rejected' && !(allowCancelled && result.reason instanceof RegistryOpeningCancelled)) errors.push(result.reason);
    if (!failures && errors.length) throw new AggregateError(errors, 'Registry operation failed to settle.');
  }
}
function profileOptions(profile: SessionProfile | undefined): Pick<RegistryOpenRequest, 'source' | 'interactiveExtensions' | 'extensionPaths' | 'extensionConfigOverrides'> {
  return { source: profile?.source ?? 'headless', ...(profile?.interactiveExtensions === undefined ? {} : { interactiveExtensions: profile.interactiveExtensions }), ...(profile?.extensionPaths ? { extensionPaths: profile.extensionPaths } : {}),
    ...(profile?.extensionConfigOverrides ? { extensionConfigOverrides: profile.extensionConfigOverrides } : {}) };
}
function directoryOf(path: string): string { return path.slice(0, path.lastIndexOf('/')) || '/'; }
function registryError(code: string, message: string): Error & { code: string } { return Object.assign(new Error(message), { code }); }
