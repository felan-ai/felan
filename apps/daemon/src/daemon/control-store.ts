import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Type } from 'typebox';
import { canonicalProspectivePath, pathInside } from './target.js';
import { CONTROL_LIMITS, ControlResourceSchema, ControlSessionMetadataSchema, ControlSessionSchema, ControlStoreError, SessionProfileSchema, assertControlRow, parseControlState, type ControlContinuation, type ControlProjection, type ControlRequest, type ControlResource, type ControlSession, type ControlSessionMetadata, type ControlState, type SessionProfile } from './control-state.js';
import { CONTROL_TABLES, ControlDatabase, sha256, type ControlChanges, type ControlRow, type ControlTable, type PersistenceBoundary, type RemoteDatabase, type StoredControl } from './persistence.js';
import type { DaemonOwnership } from './ownership.js';
import { recoverControlState, type RecoveryPlan } from './control-recovery.js';
import { IdSchema, LIMITS, OPERATION_CATALOG, parseClientEnvelope, canonicalRequestPayload, parseInteraction, parseSchema, parseServerEnvelope, requestRetainUntil, validateInteractionAnswer, type Interaction, type InteractionAnswer, type Response, type Operation, type OperationParams } from '@felan-ai/session-protocol';

export interface ControlStoreOptions {
  directory?: string;
  now?: () => number;
  fault?: (boundary: PersistenceBoundary) => void;
}
export interface ControlCommit<T> { value: T; revisions: Record<string, number> }
/** A stored row and the committed object it was written from; an identical object needs no comparison. */
interface PersistedRow { ord: number; data: string; row?: object }
const ROW_TABLES = ['sessions', 'requests', 'interactions', 'continuations', 'resources'] as const;
type RowTable = typeof ROW_TABLES[number];
/** Rows by table and ID; projections by session, then key. */
interface PersistedRows { rows: Record<RowTable, Map<string, PersistedRow>>; projections: Map<string, Map<string, PersistedRow>> }

export class DaemonControlStore {
  readonly directory: string;
  private readonly file: ControlDatabase;
  get database(): RemoteDatabase { return this.file; }
  /** Committed rows are deep-frozen and shared with commit drafts, which replace a row before changing it. */
  private state: ControlState;
  /** What the database holds for each row, so a commit writes only rows whose data or order changed. */
  private persisted: PersistedRows = emptyRows();
  private maxOrd = 0;
  /** Whether the database holds this store's namespace; until then even an unchanged state is written. */
  private initialized = false;
  private readonly now: () => number;
  private recoveryRequired = false;
  private readonly unownedDirectories = new Set<string>();
  private readonly transientRevisionCeilings = new Map<string, number>();
  constructor(readonly owner: DaemonOwnership, options: ControlStoreOptions = {}) {
    this.now = options.now ?? Date.now;
    this.file = new ControlDatabase(owner, options.directory ?? join(owner.target.agentDir, 'daemon-control'), options.fault);
    this.directory = this.file.directory;
    try {
      const stored = this.file.read();
      let state: ControlState | undefined;
      if (stored) {
        state = this.restore(assemble(stored));
        // Invalid or foreign state is moved aside; legacy discovery re-adopts the transcripts it described.
        if (state) { this.persisted = storedRows(stored); this.maxOrd = maxOrd(stored); this.initialized = true; }
        else this.file.quarantine();
      }
      if (state) { for (const table of ROW_TABLES) for (const row of state[table]) freeze(row); this.state = state; this.recoveryRequired = true; }
      else {
        this.state = { version: 1, namespace: owner.target.namespaceId, agentDir: owner.target.agentDir, clock: this.time(0), sessions: [], requests: [], interactions: [], continuations: [], resources: [] };
        this.persist(this.state);
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
    const state = this.dropSessions(structuredClone(this.state), dropped);
    this.persist(state); this.state = state;
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
  updateSession(id: string, patch: Partial<Pick<ControlSession, 'state' | 'residency' | 'run' | 'policy' | 'title' | 'branch' | 'observedTip' | 'model' | 'thinking' | 'execution' | 'draft'>>): ControlCommit<ControlSession> {
    this.file.assertCurrent();
    const old = this.findSession(this.state, id);
    if (old.deletedAt !== undefined) throw new ControlStoreError('not_found', 'Session was deleted.');
    const { projections, ...metadata } = old;
    const next: ControlSession = { ...parseSchema(ControlSessionMetadataSchema, { ...metadata, ...structuredClone(patch) }), projections };
    if (JSON.stringify(old.policy) !== JSON.stringify(next.policy) && next.policy.generation <= old.policy.generation) throw new ControlStoreError('invalid_request', 'A policy change must advance its generation.');
    return this.commit((state, touched) => {
      const at = state.sessions.findIndex(item => item.id === id); state.sessions[at] = next;
      touched.add(id); return next;
    });
  }
  /** Tombstones a draft that was never used. Unlike deletion, no client request backs it. */
  discardDraft(id: string): ControlCommit<ControlSession> {
    this.file.assertCurrent();
    return this.commit((state, touched, now) => {
      const session = this.findSession(state, id);
      if (!session.draft || session.deletedAt !== undefined) throw new ControlStoreError('invalid_request', 'Only an unused draft can be discarded.');
      const item = editSession(state, session);
      item.deletedAt = now; item.state = 'closed'; item.residency = 'evicted'; item.run = { ...item.run, state: 'idle' }; item.projections = [];
      touched.add(id); return item;
    });
  }
  configureSession(requestId: string, values: OperationParams<'config.set'>['values'], overrides: NonNullable<SessionProfile['extensionConfigOverrides']>): ControlCommit<ControlSession> {
    return this.commit((state, touched) => {
      const request = edit(state.requests, this.findRequest(state, requestId));
      if (request.op !== 'config.set' || request.phase !== 'intent' || !request.session) throw new ControlStoreError('invalid_request', 'Session configuration requires an undispatched session request.');
      const session = editSession(state, this.findSession(state, request.session));
      const payload = canonicalRequestPayload({ v: 1, id: requestId, op: 'config.set', session: session.id, params: { scope: 'session', values } });
      if (sha256(payload) !== request.identity.sha256 || Buffer.byteLength(payload) !== request.identity.bytes) throw new ControlStoreError('request_conflict', 'Configuration differs from its admitted payload.');
      session.profile = parseSchema(SessionProfileSchema, { ...session.profile, extensionConfigOverrides: overrides });
      request.phase = 'dispatch_intent'; touched.add(session.id); return session;
    });
  }
  interruptSessionRun(id: string, runId: string): ControlCommit<ControlSession> {
    return this.commit((state, touched) => {
      const session = editSession(state, this.findSession(state, id));
      if (session.state !== 'open' || session.deletedAt !== undefined || !runId || session.run.id !== runId) throw new ControlStoreError('request_conflict', 'Run identity changed before interruption.');
      if (session.run.state !== 'interrupted') { session.run = { ...session.run, state: 'interrupted' }; touched.add(id); }
      return session;
    });
  }

  transitionSessionForSafety(id: string, transition: 'cancelling' | 'idle' | 'closed' | 'evicted'): ControlCommit<ControlSession> {
    if (!['cancelling', 'idle', 'closed', 'evicted'].includes(transition)) throw new ControlStoreError('invalid_request', 'Unknown safety transition.');
    return this.commit((state, touched) => {
      const session = editSession(state, this.findSession(state, id));
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
    const revision = session.revision + 1; const ceiling = this.transientRevisionCeilings.get(id);
    const next = { ...session, revision };
    if (revision <= (ceiling ?? session.revision)) { this.state.sessions[this.state.sessions.indexOf(session)] = freeze(next); return revision; }
    if (!Number.isSafeInteger(revision + 4095)) throw new ControlStoreError('storage_failure', 'Session revision exhausted.');
    // Reserve revisions across crashes without persisting every transient frame.
    const state = draft(this.state); state.sessions[state.sessions.indexOf(session)] = next;
    this.transientRevisionCeilings.set(id, revision + 4095);
    try { this.persist(state); }
    catch (error) {
      if (ceiling === undefined) this.transientRevisionCeilings.delete(id); else this.transientRevisionCeilings.set(id, ceiling);
      throw error;
    }
    this.state = state;
    return revision;
  }

  project(id: string, values: readonly ControlProjection[]): ControlCommit<ControlSession> {
    return this.commit((state, touched, now) => {
      const session = editSession(state, this.findSession(state, id));
      if (session.deletedAt !== undefined) throw new ControlStoreError('not_found', 'Session was deleted.');
      for (const value of values) {
        const key = value.type === 'message' ? `message:${value.id}` : 'queue';
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
      const record = edit(state.requests, this.findRequest(state, id));
      if (record.phase !== 'intent') throw new ControlStoreError('already_resolved', 'Request is already dispatched or terminal; never dispatch it twice.');
      if (record.session) { const session = this.findSession(state, record.session); if (session.state !== 'open') throw new ControlStoreError('invalid_request', 'Closed sessions cannot dispatch.'); touched.add(record.session); }
      record.phase = 'dispatch_intent'; return record;
    });
  }
  markSessionDeleted(requestId: string): ControlCommit<ControlSession> {
    return this.commit((state, touched, now) => {
      const request = edit(state.requests, this.findRequest(state, requestId));
      if (request.op !== 'session.delete' || request.phase !== 'intent' || !request.session) throw new ControlStoreError('invalid_request', 'Deletion requires its undispatched session request.');
      const session = this.findSession(state, request.session);
      const payload = canonicalRequestPayload({ v: 1, id: request.id, op: 'session.delete', session: session.id, params: {} });
      if (sha256(payload) !== request.identity.sha256 || Buffer.byteLength(payload) !== request.identity.bytes) throw new ControlStoreError('request_conflict', 'Deletion differs from its admitted payload.');
      request.phase = 'dispatch_intent';
      const tree = [session.id];
      for (let index = 0; index < tree.length; index++) for (const item of state.sessions) if (item.parent === tree[index] && !tree.includes(item.id)) tree.push(item.id);
      for (const id of tree) if (this.findSession(state, id).deletedAt === undefined) {
        const item = editSession(state, this.findSession(state, id));
        item.deletedAt = now; item.state = 'closed'; item.residency = 'evicted'; item.run = { ...item.run, state: 'idle' }; item.projections = [];
        touched.add(item.id);
      }
      return this.findSession(state, session.id);
    });
  }
  finishRequest(id: string, response: unknown): ControlCommit<Response> {
    response = structuredClone(response);
    return this.commit(state => {
      const record = edit(state.requests, this.findRequest(state, id));
      if (record.phase === 'terminal') throw new ControlStoreError('already_resolved', 'Request already has an outcome.');
      const parsed = this.parseResponse(record, response);
      if (parsed.outcome === 'accepted' && record.phase !== 'dispatch_intent') throw new ControlStoreError('invalid_request', 'An effectful request cannot succeed without a committed dispatch intent.');
      record.phase = 'terminal'; record.response = parsed; return parsed;
    });
  }
  putInteraction(value: unknown): ControlCommit<Interaction> {
    const interaction = parseInteraction(structuredClone(value));
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
    answer = structuredClone(answer);
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
      const answered = edit(state.requests, record);
      answered.phase = 'terminal'; answered.response = { v: 1, re: record.id, outcome: 'accepted', result: {} };
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
      const next = edit(state.continuations, item);
      next.phase = phase; next.updatedAt = now; touched.add(item.session); return next;
    });
  }
  putResource(value: unknown): ControlCommit<ControlState['resources'][number]> {
    const resource = parseSchema(ControlResourceSchema, value);
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
    }, true); } catch (error) { this.recoveryRequired = true; throw error; }
  }
  compact(): ControlCommit<void> { return this.commit((state, touched, now) => this.prune(state, now, touched)); }
  /** `deep` gives the change a fully editable copy, for changes that update rows in place. */
  private commit<T>(change: (state: ControlState, touched: Set<string>, now: number) => T, deep = false): ControlCommit<T> {
    this.file.assertCurrent();
    if (this.recoveryRequired) throw new ControlStoreError('storage_failure', 'Recover the persisted control state before admitting mutations.');
    const state = deep ? structuredClone(this.state) : draft(this.state); const touched = new Set<string>(); const now = this.time(state.clock);
    const value = change(state, touched, now); const revisions: Record<string, number> = Object.create(null) as Record<string, number>;
    for (const id of touched) {
      const session = editSession(state, this.findSession(state, id));
      session.revision++; session.updatedAt = now; revisions[id] = session.revision;
    }
    state.clock = now;
    this.persist(state); this.state = state;
    return { value: structuredClone(value), revisions };
  }
  /**
   * Writes the rows whose committed object, data or position changed. Changed rows are validated individually;
   * cross-row references are rechecked for every row because a change can invalidate rows that refer to it.
   * A session whose committed object is unchanged also has unchanged projections, which are not visited.
   */
  private persist(state: ControlState): void {
    const upserts: [ControlTable, ControlRow][] = []; const deletes: [ControlTable, string][] = [];
    const applied: (() => void)[] = []; const replaced = new Set<string>(); const installed: object[] = [];
    let ord = this.maxOrd;
    /** `key` indexes `previous`; `storedId` maps it to the database row ID. */
    const visit = (table: ControlTable, key: string, storedId: (key: string) => string, row: object, previous: Map<string, PersistedRow>, last: number, value: () => object): number => {
      const old = previous.get(key);
      // A row keeps its position unless the array moved it ahead of a row stored after it.
      const position = old && old.ord > last ? old.ord : ++ord;
      if (old?.row === row && old.ord === position) return position;
      let data = old?.data;
      if (old?.row !== row) {
        const stored = value(); data = JSON.stringify(stored);
        if (data !== old?.data) assertControlRow(table, stored);
        replaced.add(`${table}:${key}`); installed.push(row);
      }
      if (old?.ord !== position || data !== old.data) upserts.push([table, { id: storedId(key), ord: position, data: data! }]);
      const entry = { ord: position, data: data!, row };
      applied.push(() => previous.set(key, entry));
      return position;
    };
    const same = (key: string) => key;
    const sweep = (table: ControlTable, previous: Map<string, PersistedRow>, present: ReadonlySet<string>, storedId = same) => {
      for (const key of previous.keys()) if (!present.has(key)) {
        deletes.push([table, storedId(key)]);
        applied.push(() => { previous.delete(key); if (table === 'sessions') this.transientRevisionCeilings.delete(key); });
      }
    };
    for (const table of ROW_TABLES) {
      const previous = this.persisted.rows[table]; const present = new Set<string>(); let last = 0;
      for (const row of state[table] as { id: string }[]) {
        if (present.has(row.id)) throw new ControlStoreError('storage_failure', 'Duplicate control identities.');
        present.add(row.id);
        last = visit(table, row.id, same, row, previous, last, () => table === 'sessions' ? this.durableSession(row as ControlSession) : row);
      }
      sweep(table, previous, present);
    }
    const sessions = new Map(state.sessions.map(session => [session.id, session]));
    for (const session of state.sessions) {
      if (this.persisted.rows.sessions.get(session.id)?.row === session) continue;
      let previous = this.persisted.projections.get(session.id);
      if (!previous) { const created = previous = new Map<string, PersistedRow>(); applied.push(() => this.persisted.projections.set(session.id, created)); }
      const present = new Set<string>(); let last = 0; const storedId = (key: string) => JSON.stringify([session.id, key]);
      for (const record of session.projections) {
        present.add(record.key);
        last = visit('projections', record.key, storedId, record, previous, last, () => record);
      }
      sweep('projections', previous, present, storedId);
    }
    for (const [id, previous] of this.persisted.projections) if (!sessions.has(id)) {
      for (const key of previous.keys()) deletes.push(['projections', JSON.stringify([id, key])]);
      applied.push(() => this.persisted.projections.delete(id));
    }
    const lookup = (id: string) => sessions.get(id);
    if (state.requests.some(request => !this.validRequest(state, request, replaced.has(`requests:${request.id}`), lookup))) throw new ControlStoreError('storage_failure', 'Invalid durable request state.');
    if (state.interactions.some(interaction => !this.validInteraction(state, interaction, replaced.has(`interactions:${interaction.id}`), lookup))) throw new ControlStoreError('storage_failure', 'Interaction scope mismatch.');
    if (state.continuations.some(item => !this.validContinuation(state, item))) throw new ControlStoreError('storage_failure', 'Continuation lacks a committed winning answer.');
    if (state.sessions.some(session => !this.validSession(state, session, replaced.has(`sessions:${session.id}`), lookup))) throw new ControlStoreError('storage_failure', 'Session metadata or root lineage is inconsistent.');
    if (state.resources.some(resource => sessions.get(resource.session)?.root !== resource.root)) throw new ControlStoreError('storage_failure', 'Resource scope mismatch.');
    // An unchanged state skips the synchronous transaction; its clock advance is never needed below a row's timestamp.
    if (upserts.length || deletes.length || !this.initialized) {
      this.file.write({ meta: { namespace: state.namespace, agentDir: state.agentDir, clock: state.clock }, upserts, deletes });
      this.initialized = true;
    }
    for (const apply of applied) apply();
    this.maxOrd = ord;
    for (const row of installed) freeze(row);
  }
  /** The stored session row: metadata only, with any reserved transient revision ceiling. */
  private durableSession(session: ControlSession): ControlSessionMetadata {
    const { projections: _projections, ...metadata } = session;
    const ceiling = this.transientRevisionCeilings.get(session.id);
    return ceiling !== undefined && ceiling > session.revision ? { ...metadata, revision: ceiling } : metadata;
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
    repaired.resources = repaired.resources.filter(resource => this.validResource(repaired, resource));
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
  /** `structural` rechecks the record itself; unchanged committed records only need their references checked. */
  private validRequest(state: ControlState, request: ControlRequest, structural = true, lookup = (id: string) => state.sessions.find(item => item.id === id)): boolean {
    try {
      if (structural) {
        if (!Object.hasOwn(OPERATION_CATALOG, request.op) || OPERATION_CATALOG[request.op as Operation].storage !== 'durable' || request.retainUntil < requestRetainUntil(request.id, request.admittedAt) || (request.phase === 'terminal') !== (request.response !== undefined)) return false;
        if (request.response) this.parseResponse(request, request.response);
      }
      return !request.session || lookup(request.session) !== undefined;
    } catch { return false; }
  }
  private validInteraction(state: ControlState, interaction: Interaction, structural = true, lookup = (id: string) => state.sessions.find(item => item.id === id)): boolean {
    try {
      if (structural) parseInteraction(interaction);
      return interaction.scope.kind !== 'session' || lookup(interaction.scope.session)?.root === interaction.scope.root;
    } catch { return false; }
  }
  private validContinuation(state: ControlState, item: ControlContinuation): boolean {
    const interaction = state.interactions.find(candidate => candidate.id === item.interaction);
    return !!interaction && interaction.state === 'answered' && !!interaction.deferrable && interaction.scope.kind === 'session' && interaction.scope.session === item.session
      && state.sessions.some(session => session.id === item.session);
  }
  private validSession(state: ControlState, session: ControlSession, structural = true, lookup = (id: string) => state.sessions.find(item => item.id === id)): boolean {
    const execution = session.execution;
    if (execution && (!session.parent || !!execution.completedAt !== !!execution.outcome || execution.completionPending && !execution.completedAt)) return false;
    if (session.deletedAt !== undefined && (session.state !== 'closed' || session.residency !== 'evicted' || session.run.state !== 'idle')) return false;
    if (structural && (session.projections.length > CONTROL_LIMITS.projections || new Set(session.projections.map(item => item.key)).size !== session.projections.length)) return false;
    const path = new Set<string>();
    let ancestor: ControlSession | undefined = session;
    for (;;) {
      if (path.has(ancestor.id) || ancestor.root !== session.root) return false;
      path.add(ancestor.id);
      if (ancestor.parent === undefined) return ancestor.id === session.root;
      ancestor = lookup(ancestor.parent);
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
      const retained = session.projections.filter(item => item.updatedAt + CONTROL_LIMITS.projectionAgeMs >= now || item.value.type === 'queue');
      if (retained.length === session.projections.length) continue;
      editSession(state, session).projections = retained; touched.add(session.id);
    }
  }
  private trimProjections(session: ControlSession): void {
    while (session.projections.length > CONTROL_LIMITS.projections) {
      const at = session.projections.findIndex(item => item.value.type === 'message');
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

function emptyRows(): PersistedRows {
  return { rows: Object.fromEntries(ROW_TABLES.map(table => [table, new Map()])) as PersistedRows['rows'], projections: new Map() };
}
function storedRows(stored: StoredControl): PersistedRows {
  const persisted = emptyRows();
  for (const table of ROW_TABLES) for (const row of stored.rows[table]) persisted.rows[table].set(row.id, { ord: row.ord, data: row.data });
  for (const row of stored.rows.projections) {
    const [session, key] = JSON.parse(row.id) as [string, string];
    const projections = persisted.projections.get(session) ?? new Map<string, PersistedRow>();
    persisted.projections.set(session, projections.set(key, { ord: row.ord, data: row.data }));
  }
  return persisted;
}
function maxOrd(stored: StoredControl): number {
  return CONTROL_TABLES.reduce((max, table) => stored.rows[table].reduce((value, row) => Math.max(value, row.ord), max), 0);
}
/** The whole-state shape `parseControlState` validates; undefined when a row is not JSON. */
function assemble(stored: StoredControl): unknown {
  try {
    const projections = new Map<string, unknown[]>();
    for (const row of stored.rows.projections) {
      const [session] = JSON.parse(row.id) as [string, string];
      projections.set(session, [...projections.get(session) ?? [], JSON.parse(row.data) as unknown]);
    }
    const rows = (table: typeof ROW_TABLES[number]) => stored.rows[table].map(row => JSON.parse(row.data) as Record<string, unknown>);
    return { version: 1, namespace: stored.meta.namespace, agentDir: stored.meta.agentDir, clock: stored.meta.clock,
      sessions: rows('sessions').map(session => ({ ...session, projections: projections.get(session.id as string) ?? [] })),
      requests: rows('requests'), interactions: rows('interactions'), continuations: rows('continuations'), resources: rows('resources') };
  } catch { return undefined; }
}
/** Shares every committed row with a commit; `edit` and `editSession` replace a row before it is changed. */
function draft(state: ControlState): ControlState {
  return { ...state, sessions: [...state.sessions], requests: [...state.requests], interactions: [...state.interactions], continuations: [...state.continuations], resources: [...state.resources] };
}
/** Replaces a committed (frozen) row with an editable shallow copy; nested values stay frozen and must be replaced, not mutated. */
function edit<T extends object>(rows: T[], row: T): T {
  if (!Object.isFrozen(row)) return row;
  const copy = { ...row }; rows[rows.indexOf(row)] = copy; return copy;
}
function editSession(state: ControlState, session: ControlSession): ControlSession {
  if (!Object.isFrozen(session)) {
    if (Object.isFrozen(session.projections)) session.projections = [...session.projections];
    return session;
  }
  const copy = { ...session, projections: [...session.projections] }; state.sessions[state.sessions.indexOf(session)] = copy; return copy;
}
/** Committed rows are deep-frozen; the table arrays are not, so the store can replace rows outside a commit. */
function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
}
function metadataCopy(session: ControlSession): ControlSessionMetadata {
  const { projections: _projections, ...metadata } = session;
  return structuredClone(metadata);
}
