import { randomUUID } from 'node:crypto';
import type { CreateAgentCoreSessionOptions } from '@felan-ai/agent-core';
import {
  INTERACTION_KINDS, parseInteraction, validateInteractionAnswer,
  type Interaction, type InteractionAnswer, type InteractionAuthority, type OperationParams,
} from '@felan-ai/session-protocol';
import type { AdmittedCommand, AdmissionOutcome } from './admission.js';
import { accepted, commandError } from './commands.js';
import type { ControlCommit, DaemonControlStore } from './control-store.js';
import type { SessionRegistry } from './registry.js';

type ClientKind = OperationParams<'hello'>['kind'];
type Request = Interaction['request'];
type Scope = Interaction['scope'];
type Cancellation = Extract<Interaction, { state: 'cancelled' | 'expired' }>['result'];

export interface BrokerClient {
  principal: string;
  kind: ClientKind;
  attachment: string;
  sessions: readonly string[];
  interactionKinds: OperationParams<'hello'>['interactionKinds'];
}

export interface BrokerRequestOptions {
  signal?: AbortSignal;
  timeout?: number;
  deferrable?: boolean;
  transient?: boolean;
  authority?: InteractionAuthority;
}

export type BrokerOutcome =
  | { state: 'answered'; answer: InteractionAnswer }
  | { state: 'cancelled'; reason: Cancellation['reason'] }
  | { state: 'deferred'; interactionId: string };

export interface BrokerOptions {
  store: DaemonControlStore;
  ownerPrincipal?: string;
  publish(interaction: Interaction, revisions: Readonly<Record<string, number>>): void;
  resume?(session: string, answer: InteractionAnswer, continuationId: string, dispatch: () => void): Promise<void>;
  committed?(revisions: Readonly<Record<string, number>>): void;
  now?: () => number;
  onError?(error: unknown): void;
}

interface Waiter {
  resolve(outcome: BrokerOutcome): void;
  cleanup(): void;
  recipient?: string;
}

export class InteractionBroker {
  private readonly clients = new Map<string, BrokerClient>();
  private readonly clientListeners = new Set<() => void>();
  private readonly waiters = new Map<string, Waiter>();
  private readonly transient = new Map<string, Interaction>();
  private readonly continuations = new Map<string, Promise<void>>();
  private readonly continuationLanes = new Map<string, Promise<void>>();
  private readonly now: () => number;
  private readonly ownerPrincipal: string;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private draining = false;
  private failure: unknown;

  constructor(private readonly options: BrokerOptions) {
    this.now = options.now ?? Date.now;
    this.ownerPrincipal = options.ownerPrincipal ?? `local:${options.store.owner.target.uid}:${options.store.owner.target.namespaceId}`;
    for (const item of this.pending()) {
      if (item.scope.kind === 'host' && item.scope.recipient !== undefined) this.cancel(item.id, 'restart');
    }
    this.scheduleExpiry();
  }

  get interactionKinds(): OperationParams<'hello'>['interactionKinds'] {
    return [...INTERACTION_KINDS];
  }

  canPresent(request: Request, scope: Scope, options: Pick<BrokerRequestOptions, 'authority'> = {}): boolean {
    this.assertUsable();
    return !this.draining && [...this.clients.values()].some(client => this.eligible(client, { request, scope,
      ...(options.authority ? { authority: options.authority } : {}) }));
  }

  canReceive(attachment: string, interaction: Interaction): boolean {
    this.assertUsable();
    const client = this.clients.get(attachment);
    return client !== undefined && this.eligible(client, interaction);
  }

  subscribeClients(listener: () => void): () => void {
    this.assertUsable(); this.clientListeners.add(listener);
    return () => { this.clientListeners.delete(listener); };
  }

  private clientsChanged(): void { for (const listener of [...this.clientListeners]) this.safely(listener); }

  connected(client: BrokerClient): void {
    this.assertUsable();
    this.clients.set(client.attachment, structuredClone(client));
    this.clientsChanged();
  }

  attached(attachment: string, session: string): void {
    const client = this.clients.get(attachment);
    if (client && !client.sessions.includes(session)) { client.sessions = [...client.sessions, session]; this.clientsChanged(); }
  }

  detached(attachment: string, session: string): void {
    const client = this.clients.get(attachment);
    if (client) client.sessions = client.sessions.filter(id => id !== session);
    this.cancelUnpresentableOAuth();
    this.clientsChanged();
  }

  disconnected(attachment: string): void {
    this.clients.delete(attachment);
    for (const [id, waiter] of this.waiters) {
      if (waiter.recipient === attachment) this.safely(() => this.cancel(id, 'abort'));
    }
    this.cancelUnpresentableOAuth();
    this.clientsChanged();
  }

  private cancelUnpresentableOAuth(): void {
    for (const item of this.transient.values()) {
      if (![...this.clients.values()].some(client => this.eligible(client, item))) this.cancel(item.id, 'unsupported');
    }
  }

  pending(): Interaction[] {
    return structuredClone([...this.options.store.snapshot().interactions, ...this.transient.values()]
      .filter(item => item.state === 'waiting' || item.state === 'deferred'));
  }

  presentationRequest(id: string, attachment: string): Interaction['request'] {
    this.assertUsable();
    const item = this.find(id); const client = this.clients.get(attachment);
    if (!client || !this.eligible(client, item)
      || !['waiting', 'deferred'].includes(item.state)) throw commandError('forbidden');
    return structuredClone(item.request);
  }

  request(request: Request, scope: Scope, options: BrokerRequestOptions = {}): Promise<BrokerOutcome> {
    this.assertUsable();
    if (this.draining) throw commandError('busy');
    if (options.signal?.aborted) return Promise.resolve({ state: 'cancelled', reason: 'abort' });
    if (options.timeout !== undefined && (!Number.isSafeInteger(options.timeout) || options.timeout < 1)) throw commandError('invalid_request');
    if (options.transient && scope.kind !== 'host') throw commandError('invalid_request');
    if (options.transient && options.deferrable) throw commandError('invalid_request');
    const transient = options.transient === true;
    if (scope.kind === 'session' && this.options.store.session(scope.session).state !== 'open') throw commandError('not_found');
    const createdAt = Math.max(this.now(), this.options.store.snapshot().clock);
    const interaction = parseInteraction({ id: randomUUID(), state: 'waiting', scope, request, createdAt,
      ...(options.deferrable === undefined ? {} : { deferrable: options.deferrable }),
      ...(options.authority ? { authority: options.authority }
        : scope.kind === 'host' ? { authority: 'local-console' } : {}),
      ...(options.timeout === undefined ? {} : { expiresAt: createdAt + options.timeout }) });
    if ((transient || scope.kind === 'host' && scope.recipient !== undefined)
        && ![...this.clients.values()].some(client => this.eligible(client, interaction))) {
      return Promise.resolve({ state: 'cancelled', reason: 'unsupported' });
    }
    const commit = transient ? undefined : this.options.store.putInteraction(interaction);
    if (transient) this.transient.set(interaction.id, interaction);
    const answer = new Promise<BrokerOutcome>(resolve => {
      const abort = () => this.safely(() => this.cancel(interaction.id, 'abort'));
      this.waiters.set(interaction.id, { resolve, cleanup: () => options.signal?.removeEventListener('abort', abort),
        ...(scope.kind === 'host' && scope.recipient !== undefined ? { recipient: scope.recipient } : {}) });
      options.signal?.addEventListener('abort', abort, { once: true });
    });
    this.publish(commit ?? { value: interaction, revisions: {} });
    this.scheduleExpiry();
    return answer;
  }

  dispatch(command: AdmittedCommand, client: Omit<BrokerClient, 'sessions'>): AdmissionOutcome {
    this.assertUsable();
    if (command.request.op !== 'interaction.answer') throw commandError('invalid_request');
    const item = this.find(command.request.params.interactionId);
    const binding = this.clients.get(client.attachment);
    if (!binding || binding.principal !== client.principal || binding.kind !== client.kind || !this.eligible(binding, item)) throw commandError('forbidden');
    const session = item.scope.kind === 'session' ? item.scope.session : undefined;
    if (command.request.session !== session) throw commandError('forbidden');
    if (item.state !== 'waiting' && item.state !== 'deferred' || item.expiresAt !== undefined && item.expiresAt <= this.now()) throw commandError('already_resolved');
    const answer = command.request.params.answer;
    if (!('cancelled' in answer)) validateInteractionAnswer(item, answer);
    command.assertDispatch();
    let continuationId: string | undefined;
    if (this.transient.has(item.id)) {
      command.dispatch(() => {
        const next: Interaction = 'cancelled' in answer
          ? { ...item, state: 'cancelled', resolvedAt: Math.max(this.now(), item.createdAt), result: answer }
          : { ...item, state: 'answered', resolvedAt: Math.max(this.now(), item.createdAt), responder: client.attachment, result: answer };
        this.transient.delete(item.id);
        this.publish({ value: next, revisions: {} });
      });
    } else {
      if (item.state === 'deferred' && !('cancelled' in answer) && item.scope.kind === 'session') continuationId = randomUUID();
      this.publish(this.options.store.answerInteraction(command.request.id, answer, continuationId, client.attachment));
    }
    if (continuationId) this.startContinuation(continuationId);
    this.scheduleExpiry();
    return { response: accepted(command.request, {}) };
  }

  observe(interaction: Interaction): void {
    const waiter = this.waiters.get(interaction.id);
    if (!waiter || interaction.state === 'waiting') return;
    this.waiters.delete(interaction.id);
    waiter.cleanup();
    if (interaction.state === 'deferred') waiter.resolve({ state: 'deferred', interactionId: interaction.id });
    else if (interaction.state === 'answered') waiter.resolve({ state: 'answered', answer: interaction.result });
    else waiter.resolve({ state: 'cancelled', reason: interaction.result.reason });
  }

  async recover(): Promise<void> {
    this.assertUsable();
    this.expire();
    for (const item of this.options.store.snapshot().continuations) {
      if (item.phase === 'ready') this.startContinuation(item.id);
    }
    await Promise.all(this.continuations.values());
    this.assertUsable();
  }

  async drain(): Promise<void> {
    this.assertUsable();
    if (this.draining) {
      await Promise.all(this.continuations.values());
      this.assertUsable();
      return;
    }
    this.draining = true;
    this.clientsChanged(); this.clientListeners.clear();
    for (const item of this.pending()) {
      if (item.deferrable) this.publish(this.options.store.deferInteraction(item.id));
      else this.cancel(item.id, 'drain');
    }
    await Promise.all(this.continuations.values());
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.assertUsable();
  }

  cancel(id: string, reason: Exclude<Cancellation['reason'], 'user'>): void {
    this.assertUsable();
    const item = this.find(id);
    if (item.state !== 'waiting' && item.state !== 'deferred') return;
    if (this.transient.has(item.id)) {
      this.transient.delete(id);
      this.publish({ value: { ...item, state: reason === 'timeout' ? 'expired' : 'cancelled',
        resolvedAt: Math.max(this.now(), item.createdAt), result: { cancelled: true, reason } }, revisions: {} });
    } else this.publish(this.options.store.cancelInteraction(id, reason));
    this.scheduleExpiry();
  }

  approvalExtension(registry: SessionRegistry): NonNullable<CreateAgentCoreSessionOptions['inlineExtensions']>[number] {
    return { name: '@felan-ai/daemon/tool-approvals', hidden: true, factory: pi => {
      pi.on('tool_call', async (event, context) => {
        const sessionId = context.sessionManager.getSessionId();
        const binding = registry.binding(sessionId);
        if (!binding) return { block: true, reason: 'Session is no longer available.' };
        if (!binding.tools.requiresApproval(registry.getPolicy(sessionId), event.toolName)) return;
        const outcome = await this.request({ kind: 'tool_approval', toolCallId: event.toolCallId, toolName: event.toolName,
          summary: `${event.toolName}\n${Buffer.from(JSON.stringify(event.input)).subarray(0, 24_000).toString('utf8')}`,
          options: [{ id: 'allow-once', title: 'Allow once' }, { id: 'reject-once', title: 'Reject' }] },
        { kind: 'session', session: sessionId, root: binding.rootSessionId }, context.signal ? { signal: context.signal } : {});
        if (outcome.state === 'answered' && outcome.answer.kind === 'tool_approval' && outcome.answer.optionId === 'allow-once') return;
        return { block: true, reason: 'Tool execution was not approved.' };
      });
    } };
  }

  private find(id: string): Interaction {
    const item = this.transient.get(id) ?? this.options.store.snapshot().interactions.find(item => item.id === id);
    if (!item) throw commandError('not_found');
    return item;
  }

  private eligible(client: BrokerClient, item: Pick<Interaction, 'request' | 'scope' | 'authority'>): boolean {
    return client.interactionKinds.includes(item.request.kind)
      && (item.authority !== 'owner' || client.principal === this.ownerPrincipal)
      && (item.scope.kind === 'host' ? item.scope.recipient === undefined || item.scope.recipient === client.attachment : client.sessions.includes(item.scope.session));
  }

  private publish(commit: ControlCommit<Interaction>): void {
    this.observe(commit.value);
    this.options.publish(commit.value, commit.revisions);
  }

  private startContinuation(id: string): void {
    if (this.draining || !this.options.resume || this.continuations.has(id)) return;
    const scheduled = this.options.store.snapshot().continuations.find(item => item.id === id);
    if (!scheduled || scheduled.phase !== 'ready') return;
    const previous = this.continuationLanes.get(scheduled.session) ?? Promise.resolve();
    const work = previous.then(async () => {
      if (this.draining) return;
      this.assertUsable();
      const item = this.options.store.snapshot().continuations.find(item => item.id === id);
      if (!item || item.phase !== 'ready') return;
      const interaction = this.find(item.interaction);
      if (interaction.state !== 'answered') throw new Error('Continuation has no committed answer.');
      let dispatched = false;
      try {
        await this.options.resume!(item.session, interaction.result, id, () => {
          const commit = this.options.store.transitionContinuation(id, 'dispatch_intent');
          dispatched = true;
          this.options.committed?.(commit.revisions);
        });
        const commit = this.options.store.transitionContinuation(id, 'completed');
        this.options.committed?.(commit.revisions);
      } catch (error) {
        const phase = this.options.store.snapshot().continuations.find(item => item.id === id)?.phase;
        if (phase === 'ready' && error !== null && typeof error === 'object' && 'code' in error
          && error.code === 'busy') return;
        if (dispatched && phase === 'dispatch_intent') {
          const commit = this.options.store.transitionContinuation(id, 'indeterminate');
          this.options.committed?.(commit.revisions);
        }
        throw error;
      }
    }).catch(error => {
      this.failure = error;
      this.options.onError?.(error);
    }).finally(() => {
      this.continuations.delete(id);
      if (this.continuationLanes.get(scheduled.session) === work) this.continuationLanes.delete(scheduled.session);
    });
    this.continuations.set(id, work);
    this.continuationLanes.set(scheduled.session, work);
  }

  private expire(): void {
    for (const item of this.pending()) {
      if (item.expiresAt !== undefined && item.expiresAt <= this.now()) this.cancel(item.id, 'timeout');
    }
  }

  private scheduleExpiry(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.draining || this.failure) return;
    const deadlines = this.pending().flatMap(item => item.expiresAt === undefined ? [] : [item.expiresAt]);
    if (!deadlines.length) return;
    const delay = Math.min(2_147_483_647, Math.max(0, Math.min(...deadlines) - this.now()));
    this.timer = setTimeout(() => this.safely(() => { this.expire(); this.scheduleExpiry(); }), delay);
    this.timer.unref();
  }

  private safely(effect: () => void): void {
    try { effect(); }
    catch (error) { this.failure = error; this.options.onError?.(error); }
  }

  private assertUsable(): void {
    if (this.failure) throw this.failure;
    this.options.store.owner.assertCurrent();
  }
}

export function createRegistryInteractionBroker(registry: SessionRegistry, options: Pick<BrokerOptions, 'ownerPrincipal'> = {}): InteractionBroker {
  return new InteractionBroker({ store: registry.options.store,
    ...(options.ownerPrincipal === undefined ? {} : { ownerPrincipal: options.ownerPrincipal }),
    publish: (interaction, revisions) => registry.publishInteraction(interaction, revisions),
    committed: revisions => registry.publishCommitted(revisions),
    resume: (session, answer, id, dispatch) => registry.resumeInteraction(session, answer, id, dispatch),
  });
}
