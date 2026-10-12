import { AsyncLocalStorage } from 'node:async_hooks';
import { closeSync, constants, existsSync, fsyncSync, openSync, writeFileSync } from 'node:fs';
import { opendir, stat } from 'node:fs/promises';
import { setImmediate as yieldTurn } from 'node:timers/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AgentRuntime, AgentSession } from '@felan-ai/agent-core';
import { canonicalRequestPayload, parseInteraction, parseSchema, validateRequestId, type Interaction, type InteractionAnswer, type KnownSessionChange, type OperationParams, type Origin, type Policy, type SessionSnapshot } from '@felan-ai/session-protocol';
import type { LocalSubagentHost } from '../subagents/host.js';
import type { LocalSubagentNavigatorHost } from '../subagents/presentation.js';
import { publishAgentView } from './agent-view.js';
import type { ControlCommit, DaemonControlStore } from './control-store.js';
import { SessionProfileSchema, type ControlSession, type SessionProfile } from './control-state.js';
import type { DaemonOwnership } from './ownership.js';
import type { DaemonProfile, DaemonSessionServices, ProfileOpenRequest, ProfileResources, ProfileSessionBinding, ProfileTargetIdentity, SessionExecutionPolicy } from './profile.js';
import { profilePolicy, SessionProjection, type ProjectionOutput } from './projection.js';
import { RegistryProcesses } from './processes.js';
import { adoptLegacySession, type LegacySessionIdentity } from './legacy-adoption.js';
import { guardOwnedPaths, sha256 } from './persistence.js';
import { inspectInventoryHeader, inspectInventorySource, prepareTranscriptDeletion, type CachedLegacyIdentity, type InventoryHeader, type InventorySessionIdentity } from './session-files.js';
import { assertTargetIdentity, pathInside } from './target.js';
import { sessionTip } from './session-cursor.js';

export interface RegistryOpenRequest extends Omit<ProfileOpenRequest, 'resources' | 'ownership' | 'services' | 'policy'> {
  cwd: string;
  sessionDir?: string;
  policy?: SessionExecutionPolicy;
  systemPromptAppend?: string;
  clientRoot?: true;
  subagentHost?: LocalSubagentHost;
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
  profile: DaemonProfile;
  services(context: { request: RegistryOpenRequest; getExecutionPolicy(): SessionExecutionPolicy }): DaemonSessionServices;
  now?: () => number;
  idleMs?: number;
  inventoryCwds?: readonly string[];
  commandAvailable?(session: string, name: string): boolean;
}
export interface RegistryMutationContext {
  readonly session: AgentSession;
  assertCurrent(): void;
}
const nonRunMutations = new Set(['set_model', 'set_thinking', 'session.rename', 'session.entry.label', 'session.branch.select', 'session.export', 'command.invoke', 'processes.write', 'processes.stop', 'steer', 'follow_up', 'agents.steer', 'agents.cancel']);
interface Entry {
  binding: ProfileSessionBinding;
  projection: SessionProjection;
  attachments: Map<string, { principal: string; kind: 'tui' | 'acp' | 'headless' }>;
  services: Set<RegistryService>;
  dispatches: Set<string>;
  writers: Set<Promise<void>>;
  host?: LocalSubagentHost;
  agentView?: LocalSubagentNavigatorHost;
  releaseAgentView?: () => void;
  lastDetached: number;
  disposing?: Promise<void>;
  cancelling?: Promise<void>;
}
class RegistryOpeningCancelled extends Error {}

export class SessionRegistry {
  readonly processes: RegistryProcesses;
  readonly recovery: ReturnType<DaemonControlStore['recover']>['value'] | undefined;
  private readonly entries = new Map<string, Entry>();
  private readonly runtimeOpening = new AsyncLocalStorage<{ scope?: { session: string; root: string } }>();
  private readonly bindingActivation = new AsyncLocalStorage<{ binding: ProfileSessionBinding; active: boolean }>();
  private readonly opening = new Map<string, Promise<ProfileSessionBinding>>();
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
  private stopping = false;
  private draining = false;
  private failure?: unknown;
  private failureSettlement: Promise<void> | undefined;
  private readonly cancellationFailures = new Set<unknown>();
  private readonly lossUnsubscribe: () => void;
  private commandDispatcher: ((session: string, name: string) => boolean) | undefined;
  private readonly inventoryCache = new Map<string, CachedLegacyIdentity>();

  constructor(readonly options: RegistryOptions) {
    options.owner.assertCurrent();
    if (options.store.owner !== options.owner) throw new Error('Registry and store require the same held ownership.');
    if (options.inventoryCwds && options.inventoryCwds.length > 64) throw new Error('Too many explicit inventory working directories.');
    this.now = options.now ?? Date.now;
    this.recovery = options.store.needsRecovery ? options.store.recover().value : undefined;
    this.processes = new RegistryProcesses({ store: options.store, now: this.now, assertCurrent: () => options.owner.assertCurrent(),
      changed: (id, process, rev) => this.publish({ v: 1, session: id, rev, change: { type: 'process.updated', process } }) });
    this.lossUnsubscribe = options.owner.onLost(error => { this.fence(error); });
  }

  wrapOpeningRuntime(runtime: AgentRuntime, root: string): AgentRuntime {
    const opening = this.runtimeOpening.getStore();
    if (!opening) throw new Error('Runtime factories must run inside profile.openSession.');
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

  private assertSessionAccess(id: string, activatingBinding: boolean): void {
    this.assertAdmission();
    const session = this.options.store.session(id);
    if (session.deletedAt !== undefined) throw registryError('not_found', 'Session was deleted.');
    if (this.reservations.has(session.piPath) && !activatingBinding) throw registryError('busy', 'Session has a lifecycle operation in progress.');
    if (session.state !== 'open' || this.entries.get(id)?.disposing || this.entries.get(id)?.cancelling || this.closing.has(id) || this.closing.has(session.root) || this.copyClaims.has(session.piPath)) throw new Error('Session is closing, cancelling or has a pinned copy in progress.');
    if (session.policy.pending || this.options.store.session(session.root).policy.pending) throw registryError('policy_pending', 'policy_pending');
  }

  assertNewWork(): void {
    this.assertAdmission();
    if (this.draining) throw registryError('busy', 'Daemon is draining.');
  }

  beginDrain(): void {
    if (this.draining && this.stopping && !this.failure) { this.options.owner.assertCurrent(); this.options.store.snapshot(); return; }
    this.assertAdmission(); this.draining = true;
  }

  async waitForDrain(): Promise<void> {
    this.assertAdmission();
    if (!this.draining) throw new Error('Drain must be started before waiting.');
    await this.join([...this.opening.values(), ...this.closes.values(), ...this.lifecycleWriters], undefined, true);
    for (const entry of this.entries.values()) {
      await entry.host?.settle();
      await entry.cancelling;
      await this.join([...entry.writers]);
      for (const service of entry.services) await service.settle('drain');
    }
    this.assertAdmission();
    if ([...this.entries.values()].some(entry => !entry.binding.runtime.session.isIdle || entry.dispatches.size || entry.writers.size
      || entry.host?.hasPendingWork() || [...entry.services].some(service => service.busy()) || this.processes.blocksEviction(entry.binding.rootSessionId))) {
      throw registryError('busy', 'Daemon still owns active processes or work. Explicit force is required to interrupt it.');
    }
  }

  create(request: RegistryOpenRequest): Promise<ProfileSessionBinding> {
    this.assertNewWork();
    if (request.parentSessionId && (this.closing.has(request.parentSessionId) || this.closing.has(request.rootSessionId!))) throw new Error('Parent session is closing.');
    if (request.target.kind === 'resume') throw new Error('Restore registered sessions by ID; legacy sessions require explicit adoption.');
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

  async validateConfiguration(request: RegistryOpenRequest, resources?: ProfileResources): Promise<void> {
    if (!request.extensionConfigOverrides?.length) return;
    this.assertAdmission();
    if (!this.options.profile.validateConfiguration) throw registryError('unavailable', 'The profile cannot validate session configuration before execution.');
    const resolved = resources ?? await this.options.profile.resolveResources({ cwd: request.cwd, ...(request.sessionDir ? { sessionDir: request.sessionDir } : {}) });
    const services = this.options.services({ request, getExecutionPolicy: () => request.policy ?? { mode: 'host-default', pendingTightening: false, generation: 0 } });
    await this.options.profile.validateConfiguration(resolved, request.extensionConfigOverrides, packages => services.extensions.configuration(packages));
    this.assertAdmission();
  }

  assertClientSessionDirectory(resources: ProfileResources): void {
    this.assertAdmission();
    const path = this.options.owner.assertOwnsPath(resources.sessionDir);
    const reserved = [this.options.store.directory, this.options.owner.target.runtimeDirectory,
      join(resources.agentDir, 'adopted-sessions'), resources.sessionStorageBase, resources.agentStorageRoot, resources.subagentRoot, resources.memoryRoot];
    if (path === resources.agentDir || reserved.some(root => pathInside(root, path))) throw registryError('forbidden', 'Client session directory is reserved for daemon state.');
  }

  restore(id: string, context: Pick<RegistryOpenRequest, 'systemPromptAppend' | 'subagentHost'> = {}): Promise<ProfileSessionBinding> {
    this.assertAdmission();
    const stored = this.options.store.snapshot().sessions.find(session => session.id === id);
    if (!stored) throw registryError('adoption_required', 'Unregistered sessions require explicit adoption.');
    if (stored.deletedAt !== undefined) throw registryError('not_found', 'Session was deleted.');
    if (this.reloadAttachments.has(id) && this.opening.has(id)) return this.opening.get(id)!;
    if (this.closing.has(id)) throw new Error('Session is closing.');
    const entry = this.entries.get(id);
    if (entry?.disposing) return entry.disposing.then(() => this.restore(id, context));
    if (entry) return Promise.resolve(entry.binding);
    const pending = this.opening.get(id);
    if (pending) return pending;
    if (stored.state !== 'open' || this.closing.has(id)) throw new Error('Closed session cannot be restored for execution.');
    const operation = this.open({ cwd: stored.cwd, sessionDir: directoryOf(stored.piPath), target: { kind: 'resume', sessionFile: stored.piPath },
      rootSessionId: stored.root, ...(stored.parent ? { parentSessionId: stored.parent } : {}), policy: profilePolicy(stored), ...profileOptions(stored.profile), ...context }, stored);
    this.opening.set(id, operation);
    void operation.then(() => this.opening.delete(id), () => this.opening.delete(id));
    return operation;
  }

  list(): ControlSession[] { this.options.owner.assertCurrent(); return this.options.store.snapshot().sessions.filter(session => session.deletedAt === undefined); }
  binding(id: string): ProfileSessionBinding | undefined { return this.entries.get(id)?.binding; }
  projection(id: string): SessionProjection { return this.require(id).projection; }
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
    if (entry?.attachments.delete(attachment) && !entry.attachments.size) entry.lastDetached = this.now();
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
  bindSubagentHost(id: string, host: LocalSubagentHost): void {
    const entry = this.require(id);
    if (entry.host && entry.host !== host) throw new Error('Session already has a subagent host.');
    entry.host = host;
    this.bindSubagentView(id, host);
  }
  bindSubagentView(id: string, host: LocalSubagentNavigatorHost): void {
    const entry = this.require(id);
    const activation = this.bindingActivation.getStore();
    this.assertSessionAccess(id, activation?.active === true && activation.binding === entry.binding);
    if (entry.agentView === host) return;
    entry.releaseAgentView?.();
    entry.agentView = host;
    entry.releaseAgentView = publishAgentView(host, value => entry.projection.setPresentation(value), error => this.fence(error));
  }
  subagentView(id: string): LocalSubagentNavigatorHost {
    this.assertDispatch(id);
    const host = this.require(id).agentView;
    if (!host) throw registryError('unavailable', 'Subagent views are unavailable for this session.');
    return host;
  }

  async runAdmitted<T>(requestId: string, id: string, origin: Origin, effect: (session: AgentSession) => Promise<T>): Promise<T> {
    this.assertNewWork();
    this.assertDispatch(id);
    const entry = this.require(id); const stored = this.options.store.session(id);
    if (stored.state !== 'open' || this.closing.has(id) || this.copyClaims.has(stored.piPath) || !entry.binding.runtime.session.isIdle || entry.dispatches.size) throw registryError('busy', 'Session is busy or closed.');
    if (stored.policy.pending || this.options.store.session(stored.root).policy.pending) throw registryError('policy_pending', 'policy_pending');
    const request = this.options.store.snapshot().requests.find(item => item.id === requestId);
    if (request?.session !== id) throw new Error('Admitted request belongs to another session.');
    const run = { state: 'running' as const, id: randomUUID(), origin };
    let finish!: () => void;
    const writer = new Promise<void>(resolve => { finish = resolve; });
    entry.writers.add(writer);
    entry.dispatches.add(requestId); entry.projection.setOrigin(origin);
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
    if (this.closing.has(id) || this.copyClaims.has(stored.piPath) || !entry.binding.runtime.session.isIdle || entry.dispatches.size) throw registryError('busy', 'Session is busy.');
    if (stored.policy.pending || this.options.store.session(stored.root).policy.pending) throw registryError('policy_pending', 'policy_pending');
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
    const requiresIdle = !['processes.write', 'processes.stop', 'steer', 'follow_up', 'agents.steer', 'agents.cancel'].includes(request.op);
    let active = true;
    const assertCurrent = () => {
      if (!active) throw new Error('Mutation dispatch has settled.');
      this.assertDispatch(id);
      if (this.entries.get(id) !== entry) throw new Error('Session runtime changed.');
      if (requiresIdle && (!entry.binding.runtime.session.isIdle || entry.binding.runtime.session.pendingMessageCount > 0
        || [...entry.dispatches].some(active => active !== requestId))) throw registryError('busy', 'Session is busy.');
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
    validateRequestId(requestId, Math.max(this.now(), this.options.store.snapshot().clock));
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
    if (interaction.scope.kind === 'host' || interaction.request.kind === 'oauth') {
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

  async legacyInventory(filter: { root?: string; cwd?: string } = {}): Promise<{ entries: InventorySessionIdentity[]; directories: string[]; complete: boolean;
    diagnostics: Array<{ code: 'unavailable_cwd' | 'unreadable' | 'oversize' | 'truncated'; count: number }> }> {
    this.assertAdmission();
    const managed = join(this.options.owner.target.agentDir, 'adopted-sessions');
    const directories = new Set([join(this.options.owner.target.agentDir, 'sessions')]);
    const cwds = new Set([...(this.options.inventoryCwds ?? []), ...this.list().map(session => session.cwd)]);
    for (const entry of this.entries.values()) if (!pathInside(managed, entry.binding.resources.sessionDir)) directories.add(entry.binding.resources.sessionDir);
    const resolved = new Set<string>(); const scanned = new Set<string>(); const headers = new Map<string, InventoryHeader>();
    let count = 0; let readBytes = 0; let complete = true;
    const diagnostics = new Map<'unavailable_cwd' | 'unreadable' | 'oversize' | 'truncated', number>();
    const report = (code: 'unavailable_cwd' | 'unreadable' | 'oversize' | 'truncated', unknownArea = false) => {
      if (unknownArea) complete = false;
      diagnostics.set(code, Math.min(8192, (diagnostics.get(code) ?? 0) + 1));
    };
    const state = this.options.store.snapshot(); const ownedFiles = new Set(state.sessions.map(row => row.piPath));
    const scan = async (directory: string, depth = 0): Promise<void> => {
      if (pathInside(managed, directory)) return;
      if (depth > 32 || ++count > 8192) { report('truncated', true); return; }
      let path: string;
      try { path = this.options.owner.assertOwnsPath(directory); }
      catch { this.assertAdmission(); report('unreadable', true); return; }
      if (scanned.has(path)) { scanned.add(directory); return; }
      scanned.add(directory); scanned.add(path);
      if (pathInside(managed, path)) return;
      try {
        const check = guardOwnedPaths(this.options.owner, [path]); const directory = await opendir(path);
        for await (const child of directory) {
          if (++count > 8192) { report('truncated', true); break; }
          const file = join(path, child.name);
          if (child.isDirectory()) await scan(file, depth + 1);
          else if (child.isFile() && file.endsWith('.jsonl') && !ownedFiles.has(file)) {
            try {
              const header = await inspectInventoryHeader(this.options.owner, file, this.inventoryCache.get(file));
              const identity = header.identity;
              const adoption = state.adoptions.find(item => item.session === identity.session && item.phase === 'complete');
              if (!adoption || !state.sessions.some(session => session.id === identity.session && session.piPath === adoption.destination)) headers.set(file, header);
              if (header.diagnostic) report(header.diagnostic);
              cwds.add(identity.cwd);
            } catch { this.assertAdmission(); this.inventoryCache.delete(file); report('unreadable'); }
          } else if (child.isSymbolicLink()) report('unreadable');
          await yieldTurn(); this.assertAdmission();
        }
        check();
      } catch (error) {
        this.assertAdmission();
        if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) report('unreadable', true);
      }
    };
    for (;;) {
      for (const cwd of cwds) if (!resolved.has(cwd)) {
        resolved.add(cwd);
        if (resolved.size > 8192) { report('truncated', true); break; }
        try {
          const resources = await this.options.profile.resolveResources({ cwd }); this.assertAdmission();
          const path = this.options.owner.assertOwnsPath(resources.sessionDir);
          if (!pathInside(managed, path)) directories.add(path);
        } catch {
          this.assertAdmission(); let missing = false;
          try { missing = !(await stat(cwd)).isDirectory(); }
          catch (error) { missing = ['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? ''); }
          report('unavailable_cwd', !missing);
        }
        await yieldTurn();
      }
      const remaining = [...directories].filter(directory => !scanned.has(directory));
      if (!remaining.length) break;
      for (const directory of remaining) await scan(directory);
      if (count > 8192 || resolved.size > 8192) break;
    }
    if (!cwds.size) report('unavailable_cwd', true);
    const matches = (header: InventoryHeader) => (!filter.root || filter.root === header.identity.session) && (!filter.cwd || filter.cwd === header.identity.cwd);
    const ordered = [...headers].sort(([a, left], [b, right]) => Number(matches(right)) - Number(matches(left)) || a.localeCompare(b));
    for (const [file, header] of ordered) {
      if (!header.verifiable) continue;
      try {
        const cached = await inspectInventorySource(this.options.owner, file, this.inventoryCache.get(file), 64 * 1024 * 1024 - readBytes, bytes => { readBytes += bytes; });
        if (cached.key !== header.key) throw registryError('adoption_required', 'Legacy source changed after header inspection.');
        header.identity = cached.identity;
        this.inventoryCache.delete(file); this.inventoryCache.set(file, cached);
        while (this.inventoryCache.size > 128 || Buffer.byteLength(JSON.stringify([...this.inventoryCache])) > 1024 * 1024) this.inventoryCache.delete(this.inventoryCache.keys().next().value!);
      } catch (error) {
        this.assertAdmission(); this.inventoryCache.delete(file);
        delete header.identity.fingerprint;
        report((error as { code?: string }).code === 'inventory_budget' ? 'truncated' : 'unreadable');
      }
      await yieldTurn(); this.assertAdmission();
    }
    const current = this.options.store.snapshot();
    const visible = [...headers.values()].map(header => header.identity).filter(item => !current.sessions.some(session => session.piPath === item.source)
      && !current.adoptions.some(adoption => adoption.session === item.session && adoption.phase === 'complete'
        && current.sessions.some(session => session.id === item.session && session.piPath === adoption.destination)));
    const roots: string[] = [];
    for (const directory of directories) {
      try { const path = this.options.owner.assertOwnsPath(directory); if (!pathInside(managed, path)) roots.push(path); }
      catch { this.assertAdmission(); report('unreadable', true); }
    }
    return { entries: visible, directories: [...new Set(roots)], complete,
      diagnostics: [...diagnostics].map(([code, count]) => ({ code, count })) };
  }

  adoptAdmitted(requestId: string, id: string, params: OperationParams<'session.adopt'>,
    selected: LegacySessionIdentity, directories: readonly string[]): Promise<{ sessionId: string; adoptionId: string }> {
    this.assertAdmission();
    assertTargetIdentity(this.options.owner.target, params.expected, this.options.owner.identity);
    const request = this.options.store.snapshot().requests.find(item => item.id === requestId);
    if (request?.op !== 'session.adopt' || request.session !== undefined || request.phase !== 'intent' || selected.session !== id
      || selected.fingerprint !== params.sourceFingerprint) throw registryError('request_conflict', 'Adoption selection changed.');
    const payload = canonicalRequestPayload({ v: 1, id: requestId, op: 'session.adopt', session: id, params }, { checkFreshness: false });
    if (request.identity.sha256 !== sha256(payload) || request.identity.bytes !== Buffer.byteLength(payload)) throw registryError('request_conflict', 'Adoption differs from its admitted identity.');
    const destination = this.options.owner.assertOwnsPath(join(this.options.owner.target.agentDir, 'adopted-sessions', `${sha256(id)}.jsonl`));
    const source = this.options.owner.assertOwnsPath(selected.source); const token = Symbol('adoption');
    const state = this.options.store.snapshot();
    const registered = state.sessions.find(session => session.id === id || session.piPath === destination);
    if (registered) {
      const adoption = state.adoptions.find(item => item.session === id && item.phase === 'complete' && item.destination === destination);
      if (!adoption || registered.id !== id || registered.piPath !== destination || registered.deletedAt !== undefined) throw registryError('request_conflict', 'Adoption identity is already registered differently.');
      validateRequestId(requestId, Math.max(this.now(), state.clock)); this.options.store.markDispatched(requestId);
      return Promise.resolve({ sessionId: id, adoptionId: adoption.id });
    }
    if ([...this.reservations.values()].some(item => item.id === id) || [source, destination].some(path => this.pathClaims.has(path) || this.copyClaims.has(path) || this.reservations.has(path))) throw registryError('busy', 'Adoption has a known writer.');
    for (const path of [source, destination]) { this.reservations.set(path, { token, id }); this.pathClaims.add(path); }
    const work = (async () => {
      try {
        validateRequestId(requestId, Math.max(this.now(), this.options.store.snapshot().clock));
        this.options.store.markDispatched(requestId);
        const checkKnownWriters = async () => {
          try { this.assertAdmission(); } catch { return 'unknown' as const; }
          if ([source, destination].some(path => this.copyClaims.has(path)
            || this.pathClaims.has(path) && this.reservations.get(path)?.token !== token)
            || [...this.reservations.values()].some(item => item.id === id && item.token !== token)
            || this.options.store.snapshot().sessions.some(session => session.piPath === source || session.piPath === destination)) return 'live' as const;
          return 'none_known' as const;
        };
        const adoption = await adoptLegacySession(this.options.store, { source, expectedFingerprint: params.sourceFingerprint,
          expectedSession: id, expectedCwd: selected.cwd, backupConfirmed: params.backupConfirmed,
          quiescenceConfirmed: params.quiescenceConfirmed, warningAcknowledged: params.legacyRiskAcknowledged }, {
          managedDirectory: dirname(destination), allSessionDirectories: directories, checkKnownWriters,
        });
        this.assertAdmission();
        if (adoption.phase !== 'complete') throw new Error('Adoption copy is not complete.');
        const existing = this.options.store.snapshot().sessions.find(session => session.id === id || session.piPath === destination);
        if (existing) {
          if (existing.id !== id || existing.piPath !== destination || existing.deletedAt !== undefined) throw registryError('request_conflict', 'Adoption registration conflicts.');
          await this.restore(id); return { sessionId: id, adoptionId: adoption.id };
        }
        const opening = this.open({ cwd: adoption.cwd, sessionDir: dirname(destination), target: { kind: 'resume', sessionFile: destination }, source: 'tui' }, undefined, undefined, token);
        this.opening.set(id, opening);
        try { const binding = await opening; return { sessionId: binding.sessionId, adoptionId: adoption.id }; } finally { this.opening.delete(id); }
      } finally {
        for (const path of [source, destination]) if (this.reservations.get(path)?.token === token) {
          this.reservations.delete(path);
          if (path === source || this.entries.get(id)?.binding.runtime.session.sessionManager.getSessionFile() !== path) this.pathClaims.delete(path);
        }
      }
    })();
    return this.trackLifecycle(work);
  }

  deleteAdmitted(requestId: string, id: string, expectedRevision: number): Promise<void> {
    this.assertAdmission(); const stored = this.options.store.session(id); const path = stored.piPath;
    if (stored.state !== 'closed' || stored.residency !== 'evicted' || stored.run.state !== 'idle' || this.entries.has(id)
      || this.opening.has(id) || this.closes.has(id)
      || this.pathClaims.has(path) || this.copyClaims.has(path) || this.reservations.has(path)
      || this.options.store.snapshot().adoptions.some(adoption => adoption.source === path)) throw registryError('busy', 'Deletion requires a closed, evicted and unclaimed transcript.');
    const token = Symbol('deletion'); this.reservations.set(path, { token, id }); this.pathClaims.add(path);
    const work = Promise.resolve().then(() => {
      this.assertAdmission();
      const remove = prepareTranscriptDeletion(this.options.owner, path);
      validateRequestId(requestId, Math.max(this.now(), this.options.store.snapshot().clock));
      const commit = this.options.store.markSessionDeleted(requestId, expectedRevision);
      this.publishCommitted(commit.revisions); remove();
    }).finally(() => { if (this.reservations.get(path)?.token === token) { this.reservations.delete(path); this.pathClaims.delete(path); } });
    return this.trackLifecycle(work);
  }

  reloadAdmitted(requestId: string, id: string, configuration?: { values: OperationParams<'config.set'>['values']; overrides: NonNullable<SessionProfile['extensionConfigOverrides']> }): Promise<ProfileSessionBinding> {
    this.assertDispatch(id); const stored = this.options.store.session(id); const entry = this.entries.get(id);
    const request = this.options.store.snapshot().requests.find(item => item.id === requestId);
    if (request?.op !== (configuration ? 'config.set' : 'session.reload') || request.session !== id || request.phase !== 'intent') throw registryError('request_conflict', 'Reload request differs.');
    if (stored.parent) throw registryError('unavailable', 'Only root sessions can reload.');
    if (!['idle', 'interrupted'].includes(stored.run.state) || this.hasWarmChildren(id) || this.retainedServices.get(id)?.size || this.processes.blocksEviction(stored.root)
      || this.options.store.snapshot().interactions.some(item => item.scope.kind === 'session' && item.scope.root === stored.root && ['waiting', 'deferred'].includes(item.state))
      || this.opening.has(id) || entry?.disposing || entry?.cancelling || entry && (this.busy(id) || entry.writers.size)) throw registryError('busy', 'Session must be quiescent before reload.');
    const token = Symbol('reload'); this.reservations.set(stored.piPath, { token, id });
    const attachments = entry?.attachments ?? new Map(); this.reloadAttachments.set(id, attachments);
    const work = (async () => {
      try {
        if (configuration) this.options.store.configureSession(requestId, configuration.values, configuration.overrides);
        else this.commitDispatch(requestId, id);
        if (entry) await this.disposeEntry(id, false, true);
        this.assertAdmission();
        if (this.closing.has(id) || this.options.store.session(id).state !== 'open') throw new RegistryOpeningCancelled('Session closed during reload.');
        this.pathClaims.add(stored.piPath);
        const current = this.options.store.session(id);
        const binding = await this.open({ cwd: current.cwd, sessionDir: dirname(current.piPath), target: { kind: 'resume', sessionFile: current.piPath },
          rootSessionId: current.root, policy: profilePolicy(current), ...profileOptions(current.profile) }, current, undefined, token);
        this.require(id).attachments = attachments;
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
        if (!this.failure && !this.stopping && !this.closing.has(id)) this.activatePolicy(stored.root);
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

  async forkAdmitted(requestId: string, id: string, from: OperationParams<'fork'>['from']): Promise<ProfileSessionBinding> {
    return this.copyAdmitted(requestId, id, from);
  }

  async cloneAdmitted(requestId: string, id: string): Promise<ProfileSessionBinding> {
    return this.copyAdmitted(requestId, id);
  }

  private async copyAdmitted(requestId: string, id: string, from?: OperationParams<'fork'>['from']): Promise<ProfileSessionBinding> {
    await this.restore(id);
    this.assertDispatch(id);
    const source = this.require(id);
    const stored = this.options.store.session(id);
    const request = this.options.store.snapshot().requests.find(item => item.id === requestId);
    if (request?.session !== id || request.op !== (from ? 'fork' : 'session.clone')) throw new Error('Copy request belongs to another operation or session.');
    if (this.busy(id)) throw registryError('busy', 'Source session is busy.');
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
      if (!this.failure && !this.stopping && !this.closing.has(id) && !this.closing.has(stored.root)) this.activatePolicy(stored.root);
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
    finally { delete entry.cancelling; }
    if (!this.stopping && !this.failure && !this.closing.has(id) && !this.closing.has(stored.root)) this.entries.get(stored.root)?.host?.resumeQueued();
  }

  policyBlockers(root: string): NonNullable<Policy['pending']>['blockers'] {
    const blockers: NonNullable<Policy['pending']>['blockers'] = [];
    for (const stored of this.list().filter(item => item.root === root)) {
      const entry = this.entries.get(stored.id);
      if (entry && !entry.binding.runtime.session.isIdle || ['running', 'waiting', 'cancelling'].includes(stored.run.state)) blockers.push({ session: stored.id, ...(stored.run.id ? { runId: stored.run.id } : {}), reason: 'turn' });
      for (const row of stored.projections) if (row.value.type === 'tool' && row.value.tool.state === 'running') blockers.push({ session: stored.id, toolCallId: row.value.tool.id, reason: 'tool' });
      if (entry?.host?.hasExecutingJobs() || entry?.dispatches.size || this.reservations.has(stored.piPath)) blockers.push({ session: stored.id, reason: 'admitted_dispatch' });
    }
    return blockers;
  }
  tightenPolicy(root: string): Policy {
    this.assertAdmission();
    for (const stored of this.list().filter(item => item.root === root && item.state === 'open')) {
      if (stored.policy.effective === 'acp-strict' || stored.policy.pending) continue;
      this.policyUpdate(stored.id, { effective: stored.policy.effective, generation: stored.policy.generation + 1, pending: { target: 'acp-strict', blockers: this.policyBlockers(root) } });
    }
    this.activatePolicy(root); return this.options.store.session(root).policy;
  }
  activatePolicy(root: string): void {
    const sessions = this.list().filter(item => item.root === root && item.policy.pending);
    if (!sessions.length) return;
    const blockers = this.policyBlockers(root);
    for (const stored of sessions) {
      const policy: Policy = blockers.length ? { ...stored.policy, generation: stored.policy.generation + 1, pending: { target: 'acp-strict', blockers } }
        : { effective: 'acp-strict', generation: stored.policy.generation + 1 };
      if (JSON.stringify({ ...stored.policy, generation: 0 }) !== JSON.stringify({ ...policy, generation: 0 })) this.policyUpdate(stored.id, policy);
    }
    if (!blockers.length && !this.stopping && !this.failure && !this.closing.has(root)) this.entries.get(root)?.host?.resumeQueued();
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
    void operation.then(() => this.closes.delete(id), () => {});
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
    await this.join([...this.opening.values(), ...this.closes.values(), ...this.lifecycleWriters], undefined, true);
    for (const [id, entry] of this.entries) {
      this.closing.add(id);
      this.settleInteractions(id, 'shutdown');
      if (options.interrupt) {
        await this.join([entry.host?.shutdown() ?? Promise.resolve(), entry.cancelling ?? Promise.resolve(), entry.binding.runtime.session.abort()]);
      } else {
        await entry.host?.shutdown();
        await entry.cancelling;
        await entry.binding.runtime.session.abort();
      }
      await this.processes.cancelForeground(id);
      await Promise.all(entry.writers);
      entry.projection.settleRun(this.options.store.session(id).run.id);
      await this.processes.settle(entry.binding.rootSessionId);
      for (const service of entry.services) await this.processes.withCleanup(id, async () => { await service.settle(); await service.dispose(); });
      entry.services.clear();
      await this.disposeEntry(id, false);
    }
    for (const services of this.retainedServices.values()) for (const service of services) { await service.settle(); await service.dispose(); }
    for (const row of interrupted) if (this.options.store.session(row.id).state === 'open') this.options.store.interruptSessionRun(row.id, row.run);
    this.retainedServices.clear(); this.lossUnsubscribe(); this.listeners.clear();
    // The caller closes the store/profile and releases ownership only after this resolves.
  }

  private busy(id: string): boolean {
    const entry = this.require(id); const stored = this.options.store.session(id);
    return this.copyClaims.has(stored.piPath) || this.reservations.has(stored.piPath) || !entry.binding.runtime.session.isIdle || entry.binding.runtime.session.pendingMessageCount > 0 || entry.dispatches.size > 0
      || ['running', 'waiting', 'cancelling'].includes(stored.run.state) || !!entry.host?.hasPendingWork() || !!entry.host?.hasActiveJobs()
      || [...entry.services].some(service => !service.disposeWhenIdle || service.busy()) || this.processes.blocksEviction(stored.root)
      || this.options.store.snapshot().resources.some(row => row.root === stored.root && row.kind === 'child' && row.state === 'running')
      || this.options.store.snapshot().interactions.some(item => item.scope.kind === 'session' && item.scope.root === stored.root && item.state === 'waiting');
  }

  private hasWarmChildren(id: string): boolean { return [...this.entries].some(([child, value]) => child !== id && value.binding.rootSessionId === id); }

  private async open(request: RegistryOpenRequest, restored?: ControlSession, copySource?: string, reservation?: symbol): Promise<ProfileSessionBinding> {
    const resources = await this.options.profile.resolveResources({ cwd: request.cwd, ...(request.sessionDir ? { sessionDir: request.sessionDir } : {}) });
    this.assertAdmission();
    if (request.clientRoot) this.assertClientSessionDirectory(resources);
    for (const path of resources.writableRoots) this.options.owner.assertOwnsPath(path);
    const sourcePath = request.target.kind === 'clone' || request.target.kind === 'fork' ? this.options.owner.assertOwnsPath(request.target.sourceSessionFile) : undefined;
    const source = sourcePath ? this.list().find(item => item.piPath === sourcePath) : undefined;
    const initialPolicy = request.parentSessionId ? this.getPolicy(request.rootSessionId!) : source ? profilePolicy(source) : request.policy ?? { mode: 'host-default', pendingTightening: false, generation: 0 };
    let binding: ProfileSessionBinding | undefined;
    let claim: string | undefined;
    let borrowed: string | undefined;
    const openingPolicy = () => request.parentSessionId ? this.getPolicy(request.rootSessionId!) : source ? this.getPolicy(source.id) : initialPolicy;
    const externalServices = this.options.services({ request, getExecutionPolicy: () => binding && this.entries.has(binding.sessionId) ? this.getPolicy(binding.sessionId) : openingPolicy() });
    const services: DaemonSessionServices = { ...externalServices, extensions: {
      configuration: packages => externalServices.extensions.configuration(packages),
      bind: async context => {
        const scope = this.runtimeOpening.getStore()?.scope;
        if (scope) { scope.session = context.sessionManager.getSessionId(); scope.root = context.rootSessionId; }
        const bindings = await externalServices.extensions.bind(context);
        return { ...bindings, inlineExtensions: [...(bindings.inlineExtensions ?? []), ...(request.systemPromptAppend ? [{
          name: '@felan-ai/felan/child-instructions',
          factory: (pi: import('@felan-ai/agent-core').ExtensionAPI) => { pi.on('before_agent_start', event => ({ systemPrompt: `${event.systemPrompt}\n\n${request.systemPromptAppend}` })); },
        }] : [])] };
      },
    } };
    const ownership = { assertOwned: (resolved: ProfileResources, target: ProfileTargetIdentity) => {
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
        if (this.pathClaims.has(source) && (target.kind === 'fork' || target.kind === 'clone')) {
          const current = this.list().find(item => item.piPath === source);
          if (!current || this.busy(current.id) || this.copyClaims.has(source)) throw new Error('Source session is busy.');
          borrowed = source; this.copyClaims.add(source); return;
        }
        if (this.pathClaims.has(source)) throw new Error('Session transcript already has a live writer.');
        this.pathClaims.add(source); claim = source;
      }
    } };
    try {
      const target = restored?.branch && request.target.kind === 'resume' ? { ...request.target, cursor: {
        branch: restored.branch, ...(restored.observedTip === undefined ? {} : { observedTip: restored.observedTip }),
      } } : request.target;
      binding = await this.runtimeOpening.run({}, () => this.options.profile.openSession({ ...request, target, resources, ownership, policy: initialPolicy, services }));
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
        if (Buffer.byteLength(bytes) > 64 * 1024 * 1024) throw new Error('Initial Pi session exceeds the file bound.');
        const fd = openSync(this.options.owner.assertOwnsPath(path), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        try { this.options.owner.assertCurrent(); writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
        const directory = openSync(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        try { fsyncSync(directory); } finally { closeSync(directory); }
        }
        if (claim && claim !== path) this.pathClaims.delete(claim);
        claim = path; this.pathClaims.add(path);
        binding = await this.runtimeOpening.run({}, () => this.options.profile.openSession({ ...request, resources, ownership, policy: initialPolicy, services, target: { kind: 'resume', sessionFile: path },
          rootSessionId: binding!.rootSessionId, ...(binding!.parentSessionId ? { parentSessionId: binding!.parentSessionId } : {}) }));
        this.assertAdmission(); manager = binding.runtime.session.sessionManager;
      }
      const actualPath = manager.getSessionFile();
      if (!actualPath || manager.getSessionId() !== binding.sessionId || manager.getCwd() !== resources.cwd) throw new Error('Profile returned inconsistent session identity.');
      const path = this.options.owner.assertOwnsPath(actualPath);
      if (restored && (binding.sessionId !== restored.id || path !== restored.piPath || binding.rootSessionId !== restored.root)) throw new Error('Restored session identity changed.');
      if (this.entries.has(binding.sessionId) || (this.pathClaims.has(path) && claim !== path)) throw new Error('Session already has a live writer.');
      if (claim && claim !== path) this.pathClaims.delete(claim);
      claim = path; this.pathClaims.add(path);
      const effectivePolicy = openingPolicy();
      if (!restored) this.options.store.createSession({ id: binding.sessionId, root: binding.rootSessionId, ...(binding.parentSessionId ? { parent: binding.parentSessionId } : {}),
        cwd: resources.cwd, piPath: path, title: manager.getSessionName() ?? '', state: 'open', residency: 'warm', run: { state: 'idle' },
        policy: { effective: effectivePolicy.mode, generation: effectivePolicy.generation, ...(effectivePolicy.pendingTightening ? { pending: { target: 'acp-strict', blockers: [] } } : {}) },
        branch: manager.getLeafId() ?? binding.sessionId, observedTip: sessionTip(manager),
        ...(binding.runtime.session.model ? { model: { provider: binding.runtime.session.model.provider, id: binding.runtime.session.model.id } } : {}), thinking: binding.runtime.session.thinkingLevel,
        ...(request.source !== undefined || request.extensionPaths?.length || request.extensionConfigOverrides?.length ? { profile: parseSchema(SessionProfileSchema, {
          source: request.source ?? 'headless', ...(request.extensionPaths?.length ? { extensionPaths: request.extensionPaths } : {}),
          ...(request.extensionConfigOverrides?.length ? { extensionConfigOverrides: request.extensionConfigOverrides } : {}),
        }) } : {}),
      });
      else this.options.store.updateSession(binding.sessionId, { residency: 'warm' });
      const projection = new SessionProjection({ binding, store: this.options.store, extras: () => this.extras(binding!.sessionId), publish: event => this.publish(event), onError: error => { this.fence(error); },
        commandAvailable: name => this.options.commandAvailable?.(binding!.sessionId, name) === false ? false
          : this.commandDispatcher?.(binding!.sessionId, name) ?? this.options.commandAvailable?.(binding!.sessionId, name) ?? false,
        canSettle: () => { const current = this.entries.get(binding!.sessionId); return !current?.dispatches.size && !current?.cancelling; },
        onRefresh: () => { if (!this.stopping && !this.failure && this.entries.has(binding!.sessionId)) this.activatePolicy(binding!.rootSessionId); },
      });
      const entry: Entry = { binding, projection, attachments: new Map(), dispatches: new Set(), writers: new Set(), services: this.retainedServices.get(binding.sessionId) ?? new Set(), lastDetached: this.now() };
      this.retainedServices.delete(binding.sessionId); this.entries.set(binding.sessionId, entry);
      const activation = { binding, active: true };
      try { await this.bindingActivation.run(activation, () => binding!.activate?.()); }
      finally { activation.active = false; }
      this.assertAdmission();
      if (this.closing.has(binding.sessionId) || request.parentSessionId && this.closing.has(request.parentSessionId)) throw new RegistryOpeningCancelled('Session closed during activation.');
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
            installed.releaseAgentView?.(); this.entries.delete(binding.sessionId); this.closing.delete(binding.sessionId);
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
      const commit = reason === 'shutdown' && interaction.request.kind === 'ask_user'
        ? this.options.store.deferInteraction(interaction.id)
        : this.options.store.cancelInteraction(interaction.id, reason === 'shutdown' ? 'drain' : 'abort');
      this.publish({ v: 1, session: id, rev: commit.revisions[id]!, change: { type: commit.value.state === 'deferred' ? 'interaction.requested' : 'interaction.resolved', interaction: commit.value } });
    }
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
  }
  private policyUpdate(id: string, policy: Policy): void {
    const projection = this.entries.get(id)?.projection;
    if (projection) projection.publish({ type: 'policy.updated', policy }, { policy });
    else this.options.store.updateSession(id, { policy });
  }
  private require(id: string): Entry { const entry = this.entries.get(id); if (!entry) throw new Error('Session runtime is not resident.'); return entry; }
  private async disposeEntry(id: string, close: boolean, preserveView = false): Promise<void> {
    const entry = this.require(id);
    if (entry.disposing) return entry.disposing;
    entry.disposing = (async () => {
      entry.releaseAgentView?.(); delete entry.releaseAgentView;
      entry.projection.refresh();
      if (close) this.processes.seal(id);
      for (const service of [...entry.services]) if (service.disposeWhenIdle) {
        await this.processes.withCleanup(id, async () => { await service.settle(close ? 'force' : 'drain'); await service.dispose(); });
        entry.services.delete(service);
      }
      if (!close) this.processes.seal(id);
      if (close) for (const service of entry.services) await this.processes.withCleanup(id, () => service.dispose());
      await entry.host?.shutdown();
      await this.processes.settle(entry.binding.rootSessionId, false, new Set([id]));
      await this.processes.withCleanup(id, () => entry.binding.runtime.dispose());
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
    const roots = new Set([...this.entries.values()].map(entry => entry.binding.rootSessionId));
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
function profileOptions(profile: SessionProfile | undefined): Pick<RegistryOpenRequest, 'source' | 'extensionPaths' | 'extensionConfigOverrides'> {
  return { source: profile?.source ?? 'headless', ...(profile?.extensionPaths ? { extensionPaths: profile.extensionPaths } : {}),
    ...(profile?.extensionConfigOverrides ? { extensionConfigOverrides: profile.extensionConfigOverrides } : {}) };
}
function directoryOf(path: string): string { return path.slice(0, path.lastIndexOf('/')) || '/'; }
function registryError(code: string, message: string): Error & { code: string } { return Object.assign(new Error(message), { code }); }
