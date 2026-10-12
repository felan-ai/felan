import { randomUUID } from 'node:crypto';
import type { Socket } from 'node:net';
import type { ModelRuntime } from '@felan-ai/agent-core';
import { BootstrapHelloSchema, ERROR_CODES, HEADLESS_JSON_PRESENTER, IdSchema, JsonLineDecoder, LIMITS, OPERATION_CATALOG, PresentationEventSchema, RUNTIME_UI_PRESENTER, canonicalRequestPayload, parseClientEnvelope, parseControlRequest, parseControlResponse,
  parseSchema, validateClientEligibility, type ClientEnvelope, type Interaction, type Operation, type OperationParams, type OperationResult, type Response } from '@felan-ai/session-protocol';
import { OrderedAdmission, type AdmittedCommand, type AdmissionOutcome } from './admission.js';
import { accepted, commandError, SessionCommands, type RootPreparation } from './commands.js';
import type { DaemonConfiguration } from './configuration.js';
import { SessionFanout } from './fanout.js';
import { listenLocalIpc, type LocalIpcListener } from './ipc.js';
import type { SessionRegistry } from './registry.js';
import { assertTargetIdentity, protocolTarget } from './target.js';
import type { BrokerClient } from './broker.js';
import type { HostLifecycle } from './lifecycle.js';
import type { DaemonTuiPreferences } from './tui-preferences.js';
import type { HostSetupManager } from '../setup/manager.js';
import { headlessJsonEvent } from './headless-json.js';

type Kind = OperationParams<'hello'>['kind'];
export interface BrokerDispatchPort {
  interactionKinds: OperationParams<'hello'>['interactionKinds'];
  presenters: OperationParams<'hello'>['presenters'];
  dispatch(command: AdmittedCommand, client: { principal: string; kind: Kind; attachment: string;
    interactionKinds: OperationParams<'hello'>['interactionKinds']; presenters: OperationParams<'hello'>['presenters'] }): AdmissionOutcome | Promise<AdmissionOutcome>;
  connected?(client: BrokerClient): void;
  attached?(attachment: string, session: string): void;
  detached?(attachment: string, session: string): void;
  disconnected?(attachment: string): void;
  observe?(interaction: Interaction): void;
  pending?(): Interaction[];
}
export interface SessionServerOptions {
  registry: SessionRegistry;
  configuration: DaemonConfiguration;
  models: Pick<ModelRuntime, 'getAvailable'>;
  version: string;
  preferences?: DaemonTuiPreferences;
  setup?: HostSetupManager;
  prepareOpenInteraction?(id: string, client: string, signal: AbortSignal): () => Promise<void>;
  broker?: BrokerDispatchPort;
  management?: { lifecycle: HostLifecycle; logs(params: OperationParams<'host.logs'>): OperationResult<'host.logs'> };
  setupNeeds?(): OperationResult<'host.status'>['setupNeeds'];
  prepareRoot?(params: OperationParams<'sessions.create'>, caller: { id: string; kind: Kind; signal: AbortSignal }): Promise<RootPreparation>;
  now?: () => number;
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
  presenters: OperationParams<'hello'>['presenters'];
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
    this.admission = new OrderedAdmission(registry.options.store, { ...(options.now ? { now: options.now } : {}), committed: revisions => this.invalidate(revisions), dispatched: revisions => registry.publishCommitted(revisions) });
    this.unbindCommands = registry.bindCommandDispatcher(() => true);
    this.unbindInvalidation = registry.subscribeInvalidation(revisions => this.invalidate(revisions));
    this.unbindBroker = registry.subscribeInteractions(interaction => {
      options.broker?.observe?.(interaction);
      if (interaction.scope.kind === 'host' || interaction.request.kind === 'oauth') {
        for (const connection of this.connections) this.sendInteraction(connection, interaction);
      }
    });
  }

  async start(): Promise<void> {
    if (this.listener || this.stopped || this.starting) throw new Error('Session server is already started or closed.');
    this.starting = true;
    try {
      this.listener = await listenLocalIpc(this.options.registry.options.owner, socket => this.accept(socket));
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

  private accept(socket: Socket): void {
    if (this.stopped) { socket.destroy(); return; }
    const connection: Connection = { id: randomUUID(), socket, closed: false, pending: 0, bytes: 0, attachments: new Map(), interactionKinds: [], presenters: [], lifetime: new AbortController(),
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
        const request = parseControlRequest(frame, this.options.now?.());
        assertTargetIdentity(this.options.registry.options.owner.target, request.params.expected, this.options.registry.options.owner.identity);
        let result: Response | undefined;
        if (request.op !== 'host.status' && this.options.management) {
          const command = parseClientEnvelope({ v: 1, id: request.id, op: request.op, params: request.params }, { now: this.options.now?.() ?? Date.now() });
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
      const request = parseClientEnvelope(frame, { checkFreshness: false });
      if (OPERATION_CATALOG[request.op].storage === 'connection') parseClientEnvelope(frame, { now: this.options.now?.() ?? Date.now() });
      if (request.op === 'hello') { this.hello(connection, request); return; }
      if (!connection.kind) throw commandError('forbidden');
      validateClientEligibility(request, connection.kind);
      const safety = ['cancel', 'agents.cancel', 'close', 'interaction.answer', 'processes.stop', 'host.stop', 'host.restart', 'host.setup.cancel'].includes(request.op);
      size = Buffer.byteLength(JSON.stringify(request));
      if (connection.pending >= LIMITS.inflightRequests - (safety ? 0 : 1) || connection.bytes + size > LIMITS.unsentBytes - (safety ? 0 : LIMITS.answerBytes)) throw commandError('request_capacity');
      connection.pending++; connection.bytes += size; counted = true;
      if (request.op === 'attach') {
        if (this.options.management && this.options.management.lifecycle.state !== 'ready') throw commandError('busy');
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
      const retained = durable && this.options.registry.options.store.snapshot().requests.some(item => item.id === request.id);
      if (this.options.management && this.options.management.lifecycle.state !== 'ready' && !retained
        && !['host.status', 'host.logs', 'host.stop', 'host.restart', 'cancel', 'close', 'agents.cancel', 'processes.stop', 'interaction.answer', 'detach', 'host.setup.read', 'host.setup.cancel'].includes(request.op)) throw commandError('busy');
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
      if (request.session && !retained && this.options.registry.options.store.snapshot().sessions.some(session => session.id === request.session && session.deletedAt !== undefined)
        && request.op !== 'session.delete') throw commandError('not_found');
      if (request.session && !retained && request.op !== 'session.adopt' && request.op !== 'session.delete' && !connection.attachments.has(request.session)) throw commandError('forbidden');
      if (request.session && !retained && !['session.adopt', 'session.delete'].includes(request.op)) await this.options.registry.restore(request.session);
      if (request.op === 'host.status') { connection.out.send(this.status(request)); return; }
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
      const response = await this.admission.submit(request, this.principal, !this.available(connection.kind).includes(request.op) ? undefined : command => {
        if ((request.op === 'host.stop' || request.op === 'host.restart') && this.options.management) return this.options.management.lifecycle.prepare(command);
        if (this.options.management && this.options.management.lifecycle.state !== 'ready' && !safety) throw commandError('busy');
        if (request.op === 'interaction.answer') return this.options.broker!.dispatch(command, { principal: this.principal, kind: connection.kind!, attachment: connection.id,
          interactionKinds: [...connection.interactionKinds], presenters: structuredClone(connection.presenters) });
        return this.commands.prepare(command, { origin, signal: connection.lifetime.signal, ...(rootPreparation ? { rootPreparation } : {}), invalidateAfterResponse: revisions => deferred.push(revisions) });
      });
      connection.out.send(response, () => { invalidateAfterSend(); this.options.management?.lifecycle.afterResponse(request.id, response.outcome === 'accepted'); });
    } catch (error) {
      let ambiguous = admissionAttempt;
      if (admissionAttempt && id) {
        try { ambiguous = this.options.registry.options.store.snapshot().requests.find(record => record.id === id)?.phase === 'dispatch_intent'; }
        catch {}
      }
      if (id) connection.out.send(rejected(id, error, ambiguous), invalidateAfterSend);
      else connection.out.close('resync_required');
    } finally {
      if (ownsPreparation && id && this.rootPreparations.get(id) === preparing) this.rootPreparations.delete(id);
      if (counted) { connection.pending--; connection.bytes -= size; }
    }
  }

  private available(kind: Kind): Operation[] {
    const operations: Operation[] = ['hello', 'host.status', 'attach', 'detach', ...this.commands.operations];
    if (this.options.management) operations.push('host.stop', 'host.restart', 'host.logs');
    if (this.options.broker) operations.push('interaction.answer');
    return operations.filter(op => OPERATION_CATALOG[op].clients.includes(kind));
  }

  private hello(connection: Connection, request: Extract<ClientEnvelope, { op: 'hello' }>): void {
    if (connection.kind) throw commandError('invalid_request');
    if (JSON.stringify(request.params.target) !== JSON.stringify(protocolTarget(this.options.registry.options.owner.target))) throw commandError('target_mismatch');
    connection.kind = request.params.kind;
    connection.interactionKinds = this.options.broker?.interactionKinds.filter(kind => request.params.interactionKinds.includes(kind)) ?? [];
    connection.presenters = [RUNTIME_UI_PRESENTER, ...(connection.kind === 'headless' ? [HEADLESS_JSON_PRESENTER] : []), ...(this.options.broker?.presenters ?? [])]
      .filter(presenter => request.params.presenters.some(item => item.id === presenter.id && item.version === presenter.version));
    this.options.broker?.connected?.({ principal: this.principal, kind: connection.kind, attachment: connection.id, sessions: [],
      interactionKinds: [...connection.interactionKinds], presenters: structuredClone(connection.presenters) });
    connection.out.send(accepted(request, { attachmentId: connection.id, principal: this.principal, daemonVersion: this.options.version, protocol: 1,
      identity: this.options.registry.options.owner.identity, operations: this.available(connection.kind),
      interactionKinds: connection.interactionKinds, presenters: connection.presenters }));
    for (const interaction of this.options.broker?.pending?.() ?? []) this.sendInteraction(connection, interaction);
  }

  private sendInteraction(connection: Connection, interaction: Interaction): void {
    if (connection.closed || !connection.kind || !interaction.eligibleClientKinds.includes(connection.kind)
      || !connection.interactionKinds.includes(interaction.request.kind)) return;
    if (interaction.scope.kind === 'session' && (interaction.request.kind !== 'oauth' || !connection.attachments.has(interaction.scope.session))) return;
    if (interaction.scope.kind === 'host' && (connection.kind !== 'tui'
      || interaction.scope.recipient !== undefined && interaction.scope.recipient !== connection.id)) return;
    if (interaction.request.kind === 'custom' && !connection.presenters.some(p => interaction.request.kind === 'custom'
      && p.id === interaction.request.presenter.id && p.version === interaction.request.presenter.version)) return;
    connection.out.send({ v: 1, interaction });
  }

  private status(request: ClientEnvelope): Response {
    const rows = this.options.registry.list();
    return accepted(request, { state: this.options.management?.lifecycle.state ?? 'ready', identity: this.options.registry.options.owner.identity, daemonVersion: this.options.version, protocol: 1,
      active: { sessions: rows.filter(row => row.state === 'open').length, runs: rows.filter(row => ['running', 'waiting', 'cancelling'].includes(row.run.state)).length,
        attachments: [...this.connections].reduce((sum, connection) => sum + connection.attachments.size, 0) }, setupNeeds: this.options.setupNeeds?.() ?? [] });
  }

  private async attach(connection: Connection, request: Extract<ClientEnvelope, { op: 'attach' }>): Promise<void> {
    const { registry } = this.options;
    assertTargetIdentity(registry.options.owner.target, request.params.expected, registry.options.owner.identity);
    await registry.restore(request.session);
    if (connection.closed) return;
    if (connection.kind === 'acp' || request.params.requirePolicy === 'acp-strict') registry.tightenPolicy(registry.options.store.session(request.session).root);
    if (request.params.policyWaitMs) await this.waitForPolicy(connection, request.session, request.params.policyWaitMs);
    if (connection.closed) return;
    if (connection.attachments.size >= LIMITS.pageEntries && !connection.attachments.has(request.session)) throw commandError('request_capacity');
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
      if (!connection.closed && connection.presenters.some(p => p.id === HEADLESS_JSON_PRESENTER.id && p.version === HEADLESS_JSON_PRESENTER.version)) {
        const session = registry.binding(request.session)!.runtime.session; let sequence = 0;
        const publish = (value: unknown) => {
          try {
            const json = JSON.stringify(value);
            if (Buffer.byteLength(json) > LIMITS.pageBytes) throw new Error('Headless event exceeds its bound.');
            connection.out.send(parseSchema(PresentationEventSchema, { v: 1, session: request.session,
              presentationEvent: { presenter: HEADLESS_JSON_PRESENTER, sequence: sequence++, data: JSON.parse(json) } }));
          } catch { connection.out.close('resync_required'); }
        };
        const header = session.sessionManager.getHeader(); if (header) publish(header);
        if (!connection.closed) unsubscribeJson = session.subscribe(event => {
          try { publish(headlessJsonEvent(event)); } catch { connection.out.close('resync_required'); }
        });
      }
      for (const interaction of this.options.broker?.pending?.() ?? []) {
        if (interaction.scope.kind === 'session' && interaction.scope.session === request.session) this.sendInteraction(connection, interaction);
      }
    } catch (error) {
      attachment.detach(); connection.attachments.delete(request.session);
      this.options.broker?.detached?.(connection.id, request.session);
      throw error;
    }
  }

  private async waitForPolicy(connection: Connection, id: string, ms: number): Promise<void> {
    const { registry } = this.options;
    if (!registry.options.store.session(id).policy.pending) return;
    await new Promise<void>(resolve => {
      let unsubscribe = () => {}; let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = () => { clearTimeout(timer); unsubscribe(); connection.socket.off('close', finish); resolve(); };
      unsubscribe = registry.subscribe(id, () => { if (!registry.options.store.session(id).policy.pending) finish(); });
      connection.socket.once('close', finish); timer = setTimeout(finish, ms);
      if (!registry.options.store.session(id).policy.pending || connection.closed) finish();
    });
  }
}

function rejected(id: string, error: unknown, admissionAttempt = false): Response {
  const candidate: unknown = error !== null && typeof error === 'object' && 'code' in error ? error.code : undefined;
  const code = typeof candidate === 'string' && (ERROR_CODES as readonly string[]).includes(candidate) ? candidate : 'unavailable';
  return { v: 1, re: id, outcome: admissionAttempt && !['request_conflict', 'stale_request'].includes(code) ? 'indeterminate' : 'rejected',
    error: { code, message: 'Operation is unavailable or could not be completed.', retryable: false } };
}
