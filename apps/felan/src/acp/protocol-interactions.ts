import { methods, type AgentContext, type ElicitationSchema, type ElicitationPropertySchema, type RequestPermissionResponse } from '@agentclientprotocol/sdk';
import { validateInteractionAnswer, validateUiAction, type Interaction, type InteractionAnswer, type UiInput, type UiPresentation, type UiValues } from '@felan-ai/session-protocol';
import type { SessionClient } from '../client/client.js';
import { GENERIC_UI_CAPABILITIES, presentUiElement, presentUiForm, presentationText, uiCapability, uiText, type GenericUiDriver } from '../client/ui.js';
import { accepted } from './daemon-session.js';
import type { AcpProtocolUpdates } from './protocol-updates.js';

export const ACP_UI_CAPABILITIES = GENERIC_UI_CAPABILITIES;

export function genericElicitationSchema(input: UiInput): ElicitationSchema {
  const properties: Record<string, ElicitationPropertySchema> = Object.create(null);
  for (const field of input.fields) {
    const common = { title: uiText(field.label), ...(input.defaults && Object.hasOwn(input.defaults, field.id) ? { default: input.defaults[field.id] } : {}) };
    switch (field.kind) {
      case 'string': properties[field.id] = { ...common, type: 'string', maxLength: field.maxLength, ...(field.placeholder ? { description: uiText(field.placeholder) } : {}) }; break;
      case 'number': properties[field.id] = { ...common, type: 'number', ...(field.minimum === undefined ? {} : { minimum: field.minimum }), ...(field.maximum === undefined ? {} : { maximum: field.maximum }) }; break;
      case 'boolean': properties[field.id] = { ...common, type: 'boolean' }; break;
      case 'enum': properties[field.id] = { ...common, type: 'string', oneOf: field.options.map(option => ({ const: option.id, title: uiText(option.label) })) }; break;
      case 'multi_select': properties[field.id] = { ...common, type: 'array', items: { type: 'string', enum: field.options.map(option => option.id) }, maxItems: field.maxSelections, uniqueItems: true }; break;
    }
  }
  return { type: 'object', properties, required: input.fields.filter(field => field.required).map(field => field.id) };
}

export class AcpProtocolInteractions {
  readonly #pending = new Map<string, AbortController>();
  readonly #attempted = new Set<string>();
  readonly #elements = new Map<string, { fingerprint: string; controller: AbortController }>();
  readonly #seenElements = new Map<string, string>();
  readonly #displayed = new Map<string, string>();
  readonly #submitting = new Set<AbortController>();
  #closed = false;
  #detached = 0;

  constructor(
    readonly daemon: SessionClient,
    readonly session: string,
    readonly client: AgentContext,
    readonly updates: AcpProtocolUpdates,
    readonly supportsForms: boolean,
    readonly report: (error: unknown) => void,
    readonly handlesHostInteractions: () => boolean = () => true,
  ) {}

  reconcile(): void {
    if (this.#closed) return;
    const attachment = this.daemon.getAttachment(this.session);
    if (this.daemon.status !== 'ready' || attachment?.state.status !== 'live') {
      for (const [id, controller] of this.#pending) {
        if (!this.#submitting.has(controller)) { controller.abort(); this.#pending.delete(id); }
      }
      for (const [id, value] of this.#elements) {
        if (!this.#submitting.has(value.controller)) { value.controller.abort(); this.#elements.delete(id); }
      }
      this.#attempted.clear(); this.#seenElements.clear(); this.#displayed.clear();
      for (const id of this.#pending.keys()) this.#attempted.add(id);
      for (const [id, value] of this.#elements) this.#seenElements.set(id, value.fingerprint);
      return;
    }
    const capabilities = this.daemon.capabilities;
    const interactions = this.daemon.getInteractions({ includeSessions: true }).filter(item =>
      (item.scope.kind === 'host' ? this.handlesHostInteractions() : item.scope.session === this.session)
      && capabilities?.interactionKinds.includes(item.request.kind));
    const waiting = new Set(interactions.map(item => item.id));
    for (const [id, controller] of this.#pending) if (!waiting.has(id) && !this.#submitting.has(controller)) { controller.abort(); this.#pending.delete(id); }
    for (const id of this.#attempted) if (!waiting.has(id)) this.#attempted.delete(id);
    for (const interaction of interactions) {
      if (this.#attempted.has(interaction.id) || this.#pending.has(interaction.id) || this.#pending.size >= 32 || this.#detached >= 128) continue;
      this.#attempted.add(interaction.id);
      const controller = new AbortController();
      this.#pending.set(interaction.id, controller);
      void this.answer(interaction, controller).catch(error => { if (!controller.signal.aborted) this.report(error); })
        .finally(() => { if (this.#pending.get(interaction.id) === controller) this.#pending.delete(interaction.id); this.reconcile(); });
    }
    this.reconcileElements(attachment.state.snapshot?.presentation ?? []);
  }

  close(): void {
    this.#closed = true;
    for (const controller of this.#pending.values()) controller.abort();
    this.#pending.clear(); this.#attempted.clear();
    for (const value of this.#elements.values()) value.controller.abort();
    this.#elements.clear(); this.#seenElements.clear(); this.#displayed.clear();
  }

  private async answer(interaction: Interaction, controller: AbortController): Promise<void> {
    const signal = controller.signal;
    const request = interaction.request;
    let answer: InteractionAnswer | { cancelled: true; reason: 'user' } | undefined;
    if (request.kind === 'tool_approval') {
      const response = await this.race(this.client.request<RequestPermissionResponse>(methods.client.session.requestPermission, {
        sessionId: this.session,
        toolCall: { toolCallId: this.updates.toolId(request.toolCallId), title: request.toolName, kind: 'other', status: 'pending',
          content: [{ type: 'content', content: { type: 'text', text: request.summary } }] },
        options: request.options.map(option => ({ optionId: option.id, name: option.title,
          kind: /^(allow|approve)/u.test(option.id) ? 'allow_once' as const : 'reject_once' as const })),
      }, { cancellationSignal: signal }), signal);
      if (response?.outcome.outcome === 'selected') answer = { kind: 'tool_approval', optionId: response.outcome.optionId };
      else if (response?.outcome.outcome === 'cancelled') answer = { cancelled: true, reason: 'user' };
    } else if (this.supportsForms) {
      if (request.kind === 'form') {
        const result = await presentUiForm(request.form, this.genericDriver(), signal);
        if (result) answer = result;
        else if (!signal.aborted) answer = { cancelled: true, reason: 'user' };
      } else if (request.kind === 'select') {
        const schema: ElicitationSchema = { type: 'object', properties: { value: request.multiple
          ? { type: 'array', items: { type: 'string', enum: request.choices.map(choice => choice.id) } }
          : { type: 'string', enum: request.choices.map(choice => choice.id) } }, required: ['value'] };
        const result = await this.elicit(request.title, schema, signal);
        if (result === null) answer = { cancelled: true, reason: 'user' };
        else if (result) answer = { kind: 'select', choices: Array.isArray(result.value) ? result.value as string[] : [result.value as string] };
      } else if (request.kind === 'confirm' || request.kind === 'dependency') {
        const title = request.kind === 'confirm' ? request.title : request.dependency;
        const result = await this.elicit(`${title}\n\n${request.message}`, { type: 'object', properties: { value: { type: 'boolean' } }, required: ['value'] }, signal);
        if (result === null) answer = { cancelled: true, reason: 'user' };
        else if (result) answer = request.kind === 'confirm' ? { kind: 'confirm', confirmed: result.value as boolean }
          : { kind: 'dependency', approved: result.value as boolean };
      } else if (request.kind === 'input' || request.kind === 'editor') {
        const result = await this.elicit(request.title, { type: 'object', properties: { value: { type: 'string', maxLength: 32 * 1024,
          ...(request.initialValue === undefined ? {} : { default: request.initialValue }),
          ...(request.kind === 'input' && request.placeholder ? { description: request.placeholder } : {}) } }, required: ['value'] }, signal);
        if (result === null) answer = { cancelled: true, reason: 'user' };
        else if (result) answer = { kind: request.kind, text: result.value as string };
      }
    }
    if (signal.aborted || this.#closed || !answer) return;
    if (this.daemon.status !== 'ready' || !this.daemon.getInteractions({ includeSessions: true }).some(current => current.id === interaction.id
      && JSON.stringify(current.request) === JSON.stringify(interaction.request)
      && JSON.stringify(current.scope) === JSON.stringify(interaction.scope) && current.authority === interaction.authority)) return;
    if (!('cancelled' in answer)) validateInteractionAnswer(interaction, answer);
    this.#submitting.add(controller);
    try { accepted(await this.daemon.request('interaction.answer', { interactionId: interaction.id, answer },
      interaction.scope.kind === 'session' ? { session: interaction.scope.session } : undefined)); }
    finally { this.#submitting.delete(controller); }
  }

  private genericDriver(): GenericUiDriver {
    return {
      choose: async (message, options, signal) => {
        const result = await this.elicit(message, { type: 'object', properties: {
          choice: { type: 'string', oneOf: options.map(option => ({ const: option.id, title: option.label })) },
        }, required: ['choice'] }, signal);
        if (!result) return undefined;
        if (typeof result.choice !== 'string' || !options.some(option => option.id === result.choice)) throw new Error('Invalid generic UI choice.');
        return result.choice;
      },
      fields: async (message, input, signal) => {
        if (!input.fields.length) return {};
        const result = await this.elicit(message, genericElicitationSchema(input), signal);
        return result ? result as UiValues : undefined;
      },
      display: async message => { this.updates.send({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `${message}\n` } }); await this.updates.flush(); },
    };
  }

  private reconcileElements(values: readonly unknown[]): void {
    const presentations = values.filter((item): item is UiPresentation => typeof item === 'object' && item !== null && 'kind' in item
      && ['document', 'view', 'progress', 'status'].includes(String(item.kind)));
    for (const [id, value] of this.#elements) {
      if (!this.#submitting.has(value.controller) && !presentations.some(element => element.id === id && JSON.stringify(element) === value.fingerprint)) {
        value.controller.abort(); this.#elements.delete(id);
      }
    }
    for (const id of this.#seenElements.keys()) if (!presentations.some(element => element.id === id)) this.#seenElements.delete(id);
    for (const id of this.#displayed.keys()) if (!presentations.some(element => element.id === id)) this.#displayed.delete(id);
    for (const element of presentations) {
      const fingerprint = JSON.stringify(element);
      if (this.#seenElements.get(element.id) === fingerprint || this.#elements.has(element.id) || this.#pending.size + this.#elements.size >= 32 || this.#detached >= 128) continue;
      const passive = element.kind === 'status' || !element.actions.length ? presentationText(element) : undefined;
      if (passive !== undefined && this.#displayed.get(element.id) === passive) {
        this.#seenElements.set(element.id, fingerprint); continue;
      }
      this.#seenElements.set(element.id, fingerprint);
      const controller = new AbortController();
      this.#elements.set(element.id, { fingerprint, controller });
      const signal = controller.signal;
      void (async () => {
        const driver = this.genericDriver();
        const capabilities = this.daemon.capabilities;
        const interactive = this.supportsForms && capabilities?.capabilities?.includes(uiCapability(element))
          && capabilities.capabilities.includes('ui.action') && capabilities.operations.includes('ui.action');
        if (element.kind === 'status') {
          await driver.display(passive!, signal);
          if (!signal.aborted) this.#displayed.set(element.id, passive!);
          return;
        }
        const action = await presentUiElement(element, driver, signal, Boolean(interactive));
        if (passive !== undefined && !signal.aborted) this.#displayed.set(element.id, passive);
        if (!action || signal.aborted || this.#closed || this.daemon.status !== 'ready') return;
        const current = this.daemon.getAttachment(this.session)?.state;
        const source = current?.status === 'live' ? current.snapshot?.presentation.find(item => item.id === element.id && item.kind === element.kind) : undefined;
        if (!source || !('revision' in source) || source.revision !== element.revision) return;
        validateUiAction(element, action);
        this.#submitting.add(controller);
        try { accepted(await this.daemon.request('ui.action', action, { session: this.session })); }
        finally { this.#submitting.delete(controller); }
      })().catch(error => { if (!signal.aborted && !this.#closed) this.report(error); })
        .finally(() => { if (this.#elements.get(element.id)?.controller === controller) this.#elements.delete(element.id); this.reconcile(); });
    }
  }

  private async elicit(message: string, requestedSchema: ElicitationSchema, signal: AbortSignal): Promise<Record<string, unknown> | null | undefined> {
    const response = await this.race(this.client.request(methods.client.elicitation.create,
      { mode: 'form', sessionId: this.session, message, requestedSchema }, { cancellationSignal: signal }), signal);
    if (!response) return undefined;
    if (response.action !== 'accept') return null;
    return response.content as Record<string, unknown>;
  }

  private async race<T>(request: Promise<T>, signal: AbortSignal): Promise<T | undefined> {
    this.#detached++;
    void request.then(() => { this.#detached--; }, () => { this.#detached--; });
    let abort = () => {};
    try {
      return await Promise.race([request, new Promise<undefined>(resolve => {
        abort = () => resolve(undefined);
        if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
      })]);
    } finally { signal.removeEventListener('abort', abort); }
  }
}
