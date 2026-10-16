import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as wait } from 'node:timers/promises';
import {
  CONTROL_VERSION, LIMITS, OPERATION_CATALOG, PROTOCOL_VERSION, canonicalRequestPayload, encodeFrame,
  parseClientEnvelope, parseControlRequest, parseControlResponse, parseServerEnvelope,
  type ClientEnvelope, type ControlRequest, type ControlResponse, type DaemonIdentity, type Interaction,
  type Operation, type OperationParams, type OperationResult, type PresentationEvent, type Response, type ResponseFor,
} from '@felan-ai/session-protocol';
import { spawnDetachedDaemon } from '@felan-ai/daemon/client';
import { assertTargetIdentity, protocolTarget, resolveDaemonTarget, type DaemonTarget, type ResolvedDaemonTarget } from '@felan-ai/daemon/client';
import { waitForDaemonStop } from './daemon-stop.js';
import { createSessionState, reduceSession, type SessionState } from './reducer.js';
import { diagnosticText, type AttachTrigger, type BlockedReason, type ClientDiagnostic } from './diagnostics.js';
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
  readonly binding?: string;
  readonly state: SessionState;
  /** When the latest snapshot made this attachment live. */
  readonly liveSince?: number;
  /** Why the attachment last became blocked. */
  readonly blocked?: BlockedReason;
}
export interface SessionClientOptions {
  target: DaemonTarget;
  clientVersion: string;
  expectedDaemonVersion?: string;
  expectedComposition?: Pick<NonNullable<OperationResult<'hello'>['composition']>, 'managerPackage' | 'managerVersion' | 'providerDigest'>;
  kind: OperationParams<'hello'>['kind'];
  interactionKinds?: OperationParams<'hello'>['interactionKinds'];
  capabilities?: OperationParams<'hello'>['capabilities'];
  expected?: DaemonIdentity;
  connector?: TransportConnector;
  launch?: { entrypoint: string; timeoutMs?: number; replacing?: DaemonIdentity; hostConfigPath?: string };
  requestTimeoutMs?: number;
  retries?: number;
  /** Automatic reconnect attempts after an established connection drops; unlimited by default, 0 disables. */
  reconnectAttempts?: number;
  /** First automatic reconnect delay; later attempts double it up to `reconnectMaxDelayMs`. */
  reconnectDelayMs?: number;
  reconnectMaxDelayMs?: number;
  /** Receives connection and attachment transitions for troubleshooting; must not throw. */
  diagnostics?: (event: ClientDiagnostic) => void;
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
const LIVENESS_OPERATIONS = new Set<Operation>(['hello', 'host.status']);
const failure = (id: string, outcome: 'rejected' | 'indeterminate', code: string, message: string): Response =>
  ({ v: 1, re: id, outcome, error: { code, message, retryable: false } });

export class SessionClient {
  readonly target: ResolvedDaemonTarget;
  private readonly connector: TransportConnector;
  private readonly timeout: number;
  private readonly retries: number;
  private readonly reconnectLimit: number;
  private readonly delay: number;
  private readonly maxDelay: number;
  private transport: ClientTransport | undefined;
  private connecting: Promise<OperationResult<'hello'>> | undefined;
  private connectingLaunches = false;
  private epoch = 0;
  private closed = false;
  private readonly lifetime = new AbortController();
  private reconnectCount = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private reconnectAt: number | undefined;
  private established = false;
  private readyAt = 0;
  private records = new Map<string, Pending>();
  private attachments = new Map<string, AttachmentState>();
  private readonly interactionNotifications = new Map<string, Interaction>();
  private queuedInteractions: Interaction[] = [];
  private queuedInteractionBytes = 0;
  private recovering = new Set<string>();
  private listeners = new Set<() => void>();
  private readonly presentationListeners = new Set<(event: PresentationEvent) => void>();
  private readonly presentationSequences = new Map<string, number>();
  private pinned: DaemonIdentity | undefined;
  private verifying: DaemonIdentity | undefined;
  private replacing: DaemonIdentity | undefined;
  private mismatchedWork: number | undefined;
  private negotiated: OperationResult<'hello'> | undefined;
  private connectionState: 'disconnected' | 'connecting' | 'ready' | 'incompatible' | 'blocked' | 'closed' = 'disconnected';

  constructor(private readonly options: SessionClientOptions) {
    this.options = { ...options, target: structuredClone(options.target),
      ...(options.launch ? { launch: structuredClone(options.launch) } : {}),
      interactionKinds: [...(options.interactionKinds ?? [])], capabilities: [...(options.capabilities ?? [])] };
    this.target = resolveDaemonTarget(options.target);
    if (options.expectedDaemonVersion !== undefined && (!options.expectedDaemonVersion || Buffer.byteLength(options.expectedDaemonVersion) > 128)) throw new Error('Invalid expected daemon version.');
    this.connector = options.connector ?? localConnector(this.target);
    this.pinned = options.expected && structuredClone(options.expected);
    if (this.pinned) assertTargetIdentity(this.target, this.pinned, this.pinned);
    this.timeout = bounded(options.requestTimeoutMs ?? 5_000, 1, 60_000);
    this.retries = bounded(options.retries ?? 2, 0, 5);
    this.reconnectLimit = options.reconnectAttempts === undefined ? Infinity : bounded(options.reconnectAttempts, 0, Number.MAX_SAFE_INTEGER);
    this.delay = bounded(options.reconnectDelayMs ?? 250, 0, 10_000);
    this.maxDelay = Math.max(this.delay, bounded(options.reconnectMaxDelayMs ?? 10_000, 0, 300_000));
  }

  get status() { return this.connectionState; }
  /** The scheduled automatic reconnect after an established connection dropped; automatic attempts never launch a daemon. */
  get reconnection(): { attempt: number; retryAt: number } | undefined {
    return this.reconnectAt === undefined ? undefined : { attempt: this.reconnectCount + 1, retryAt: this.reconnectAt };
  }
  get identity() { return this.pinned && structuredClone(this.pinned); }
  get capabilities() { return this.negotiated && structuredClone(this.negotiated); }
  /** Active work on an incompatible daemon, when it could report it; restarting it would interrupt that work. */
  get incompatibleActiveWork(): number | undefined { return this.connectionState === 'incompatible' ? this.mismatchedWork : undefined; }
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
  /** An independent, mutable copy of the attachment; use {@link readAttachment} for frequent reads. */
  getAttachment(session: string): AttachmentState | undefined { return structuredClone(this.attachments.get(session)); }
  /** The current attachment itself, deeply frozen and shared with every reader; it never changes, later updates replace it. */
  readAttachment(session: string): AttachmentState | undefined {
    const attachment = this.attachments.get(session);
    if (attachment) deepFreeze(attachment);
    return attachment;
  }
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

  /** Connects now, resetting automatic backoff; unlike automatic reconnects this starts an absent daemon when `launch` is configured. */
  async connect(options: { replacing?: DaemonIdentity } = {}): Promise<OperationResult<'hello'>> {
    if (options.replacing) { assertTargetIdentity(this.target, options.replacing, options.replacing); this.replacing = structuredClone(options.replacing); }
    if (this.connecting && !this.connectingLaunches) await this.connecting.catch(() => {});
    this.cancelReconnect(); this.reconnectCount = 0;
    try { return await this.connectShared(true); }
    catch (error) { this.retryLater(); throw error; }
  }

  private connectShared(launch: boolean): Promise<OperationResult<'hello'>> {
    if (this.closed) return Promise.reject(new Error('Client is closed'));
    if (this.connecting) return this.connecting;
    if (this.connectionState === 'ready') return Promise.resolve(structuredClone(this.negotiated!));
    this.connectingLaunches = launch;
    this.connecting = this.open(launch).finally(() => { this.connecting = undefined; });
    return this.connecting;
  }

  /** An idle daemon from another installation is replaced transparently; one with active work stays incompatible so the caller can ask. */
  private async open(launch: boolean): Promise<OperationResult<'hello'>> {
    try { return await this.openOnce(launch); }
    catch (error) {
      if (!launch || this.closed || this.connectionState !== 'incompatible' || this.mismatchedWork !== 0 || !this.options.launch || this.options.expected) throw error;
      const identity = this.pinned!;
      const response = await this.control('host.restart', 'drain');
      if (response.outcome !== 'accepted') throw new Error('The running daemon did not accept a restart.');
      await waitForDaemonStop(this, this.lifetime.signal);
      this.pinned = undefined; this.replacing = identity;
      return this.openOnce(launch);
    }
  }

  private async openOnce(launch: boolean): Promise<OperationResult<'hello'>> {
    this.queuedInteractions = []; this.queuedInteractionBytes = 0; this.mismatchedWork = undefined;
    // Only an explicit expected identity or this attempt's launch receipt pins the instance; an unpinned client follows daemon restarts.
    this.verifying = this.options.expected && structuredClone(this.options.expected);
    this.connectionState = 'connecting'; this.negotiated = undefined; this.emit();
    const epoch = ++this.epoch;
    const receiver = { frame: (value: unknown) => { if (epoch === this.epoch) this.receive(value); },
      closed: (reason: string) => { if (epoch === this.epoch) this.lost(reason); } };
    try {
      try { this.transport = await this.connectTransport(receiver); }
      catch (error) {
        if (this.closed) throw new Error('Client is closed');
        const code = (error as { code?: string }).code;
        if (!launch || this.options.expected || !this.options.launch || !['ENOENT', 'stale_endpoint', 'unavailable'].includes(code ?? '')) throw error;
        try {
          const receipt = await this.whileOpen(spawnDetachedDaemon({ target: this.options.target, ...this.options.launch, ...(this.replacing ? { replacing: this.replacing } : {}) }));
          if (this.closed) throw new Error('Client is closed');
          assertTargetIdentity(this.target, receipt.identity, receipt.identity);
          this.pinned = receipt.identity; this.verifying = receipt.identity;
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
        kind: this.options.kind, interactionKinds: this.options.interactionKinds ?? [],
        capabilities: this.options.capabilities ?? [],
        target: protocolTarget(this.target) }, undefined, undefined, true);
      if (this.closed || epoch !== this.epoch) throw new Error('Connection was superseded');
      if (hello.outcome !== 'accepted') throw new Error('Daemon handshake rejected');
      const result = hello.result;
      assertTargetIdentity(this.target, this.verifying ?? result.identity, result.identity);
      this.pinned = structuredClone(result.identity);
      const versionDiffers = !!this.options.expectedDaemonVersion && result.daemonVersion !== this.options.expectedDaemonVersion;
      if (versionDiffers || this.options.expectedComposition && (this.options.expectedComposition.managerPackage !== result.composition?.managerPackage
        || this.options.expectedComposition.managerVersion !== result.composition?.managerVersion
        || this.options.expectedComposition.providerDigest !== result.composition?.providerDigest)) {
        this.mismatchedWork = await this.activeWork(result.operations);
        this.connectionState = 'incompatible';
        throw new Error(versionDiffers ? 'Daemon version differs from the installed package; restart it to continue.'
          : 'Daemon provider configuration differs from the selected configuration; restart it to continue.');
      }
      this.negotiated = structuredClone(result);
      for (const interaction of this.queuedInteractions) this.acceptInteraction(interaction);
      this.queuedInteractions = []; this.queuedInteractionBytes = 0;
      for (const attachment of this.attachments.values()) {
        if (this.closed || epoch !== this.epoch) throw new Error('Connection was superseded');
        await this.restore(attachment.session, 'reconnect');
      }
      if (epoch !== this.epoch || this.closed) throw new Error('Connection was superseded');
      this.connectionState = 'ready'; this.established = true; this.readyAt = Date.now(); this.replacing = undefined;
      this.diagnose({ event: 'connection.ready', daemonVersion: result.daemonVersion, instanceId: result.identity.instanceId });
      for (const record of this.records.values()) if (!record.internal && !record.response) this.transmit(record);
      this.emit();
      return structuredClone(result);
    } catch (error) {
      this.diagnose({ event: 'connection.failed', error: diagnosticText(error) });
      const status = this.connectionState as string;
      // An established client that will retry stays disconnected so observers do not treat a daemon restart as fatal.
      if (status !== 'incompatible' && !this.closed) this.connectionState = this.established && this.reconnectCount < this.reconnectLimit ? 'disconnected' : 'blocked';
      this.interactionNotifications.clear(); this.queuedInteractions = []; this.queuedInteractionBytes = 0;
      ++this.epoch; this.transport?.close(); this.transport = undefined;
      this.settleOutstanding('Daemon connection could not be established; execution may still be running');
      this.emit(); throw error;
    }
  }

  private async activeWork(operations: readonly string[]): Promise<number | undefined> {
    if (!operations.includes('host.status')) return undefined;
    const response = await this.exchange('host.status', {}, undefined, undefined, true);
    return response.outcome === 'accepted' ? response.result.active.work : undefined;
  }

  request<O extends Operation>(op: O, params: OperationParams<O>, options: { session?: string; id?: string } = {}): Promise<ResponseFor<O>> {
    if (op === 'hello' || op === 'attach' || op === 'detach') throw new Error('Use connect, attach or detach for connection bindings');
    return this.exchange(op, params, options.session, options.id, false);
  }

  private exchange<O extends Operation>(op: O, params: OperationParams<O>, session?: string, suppliedId?: string, internal = false): Promise<ResponseFor<O>> {
    const id = OPERATION_CATALOG[op].mutation ? (suppliedId ?? newRequestId()).toLowerCase() : suppliedId ?? randomUUID();
    const previous = this.records.get(id);
    const envelope = parseClientEnvelope({ v: 1, id, op, params, ...(session === undefined ? {} : { session }) });
    const canonical = canonicalRequestPayload(envelope);
    const payload = op === 'host.setup.answer' ? createHash('sha256').update(canonical).digest('hex') : canonical;
    if (previous) {
      if (previous.payload !== payload) return Promise.resolve(failure(id, 'rejected', 'request_conflict', 'Request ID already names a different command') as ResponseFor<O>);
      return previous.promise as Promise<ResponseFor<O>>;
    }
    const bytes = encodeFrame(envelope).byteLength;
    if (!internal && (this.connectionState !== 'ready' || !this.negotiated?.operations.includes(op))) {
      return Promise.resolve(failure(id, 'rejected', this.connectionState === 'ready' ? 'unsupported_operation' : 'unavailable', this.connectionState === 'ready' ? 'Operation is not available on this connection' : 'Daemon is not connected') as ResponseFor<O>);
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
      if (!this.transport) throw new Error('No transport');
      ++record.attempts;
      // Interactive operations wait for their authoritative reply; only liveness probes are bounded.
      if (LIVENESS_OPERATIONS.has(record.envelope.op)) record.timer = setTimeout(() => {
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
        assertTargetIdentity(this.target, this.verifying ?? reply.identity, reply.identity);
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
            record.localAttachmentId === this.attachments.get(record.envelope.session)?.id) this.resync(record.envelope.session, record.envelope.op);
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
        const event = message.presentationEvent;
        if (!this.negotiated.capabilities?.includes('native.events')) throw new Error('Unnegotiated native event.');
        if (event.sequence !== (this.presentationSequences.get(message.session) ?? -1) + 1) throw new Error('Native event sequence gap.');
        this.presentationSequences.set(message.session, event.sequence);
        for (const listener of [...this.presentationListeners]) listener(structuredClone(message));
        return;
      }
      if (!this.negotiated) throw new Error('Session update before handshake');
      const attachment = this.attachments.get(message.session);
      if (!attachment) return;
      const current = this.renewRecoveryBudget(attachment);
      this.store({ ...current, state: reduceSession(current.state, { type: 'update', update: message }) });
      this.recover(message.session); this.emit();
    } catch (error) { this.lost('invalid_frame', error); }
  }

  private acceptInteraction(interaction: Interaction): void {
    if (!this.negotiated?.interactionKinds.includes(interaction.request.kind)) throw new Error('Ineligible interaction notification');
    if (interaction.scope.kind === 'session' && !this.attachments.has(interaction.scope.session)) throw new Error('Unbound interaction notification');
    if (interaction.scope.kind === 'host' && interaction.scope.recipient !== undefined
      && interaction.scope.recipient !== this.negotiated.attachmentId) throw new Error('Host interaction targets another client');
    if (interaction.state === 'waiting' || interaction.state === 'deferred') this.interactionNotifications.set(interaction.id, interaction);
    else this.interactionNotifications.delete(interaction.id);
    if (this.interactionNotifications.size > LIMITS.pageEntries) throw new Error('Interaction notification limit exceeded');
  }

  async attach(session: string, policy: { requirePolicy?: 'acp-strict' } = {}): Promise<ResponseFor<'attach'>> {
    if (this.connectionState !== 'ready') throw new Error('Connect before attaching');
    if (this.attachments.has(session)) throw new Error('Session already attached');
    const attachment = { id: randomUUID(), session, ...policy, state: createSessionState(session) };
    this.attachments.set(session, attachment);
    const response = await this.restore(session, 'attach');
    if (response.outcome === 'rejected' && this.attachments.get(session)?.id === attachment.id) this.attachments.delete(session);
    this.emit(); return response;
  }

  async retryAttach(session: string): Promise<ResponseFor<'attach'>> {
    if (this.connectionState !== 'ready') throw new Error('Connect before retrying an attachment');
    const attachment = this.attachments.get(session);
    if (!attachment || attachment.state.status !== 'blocked') throw new Error('No blocked attachment to retry');
    if (attachment.state.recoveryAttempts >= 3) throw new Error('Attachment recovery limit reached; restart this client to attach again');
    this.store({ ...attachment, state: reduceSession({ ...attachment.state, status: 'awaiting_snapshot' }, { type: 'recovery_started' }) });
    this.emit();
    return this.restore(session, 'retry');
  }

  private async restore(session: string, trigger: AttachTrigger): Promise<ResponseFor<'attach'>> {
    this.presentationSequences.delete(session);
    const attachment = this.attachments.get(session)!;
    const epoch = this.epoch;
    const bufferGeneration = attachment.state.bufferGeneration;
    if (attachment.state.status === 'disconnected') this.attachments.set(session, { ...attachment, state: { ...attachment.state, status: 'awaiting_snapshot' } });
    const started = Date.now();
    const response = await this.exchange('attach', { expected: this.pinned!,
      ...(attachment.requirePolicy ? { requirePolicy: attachment.requirePolicy } : {}) }, session, undefined, true);
    this.diagnoseAttach(session, trigger, response, Date.now() - started);
    if (this.closed || epoch !== this.epoch || this.attachments.get(session)?.id !== attachment.id) return response;
    if (response.outcome === 'accepted') {
      const current = this.attachments.get(session);
      if (current) {
        const state = reduceSession(current.state, { type: 'snapshot', snapshot: response.result.snapshot, bufferGeneration });
        this.store({ ...current, binding: response.result.attachmentId, state, ...(state.status === 'live' ? { liveSince: Date.now() } : {}) }, { snapshot: true });
      }
      this.recover(session);
    } else {
      const current = this.attachments.get(session);
      if (current) this.store({ ...current, state: { ...current.state, status: 'blocked' } },
        { failure: { kind: 'attach_failed', outcome: response.outcome, code: response.error.code, message: diagnosticText(response.error.message) } });
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

  private resync(session: string, op: Operation) {
    const attachment = this.attachments.get(session);
    if (attachment) {
      const current = this.renewRecoveryBudget(attachment);
      this.store({ ...current, state: reduceSession(current.state, { type: 'resync', cause: 'daemon_resync' }) }, { op });
    }
    this.recover(session);
  }

  /** Updates an attachment and reports transitions into recovery or a blocked state, keeping why it blocked. A snapshot that cannot go live is a new recovery. */
  private store(next: AttachmentState, detail: { op?: Operation; failure?: BlockedReason; snapshot?: boolean } = {}): void {
    const previous = this.attachments.get(next.session)?.state.status;
    const { state } = next;
    if (state.status === 'recovering' && (previous !== 'recovering' || detail.snapshot) && state.recoveryCause) {
      this.diagnose({ event: 'attachment.recovering', session: next.session, cause: state.recoveryCause, attempts: state.recoveryAttempts, ...(detail.op ? { op: detail.op } : {}) });
    }
    if (state.status === 'blocked' && previous !== 'blocked') {
      const reason: BlockedReason = detail.failure ?? { kind: 'recovery_limit', ...(state.recoveryCause ? { cause: state.recoveryCause } : {}) };
      this.diagnose({ event: 'attachment.blocked', session: next.session, attempts: state.recoveryAttempts, reason });
      this.attachments.set(next.session, { ...next, blocked: reason });
      return;
    }
    this.attachments.set(next.session, next);
  }

  private diagnoseAttach(session: string, trigger: AttachTrigger, response: ResponseFor<'attach'>, durationMs: number): void {
    if (!this.options.diagnostics) return;
    if (response.outcome !== 'accepted') {
      this.diagnose({ event: 'attachment.attached', session, trigger, outcome: response.outcome, durationMs, code: response.error.code, message: diagnosticText(response.error.message) });
      return;
    }
    const { snapshot } = response.result;
    this.diagnose({ event: 'attachment.attached', session, trigger, outcome: 'accepted', durationMs, revision: snapshot.revision,
      snapshotBytes: Buffer.byteLength(JSON.stringify(snapshot)),
      counts: { history: snapshot.history.entries.length, tools: snapshot.tools.length, processes: snapshot.processes.length, children: snapshot.children.length,
        interactions: snapshot.interactions.length, presentation: snapshot.presentation.length, activeStreams: snapshot.activeStreams.length } });
  }

  private diagnose(event: ClientDiagnostic): void {
    try { this.options.diagnostics?.(event); } catch { /* Diagnostics never affect the protocol. */ }
  }

  /** Like connection backoff, the recovery budget renews only after the attachment stayed live longer than the longest reconnect delay, so a flapping session cannot resnapshot forever. */
  private renewRecoveryBudget(attachment: AttachmentState): AttachmentState {
    const { state, liveSince } = attachment;
    if (state.status !== 'live' || state.recoveryAttempts === 0 || liveSince === undefined || Date.now() - liveSince < this.maxDelay) return attachment;
    return { ...attachment, state: { ...state, recoveryAttempts: 0 } };
  }
  private recover(session: string) {
    const attachment = this.attachments.get(session);
    if (!attachment || attachment.state.status !== 'recovering' || this.recovering.has(session) || !this.transport) return;
    const state = reduceSession(attachment.state, { type: 'recovery_started' });
    this.store({ ...attachment, state });
    if (state.status === 'blocked') return;
    this.recovering.add(session);
    const epoch = this.epoch;
    void this.restore(session, 'recovery').catch(error => {
      const current = this.attachments.get(session);
      if (!this.closed && epoch === this.epoch && current?.id === attachment.id) this.store({ ...current, state: { ...current.state, status: 'blocked' } },
        { failure: { kind: 'attach_failed', outcome: 'error', message: diagnosticText(error) } });
    }).finally(() => { this.recovering.delete(session); this.recover(session); this.emit(); });
  }

  private lost(reason: string, error?: unknown) {
    if (this.closed) return;
    this.diagnose({ event: 'connection.lost', reason, ...(error === undefined ? {} : { error: diagnosticText(error) }) });
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
    // Backoff restarts only after a connection that stayed up longer than the longest delay, so a flapping daemon is not hammered.
    if (wasReady && Date.now() - this.readyAt >= this.maxDelay) this.reconnectCount = 0;
    if (!wasReady || reason === 'invalid_frame' || !this.retryLater()) this.settleOutstanding('Daemon connection lost; execution may still be running');
    this.emit();
  }
  /** Schedules the next automatic attempt; outstanding requests stay pending only until an attempt fails. */
  private retryLater(): boolean {
    if (this.closed || !this.established || this.connectionState === 'incompatible' || this.reconnectCount >= this.reconnectLimit) return false;
    if (this.reconnectTimer) return true;
    this.connectionState = 'disconnected';
    const delay = Math.min(this.maxDelay, this.delay * 2 ** Math.min(this.reconnectCount, 30) * (0.9 + Math.random() * 0.2));
    this.reconnectAt = Date.now() + delay;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined; this.reconnectAt = undefined; ++this.reconnectCount;
      void this.connectShared(false).catch(() => { this.retryLater(); this.emit(); });
    }, delay);
    this.reconnectTimer.unref?.();
    this.emit();
    return true;
  }
  private cancelReconnect() { clearTimeout(this.reconnectTimer); this.reconnectTimer = undefined; this.reconnectAt = undefined; }
  private settleOutstanding(message: string) {
    for (const record of this.records.values()) if (!record.response) this.finish(record, failure(record.envelope.id, record.attempts ? 'indeterminate' : 'rejected', 'indeterminate', message));
  }

  async control(op: ControlRequest['op'], mode?: 'drain' | 'force'): Promise<ControlResponse> {
    if (this.closed) throw new Error('Client is closed');
    if (!this.pinned) throw new Error('Control requires a verified daemon identity');
    const id = op === 'host.status' ? randomUUID() : newRequestId();
    const request = parseControlRequest({ control: CONTROL_VERSION, id, op, params: { expected: this.pinned, ...(mode ? { mode } : {}) } });
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
    this.cancelReconnect(); this.transport?.close(); this.transport = undefined;
    this.settleOutstanding('Client detached; execution may still be running');
    for (const [session, attachment] of this.attachments) this.attachments.set(session, { ...attachment, state: reduceSession(attachment.state, { type: 'disconnected' }) });
    this.emit();
  }
}

/** Freezes children before parents, so a frozen object's descendants are frozen and the unchanged parts shared by successive states are skipped. */
function deepFreeze(value: unknown): void {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return;
  for (const child of Object.values(value)) deepFreeze(child);
  Object.freeze(value);
}

function bounded(value: number, min: number, max: number): number {
  if (!Number.isInteger(value) || value < min || value > max) throw new Error('Invalid client limit');
  return value;
}
