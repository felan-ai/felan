import { join } from 'node:path';
import { Type } from 'typebox';
import { CONTROL_LIMITS, CONTROL_REQUEST_BUDGET, ControlAdoptionSchema, ControlResourceSchema, ControlSessionSchema, ControlStateSchema, ControlStoreError, SessionProfileSchema, type ControlAdoption, type ControlContinuation, type ControlProjection, type ControlRequest, type ControlSession, type ControlState, type SessionProfile } from './control-state.js';
import { AtomicControlFile, sha256, type PersistenceBoundary } from './persistence.js';
import type { DaemonOwnership } from './ownership.js';
import { recoverControlState, type RecoveryPlan } from './control-recovery.js';
import { IdSchema, LIMITS, OPERATION_CATALOG, parseClientEnvelope, canonicalRequestPayload, parseInteraction, parseSchema, parseServerEnvelope, requestRetainUntil, validateInteractionAnswer, type Interaction, type InteractionAnswer, type Response, type Operation, type OperationParams } from '@felan-ai/session-protocol';

const outcomeReserve = CONTROL_REQUEST_BUDGET.outcome;
const safetyOperations = new Set<Operation>(['cancel', 'agents.cancel', 'interaction.answer', 'processes.stop', 'host.stop', 'host.restart', 'close']);
export interface ControlCapacity { bytes: number; reserveBytes: number; requests: number; sessionRequests: number; reserveRequests: number }
export interface ControlStoreOptions {
  directory?: string;
  now?: () => number;
  capacity?: Partial<ControlCapacity>;
  fault?: (boundary: PersistenceBoundary) => void;
}
export interface ControlCommit<T> { value: T; revisions: Record<string, number> }

export class DaemonControlStore {
  readonly directory: string;
  private readonly file: AtomicControlFile;
  private state: ControlState;
  private readonly now: () => number;
  private readonly capacity: ControlCapacity;
  private recoveryRequired = false;
  constructor(readonly owner: DaemonOwnership, options: ControlStoreOptions = {}) {
    this.now = options.now ?? Date.now;
    this.capacity = { bytes: CONTROL_LIMITS.bytes, reserveBytes: CONTROL_LIMITS.reserveBytes, requests: CONTROL_LIMITS.requests, sessionRequests: CONTROL_LIMITS.sessionRequests, reserveRequests: CONTROL_LIMITS.reserveRequests, ...options.capacity };
    for (const key of Object.keys(this.capacity) as (keyof ControlCapacity)[]) {
      if (!Number.isSafeInteger(this.capacity[key]) || this.capacity[key] < 0 || this.capacity[key] > CONTROL_LIMITS[key]) throw new ControlStoreError('invalid_request', 'Capacity may only lower a published bound.');
    }
    if (this.capacity.requests <= this.capacity.reserveRequests || this.capacity.bytes <= this.capacity.reserveBytes) throw new ControlStoreError('invalid_request', 'Capacity must leave room for ordinary admissions.');
    if (this.capacity.reserveBytes < CONTROL_LIMITS.reserveBytes) throw new ControlStoreError('invalid_request', 'Emergency capacity must cover a complete request, outcome and commit bookkeeping.');
    this.file = new AtomicControlFile(owner, options.directory ?? join(owner.target.agentDir, 'daemon-control-v1'), options.fault);
    this.directory = this.file.directory;
    try {
      const raw = this.file.read();
      this.state = raw === null ? { version: 1, namespace: owner.target.namespaceId, agentDir: owner.target.agentDir, clock: this.time(0), sessions: [], requests: [], interactions: [], continuations: [], resources: [], adoptions: [] } : this.validate(raw);
      if (this.state.namespace !== owner.target.namespaceId || this.state.agentDir !== owner.target.agentDir) throw new Error('identity');
      if (raw === null) this.file.write(this.state, this.capacity.bytes);
      else this.recoveryRequired = true;
    } catch { this.file.close(); throw new ControlStoreError('storage_failure', 'Control state is invalid or belongs to another namespace; no automatic migration is allowed.'); }
  }
  close(): void { this.file.close(); }
  get needsRecovery(): boolean { return this.recoveryRequired; }
  snapshot(): ControlState { this.file.assertCurrent(); return structuredClone(this.state); }
  session(id: string): ControlSession { this.file.assertCurrent(); return structuredClone(this.findSession(this.state, id)); }
  createSession(input: Omit<ControlSession, 'revision' | 'updatedAt' | 'projections'>): ControlCommit<ControlSession> {
    const session = parseSchema(ControlSessionSchema, { ...input, revision: 0, updatedAt: this.time(this.state.clock), projections: [] });
    if (session.deletedAt !== undefined) throw new ControlStoreError('invalid_request', 'Only explicit deletion can create a tombstone.');
    session.piPath = this.owner.assertOwnsPath(session.piPath);
    if (this.state.sessions.some(item => item.id === session.id || item.piPath === session.piPath)) throw new ControlStoreError('request_conflict', 'Session identity or transcript path is already registered.');
    return this.commit((state, touched) => { state.sessions.push(session); touched.add(session.id); return session; });
  }
  updateSession(id: string, patch: Partial<Pick<ControlSession, 'state' | 'residency' | 'run' | 'policy' | 'title' | 'branch' | 'observedTip' | 'model' | 'thinking'>>): ControlCommit<ControlSession> {
    const old = this.session(id);
    if (old.deletedAt !== undefined) throw new ControlStoreError('not_found', 'Session was deleted.');
    const next = parseSchema(ControlSessionSchema, { ...old, ...patch });
    if (old.state === 'closed' && next.state !== 'closed') throw new ControlStoreError('invalid_request', 'A closed session cannot be reopened implicitly.');
    if ((old.policy.effective === 'acp-strict' && next.policy.effective !== 'acp-strict') || next.policy.generation < old.policy.generation ||
      (old.policy.pending && next.policy.effective !== 'acp-strict' && !next.policy.pending)) throw new ControlStoreError('invalid_request', 'Session policy may only tighten.');
    if (JSON.stringify(old.policy) !== JSON.stringify(next.policy) && next.policy.generation <= old.policy.generation) throw new ControlStoreError('invalid_request', 'A policy change must advance its generation.');
    return this.commit((state, touched) => { const at = state.sessions.findIndex(item => item.id === id); state.sessions[at] = next; touched.add(id); return next; });
  }
  configureSession(requestId: string, values: OperationParams<'config.set'>['values'], overrides: NonNullable<SessionProfile['extensionConfigOverrides']>): ControlCommit<ControlSession> {
    return this.commit((state, touched) => {
      const request = this.findRequest(state, requestId);
      if (request.op !== 'config.set' || request.phase !== 'intent' || !request.session) throw new ControlStoreError('invalid_request', 'Session configuration requires an undispatched session request.');
      const session = this.findSession(state, request.session);
      const payload = canonicalRequestPayload({ v: 1, id: requestId, op: 'config.set', session: session.id, params: { scope: 'session', values } }, { checkFreshness: false });
      if (sha256(payload) !== request.identity.sha256 || Buffer.byteLength(payload) !== request.identity.bytes) throw new ControlStoreError('request_conflict', 'Configuration differs from its admitted payload.');
      if (session.parent || session.state !== 'open' || !['idle', 'interrupted'].includes(session.run.state)) throw new ControlStoreError('invalid_request', 'Session configuration requires a quiescent open root.');
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
    }, true);
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
    }, true);
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
    const request = parseClientEnvelope(value, { checkFreshness: false });
    if (OPERATION_CATALOG[request.op].storage !== 'durable') throw new ControlStoreError('invalid_request', 'Only durable mutations have control request records.');
    const payload = canonicalRequestPayload(request, { checkFreshness: false });
    const identity = { sha256: sha256(payload), bytes: Buffer.byteLength(payload) };
    const previous = this.state.requests.find(item => item.id === request.id);
    if (previous) {
      if (previous.principal !== principal || previous.identity.sha256 !== identity.sha256 || previous.identity.bytes !== identity.bytes) throw new ControlStoreError('request_conflict', 'Request ID was already used by another principal or payload.');
      return { value: structuredClone(previous), revisions: {} };
    }
    const now = this.time(this.state.clock);
    parseClientEnvelope(request, { now });
    const session = request.op === 'session.adopt' ? undefined : request.session;
    if (session) {
      const target = this.findSession(this.state, session);
      if (target.deletedAt !== undefined && request.op !== 'session.delete') throw new ControlStoreError('not_found', 'Session was deleted.');
    }
    const safety = safetyOperations.has(request.op);
    const record: ControlRequest = { id: request.id, principal, ...(session ? { session } : {}), op: request.op, admittedAt: now, retainUntil: requestRetainUntil(request.id, now), identity, phase: 'intent' };
    return this.commit((state, touched) => {
      this.prune(state, now, touched);
      const sessionReserve = Math.min(this.capacity.reserveRequests, Math.max(0, this.capacity.sessionRequests - 1));
      if (state.requests.length >= this.capacity.requests - (safety ? 0 : this.capacity.reserveRequests) || state.requests.filter(item => item.session === session).length >= this.capacity.sessionRequests - (safety ? 0 : sessionReserve)) throw new ControlStoreError('request_capacity', 'Request capacity reached; retry after the retention window.');
      state.requests.push(record); return record;
    }, safety);
  }
  markDispatched(id: string): ControlCommit<ControlRequest> {
    return this.commit((state, touched) => {
      const record = this.findRequest(state, id);
      if (record.phase !== 'intent') throw new ControlStoreError('already_resolved', 'Request is already dispatched or terminal; never dispatch it twice.');
      if (record.session) { const session = this.findSession(state, record.session); if (session.state !== 'open') throw new ControlStoreError('invalid_request', 'Closed sessions cannot dispatch.'); touched.add(record.session); }
      record.phase = 'dispatch_intent'; return record;
    }, true);
  }
  markSessionDeleted(requestId: string, expectedRevision: number): ControlCommit<ControlSession> {
    return this.commit((state, touched, now) => {
      const request = this.findRequest(state, requestId);
      if (request.op !== 'session.delete' || request.phase !== 'intent' || !request.session) throw new ControlStoreError('invalid_request', 'Deletion requires its undispatched session request.');
      const session = this.findSession(state, request.session);
      const payload = canonicalRequestPayload({ v: 1, id: request.id, op: 'session.delete', session: session.id, params: { confirmed: true, expectedRevision } }, { checkFreshness: false });
      if (sha256(payload) !== request.identity.sha256 || Buffer.byteLength(payload) !== request.identity.bytes) throw new ControlStoreError('request_conflict', 'Deletion differs from its admitted payload.');
      if (session.revision !== expectedRevision) throw Object.assign(new Error('Deletion revision changed.'), { code: 'stale_request' });
      const descendants = new Set([session.id]);
      for (let previous = -1; previous !== descendants.size;) {
        previous = descendants.size;
        for (const child of state.sessions) if (child.parent && descendants.has(child.parent)) descendants.add(child.id);
      }
      if (session.state !== 'closed' || session.residency !== 'evicted' || session.run.state !== 'idle'
        || state.sessions.some(child => child.id !== session.id && descendants.has(child.id) && child.state === 'open')
        || state.requests.some(other => other.id !== request.id && other.session && descendants.has(other.session) && other.phase !== 'terminal')
        || state.resources.some(resource => (descendants.has(resource.session) || session.root === session.id && resource.root === session.id) && ['running', 'reconciling'].includes(resource.state))
        || state.interactions.some(item => item.scope.kind === 'session' && descendants.has(item.scope.session) && ['waiting', 'deferred'].includes(item.state))
        || state.continuations.some(item => descendants.has(item.session) && ['ready', 'dispatch_intent'].includes(item.phase))) {
        throw Object.assign(new Error('Deletion requires a closed, evicted and settled session tree.'), { code: 'busy' });
      }
      request.phase = 'dispatch_intent';
      if (session.deletedAt === undefined) { session.deletedAt = now; session.projections = []; touched.add(session.id); }
      return session;
    });
  }
  finishRequest(id: string, response: unknown): ControlCommit<Response> {
    return this.commit(state => {
      const record = this.findRequest(state, id);
      if (record.phase === 'terminal') throw new ControlStoreError('already_resolved', 'Request already has an outcome.');
      const parsed = this.safeResponse(record, response);
      if (parsed.outcome === 'accepted' && record.phase !== 'dispatch_intent') throw new ControlStoreError('invalid_request', 'An effectful request cannot succeed without a committed dispatch intent.');
      record.phase = 'terminal'; record.response = parsed; return parsed;
    }, true);
  }
  putInteraction(value: unknown): ControlCommit<Interaction> {
    const interaction = parseInteraction(value);
    if (interaction.state !== 'waiting') throw new ControlStoreError('invalid_request', 'New interactions must be waiting.');
    // OAuth URLs and transient credentials never belong in the control snapshot.
    if (interaction.request.kind === 'oauth') throw new ControlStoreError('invalid_request', 'OAuth presentation must stay transient; persist only its interrupted operation outcome.');
    if (Buffer.byteLength(JSON.stringify(interaction)) + LIMITS.answerBytes + 1024 > LIMITS.interactionBytes) throw new ControlStoreError('request_capacity', 'Interaction must leave room for its maximum valid answer and terminal metadata.');
    return this.commit((state, touched) => {
      if (state.interactions.some(item => item.id === interaction.id)) throw new ControlStoreError('request_conflict', 'Interaction ID already exists.');
      if (interaction.scope.kind === 'session') { const session = this.findSession(state, interaction.scope.session); if (session.root !== interaction.scope.root) throw new ControlStoreError('invalid_request', 'Interaction root mismatch.'); touched.add(session.id); }
      state.interactions.push(interaction); return interaction;
    });
  }
  deferInteraction(id: string): ControlCommit<Interaction> {
    return this.commit((state, touched, now) => {
      const item = this.findInteraction(state, id);
      if (!['waiting', 'deferred'].includes(item.state) || item.request.kind !== 'ask_user') throw new ControlStoreError('invalid_request', 'Only a pending ask-user interaction is serializable across drain.');
      const next: Interaction = { ...item, state: 'deferred', expiresAt: item.expiresAt ?? now + 30 * 60 * 1000 };
      state.interactions[state.interactions.indexOf(item)] = next;
      if (item.scope.kind === 'session') touched.add(item.scope.session); return next;
    }, true);
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
    }, true);
  }
  answerInteraction(requestId: string, answer: InteractionAnswer | { cancelled: true; reason: 'user' }, kind: 'tui' | 'acp' | 'headless', continuationId?: string, responder?: string): ControlCommit<Interaction> {
    return this.commit((state, touched, now) => {
      const record = this.findRequest(state, requestId);
      if (record.op !== 'interaction.answer' || record.phase !== 'intent') throw new ControlStoreError('already_resolved', 'An answer requires its newly admitted request.');
      const candidates = state.interactions.filter(item => {
        const envelope = { v: 1, id: record.id, op: 'interaction.answer', ...(record.session ? { session: record.session } : {}), params: { interactionId: item.id, answer } };
        const payload = canonicalRequestPayload(envelope, { checkFreshness: false });
        return sha256(payload) === record.identity.sha256 && Buffer.byteLength(payload) === record.identity.bytes;
      });
      const item = candidates[0];
      if (!item || candidates.length !== 1) throw new ControlStoreError('request_conflict', 'Answer differs from admitted payload.');
      if (!item.eligibleClientKinds.includes(kind)) throw new ControlStoreError('invalid_request', 'Client is not eligible to answer.');
      if (item.state !== 'waiting' && item.state !== 'deferred') throw new ControlStoreError('already_resolved', 'Interaction already resolved.');
      if (item.expiresAt !== undefined && item.expiresAt <= now) throw new ControlStoreError('already_resolved', 'Interaction expired.');
      if ((item.scope.kind === 'session' ? item.scope.session : undefined) !== record.session) throw new ControlStoreError('request_conflict', 'Answer scope differs from interaction scope.');
      const next: Interaction = 'cancelled' in answer ? { ...item, state: 'cancelled', resolvedAt: now, result: answer } : { ...item, state: 'answered', responder: parseSchema(IdSchema, responder ?? record.principal), resolvedAt: now, result: validateInteractionAnswer(item, answer) };
      if (continuationId !== undefined) {
        if (next.state !== 'answered' || item.request.kind !== 'ask_user' || item.scope.kind !== 'session') throw new ControlStoreError('invalid_request', 'Only answered session ask-user prompts have replayable continuations.');
        if (state.continuations.some(item => item.id === continuationId || item.interaction === next.id)) throw new ControlStoreError('request_conflict', 'Continuation identity already exists.');
        state.continuations.push({ id: continuationId, interaction: item.id, session: item.scope.session, phase: 'ready', createdAt: now, updatedAt: now });
      }
      state.interactions[state.interactions.indexOf(item)] = next;
      record.phase = 'terminal'; record.response = { v: 1, re: record.id, outcome: 'accepted', result: {} };
      if (item.scope.kind === 'session') touched.add(item.scope.session); return next;
    }, true);
  }
  transitionContinuation(id: string, phase: 'dispatch_intent' | 'completed' | 'indeterminate'): ControlCommit<ControlContinuation> {
    return this.commit((state, touched, now) => {
      const item = state.continuations.find(item => item.id === id);
      if (!item) throw new ControlStoreError('not_found', 'Continuation not found.');
      if ((phase === 'dispatch_intent' && item.phase !== 'ready') || (phase !== 'dispatch_intent' && item.phase !== 'dispatch_intent')) throw new ControlStoreError('already_resolved', 'Continuation cannot transition or dispatch twice.');
      const session = this.findSession(state, item.session);
      if (phase === 'dispatch_intent' && session.state !== 'open') throw new ControlStoreError('invalid_request', 'Closed sessions cannot dispatch continuations.');
      item.phase = phase; item.updatedAt = now; touched.add(item.session); return item;
    }, true);
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
    }, true);
  }
  recordAdoption(value: unknown): ControlCommit<ControlAdoption> {
    const adoption = parseSchema(ControlAdoptionSchema, value);
    adoption.source = this.owner.assertOwnsPath(adoption.source); adoption.destination = this.owner.assertOwnsPath(adoption.destination);
    return this.commit(state => {
      const previous = state.adoptions.find(item => item.session === adoption.session || item.id === adoption.id);
      if (previous) {
        if (previous.id !== adoption.id || previous.source !== adoption.source || previous.destination !== adoption.destination || previous.fingerprint !== adoption.fingerprint || previous.cwd !== adoption.cwd || (previous.phase === 'complete' && adoption.phase !== 'complete')) throw new ControlStoreError('request_conflict', 'Adoption source or identity changed.');
        state.adoptions[state.adoptions.indexOf(previous)] = adoption;
      } else {
        if (adoption.phase !== 'copy_intent') throw new ControlStoreError('invalid_request', 'Adoption completion requires a durable copy intent.');
        state.adoptions.push(adoption);
      }
      return adoption;
    }, true);
  }
  recover(): ControlCommit<Omit<RecoveryPlan, 'changedSessions'>> {
    if (!this.recoveryRequired) throw new ControlStoreError('invalid_request', 'Recovery is only valid immediately after reopening persisted state.');
    this.recoveryRequired = false;
    try { return this.commit((state, touched, now) => {
      const { changedSessions, ...plan } = recoverControlState(state, now);
      for (const id of changedSessions) touched.add(id); return plan;
    }, true); } catch (error) { this.recoveryRequired = true; throw error; }
  }
  compact(): ControlCommit<void> { return this.commit((state, touched, now) => this.prune(state, now, touched), true); }
  private commit<T>(change: (state: ControlState, touched: Set<string>, now: number) => T, safety = false): ControlCommit<T> {
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
    const byteLimit = this.capacity.bytes - (safety ? 0 : this.capacity.reserveBytes);
    const reserved = parsed.requests.filter(item => item.phase !== 'terminal').length * outcomeReserve
      + parsed.interactions.filter(item => item.state === 'waiting' || item.state === 'deferred').length * (LIMITS.answerBytes + 1024);
    if (Buffer.byteLength(JSON.stringify(parsed)) + reserved + CONTROL_REQUEST_BUDGET.bookkeeping > byteLimit) throw new ControlStoreError('request_capacity', 'Control capacity is reserved for outcomes and safety operations.');
    this.file.write(parsed, byteLimit); this.state = parsed;
    return { value: structuredClone(value), revisions };
  }
  private safeResponse(record: ControlRequest, value: unknown): Response {
    const response = parseServerEnvelope(value, record.op as Operation) as Response;
    if (response.re !== record.id) throw new ControlStoreError('request_conflict', 'Response ID differs from request.');
    const safe: Response = response.outcome === 'accepted' ? response : { v: 1, re: response.re, outcome: response.outcome, error: { ...response.error, message: 'Operation did not complete. Inspect the current session before retrying.' } };
    if (Buffer.byteLength(JSON.stringify(safe)) > outcomeReserve) throw new ControlStoreError('invalid_request', 'Durable outcome exceeds its reserved capacity.');
    return safe;
  }
  private validate(value: unknown): ControlState {
    const state = parseSchema(ControlStateSchema, value) as ControlState;
    for (const key of ['sessions', 'requests', 'interactions', 'continuations', 'resources', 'adoptions'] as const) {
      const ids = state[key].map(item => item.id); if (new Set(ids).size !== ids.length) throw new ControlStoreError('storage_failure', 'Duplicate control identities.');
    }
    for (const request of state.requests) {
      const { response: _response, ...metadata } = request;
      if (Buffer.byteLength(JSON.stringify(metadata)) > CONTROL_REQUEST_BUDGET.metadata) throw new ControlStoreError('request_capacity', 'Request metadata exceeds its reserved capacity.');
      if (!Object.hasOwn(OPERATION_CATALOG, request.op) || OPERATION_CATALOG[request.op as Operation].storage !== 'durable' || request.retainUntil < requestRetainUntil(request.id, request.admittedAt) || (request.phase === 'terminal') !== (request.response !== undefined)) throw new ControlStoreError('storage_failure', 'Invalid durable request state.');
      if (request.response) request.response = this.safeResponse(request, request.response);
      if (request.session) this.findSession(state, request.session);
    }
    for (const interaction of state.interactions) {
      parseInteraction(interaction);
      if (interaction.scope.kind === 'session' && this.findSession(state, interaction.scope.session).root !== interaction.scope.root) throw new ControlStoreError('storage_failure', 'Interaction scope mismatch.');
      if (interaction.request.kind === 'oauth') throw new ControlStoreError('storage_failure', 'OAuth credentials cannot be durable control state.');
    }
    for (const item of state.continuations) {
      const interaction = this.findInteraction(state, item.interaction);
      if (interaction.state !== 'answered' || interaction.request.kind !== 'ask_user' || interaction.scope.kind !== 'session' || interaction.scope.session !== item.session) throw new ControlStoreError('storage_failure', 'Continuation lacks a committed winning answer.');
      this.findSession(state, item.session);
    }
    for (const session of state.sessions) {
      if (session.deletedAt !== undefined && (session.state !== 'closed' || session.residency !== 'evicted' || session.run.state !== 'idle')) throw new ControlStoreError('storage_failure', 'A deleted session must remain closed, evicted and idle.');
      if (this.owner.assertOwnsPath(session.piPath) !== session.piPath) throw new ControlStoreError('storage_failure', 'Persisted transcript path changed canonical identity.');
      if (new Set(session.projections.map(item => item.key)).size !== session.projections.length) throw new ControlStoreError('storage_failure', 'Duplicate projections.');
      if (session.parent === session.id || (session.parent === undefined ? session.root !== session.id : this.findSession(state, session.parent).root !== session.root)) throw new ControlStoreError('storage_failure', 'Session root lineage mismatch.');
    }
    for (const resource of state.resources) {
      if (resource.reference && this.owner.assertOwnsPath(resource.reference) !== resource.reference) throw new ControlStoreError('storage_failure', 'Persisted resource path changed canonical identity.');
      if (this.findSession(state, resource.session).root !== resource.root) throw new ControlStoreError('storage_failure', 'Resource scope mismatch.');
    }
    for (const adoption of state.adoptions) {
      if (this.owner.assertOwnsPath(adoption.source) !== adoption.source || this.owner.assertOwnsPath(adoption.destination) !== adoption.destination) throw new ControlStoreError('storage_failure', 'Persisted adoption path changed canonical identity.');
    }
    return state;
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
