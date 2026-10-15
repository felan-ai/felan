import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Type } from 'typebox';
import { canonicalProspectivePath, pathInside } from './target.js';
import { CONTROL_LIMITS, ControlResourceSchema, ControlSessionSchema, ControlStoreError, SessionProfileSchema, parseControlState, type ControlContinuation, type ControlProjection, type ControlRequest, type ControlResource, type ControlSession, type ControlSessionMetadata, type ControlState, type SessionProfile } from './control-state.js';
import { AtomicControlFile, sha256, type PersistenceBoundary } from './persistence.js';
import type { DaemonOwnership } from './ownership.js';
import { recoverControlState, type RecoveryPlan } from './control-recovery.js';
import { IdSchema, LIMITS, OPERATION_CATALOG, parseClientEnvelope, canonicalRequestPayload, parseInteraction, parseSchema, parseServerEnvelope, requestRetainUntil, validateInteractionAnswer, type Interaction, type InteractionAnswer, type Response, type Operation, type OperationParams } from '@felan-ai/session-protocol';

export interface ControlStoreOptions {
  directory?: string;
  now?: () => number;
  fault?: (boundary: PersistenceBoundary) => void;
}
export interface ControlCommit<T> { value: T; revisions: Record<string, number> }

export class DaemonControlStore {
  readonly directory: string;
  private readonly file: AtomicControlFile;
  private state: ControlState;
  private readonly now: () => number;
  private recoveryRequired = false;
  private readonly unownedDirectories = new Set<string>();
  private readonly transientRevisionCeilings = new Map<string, number>();
  constructor(readonly owner: DaemonOwnership, options: ControlStoreOptions = {}) {
    this.now = options.now ?? Date.now;
    this.file = new AtomicControlFile(owner, options.directory ?? join(owner.target.agentDir, 'daemon-control-v1'), options.fault);
    this.directory = this.file.directory;
    try {
      const raw = this.file.read();
      const state = raw === null ? undefined : this.restore(raw);
      if (state) { this.state = state; this.recoveryRequired = true; }
      else {
        // Invalid or foreign state is moved aside; legacy discovery re-adopts the transcripts it described.
        if (raw !== null) this.file.quarantine();
        this.state = { version: 1, namespace: owner.target.namespaceId, agentDir: owner.target.agentDir, clock: this.time(0), sessions: [], requests: [], interactions: [], continuations: [], resources: [] };
        this.file.write(this.state);
      }
    } catch (error) { this.file.close(); throw error; }
  }
  /** Only a foreign or structurally invalid file is discarded; individually inconsistent rows are dropped. */
  private restore(raw: unknown): ControlState | undefined {
    let state: ControlState;
    try { state = parseControlState(raw); } catch { return undefined; }
    if (state.namespace !== this.owner.target.namespaceId || state.agentDir !== this.owner.target.agentDir) return undefined;
    const repaired = this.repair(state);
    try { return this.validate(repaired); } catch { return undefined; }
  }
  /**
   * Session directories recorded outside the current store roots (for example after `daemon-store-roots.json` was lost)
   * become owned roots again; rows whose directory cannot be owned are dropped individually.
   */
  async ownPersistedRoots(): Promise<void> {
    const dropped = new Set<string>();
    for (const directory of this.unownedDirectories) {
      try {
        if (!existsSync(directory)) throw new Error('Session directory is missing.');
        await this.owner.ownRoot(directory);
      } catch {
        this.owner.assertCurrent();
        for (const session of this.state.sessions) if (dirname(session.piPath) === directory) dropped.add(session.id);
      }
    }
    this.unownedDirectories.clear();
    if (!dropped.size) return;
    const state = this.validate(this.dropSessions(structuredClone(this.state), dropped));
    this.file.write(this.durableState(state)); this.state = state;
  }
  close(): void { this.file.close(); }
  get needsRecovery(): boolean { return this.recoveryRequired; }
  snapshot(): ControlState { this.file.assertCurrent(); return structuredClone(this.state); }
  session(id: string): ControlSession { this.file.assertCurrent(); return structuredClone(this.findSession(this.state, id)); }
  /** Copies a session without its projections, which dominate the stored size. */
  sessionMetadata(id: string): ControlSessionMetadata { this.file.assertCurrent(); return metadataCopy(this.findSession(this.state, id)); }
  sessionMetadatas(): ControlSessionMetadata[] { this.file.assertCurrent(); return this.state.sessions.map(metadataCopy); }
  findSessionMetadata(id: string): ControlSessionMetadata | undefined { this.file.assertCurrent(); const item = this.state.sessions.find(item => item.id === id); return item && metadataCopy(item); }
  interactions(): Interaction[] { this.file.assertCurrent(); return structuredClone(this.state.interactions); }
  request(id: string): ControlRequest | undefined { this.file.assertCurrent(); const item = this.state.requests.find(item => item.id === id); return item && structuredClone(item); }
  resource(id: string): ControlResource | undefined { this.file.assertCurrent(); const item = this.state.resources.find(item => item.id === id); return item && structuredClone(item); }
  resources(): ControlResource[] { this.file.assertCurrent(); return structuredClone(this.state.resources); }
  assertCurrent(): void { this.file.assertCurrent(); }
  createSession(input: Omit<ControlSession, 'revision' | 'updatedAt' | 'projections'>): ControlCommit<ControlSession> {
    const session = parseSchema(ControlSessionSchema, { ...input, revision: 0, updatedAt: this.time(this.state.clock), projections: [] });
    if (session.deletedAt !== undefined) throw new ControlStoreError('invalid_request', 'Only explicit deletion can create a tombstone.');
    session.piPath = this.owner.assertOwnsPath(session.piPath);
    if (this.state.sessions.some(item => item.id === session.id || item.piPath === session.piPath)) throw new ControlStoreError('request_conflict', 'Session identity or transcript path is already registered.');
    return this.commit((state, touched) => {
      state.sessions.push(session);
      touched.add(session.id); return session;
    });
  }
  updateSession(id: string, patch: Partial<Pick<ControlSession, 'state' | 'residency' | 'run' | 'policy' | 'title' | 'branch' | 'observedTip' | 'model' | 'thinking' | 'execution'>>): ControlCommit<ControlSession> {
    const old = this.session(id);
    if (old.deletedAt !== undefined) throw new ControlStoreError('not_found', 'Session was deleted.');
    const next = parseSchema(ControlSessionSchema, { ...old, ...patch });
    if (JSON.stringify(old.policy) !== JSON.stringify(next.policy) && next.policy.generation <= old.policy.generation) throw new ControlStoreError('invalid_request', 'A policy change must advance its generation.');
    return this.commit((state, touched) => {
      const at = state.sessions.findIndex(item => item.id === id); state.sessions[at] = next;
      touched.add(id); return next;
    });
  }
  configureSession(requestId: string, values: OperationParams<'config.set'>['values'], overrides: NonNullable<SessionProfile['extensionConfigOverrides']>): ControlCommit<ControlSession> {
    return this.commit((state, touched) => {
      const request = this.findRequest(state, requestId);
      if (request.op !== 'config.set' || request.phase !== 'intent' || !request.session) throw new ControlStoreError('invalid_request', 'Session configuration requires an undispatched session request.');
      const session = this.findSession(state, request.session);
      const payload = canonicalRequestPayload({ v: 1, id: requestId, op: 'config.set', session: session.id, params: { scope: 'session', values } });
      if (sha256(payload) !== request.identity.sha256 || Buffer.byteLength(payload) !== request.identity.bytes) throw new ControlStoreError('request_conflict', 'Configuration differs from its admitted payload.');
      session.profile = parseSchema(SessionProfileSchema, { ...(session.profile ?? { source: 'headless' }), extensionConfigOverrides: overrides });
      request.phase = 'dispatch_intent'; touched.add(session.id); return session;
    });
  }
  interruptSessionRun(id: string, runId: string): ControlCommit<ControlSession> {
    return this.commit((state, touched) => {
      const session = this.findSession(state, id);
      if (session.state !== 'open' || session.deletedAt !== undefined || !runId || session.run.id !== runId) throw new ControlStoreError('request_conflict', 'Run identity changed before interruption.');
      if (session.run.state !== 'interrupted') { session.run = { ...session.run, state: 'interrupted' }; touched.add(id); }
      return session;
    });
  }

  transitionSessionForSafety(id: string, transition: 'cancelling' | 'idle' | 'closed' | 'evicted'): ControlCommit<ControlSession> {
    if (!['cancelling', 'idle', 'closed', 'evicted'].includes(transition)) throw new ControlStoreError('invalid_request', 'Unknown safety transition.');
    return this.commit((state, touched) => {
      const session = this.findSession(state, id);
      if (session.deletedAt !== undefined) throw new ControlStoreError('not_found', 'Session was deleted.');
      const active = ['running', 'waiting', 'cancelling'].includes(session.run.state);
      if (transition === 'cancelling' && (session.state !== 'open' || !active || !session.run.id)) throw new ControlStoreError('invalid_request', 'Cancellation requires an existing active open run.');
      if ((transition === 'closed' || transition === 'evicted') && active) throw new ControlStoreError('invalid_request', 'Settle the active run before closing or evicting.');
      if (transition === 'idle' && session.state === 'closed' && session.run.state !== 'idle') throw new ControlStoreError('invalid_request', 'A closed session cannot settle a new run.');
      let changed = false;
      const runState = transition === 'cancelling' ? 'cancelling' : transition === 'idle' || transition === 'closed' ? 'idle' : session.run.state;
      if (session.run.state !== runState) { session.run = { ...session.run, state: runState }; changed = true; }
      if (transition === 'closed' && session.state !== 'closed') { session.state = 'closed'; changed = true; }
      if ((transition === 'closed' || transition === 'evicted') && session.residency !== 'evicted') { session.residency = 'evicted'; changed = true; }
      if (changed) touched.add(id);
      return session;
    });
  }
  advanceTransientRevision(id: string): number {
    this.file.assertCurrent();
    if (this.recoveryRequired) throw new ControlStoreError('storage_failure', 'Recover the persisted control state before publishing.');
    const session = this.findSession(this.state, id);
    if (session.deletedAt !== undefined) throw new ControlStoreError('not_found', 'Session was deleted.');
    const revision = session.revision + 1;
    if (revision > (this.transientRevisionCeilings.get(id) ?? session.revision)) {
      const ceiling = revision + 4095;
      if (!Number.isSafeInteger(ceiling)) throw new ControlStoreError('storage_failure', 'Session revision exhausted.');
      const durable = this.durableState(this.state);
      this.findSession(durable, id).revision = ceiling;
      // Reserve revisions across crashes without persisting every transient frame.
      this.file.write(durable);
      this.transientRevisionCeilings.set(id, ceiling);
    }
    session.revision = revision;
    return revision;
  }

  project(id: string, values: readonly ControlProjection[]): ControlCommit<ControlSession> {
    return this.commit((state, touched, now) => {
      const session = this.findSession(state, id);
      if (session.deletedAt !== undefined) throw new ControlStoreError('not_found', 'Session was deleted.');
      for (const value of values) {
        const key = value.type === 'message' ? `message:${value.id}` : value.type === 'tool' ? `tool:${value.tool.id}` : value.type === 'queue' ? 'queue' : `status:${value.id}`;
        const record = parseSchema(Type.Index(ControlSessionSchema, ['projections']), [{ key, updatedAt: now, value }])[0]!;
        const previous = session.projections.find(item => item.key === key);
        if (previous?.value.type === 'message' && record.value.type === 'message' && previous.value.entryId !== record.value.entryId) throw new ControlStoreError('request_conflict', 'A message cannot change its Pi entry identity.');
        session.projections = session.projections.filter(item => item.key !== key); session.projections.push(record);
      }
      this.trimProjections(session); touched.add(id); return session;
    });
  }
  reconcilePi(id: string, observation: { present: { id: string; entryId: string }[]; absentEntryIds: string[] }): ControlCommit<ControlSession> {
    if (observation.present.length + observation.absentEntryIds.length > CONTROL_LIMITS.projections) throw new ControlStoreError('invalid_request', 'Reconcile Pi references in bounded pages.');
    const session = this.session(id);
    const values: ControlProjection[] = observation.present.map(item => ({ type: 'message', ...item, state: 'observed' }));
    for (const projection of session.projections) if (projection.value.type === 'message' && observation.absentEntryIds.includes(projection.value.entryId)) values.push({ ...projection.value, state: 'missing' });
    return this.project(id, values);
  }
  admit(value: unknown, principal: string): ControlCommit<ControlRequest> {
    this.file.assertCurrent();
    if (this.recoveryRequired) throw new ControlStoreError('storage_failure', 'Recover the persisted control state before admitting mutations.');
    const request = parseClientEnvelope(value);
    if (OPERATION_CATALOG[request.op].storage !== 'durable') throw new ControlStoreError('invalid_request', 'Only durable mutations have control request records.');
    const payload = canonicalRequestPayload(request);
    const identity = { sha256: sha256(payload), bytes: Buffer.byteLength(payload) };
    const previous = this.state.requests.find(item => item.id === request.id);
    if (previous) {
      if (previous.principal !== principal || previous.identity.sha256 !== identity.sha256 || previous.identity.bytes !== identity.bytes) throw new ControlStoreError('request_conflict', 'Request ID was already used by another principal or payload.');
      return { value: structuredClone(previous), revisions: {} };
    }
    const now = this.time(this.state.clock);
    const session = request.session;
    if (session) {
      const target = this.findSession(this.state, session);
      if (target.deletedAt !== undefined && request.op !== 'session.delete') throw new ControlStoreError('not_found', 'Session was deleted.');
    }
    const record: ControlRequest = { id: request.id, principal, ...(session ? { session } : {}), op: request.op, admittedAt: now, retainUntil: requestRetainUntil(request.id, now), identity, phase: 'intent' };
    return this.commit((state, touched) => {
      this.prune(state, now, touched);
      state.requests.push(record); return record;
    });
  }
  markDispatched(id: string): ControlCommit<ControlRequest> {
    return this.commit((state, touched) => {
      const record = this.findRequest(state, id);
      if (record.phase !== 'intent') throw new ControlStoreError('already_resolved', 'Request is already dispatched or terminal; never dispatch it twice.');
      if (record.session) { const session = this.findSession(state, record.session); if (session.state !== 'open') throw new ControlStoreError('invalid_request', 'Closed sessions cannot dispatch.'); touched.add(record.session); }
      record.phase = 'dispatch_intent'; return record;
    });
  }
  markSessionDeleted(requestId: string): ControlCommit<ControlSession> {
    return this.commit((state, touched, now) => {
      const request = this.findRequest(state, requestId);
      if (request.op !== 'session.delete' || request.phase !== 'intent' || !request.session) throw new ControlStoreError('invalid_request', 'Deletion requires its undispatched session request.');
      const session = this.findSession(state, request.session);
      const payload = canonicalRequestPayload({ v: 1, id: request.id, op: 'session.delete', session: session.id, params: {} });
      if (sha256(payload) !== request.identity.sha256 || Buffer.byteLength(payload) !== request.identity.bytes) throw new ControlStoreError('request_conflict', 'Deletion differs from its admitted payload.');
      request.phase = 'dispatch_intent';
      const tree = [session];
      for (let index = 0; index < tree.length; index++) for (const item of state.sessions) if (item.parent === tree[index]!.id && !tree.includes(item)) tree.push(item);
      for (const item of tree) if (item.deletedAt === undefined) {
        item.deletedAt = now; item.state = 'closed'; item.residency = 'evicted'; item.run = { ...item.run, state: 'idle' }; item.projections = [];
        touched.add(item.id);
      }
      return session;
    });
  }
  finishRequest(id: string, response: unknown): ControlCommit<Response> {
    return this.commit(state => {
      const record = this.findRequest(state, id);
      if (record.phase === 'terminal') throw new ControlStoreError('already_resolved', 'Request already has an outcome.');
      const parsed = this.parseResponse(record, response);
      if (parsed.outcome === 'accepted' && record.phase !== 'dispatch_intent') throw new ControlStoreError('invalid_request', 'An effectful request cannot succeed without a committed dispatch intent.');
      record.phase = 'terminal'; record.response = parsed; return parsed;
    });
  }
  putInteraction(value: unknown): ControlCommit<Interaction> {
    const interaction = parseInteraction(value);
    if (interaction.state !== 'waiting') throw new ControlStoreError('invalid_request', 'New interactions must be waiting.');
    return this.commit((state, touched) => {
      if (state.interactions.some(item => item.id === interaction.id)) throw new ControlStoreError('request_conflict', 'Interaction ID already exists.');
      if (interaction.scope.kind === 'session') { const session = this.findSession(state, interaction.scope.session); if (session.root !== interaction.scope.root) throw new ControlStoreError('invalid_request', 'Interaction root mismatch.'); touched.add(session.id); }
      state.interactions.push(interaction); return interaction;
    });
  }
  deferInteraction(id: string): ControlCommit<Interaction> {
    return this.commit((state, touched, now) => {
      const item = this.findInteraction(state, id);
      if (!['waiting', 'deferred'].includes(item.state) || !item.deferrable) throw new ControlStoreError('invalid_request', 'Only a pending deferrable interaction is serializable across drain.');
      const next: Interaction = { ...item, state: 'deferred', expiresAt: item.expiresAt ?? now + 30 * 60 * 1000 };
      state.interactions[state.interactions.indexOf(item)] = next;
      if (item.scope.kind === 'session') touched.add(item.scope.session); return next;
    });
  }
  cancelInteraction(id: string, reason: 'abort' | 'timeout' | 'unsupported' | 'drain' | 'restart'): ControlCommit<Interaction> {
    return this.commit((state, touched, now) => {
      const item = this.findInteraction(state, id);
      if (item.state !== 'waiting' && item.state !== 'deferred') throw new ControlStoreError('already_resolved', 'Interaction already resolved.');
      if (reason === 'timeout' && (item.expiresAt === undefined || item.expiresAt > now)) throw new ControlStoreError('invalid_request', 'Interaction has not expired.');
      const next: Interaction = { ...item, state: reason === 'timeout' ? 'expired' : 'cancelled', resolvedAt: now, result: { cancelled: true, reason } };
      state.interactions[state.interactions.indexOf(item)] = next;
      if (item.scope.kind === 'session') touched.add(item.scope.session);
      return next;
    });
  }
  answerInteraction(requestId: string, answer: InteractionAnswer | { cancelled: true; reason: 'user' }, continuationId?: string, responder?: string): ControlCommit<Interaction> {
    return this.commit((state, touched, now) => {
      const record = this.findRequest(state, requestId);
      if (record.op !== 'interaction.answer' || record.phase !== 'intent') throw new ControlStoreError('already_resolved', 'An answer requires its newly admitted request.');
      const candidates = state.interactions.filter(item => {
        const envelope = { v: 1, id: record.id, op: 'interaction.answer', ...(record.session ? { session: record.session } : {}), params: { interactionId: item.id, answer } };
        const payload = canonicalRequestPayload(envelope);
        return sha256(payload) === record.identity.sha256 && Buffer.byteLength(payload) === record.identity.bytes;
      });
      const item = candidates[0];
      if (!item || candidates.length !== 1) throw new ControlStoreError('request_conflict', 'Answer differs from admitted payload.');
      if (item.state !== 'waiting' && item.state !== 'deferred') throw new ControlStoreError('already_resolved', 'Interaction already resolved.');
      if (item.expiresAt !== undefined && item.expiresAt <= now) throw new ControlStoreError('already_resolved', 'Interaction expired.');
      if ((item.scope.kind === 'session' ? item.scope.session : undefined) !== record.session) throw new ControlStoreError('request_conflict', 'Answer scope differs from interaction scope.');
      const next: Interaction = 'cancelled' in answer ? { ...item, state: 'cancelled', resolvedAt: now, result: answer } : { ...item, state: 'answered', responder: parseSchema(IdSchema, responder ?? record.principal), resolvedAt: now, result: validateInteractionAnswer(item, answer) };
      if (continuationId !== undefined) {
        if (next.state !== 'answered' || !item.deferrable || item.scope.kind !== 'session') throw new ControlStoreError('invalid_request', 'Only answered deferrable session interactions have replayable continuations.');
        if (state.continuations.some(item => item.id === continuationId || item.interaction === next.id)) throw new ControlStoreError('request_conflict', 'Continuation identity already exists.');
        state.continuations.push({ id: continuationId, interaction: item.id, session: item.scope.session, phase: 'ready', createdAt: now, updatedAt: now });
      }
      state.interactions[state.interactions.indexOf(item)] = next;
      record.phase = 'terminal'; record.response = { v: 1, re: record.id, outcome: 'accepted', result: {} };
      if (item.scope.kind === 'session') touched.add(item.scope.session); return next;
    });
  }
  transitionContinuation(id: string, phase: 'dispatch_intent' | 'completed' | 'indeterminate'): ControlCommit<ControlContinuation> {
    return this.commit((state, touched, now) => {
      const item = state.continuations.find(item => item.id === id);
      if (!item) throw new ControlStoreError('not_found', 'Continuation not found.');
      if ((phase === 'dispatch_intent' && item.phase !== 'ready') || (phase !== 'dispatch_intent' && item.phase !== 'dispatch_intent')) throw new ControlStoreError('already_resolved', 'Continuation cannot transition or dispatch twice.');
      const session = this.findSession(state, item.session);
      if (phase === 'dispatch_intent' && session.state !== 'open') throw new ControlStoreError('invalid_request', 'Closed sessions cannot dispatch continuations.');
      item.phase = phase; item.updatedAt = now; touched.add(item.session); return item;
    });
  }
  putResource(value: unknown): ControlCommit<ControlState['resources'][number]> {
    const resource = parseSchema(ControlResourceSchema, value);
    if (resource.reference) resource.reference = this.owner.assertOwnsPath(resource.reference);
    return this.commit((state, touched, now) => {
      if (this.findSession(state, resource.session).root !== resource.root) throw new ControlStoreError('invalid_request', 'Resource root mismatch.');
      const previous = state.resources.find(item => item.id === resource.id);
      if (previous && (previous.kind !== resource.kind || previous.session !== resource.session || previous.reference !== resource.reference || previous.pid !== resource.pid || previous.startIdentity !== resource.startIdentity)) throw new ControlStoreError('request_conflict', 'Resource identity cannot be replaced.');
      const next = { ...resource, updatedAt: now };
      state.resources = state.resources.filter(item => item.id !== resource.id); state.resources.push(next); touched.add(resource.session); return next;
    });
  }
  recover(): ControlCommit<Omit<RecoveryPlan, 'changedSessions'>> {
    if (!this.recoveryRequired) throw new ControlStoreError('invalid_request', 'Recovery is only valid immediately after reopening persisted state.');
    this.recoveryRequired = false;
    try { return this.commit((state, touched, now) => {
      const { changedSessions, ...plan } = recoverControlState(state, now);
      for (const id of changedSessions) touched.add(id); return plan;
    }); } catch (error) { this.recoveryRequired = true; throw error; }
  }
  compact(): ControlCommit<void> { return this.commit((state, touched, now) => this.prune(state, now, touched)); }
  private commit<T>(change: (state: ControlState, touched: Set<string>, now: number) => T): ControlCommit<T> {
    this.file.assertCurrent();
    if (this.recoveryRequired) throw new ControlStoreError('storage_failure', 'Recover the persisted control state before admitting mutations.');
    const state = structuredClone(this.state); const touched = new Set<string>(); const now = this.time(state.clock);
    const value = change(state, touched, now); const revisions: Record<string, number> = Object.create(null) as Record<string, number>;
    for (const id of touched) {
      const session = this.findSession(state, id);
      session.revision++; session.updatedAt = now; revisions[id] = session.revision;
    }
    state.clock = now;
    const parsed = this.validate(state);
    this.file.write(this.durableState(parsed)); this.state = parsed;
    return { value: structuredClone(value), revisions };
  }
  private durableState(state: ControlState): ControlState {
    const durable = structuredClone(state);
    for (const session of durable.sessions) {
      session.revision = Math.max(session.revision, this.transientRevisionCeilings.get(session.id) ?? session.revision);
    }
    return durable;
  }

  private parseResponse(record: ControlRequest, value: unknown): Response {
    const response = parseServerEnvelope(value, record.op as Operation) as Response;
    if (response.re !== record.id) throw new ControlStoreError('request_conflict', 'Response ID differs from request.');
    return response;
  }
  private validate(value: unknown): ControlState {
    const state = parseControlState(value);
    for (const key of ['sessions', 'requests', 'interactions', 'continuations', 'resources'] as const) {
      const ids = state[key].map(item => item.id); if (new Set(ids).size !== ids.length) throw new ControlStoreError('storage_failure', 'Duplicate control identities.');
    }
    if (state.requests.some(request => !this.validRequest(state, request))) throw new ControlStoreError('storage_failure', 'Invalid durable request state.');
    if (state.interactions.some(interaction => !this.validInteraction(state, interaction))) throw new ControlStoreError('storage_failure', 'Interaction scope mismatch.');
    if (state.continuations.some(item => !this.validContinuation(state, item))) throw new ControlStoreError('storage_failure', 'Continuation lacks a committed winning answer.');
    if (state.sessions.some(session => !this.validSession(state, session))) throw new ControlStoreError('storage_failure', 'Session metadata or root lineage is inconsistent.');
    if (state.resources.some(resource => !this.validResource(state, resource))) throw new ControlStoreError('storage_failure', 'Resource scope mismatch.');
    return state;
  }
  /** Drops individually inconsistent rows (and the rows that depend on them) from a structurally valid persisted state. */
  private repair(state: ControlState): ControlState {
    const unique = <T extends { id: string }>(items: T[]) => items.filter((item, index) => items.findIndex(other => other.id === item.id) === index);
    state.sessions = unique(state.sessions); state.requests = unique(state.requests); state.interactions = unique(state.interactions);
    state.continuations = unique(state.continuations); state.resources = unique(state.resources);
    const invalid = new Set(state.sessions.filter(session => !this.validSession(state, session) || !this.usablePersistedPath(session.piPath)).map(session => session.id));
    const repaired = this.dropSessions(state, invalid);
    repaired.requests = repaired.requests.filter(request => this.validRequest(repaired, request));
    repaired.interactions = repaired.interactions.filter(interaction => this.validInteraction(repaired, interaction));
    repaired.continuations = repaired.continuations.filter(item => this.validContinuation(repaired, item));
    repaired.resources = repaired.resources.filter(resource => this.validResource(repaired, resource) && (!resource.reference || this.usablePersistedPath(resource.reference)));
    return repaired;
  }
  /** Records directories outside the current roots for re-ownership; a path whose canonical identity changed is unusable. */
  private usablePersistedPath(path: string): boolean {
    let canonical: string;
    try { canonical = canonicalProspectivePath(path); } catch { return false; }
    if (canonical !== path) return false;
    if (!this.owner.target.rootSet.some(root => pathInside(root, canonical))) this.unownedDirectories.add(dirname(canonical));
    return true;
  }
  private dropSessions(state: ControlState, ids: ReadonlySet<string>): ControlState {
    const dropped = new Set(ids);
    for (let changed = dropped.size > 0; changed;) {
      changed = false;
      for (const session of state.sessions) {
        if (!dropped.has(session.id) && (dropped.has(session.root) || session.parent !== undefined && dropped.has(session.parent))) { dropped.add(session.id); changed = true; }
      }
    }
    if (!dropped.size) return state;
    state.sessions = state.sessions.filter(session => !dropped.has(session.id));
    state.requests = state.requests.filter(request => !request.session || !dropped.has(request.session));
    state.interactions = state.interactions.filter(item => item.scope.kind !== 'session' || !dropped.has(item.scope.session));
    state.continuations = state.continuations.filter(item => !dropped.has(item.session));
    state.resources = state.resources.filter(item => !dropped.has(item.session));
    return state;
  }
  private validRequest(state: ControlState, request: ControlRequest): boolean {
    try {
      if (!Object.hasOwn(OPERATION_CATALOG, request.op) || OPERATION_CATALOG[request.op as Operation].storage !== 'durable' || request.retainUntil < requestRetainUntil(request.id, request.admittedAt) || (request.phase === 'terminal') !== (request.response !== undefined)) return false;
      if (request.response) this.parseResponse(request, request.response);
      if (request.session) this.findSession(state, request.session);
      return true;
    } catch { return false; }
  }
  private validInteraction(state: ControlState, interaction: Interaction): boolean {
    try {
      parseInteraction(interaction);
      return interaction.scope.kind !== 'session' || this.findSession(state, interaction.scope.session).root === interaction.scope.root;
    } catch { return false; }
  }
  private validContinuation(state: ControlState, item: ControlContinuation): boolean {
    const interaction = state.interactions.find(candidate => candidate.id === item.interaction);
    return !!interaction && interaction.state === 'answered' && !!interaction.deferrable && interaction.scope.kind === 'session' && interaction.scope.session === item.session
      && state.sessions.some(session => session.id === item.session);
  }
  private validSession(state: ControlState, session: ControlSession): boolean {
    const execution = session.execution;
    if (execution && (!session.parent || !!execution.completedAt !== !!execution.outcome || execution.completionPending && !execution.completedAt)) return false;
    if (session.deletedAt !== undefined && (session.state !== 'closed' || session.residency !== 'evicted' || session.run.state !== 'idle')) return false;
    if (new Set(session.projections.map(item => item.key)).size !== session.projections.length) return false;
    const path = new Set<string>();
    let ancestor: ControlSession | undefined = session;
    for (;;) {
      if (path.has(ancestor.id) || ancestor.root !== session.root) return false;
      path.add(ancestor.id);
      if (ancestor.parent === undefined) return ancestor.id === session.root;
      const parent: string = ancestor.parent;
      ancestor = state.sessions.find(item => item.id === parent);
      if (!ancestor) return false;
    }
  }
  private validResource(state: ControlState, resource: ControlState['resources'][number]): boolean {
    return state.sessions.find(session => session.id === resource.session)?.root === resource.root;
  }
  private prune(state: ControlState, now: number, touched: Set<string>): void {
    state.requests = state.requests.filter(item => item.phase !== 'terminal' || item.retainUntil >= now);
    state.continuations = state.continuations.filter(item => ['ready', 'dispatch_intent', 'indeterminate'].includes(item.phase) || item.updatedAt + LIMITS.requestRetentionMs >= now);
    state.interactions = state.interactions.filter(item => {
      const keep = !('resolvedAt' in item) || item.resolvedAt + LIMITS.requestRetentionMs >= now || state.continuations.some(c => c.interaction === item.id);
      if (!keep && item.scope.kind === 'session') touched.add(item.scope.session);
      return keep;
    });
    state.resources = state.resources.filter(item => {
      const keep = item.state !== 'exited' || item.updatedAt + LIMITS.requestRetentionMs >= now;
      if (!keep) touched.add(item.session);
      return keep;
    });
    state.sessions = state.sessions.filter(session => {
      const keep = session.deletedAt === undefined || session.deletedAt + LIMITS.requestRetentionMs >= now
        || state.sessions.some(other => other.id !== session.id && (other.parent === session.id || other.root === session.id))
        || state.requests.some(item => item.session === session.id)
        || state.interactions.some(item => item.scope.kind === 'session' && item.scope.session === session.id)
        || state.continuations.some(item => item.session === session.id)
        || state.resources.some(item => item.session === session.id || item.root === session.id);
      if (!keep) touched.delete(session.id);
      return keep;
    });
    for (const session of state.sessions) {
      const retained = session.projections.filter(item => item.updatedAt + CONTROL_LIMITS.projectionAgeMs >= now || (item.value.type === 'tool' && item.value.tool.state === 'running') || item.value.type === 'queue');
      if (retained.length !== session.projections.length) touched.add(session.id);
      session.projections = retained;
    }
  }
  private trimProjections(session: ControlSession): void {
    while (session.projections.length > CONTROL_LIMITS.projections) {
      const at = session.projections.findIndex(item => item.value.type === 'message' || item.value.type === 'status' || (item.value.type === 'tool' && item.value.tool.state !== 'running'));
      if (at < 0) throw new ControlStoreError('request_capacity', 'Active projection capacity reached.');
      session.projections.splice(at, 1);
    }
  }
  private findSession(state: ControlState, id: string): ControlSession {
    const item = state.sessions.find(item => item.id === id);
    if (!item) throw new ControlStoreError('not_found', 'Session not found.'); return item;
  }
  private findRequest(state: ControlState, id: string): ControlRequest {
    const item = state.requests.find(item => item.id === id.toLowerCase());
    if (!item) throw new ControlStoreError('not_found', 'Request not found.'); return item;
  }
  private findInteraction(state: ControlState, id: string): Interaction {
    const item = state.interactions.find(item => item.id === id);
    if (!item) throw new ControlStoreError('not_found', 'Interaction not found.'); return item;
  }
  private time(previous: number): number {
    const now = this.now(); if (!Number.isSafeInteger(now) || now < 0) throw new ControlStoreError('invalid_request', 'Invalid clock.'); return Math.max(previous, now);
  }
}

function metadataCopy(session: ControlSession): ControlSessionMetadata {
  const { projections: _projections, ...metadata } = session;
  return structuredClone(metadata);
}
