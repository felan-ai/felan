import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as wait } from 'node:timers/promises';
import {
  CONTROL_VERSION, LIMITS, OPERATION_CATALOG, PROTOCOL_VERSION, canonicalRequestPayload, encodeFrame,
  parseClientEnvelope, parseControlRequest, parseControlResponse, parseServerEnvelope, validateClientEligibility,
  validateRequestId, type ClientEnvelope, type ControlRequest, type ControlResponse, type DaemonIdentity, type Interaction,
  type Operation, type OperationParams, type OperationResult, type PresentationEvent, type Response, type ResponseFor,
} from '@felan-ai/session-protocol';
import { spawnDetachedDaemon } from '@felan-ai/daemon/internal/daemon/supervisor';
import { assertTargetIdentity, protocolTarget, resolveDaemonTarget, type DaemonTarget, type ResolvedDaemonTarget } from '@felan-ai/daemon/internal/daemon/target';
import { createSessionState, reduceSession, type SessionState } from './reducer.js';
import { localConnector, type ClientTransport, type TransportConnector } from './transport.js';

export function newRequestId(now = Date.now()): string {
  if (!Number.isSafeInteger(now) || now < 0 || now > 0xffffffffffff) throw new Error('Invalid request timestamp');
  const bytes = randomBytes(16);
  bytes.writeUIntBE(now, 0, 6);
  bytes[6] = (bytes[6]! & 15) | 0x70;
  bytes[8] = (bytes[8]! & 63) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export type RequestState =
  | { status: 'pending'; id: string; op: Operation; attempts: number }
  | { status: 'accepted' | 'rejected' | 'indeterminate'; id: string; op: Operation; attempts: number; response: Response };
export interface AttachmentState {
  readonly id: string;
  readonly session: string;
  readonly requirePolicy?: 'acp-strict';
  readonly policyWaitMs?: number;
  readonly binding?: string;
  readonly state: SessionState;
}
export interface SessionClientOptions {
  target: DaemonTarget;
  clientVersion: string;
  expectedDaemonVersion?: string;
  kind: OperationParams<'hello'>['kind'];
  interactionKinds?: OperationParams<'hello'>['interactionKinds'];
  presenters?: OperationParams<'hello'>['presenters'];
  expected?: DaemonIdentity;
  connector?: TransportConnector;
  launch?: { entrypoint: string; timeoutMs?: number; replacing?: DaemonIdentity };
  requestTimeoutMs?: number;
  retries?: number;
  reconnectAttempts?: number;
  reconnectDelayMs?: number;
}
interface Pending {
  envelope: ClientEnvelope;
  payload: string;
  bytes: number;
  attempts: number;
  response?: Response;
  timer?: ReturnType<typeof setTimeout> | undefined;
  resolve: (response: Response) => void;
  promise: Promise<Response>;
  internal: boolean;
  localAttachmentId: string | undefined;
}
const failure = (id: string, outcome: 'rejected' | 'indeterminate', code: string, message: string): Response =>
  ({ v: 1, re: id, outcome, error: { code, message, retryable: false } });

export class SessionClient {
  readonly target: ResolvedDaemonTarget;
  private readonly connector: TransportConnector;
  private readonly timeout: number;
  private readonly retries: number;
  private readonly reconnectLimit: number;
  private readonly delay: number;
  private transport: ClientTransport | undefined;
  private connecting: Promise<OperationResult<'hello'>> | undefined;
  private epoch = 0;
  private closed = false;
  private readonly lifetime = new AbortController();
  private reconnectCount = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private records = new Map<string, Pending>();
  private attachments = new Map<string, AttachmentState>();
  private readonly interactionNotifications = new Map<string, Interaction>();
  private queuedInteractions: Interaction[] = [];
  private queuedInteractionBytes = 0;
  private recovering = new Set<string>();
  private listeners = new Set<() => void>();
  private readonly presentationListeners = new Set<(event: PresentationEvent) => void>();
  private readonly presentationSequences = new Map<string, Map<string, number>>();
  private pinned: DaemonIdentity | undefined;
  private negotiated: OperationResult<'hello'> | undefined;
  private connectionState: 'disconnected' | 'connecting' | 'ready' | 'incompatible' | 'blocked' | 'closed' = 'disconnected';

  constructor(private readonly options: SessionClientOptions) {
    this.options = { ...options, target: structuredClone(options.target),
      ...(options.launch ? { launch: structuredClone(options.launch) } : {}),
      interactionKinds: [...(options.interactionKinds ?? [])], presenters: structuredClone(options.presenters ?? []) };
    this.target = resolveDaemonTarget(options.target);
    if (options.expectedDaemonVersion !== undefined && (!options.expectedDaemonVersion || Buffer.byteLength(options.expectedDaemonVersion) > 128)) throw new Error('Invalid expected daemon version.');
    this.connector = options.connector ?? localConnector(this.target);
    this.pinned = options.expected && structuredClone(options.expected);
    if (this.pinned) assertTargetIdentity(this.target, this.pinned, this.pinned);
    this.timeout = bounded(options.requestTimeoutMs ?? 5_000, 1, 60_000);
    this.retries = bounded(options.retries ?? 2, 0, 5);
    this.reconnectLimit = bounded(options.reconnectAttempts ?? 3, 0, 5);
    this.delay = bounded(options.reconnectDelayMs ?? 100, 0, 10_000);
  }

  get status() { return this.connectionState; }
  get identity() { return this.pinned && structuredClone(this.pinned); }
  get capabilities() { return this.negotiated && structuredClone(this.negotiated); }
  getInteractions(options: { includeSessions?: boolean } = {}): readonly Interaction[] {
    const items = new Map(this.interactionNotifications);
    if (options.includeSessions) for (const attachment of this.attachments.values()) {
      if (attachment.state.status !== 'live') continue;
      for (const item of attachment.state.snapshot?.interactions ?? []) {
        if (item.state === 'waiting' || item.state === 'deferred') items.set(item.id, item);
      }
    }
    return structuredClone([...items.values()]);
  }
  getAttachment(session: string): AttachmentState | undefined { return structuredClone(this.attachments.get(session)); }
  getRequest(id: string): RequestState | undefined {
    const record = this.records.get(id) ?? this.records.get(id.toLowerCase());
    return record && (record.response ? { status: record.response.outcome, id: record.envelope.id, op: record.envelope.op, attempts: record.attempts, response: structuredClone(record.response) }
      : { status: 'pending', id: record.envelope.id, op: record.envelope.op, attempts: record.attempts });
  }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  subscribePresentation(listener: (event: PresentationEvent) => void): () => void {
    this.presentationListeners.add(listener); return () => this.presentationListeners.delete(listener);
  }
  private emit() { for (const listener of this.listeners) { try { listener(); } catch { /* Observers cannot interrupt protocol processing. */ } } }

  private connectTransport(receiver: Parameters<TransportConnector>[0]): Promise<ClientTransport> {
    if (this.closed) return Promise.reject(new Error('Client is closed'));
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error?: unknown, transport?: ClientTransport) => {
        if (settled) { transport?.close(); return; }
        settled = true; clearTimeout(timer); this.lifetime.signal.removeEventListener('abort', onClose);
        if (transport) resolve(transport); else reject(error);
      };
      const onClose = () => finish(new Error('Client is closed'));
      const timer = setTimeout(() => finish(new Error('Connection deadline exceeded')), this.timeout);
      this.lifetime.signal.addEventListener('abort', onClose, { once: true });
      try { void this.connector(receiver).then(transport => finish(undefined, transport), error => finish(error)); }
      catch (error) { finish(error); }
    });
  }

  private whileOpen<T>(operation: Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      const onClose = () => reject(new Error('Client is closed'));
      if (this.closed) onClose();
      else this.lifetime.signal.addEventListener('abort', onClose, { once: true });
      void operation.then(resolve, reject).finally(() => this.lifetime.signal.removeEventListener('abort', onClose));
    });
  }

  connect(): Promise<OperationResult<'hello'>> {
    if (!this.connecting) {
      clearTimeout(this.reconnectTimer);
      this.reconnectCount = 0;
    }
    return this.connectShared();
  }

  private connectShared(): Promise<OperationResult<'hello'>> {
    if (this.closed) return Promise.reject(new Error('Client is closed'));
    if (this.connecting) return this.connecting;
    if (this.connectionState === 'ready') return Promise.resolve(structuredClone(this.negotiated!));
    this.connecting = this.open().finally(() => { this.connecting = undefined; });
    return this.connecting;
  }

  private async open(): Promise<OperationResult<'hello'>> {
    this.queuedInteractions = []; this.queuedInteractionBytes = 0;
    this.connectionState = 'connecting'; this.negotiated = undefined; this.emit();
    const epoch = ++this.epoch;
    const receiver = { frame: (value: unknown) => { if (epoch === this.epoch) this.receive(value); },
      closed: (reason: string) => { if (epoch === this.epoch) this.lost(reason); } };
    try {
      try { this.transport = await this.connectTransport(receiver); }
      catch (error) {
        if (this.closed) throw new Error('Client is closed');
        const code = (error as { code?: string }).code;
        if (this.pinned || !this.options.launch || !['ENOENT', 'stale_endpoint', 'unavailable'].includes(code ?? '')) throw error;
        try {
          const receipt = await this.whileOpen(spawnDetachedDaemon({ target: this.options.target, ...this.options.launch }));
          if (this.closed) throw new Error('Client is closed');
          assertTargetIdentity(this.target, receipt.identity, receipt.identity);
          this.pinned = receipt.identity;
        } catch (launchError) {
          if ((launchError as { code?: string }).code !== 'launch_failed') throw launchError;
          // A concurrent starter can win ownership while this launch exits.
          for (let attempt = 0; attempt < 3; attempt++) {
            if (attempt) await wait(this.delay, undefined, { signal: this.lifetime.signal });
            try { this.transport = await this.connectTransport(receiver); break; } catch { /* Retry only discovery, never the launch. */ }
          }
          if (!this.transport) throw launchError;
        }
        this.transport ??= await this.connectTransport(receiver);
      }
      if (this.closed || epoch !== this.epoch) { this.transport?.close(); throw new Error('Connection was superseded'); }
      const hello = await this.exchange('hello', { clientVersion: this.options.clientVersion, protocol: PROTOCOL_VERSION,
        kind: this.options.kind, interactionKinds: this.options.interactionKinds ?? [], presenters: this.options.presenters ?? [],
        target: protocolTarget(this.target) }, undefined, undefined, true);
      if (this.closed || epoch !== this.epoch) throw new Error('Connection was superseded');
      if (hello.outcome !== 'accepted') throw new Error('Daemon handshake rejected');
      const result = hello.result;
      assertTargetIdentity(this.target, this.pinned ?? result.identity, result.identity);
      this.pinned = structuredClone(result.identity);
      if (this.options.expectedDaemonVersion && result.daemonVersion !== this.options.expectedDaemonVersion) {
        this.connectionState = 'incompatible';
        throw new Error('Daemon version differs from the installed package. Explicit restart is required.');
      }
      this.negotiated = structuredClone(result);
      for (const interaction of this.queuedInteractions) this.acceptInteraction(interaction);
      this.queuedInteractions = []; this.queuedInteractionBytes = 0;
      for (const attachment of this.attachments.values()) {
        if (this.closed || epoch !== this.epoch) throw new Error('Connection was superseded');
        await this.restore(attachment.session);
      }
      if (epoch !== this.epoch || this.closed) throw new Error('Connection was superseded');
      this.connectionState = 'ready';
      for (const record of this.records.values()) if (!record.internal && !record.response) this.transmit(record);
      this.emit();
      return structuredClone(result);
    } catch (error) {
      const status = this.connectionState as string;
      if (status !== 'incompatible' && !this.closed) this.connectionState = 'blocked';
      this.interactionNotifications.clear(); this.queuedInteractions = []; this.queuedInteractionBytes = 0;
      ++this.epoch; this.transport?.close(); this.transport = undefined;
      if (this.reconnectCount === 0) this.settleOutstanding('Connection could not be established');
      this.emit(); throw error;
    }
  }

  request<O extends Operation>(op: O, params: OperationParams<O>, options: { session?: string; id?: string } = {}): Promise<ResponseFor<O>> {
    if (op === 'hello' || op === 'attach' || op === 'detach') throw new Error('Use connect, attach or detach for connection bindings');
    return this.exchange(op, params, options.session, options.id, false);
  }

  private exchange<O extends Operation>(op: O, params: OperationParams<O>, session?: string, suppliedId?: string, internal = false): Promise<ResponseFor<O>> {
    const id = OPERATION_CATALOG[op].mutation ? (suppliedId ?? newRequestId()).toLowerCase() : suppliedId ?? randomUUID();
    const previous = this.records.get(id);
    const envelope = parseClientEnvelope({ v: 1, id, op, params, ...(session === undefined ? {} : { session }) }, { checkFreshness: previous === undefined });
    validateClientEligibility(envelope, this.options.kind);
    const canonical = canonicalRequestPayload(envelope, { checkFreshness: false });
    const payload = op === 'host.setup.answer' ? createHash('sha256').update(canonical).digest('hex') : canonical;
    if (previous) {
      if (previous.payload !== payload) return Promise.resolve(failure(id, 'rejected', 'request_conflict', 'Request ID already names a different command') as ResponseFor<O>);
      return previous.promise as Promise<ResponseFor<O>>;
    }
    const bytes = encodeFrame(envelope).byteLength;
    if (!internal && (this.connectionState !== 'ready' || !this.negotiated?.operations.includes(op))) {
      return Promise.resolve(failure(id, 'rejected', this.connectionState === 'ready' ? 'unsupported_operation' : 'unavailable', 'Operation is not available on this connection') as ResponseFor<O>);
    }
    const pending = [...this.records.values()].filter(record => !record.response);
    if (pending.length >= LIMITS.inflightRequests || pending.reduce((sum, record) => sum + record.bytes, 0) + bytes > LIMITS.unsentBytes) {
      return Promise.resolve(failure(id, 'rejected', 'request_capacity', 'Client in-flight request limit reached') as ResponseFor<O>);
    }
    let resolve!: (response: Response) => void;
    const promise = new Promise<Response>(done => { resolve = done; });
    const record: Pending = { envelope, payload, bytes, attempts: 0, resolve, promise, internal,
      localAttachmentId: session === undefined ? undefined : this.attachments.get(session)?.id };
    this.records.set(id, record); this.transmit(record); this.emit();
    return promise as Promise<ResponseFor<O>>;
  }

  private transmit(record: Pending) {
    if (record.response || record.timer) return;
    if (this.closed) { this.finish(record, failure(record.envelope.id, 'indeterminate', 'unavailable', 'Client is closed')); return; }
    if (record.attempts > this.retries) { this.finish(record, failure(record.envelope.id, 'indeterminate', 'indeterminate', 'No authoritative reply before retry limit')); return; }
    try {
      if (OPERATION_CATALOG[record.envelope.op].mutation) validateRequestId(record.envelope.id);
      if (!this.transport) throw new Error('No transport');
      ++record.attempts;
      record.timer = setTimeout(() => {
        record.timer = undefined;
        if (this.transport) this.transmit(record);
        else this.finish(record, failure(record.envelope.id, 'indeterminate', 'indeterminate', 'Connection lost before authoritative reply'));
      }, this.timeout);
      this.transport.send(record.envelope);
    } catch {
      this.finish(record, failure(record.envelope.id, record.attempts ? 'indeterminate' : 'rejected', 'unavailable', 'Request could not be delivered'));
    }
  }

  private finish(record: Pending, response: Response) {
    clearTimeout(record.timer); record.timer = undefined;
    if (record.response) return;
    record.response = structuredClone(response); record.resolve(structuredClone(response));
    if (record.envelope.op === 'host.setup.answer') {
      record.envelope = { ...record.envelope, params: { ...record.envelope.params, text: '' } };
      record.bytes = encodeFrame(record.envelope).byteLength;
    }
    record.bytes += encodeFrame(response).byteLength;
    const completed = [...this.records].filter(([, item]) => item.response);
    let retainedBytes = [...this.records.values()].reduce((sum, item) => sum + item.bytes, 0);
    for (const [index, [id, item]] of completed.entries()) {
      if (completed.length - index <= 256 && retainedBytes <= LIMITS.unsentBytes) break;
      this.records.delete(id); retainedBytes -= item.bytes;
    }
    this.emit();
  }

  private receive(value: unknown) {
    try {
      if (value !== null && typeof value === 'object' && 'control' in value) {
        const reply = parseControlResponse(value);
        const record = this.records.get(reply.re);
        if (!record || record.envelope.op !== 'hello' || reply.outcome !== 'mismatch') throw new Error('Unexpected control reply');
        assertTargetIdentity(this.target, this.pinned ?? reply.identity, reply.identity);
        if (record.response) return;
        this.pinned = reply.identity; this.connectionState = 'incompatible';
        this.finish(record, failure(reply.re, 'rejected', 'protocol_mismatch', 'Daemon uses an incompatible protocol'));
        return;
      }
      const re = value !== null && typeof value === 'object' && 're' in value ? value.re : undefined;
      const record = typeof re === 'string' ? this.records.get(re) : undefined;
      // Replies are decoded against the operation that produced them, never a union of result shapes.
      if (re !== undefined && !record) throw new Error('Uncorrelated response');
      const message = parseServerEnvelope(value, record?.envelope.op);
      if ('re' in message) {
        if (!record) throw new Error('Uncorrelated response');
        if (message.outcome === 'accepted' && record.envelope.op === 'attach' &&
            (message.result as OperationResult<'attach'>).snapshot.session !== record.envelope.session) throw new Error('Attachment session mismatch');
        if (record.response) return;
        if (message.outcome !== 'accepted' && message.error.code === 'resync_required' && record.envelope.session &&
            record.localAttachmentId === this.attachments.get(record.envelope.session)?.id) this.resync(record.envelope.session);
        this.finish(record, message); return;
      }
      if ('interaction' in message) {
        const interaction = message.interaction;
        if (!this.negotiated) {
          const bytes = Buffer.byteLength(JSON.stringify(interaction));
          if (this.connectionState !== 'connecting' || this.queuedInteractions.length >= LIMITS.pageEntries
            || this.queuedInteractionBytes + bytes > LIMITS.unsentBytes) throw new Error('Interaction notification before handshake');
          this.queuedInteractions.push(interaction); this.queuedInteractionBytes += bytes;
          return;
        }
        this.acceptInteraction(interaction);
        this.emit(); return;
      }
      if ('presentationEvent' in message) {
        if (!this.negotiated || !this.attachments.has(message.session)) throw new Error('Unbound presentation event.');
        const event = message.presentationEvent; const key = JSON.stringify([event.presenter.id, event.presenter.version]);
        if (!this.negotiated.presenters.some(p => p.id === event.presenter.id && p.version === event.presenter.version)) throw new Error('Unnegotiated presentation event.');
        const sequences = this.presentationSequences.get(message.session) ?? new Map<string, number>();
        if (event.sequence !== (sequences.get(key) ?? -1) + 1) throw new Error('Presentation event sequence gap.');
        sequences.set(key, event.sequence); this.presentationSequences.set(message.session, sequences);
        for (const listener of [...this.presentationListeners]) listener(structuredClone(message));
        return;
      }
      if (!this.negotiated) throw new Error('Session update before handshake');
      const attachment = this.attachments.get(message.session);
      if (!attachment) return;
      this.attachments.set(message.session, { ...attachment, state: reduceSession(attachment.state, { type: 'update', update: message }) });
      this.recover(message.session); this.emit();
    } catch { this.lost('invalid_frame'); }
  }

  private acceptInteraction(interaction: Interaction): void {
    if (!this.negotiated?.interactionKinds.includes(interaction.request.kind) || !interaction.eligibleClientKinds.includes(this.options.kind)) throw new Error('Ineligible interaction notification');
    if (interaction.scope.kind === 'session' && !this.attachments.has(interaction.scope.session)) throw new Error('Unbound interaction notification');
    if (interaction.scope.kind === 'host' && this.options.kind !== 'tui') throw new Error('Host interaction requires a local TUI');
    if (interaction.scope.kind === 'host' && interaction.scope.recipient !== undefined
      && interaction.scope.recipient !== this.negotiated.attachmentId) throw new Error('Host interaction targets another client');
    if (interaction.state === 'waiting' || interaction.state === 'deferred') this.interactionNotifications.set(interaction.id, interaction);
    else this.interactionNotifications.delete(interaction.id);
    if (this.interactionNotifications.size > LIMITS.pageEntries) throw new Error('Interaction notification limit exceeded');
  }

  async attach(session: string, policy: { requirePolicy?: 'acp-strict'; policyWaitMs?: number } = {}): Promise<ResponseFor<'attach'>> {
    if (this.connectionState !== 'ready') throw new Error('Connect before attaching');
    if (this.attachments.has(session)) throw new Error('Session already attached');
    const requirePolicy = this.options.kind === 'acp' ? 'acp-strict' : policy.requirePolicy;
    const attachment = { id: randomUUID(), session, ...policy, ...(requirePolicy ? { requirePolicy } : {}), state: createSessionState(session) };
    this.attachments.set(session, attachment);
    const response = await this.restore(session);
    if (response.outcome === 'rejected' && this.attachments.get(session)?.id === attachment.id) this.attachments.delete(session);
    this.emit(); return response;
  }

  async retryAttach(session: string): Promise<ResponseFor<'attach'>> {
    if (this.connectionState !== 'ready') throw new Error('Connect before retrying an attachment');
    const attachment = this.attachments.get(session);
    if (!attachment || attachment.state.status !== 'blocked') throw new Error('No blocked attachment to retry');
    if (attachment.state.recoveryAttempts >= 3) throw new Error('Attachment recovery limit reached');
    this.attachments.set(session, { ...attachment, state: reduceSession({ ...attachment.state, status: 'awaiting_snapshot' }, { type: 'recovery_started' }) });
    this.emit();
    return this.restore(session);
  }

  private async restore(session: string): Promise<ResponseFor<'attach'>> {
    this.presentationSequences.delete(session);
    const attachment = this.attachments.get(session)!;
    const epoch = this.epoch;
    const bufferGeneration = attachment.state.bufferGeneration;
    if (attachment.state.status === 'disconnected') this.attachments.set(session, { ...attachment, state: { ...attachment.state, status: 'awaiting_snapshot' } });
    const response = await this.exchange('attach', { expected: this.pinned!,
      ...(attachment.requirePolicy ? { requirePolicy: attachment.requirePolicy } : {}),
      ...(attachment.policyWaitMs === undefined ? {} : { policyWaitMs: attachment.policyWaitMs }) }, session, undefined, true);
    if (this.closed || epoch !== this.epoch || this.attachments.get(session)?.id !== attachment.id) return response;
    if (response.outcome === 'accepted') {
      const current = this.attachments.get(session);
      if (current) this.attachments.set(session, { ...current, binding: response.result.attachmentId,
        state: reduceSession(current.state, { type: 'snapshot', snapshot: response.result.snapshot, bufferGeneration }) });
      this.recover(session);
    } else {
      const current = this.attachments.get(session);
      if (current) this.attachments.set(session, { ...current, state: { ...current.state, status: 'blocked' } });
    }
    return response;
  }

  async detach(session: string): Promise<ResponseFor<'detach'>> {
    const attachment = this.attachments.get(session);
    if (!attachment) throw new Error('No attachment');
    this.attachments.delete(session);
    this.presentationSequences.delete(session);
    for (const [id, interaction] of this.interactionNotifications) {
      if (interaction.scope.kind === 'session' && interaction.scope.session === session) this.interactionNotifications.delete(id);
    }
    if (!attachment.binding || this.connectionState !== 'ready') {
      this.emit();
      return failure(newRequestId(), 'indeterminate', 'indeterminate', 'Local attachment removed; server binding outcome is unknown') as ResponseFor<'detach'>;
    }
    const response = await this.exchange('detach', { attachmentId: attachment.binding }, session, undefined, true);
    this.emit(); return response;
  }

  private resync(session: string) {
    const attachment = this.attachments.get(session);
    if (attachment) this.attachments.set(session, { ...attachment, state: reduceSession(attachment.state, { type: 'resync' }) });
    this.recover(session);
  }
  private recover(session: string) {
    const attachment = this.attachments.get(session);
    if (!attachment || attachment.state.status !== 'recovering' || this.recovering.has(session) || !this.transport) return;
    const state = reduceSession(attachment.state, { type: 'recovery_started' });
    this.attachments.set(session, { ...attachment, state });
    if (state.status === 'blocked') return;
    this.recovering.add(session);
    const epoch = this.epoch;
    void this.restore(session).catch(() => {
      const current = this.attachments.get(session);
      if (!this.closed && epoch === this.epoch && current?.id === attachment.id) this.attachments.set(session, { ...current, state: { ...current.state, status: 'blocked' } });
    }).finally(() => { this.recovering.delete(session); this.recover(session); this.emit(); });
  }

  private lost(reason: string) {
    if (this.closed) return;
    const wasReady = this.connectionState === 'ready';
    ++this.epoch; const transport = this.transport; this.transport = undefined; transport?.close();
    this.connectionState = reason === 'invalid_frame' ? 'blocked' : 'disconnected';
    this.interactionNotifications.clear();
    this.queuedInteractions = []; this.queuedInteractionBytes = 0;
    for (const [session, attachment] of this.attachments) this.attachments.set(session, { ...attachment, state: reduceSession(attachment.state, { type: 'disconnected' }) });
    for (const record of this.records.values()) {
      clearTimeout(record.timer); record.timer = undefined;
      if (record.internal && !record.response) this.finish(record, failure(record.envelope.id, 'indeterminate', 'unavailable', 'Connection lost'));
    }
    if (wasReady && reason !== 'invalid_frame' && this.reconnectCount < this.reconnectLimit) this.scheduleReconnect();
    else this.settleOutstanding('Transport lost; execution may still be running');
    this.emit();
  }
  private scheduleReconnect() {
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      ++this.reconnectCount;
      void this.connectShared().catch(() => {
        if (!this.closed && this.connectionState !== 'incompatible' && this.reconnectCount < this.reconnectLimit) this.scheduleReconnect();
        else this.settleOutstanding('Reconnect exhausted; execution may still be running');
      });
    }, this.delay);
  }
  private settleOutstanding(message: string) {
    for (const record of this.records.values()) if (!record.response) this.finish(record, failure(record.envelope.id, record.attempts ? 'indeterminate' : 'rejected', 'indeterminate', message));
  }

  async control(op: ControlRequest['op'], options: { confirmed: true; mode: 'drain' | 'force' } | undefined = undefined): Promise<ControlResponse> {
    if (this.closed) throw new Error('Client is closed');
    if (!this.pinned) throw new Error('Control requires a verified daemon identity');
    const id = op === 'host.status' ? randomUUID() : newRequestId();
    const request = parseControlRequest({ control: CONTROL_VERSION, id, op, params: { expected: this.pinned, ...options } });
    let transport: ClientTransport | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onClose = () => {};
    try {
      return await new Promise<ControlResponse>((resolve, reject) => {
        let settled = false;
        const fail = () => {
          if (!settled) { settled = true; clearTimeout(timer); transport?.close(); reject(new Error('Control outcome is indeterminate')); }
        };
        onClose = fail;
        this.lifetime.signal.addEventListener('abort', onClose, { once: true });
        timer = setTimeout(fail, this.timeout);
        void this.connectTransport({ frame: raw => {
          if (settled) return;
          try {
            const response = parseControlResponse(raw);
            assertTargetIdentity(this.target, this.pinned!, response.identity);
            if (response.re !== id) throw new Error('Control correlation mismatch');
            settled = true; clearTimeout(timer); resolve(response);
          } catch { fail(); }
        }, closed: fail }).then(connection => {
          transport = connection;
          if (settled) connection.close(); else { try { connection.send(request); } catch { fail(); } }
        }, fail);
      });
    } finally { this.lifetime.signal.removeEventListener('abort', onClose); clearTimeout(timer); transport?.close(); }
  }

  close(): void {
    this.closed = true; this.connectionState = 'closed'; ++this.epoch;
    this.lifetime.abort();
    this.interactionNotifications.clear();
    this.presentationSequences.clear(); this.presentationListeners.clear();
    this.queuedInteractions = []; this.queuedInteractionBytes = 0;
    clearTimeout(this.reconnectTimer); this.transport?.close(); this.transport = undefined;
    this.settleOutstanding('Client detached; execution may still be running');
    for (const [session, attachment] of this.attachments) this.attachments.set(session, { ...attachment, state: reduceSession(attachment.state, { type: 'disconnected' }) });
    this.emit();
  }
}

function bounded(value: number, min: number, max: number): number {
  if (!Number.isInteger(value) || value < min || value > max) throw new Error('Invalid client limit');
  return value;
}
