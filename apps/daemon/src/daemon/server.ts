import type { HostConfiguration, HostSetup } from './host-services.js';
import { randomUUID } from 'node:crypto';
import type { Socket } from 'node:net';
import type { ModelRuntime } from '@felan-ai/agent-core';
import { BootstrapHelloSchema, ERROR_CODES, IdSchema, JsonLineDecoder, LIMITS, OPERATION_CATALOG, PresentationEventSchema, UI_CAPABILITIES, canonicalRequestPayload, parseClientEnvelope, parseControlRequest, parseControlResponse,
  parseSchema, type ClientEnvelope, type Interaction, type Operation, type OperationParams, type OperationResult, type Response } from '@felan-ai/session-protocol';
import { OrderedAdmission, SAFETY_BYTES, diagnosticMessage, type AdmittedCommand, type AdmissionOutcome } from './admission.js';
import { accepted, commandError, SessionCommands, type RootPreparation } from './commands.js';
import { SessionFanout } from './fanout.js';
import { listenLocalIpc, type LocalIpcListener } from './ipc.js';
import type { SessionRegistry } from './registry.js';
import { assertTargetIdentity, protocolTarget } from './target.js';
import type { BrokerClient } from './broker.js';
import type { HostLifecycle } from './lifecycle.js';
import type { HostCompositionInfo } from './host-config.js';
import { headlessJsonEvent } from './headless-json.js';

type Kind = OperationParams<'hello'>['kind'];
export interface BrokerDispatchPort {
  interactionKinds: OperationParams<'hello'>['interactionKinds'];
  dispatch(command: AdmittedCommand, client: { principal: string; kind: Kind; attachment: string;
    interactionKinds: OperationParams<'hello'>['interactionKinds'];
    capabilities?: OperationParams<'hello'>['capabilities'] }): AdmissionOutcome | Promise<AdmissionOutcome>;
  connected?(client: BrokerClient): void;
  attached?(attachment: string, session: string): void;
  detached?(attachment: string, session: string): void;
  disconnected?(attachment: string): void;
  observe?(interaction: Interaction): void;
  pending?(): Interaction[];
  canReceive?(attachment: string, interaction: Interaction): boolean;
}
export interface SessionServerOptions {
  registry: SessionRegistry;
  configuration: HostConfiguration;
  models: Pick<ModelRuntime, 'getAvailable'>;
  version: string;
  composition?: HostCompositionInfo;
  setup?: HostSetup;
  prepareOpenInteraction?(id: string, client: string, signal: AbortSignal): () => Promise<void>;
  broker?: BrokerDispatchPort;
  management?: { lifecycle: HostLifecycle; logs(params: OperationParams<'host.logs'>): OperationResult<'host.logs'> };
  setupNeeds?(): OperationResult<'host.status'>['setupNeeds'];
  currentComposition?(): Promise<HostCompositionInfo>;
  prepareRoot?(params: OperationParams<'sessions.create'>, caller: { id: string; kind: Kind; signal: AbortSignal }): Promise<RootPreparation>;
}
interface Attachment { id: string; detach(): void }
interface Connection {
  id: string;
  socket: Socket;
  out: SessionFanout;
  kind?: Kind;
  closed: boolean;
  pending: number;
  bytes: number;
  attachments: Map<string, Attachment>;
  interactionKinds: OperationParams<'hello'>['interactionKinds'];
  capabilities: NonNullable<OperationParams<'hello'>['capabilities']>;
  lifetime: AbortController;
}

export class SessionServer {
  private readonly connections = new Set<Connection>();
  private readonly admission: OrderedAdmission;
  private readonly commands: SessionCommands;
  private listener?: LocalIpcListener;
  private stopped = false;
  private starting = false;
  private sealed = false;
  private readonly pendingReceives = new Set<Promise<unknown>>();
  private readonly rootPreparations = new Map<string, { payload: string; work: Promise<RootPreparation> }>();
  private receiveFailure: unknown;
  private unwatch = () => {};
  private unbindCommands = () => {};
  private unbindInvalidation = () => {};
  private unbindBroker = () => {};
  readonly principal: string;

  constructor(private readonly options: SessionServerOptions) {
    const { registry } = options; registry.assertAdmission();
    this.principal = parseSchema(IdSchema, `local:${registry.options.owner.target.uid}:${registry.options.owner.target.namespaceId}`);
    this.commands = new SessionCommands({ ...options, invalidated: revisions => this.invalidate(revisions) });
    this.admission = new OrderedAdmission(registry.options.store, { committed: revisions => this.invalidate(revisions), dispatched: revisions => registry.publishCommitted(revisions) });
    this.unbindCommands = registry.bindCommandDispatcher(() => true);
    this.unbindInvalidation = registry.subscribeInvalidation(revisions => this.invalidate(revisions));
    this.unbindBroker = registry.subscribeInteractions(interaction => {
      options.broker?.observe?.(interaction);
      if (interaction.scope.kind === 'host') {
        for (const connection of this.connections) this.sendInteraction(connection, interaction);
      }
    });
  }

  async start(): Promise<void> {
    if (this.listener || this.stopped || this.starting) throw new Error('Session server is already started or closed.');
    this.starting = true;
    try {
      this.listener = await listenLocalIpc(this.options.registry.options.owner, socket => this.acceptLocalConsole(socket));
      if (this.stopped) { this.listener.close(); throw new Error('Session server closed during startup.'); }
      this.options.registry.options.owner.assertCurrent();
      this.unwatch = this.options.registry.options.owner.onLost(() => this.close());
    } catch (error) { this.close(); throw error; }
    finally { this.starting = false; }
  }

  close(): void {
    if (this.stopped) return;
    this.stopped = true; this.unwatch(); this.listener?.close();
    for (const connection of [...this.connections]) connection.out.close();
    this.unbindCommands(); this.unbindInvalidation(); this.unbindBroker();
  }

  sealCommands(): void { this.sealed = true; }

  async settleCommands(): Promise<void> {
    while (this.pendingReceives.size) {
      await Promise.allSettled([...this.pendingReceives]);
    }
    if (this.receiveFailure) throw new Error('Server commands did not settle cleanly.');
  }

  private trackReceive<T>(work: Promise<T>): Promise<T> {
    this.pendingReceives.add(work);
    void work.then(() => this.pendingReceives.delete(work), error => { this.pendingReceives.delete(work); this.receiveFailure ??= error; });
    return work;
  }

  async requestManagement(request: Extract<ClientEnvelope, { op: 'host.stop' | 'host.restart' }>): Promise<Response> {
    if (!this.options.management || this.sealed) throw commandError('unavailable');
    const response = await this.trackReceive(this.admission.submit(request, this.principal, command => this.options.management!.lifecycle.prepare(command)));
    this.options.management.lifecycle.afterResponse(request.id, response.outcome === 'accepted');
    return response;
  }

  invalidate(revisions: Readonly<Record<string, number>>): void {
    const store = this.options.registry.options.store;
    for (const [id, revision] of Object.entries(revisions)) {
      if (!Number.isSafeInteger(revision) || revision < 0 || store.session(id).revision < revision) throw new Error('Invalidation must name an actual committed revision.');
    }
    for (const connection of this.connections) {
      if (Object.keys(revisions).some(id => connection.attachments.has(id))) connection.out.close('resync_required');
    }
  }

  private acceptLocalConsole(socket: Socket): void {
    if (this.stopped) { socket.destroy(); return; }
    const connection: Connection = { id: randomUUID(), socket, closed: false, pending: 0, bytes: 0, attachments: new Map(), interactionKinds: [], capabilities: [], lifetime: new AbortController(),
      out: new SessionFanout({ write: (data, done) => socket.write(data, done), close: () => {
        if (connection.closed) return;
        connection.closed = true;
        connection.lifetime.abort();
        this.options.setup?.disconnected(connection.id);
        for (const attachment of connection.attachments.values()) attachment.detach();
        this.options.broker?.disconnected?.(connection.id);
        connection.attachments.clear(); this.connections.delete(connection); socket.destroy();
      } }) };
    this.connections.add(connection);
    const decoder = new JsonLineDecoder();
    const deadline = setTimeout(() => { if (!connection.kind) connection.out.close(); }, 2_000);
    deadline.unref();
    socket.on('drain', () => connection.out.drain());
    socket.on('error', () => connection.out.close('transport_error'));
    socket.on('close', () => { clearTimeout(deadline); connection.out.close(); });
    socket.on('end', () => {
      try { decoder.finish(); } catch { connection.out.close('resync_required'); }
    });
    socket.on('data', (bytes: Buffer) => {
      try {
        this.options.registry.options.owner.assertCurrent();
        for (const frame of decoder.push(bytes)) {
          if (connection.closed) break;
          this.trackReceive(this.receive(connection, frame));
        }
      } catch { connection.out.close('resync_required'); }
    });
  }

  private async receive(connection: Connection, frame: unknown): Promise<void> {
    let id: string | undefined; let size = 0; let counted = false; let admissionAttempt = false;
    let rootPreparation: RootPreparation | undefined;
    let preparing: { payload: string; work: Promise<RootPreparation> } | undefined;
    let ownsPreparation = false;
    const deferred: Array<Readonly<Record<string, number>>> = [];
    const invalidateAfterSend = () => { for (const revisions of deferred.splice(0)) this.invalidate(revisions); };
    try {
      if (frame === null || typeof frame !== 'object') throw commandError('invalid_request');
      id = parseSchema(IdSchema, 'id' in frame ? frame.id : undefined);
      if (this.sealed && !('control' in frame && 'op' in frame && frame.op === 'host.status')) throw commandError('busy');
      if ('control' in frame) {
        const request = parseControlRequest(frame);
        assertTargetIdentity(this.options.registry.options.owner.target, request.params.expected, this.options.registry.options.owner.identity);
        let result: Response | undefined;
        if (request.op !== 'host.status' && this.options.management) {
          const command = parseClientEnvelope({ v: 1, id: request.id, op: request.op, params: request.params });
          try { result = await this.admission.submit(command, this.principal, admitted => this.options.management!.lifecycle.prepare(admitted)); }
          catch (error) { result = rejected(id, error, true); }
        }
        const response = { control: 1, re: id, identity: this.options.registry.options.owner.identity, daemonVersion: this.options.version, supportedProtocol: 1,
          state: this.options.management?.lifecycle.state ?? 'ready',
          ...(request.op === 'host.status' || result?.outcome === 'accepted' ? { outcome: 'accepted' }
            : { outcome: 'rejected', error: result ? result.error : { code: 'unavailable', message: 'Host management is unavailable.', retryable: false } }) };
        connection.out.send(parseControlResponse(response), () => this.options.management?.lifecycle.afterResponse(request.id, result?.outcome === 'accepted')); return;
      }
      if ('op' in frame && frame.op === 'hello') {
        const bootstrap = parseSchema(BootstrapHelloSchema, frame);
        if (bootstrap.v !== 1 || bootstrap.params.protocol !== 1) {
          connection.out.send(parseControlResponse({ control: 1, re: id, identity: this.options.registry.options.owner.identity, daemonVersion: this.options.version,
            supportedProtocol: 1, state: 'ready', outcome: 'mismatch' })); return;
        }
      }
      const request = parseClientEnvelope(frame);
      if (request.op === 'hello') { await this.hello(connection, request); return; }
      if (!connection.kind) throw commandError('forbidden');
      if (request.op === 'ui.action' && !connection.capabilities.includes('ui.action')) throw commandError('unavailable');
      const safety = ['cancel', 'executions.cancel', 'close', 'interaction.answer', 'processes.stop', 'host.stop', 'host.restart', 'host.setup.cancel'].includes(request.op);
      size = Buffer.byteLength(JSON.stringify(request));
      if (connection.pending >= LIMITS.inflightRequests - (safety ? 0 : 1) || connection.bytes + size > LIMITS.unsentBytes - (safety ? 0 : SAFETY_BYTES)) throw commandError('request_capacity');
      connection.pending++; connection.bytes += size; counted = true;
      if (request.op === 'attach') {
        await this.attach(connection, request); return;
      }
      if (request.op === 'detach') {
        const attachment = connection.attachments.get(request.session);
        if (!attachment || attachment.id !== request.params.attachmentId) throw commandError('forbidden');
        attachment.detach(); connection.attachments.delete(request.session);
        this.options.broker?.detached?.(connection.id, request.session);
        connection.out.send(accepted(request, {})); return;
      }
      const durable = OPERATION_CATALOG[request.op].storage === 'durable';
      const retained = durable && this.options.registry.options.store.request(request.id) !== undefined;
      if (this.stopping() && !retained
        && !['host.status', 'host.logs', 'host.stop', 'host.restart', 'cancel', 'close', 'executions.cancel', 'processes.stop', 'interaction.answer', 'detach', 'host.setup.read', 'host.setup.cancel'].includes(request.op)) throw commandError('busy');
      if (request.op === 'sessions.create' && !retained && this.options.prepareRoot) {
        const payload = canonicalRequestPayload(request);
        preparing = this.rootPreparations.get(request.id);
        if (preparing && preparing.payload !== payload) throw commandError('request_conflict');
        if (!preparing) {
          if (this.rootPreparations.size >= LIMITS.inflightRequests) throw commandError('request_capacity');
          preparing = { payload, work: this.options.prepareRoot(request.params, { id: connection.id, kind: connection.kind, signal: connection.lifetime.signal }) };
          this.rootPreparations.set(request.id, preparing);
          ownsPreparation = true;
        }
        rootPreparation = await preparing.work;
        if (connection.closed) return;
      }
      if (request.session && !retained && this.options.registry.options.store.findSessionMetadata(request.session)?.deletedAt !== undefined
        && request.op !== 'session.delete') throw commandError('not_found');
      const unattached = request.op === 'session.delete' || request.op === 'session.reload';
      if (request.session && !retained && !unattached && !connection.attachments.has(request.session)) throw commandError('forbidden');
      if (request.session && !retained && !unattached) await this.options.registry.restore(request.session);
      if (request.op === 'host.status') { connection.out.send(await this.status(request)); return; }
      if (request.op === 'host.logs' && this.options.management) { connection.out.send(accepted(request, this.options.management.logs(request.params))); return; }
      if (request.op === 'host.setup.answer' || request.op === 'host.setup.cancel') {
        if (!this.options.setup) throw commandError('unavailable');
        if (request.op === 'host.setup.answer') await this.options.setup.answer(request.params.jobId, request.params.promptId, request.params.text, connection.id);
        else this.options.setup.cancel(request.params.jobId, connection.id);
        connection.out.send(accepted(request, {})); return;
      }
      if (!durable) { connection.out.send(await this.commands.read(request, connection.id)); return; }
      const attachment = request.session && connection.attachments.get(request.session);
      const origin = { kind: connection.kind, attachment: attachment ? attachment.id : connection.id };
      admissionAttempt = true;
      const response = await this.admission.submit(request, this.principal, !this.available(connection.capabilities).includes(request.op) ? undefined : command => {
        if ((request.op === 'host.stop' || request.op === 'host.restart') && this.options.management) return this.options.management.lifecycle.prepare(command);
        if (this.stopping() && !safety) throw commandError('busy');
        if (request.op === 'interaction.answer') return this.options.broker!.dispatch(command, { principal: this.principal, kind: connection.kind!, attachment: connection.id,
          interactionKinds: [...connection.interactionKinds], capabilities: [...connection.capabilities] });
        return this.commands.prepare(command, { origin, signal: connection.lifetime.signal, ...(rootPreparation ? { rootPreparation } : {}), invalidateAfterResponse: revisions => deferred.push(revisions) });
      });
      connection.out.send(response, () => { invalidateAfterSend(); this.options.management?.lifecycle.afterResponse(request.id, response.outcome === 'accepted'); });
    } catch (error) {
      let ambiguous = admissionAttempt;
      if (admissionAttempt && id) {
        try { ambiguous = this.options.registry.options.store.request(id)?.phase === 'dispatch_intent'; }
        catch {}
      }
      if (id) connection.out.send(rejected(id, error, ambiguous), invalidateAfterSend);
      else connection.out.close('resync_required');
    } finally {
      if (ownsPreparation && id && this.rootPreparations.get(id) === preparing) this.rootPreparations.delete(id);
      if (counted) { connection.pending--; connection.bytes -= size; }
    }
  }

  /** New work is refused only while the host is draining or has stopped; safety operations stay available. */
  private stopping(): boolean {
    const state = this.options.management?.lifecycle.state;
    return state === 'draining' || state === 'stopped';
  }

  private available(capabilities: readonly string[] = []): Operation[] {
    const operations: Operation[] = ['hello', 'host.status', 'attach', 'detach', ...this.commands.operations];
    if (this.options.management) operations.push('host.stop', 'host.restart', 'host.logs');
    if (this.options.broker) operations.push('interaction.answer');
    return operations.filter(op => op !== 'ui.action' || capabilities.includes('ui.action'));
  }

  private async hello(connection: Connection, request: Extract<ClientEnvelope, { op: 'hello' }>): Promise<void> {
    if (connection.kind) throw commandError('invalid_request');
    if (JSON.stringify(request.params.target) !== JSON.stringify(protocolTarget(this.options.registry.options.owner.target))) throw commandError('target_mismatch');
    connection.kind = request.params.kind;
    connection.capabilities = UI_CAPABILITIES.filter(capability => request.params.capabilities?.includes(capability));
    connection.interactionKinds = this.options.broker?.interactionKinds.filter(kind => request.params.interactionKinds.includes(kind)) ?? [];
    this.options.broker?.connected?.({ principal: this.principal, kind: connection.kind, attachment: connection.id, sessions: [],
      interactionKinds: [...connection.interactionKinds] });
    const composition = await this.currentComposition();
    connection.out.send(accepted(request, { attachmentId: connection.id, principal: this.principal, daemonVersion: this.options.version, protocol: 1,
      identity: this.options.registry.options.owner.identity, ...(composition ? { composition } : {}), operations: this.available(connection.capabilities),
      interactionKinds: connection.interactionKinds, capabilities: connection.capabilities }));
    for (const interaction of this.options.broker?.pending?.() ?? []) this.sendInteraction(connection, interaction);
  }

  private sendInteraction(connection: Connection, interaction: Interaction): void {
    if (connection.closed || !connection.kind
      || !connection.interactionKinds.includes(interaction.request.kind)) return;
    // Session questions reach attached clients through their session projection.
    if (interaction.scope.kind === 'session') return;
    if (this.options.broker?.canReceive) {
      if (!this.options.broker.canReceive(connection.id, interaction)) return;
    } else if (interaction.scope.kind === 'host' || interaction.authority !== undefined) return;
    connection.out.send({ v: 1, interaction });
  }

  private async status(request: ClientEnvelope): Promise<Response> {
    const rows = this.options.registry.listed();
    const composition = await this.currentComposition();
    return accepted(request, { state: this.options.management?.lifecycle.state ?? 'ready', identity: this.options.registry.options.owner.identity, daemonVersion: this.options.version, protocol: 1,
      ...(composition ? { composition } : {}),
      active: { sessions: rows.filter(row => row.state === 'open').length, runs: rows.filter(row => ['running', 'waiting', 'cancelling'].includes(row.run.state)).length,
        work: await this.activeWork(), attachments: [...this.connections].reduce((sum, connection) => sum + connection.attachments.size, 0) }, setupNeeds: this.options.setupNeeds?.() ?? [] });
  }

  /** Everything a restart would interrupt: busy sessions, child executions, processes and unanswered host questions. */
  private async activeWork(): Promise<number> {
    const { registry } = this.options;
    const interactions = (this.options.broker?.pending?.() ?? registry.options.store.interactions())
      .filter(item => item.state === 'waiting' && item.scope.kind === 'host').length;
    return await registry.activeWork() + interactions;
  }

  private async currentComposition(): Promise<HostCompositionInfo | undefined> {
    if (!this.options.composition) return undefined;
    try {
      const current = await this.options.currentComposition?.();
      if (!current) return this.options.composition;
      return { ...this.options.composition, configDigest: current.configDigest,
        ...(current.providerDigest !== this.options.composition.providerDigest ? { restartRequired: true } : {}) };
    } catch { return { ...this.options.composition, restartRequired: true }; }
  }

  private async attach(connection: Connection, request: Extract<ClientEnvelope, { op: 'attach' }>): Promise<void> {
    const { registry } = this.options;
    assertTargetIdentity(registry.options.owner.target, request.params.expected, registry.options.owner.identity);
    if (!registry.options.store.findSessionMetadata(request.session)) {
      await registry.adopt(request.session, { source: connection.kind!, ...(connection.kind === 'tui' ? { interactiveExtensions: true } : {}),
        ...(request.params.requirePolicy === 'acp-strict' ? { policy: { mode: 'acp-strict', generation: 0 } } : {}) });
      if (connection.closed) return;
    }
    await registry.restore(request.session);
    if (connection.closed) return;
    if (request.params.requirePolicy === 'acp-strict') registry.tightenPolicy(registry.options.store.session(request.session).root);
    const binding = await registry.attach(request.session, { principal: this.principal, kind: connection.kind! });
    if (connection.closed) { registry.detach(request.session, binding.attachment); return; }
    connection.attachments.get(request.session)?.detach();
    let unsubscribe = () => {};
    let unsubscribeJson = () => {};
    const attachment: Attachment = { id: binding.attachment, detach: () => { unsubscribe(); unsubscribeJson(); registry.detach(request.session, binding.attachment); } };
    connection.attachments.set(request.session, attachment);
    this.options.broker?.attached?.(connection.id, request.session);
    try {
      unsubscribe = connection.out.attach({ subscribe: listener => registry.subscribe(request.session, listener), snapshot: () => registry.projection(request.session).snapshot() },
        snapshot => accepted(request, { attachmentId: binding.attachment, snapshot }));
      if (!connection.closed && connection.capabilities.includes('native.events')) {
        const session = registry.binding(request.session)!.runtime.session; let sequence = 0;
        const publish = (value: unknown) => {
          try {
            const json = JSON.stringify(value);
            connection.out.send(parseSchema(PresentationEventSchema, { v: 1, session: request.session,
              presentationEvent: { sequence: sequence++, data: JSON.parse(json) } }));
          } catch { connection.out.close('resync_required'); }
        };
        const header = session.sessionManager.getHeader(); if (header) publish(header);
        if (!connection.closed) unsubscribeJson = session.subscribe(event => {
          try { publish(headlessJsonEvent(event)); } catch { connection.out.close('resync_required'); }
        });
      }
    } catch (error) {
      attachment.detach(); connection.attachments.delete(request.session);
      this.options.broker?.detached?.(connection.id, request.session);
      throw error;
    }
  }
}

function rejected(id: string, error: unknown, admissionAttempt = false): Response {
  const candidate: unknown = error !== null && typeof error === 'object' && 'code' in error ? error.code : undefined;
  const code = typeof candidate === 'string' && (ERROR_CODES as readonly string[]).includes(candidate) ? candidate : 'unavailable';
  return { v: 1, re: id, outcome: admissionAttempt && !['request_conflict', 'stale_request'].includes(code) ? 'indeterminate' : 'rejected',
    error: { code, message: diagnosticMessage(error), retryable: false } };
}
