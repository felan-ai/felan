import { methods, type AgentContext, type ElicitationSchema, type RequestPermissionResponse } from '@agentclientprotocol/sdk';
import { validateInteractionAnswer, type Interaction, type InteractionAnswer } from '@felan-ai/session-protocol';
import type { SessionClient } from '../client/client.js';
import { accepted } from './daemon-session.js';
import type { AcpProtocolUpdates } from './protocol-updates.js';

export class AcpProtocolInteractions {
  readonly #pending = new Map<string, AbortController>();
  readonly #attempted = new Set<string>();
  #closed = false;
  #detached = 0;

  constructor(
    readonly daemon: SessionClient,
    readonly session: string,
    readonly client: AgentContext,
    readonly updates: AcpProtocolUpdates,
    readonly supportsForms: boolean,
    readonly report: (error: unknown) => void,
  ) {}

  reconcile(): void {
    if (this.#closed) return;
    const interactions = this.daemon.getInteractions({ includeSessions: true }).filter(item => item.scope.kind === 'session' && item.scope.session === this.session);
    const waiting = new Set(interactions.map(item => item.id));
    for (const [id, controller] of this.#pending) if (!waiting.has(id)) { controller.abort(); this.#pending.delete(id); }
    for (const id of this.#attempted) if (!waiting.has(id)) this.#attempted.delete(id);
    for (const interaction of interactions) {
      if (this.#attempted.has(interaction.id) || this.#pending.size >= 32 || this.#detached >= 128) continue;
      this.#attempted.add(interaction.id);
      const controller = new AbortController();
      this.#pending.set(interaction.id, controller);
      void this.answer(interaction, controller).catch(error => { if (!controller.signal.aborted) this.report(error); })
        .finally(() => { if (this.#pending.get(interaction.id) === controller) this.#pending.delete(interaction.id); });
    }
  }

  close(): void {
    this.#closed = true;
    for (const controller of this.#pending.values()) controller.abort();
    this.#pending.clear(); this.#attempted.clear();
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
      if (request.kind === 'select') {
        const schema: ElicitationSchema = { type: 'object', properties: { value: request.multiple
          ? { type: 'array', items: { type: 'string', enum: request.choices.map(choice => choice.id) } }
          : { type: 'string', enum: request.choices.map(choice => choice.id) } }, required: ['value'] };
        const result = await this.elicit(request.title, schema, signal);
        if (result === null) answer = { cancelled: true, reason: 'user' };
        else if (result) answer = { kind: 'select', choices: Array.isArray(result.value) ? result.value as string[] : [result.value as string] };
      } else if (request.kind === 'confirm') {
        const result = await this.elicit(`${request.title}\n\n${request.message}`, { type: 'object', properties: { value: { type: 'boolean' } }, required: ['value'] }, signal);
        if (result === null) answer = { cancelled: true, reason: 'user' };
        else if (result) answer = { kind: 'confirm', confirmed: result.value as boolean };
      } else if (request.kind === 'input' || request.kind === 'editor') {
        const result = await this.elicit(request.title, { type: 'object', properties: { value: { type: 'string', maxLength: 32 * 1024,
          ...(request.initialValue === undefined ? {} : { default: request.initialValue }),
          ...(request.kind === 'input' && request.placeholder ? { description: request.placeholder } : {}) } }, required: ['value'] }, signal);
        if (result === null) answer = { cancelled: true, reason: 'user' };
        else if (result) answer = { kind: request.kind, text: result.value as string };
      } else if (request.kind === 'ask_user') {
        const answers: Extract<InteractionAnswer, { kind: 'ask_user' }>['answers'] = [];
        for (const question of request.questions) {
          const properties: ElicitationSchema['properties'] = {};
          if (question.options?.length) properties.choices = question.allowMultiple
            ? { type: 'array', items: { type: 'string', enum: question.options.map(option => option.id) } }
            : { type: 'string', enum: question.options.map(option => option.id) };
          if (question.allowFreeform !== false) properties.text = { type: 'string', maxLength: 32 * 1024 };
          if (question.allowComment) properties.comment = { type: 'string', maxLength: 32 * 1024 };
          const labels = question.options?.map(option => `${option.id}: ${option.title}${option.description ? ` — ${option.description}` : ''}`).join('\n');
          const result = await this.elicit([question.header, question.context, question.question, labels].filter(Boolean).join('\n\n'), { type: 'object', properties }, signal);
          if (!result) { if (result === null) answer = { cancelled: true, reason: 'user' }; break; }
          answers.push({ questionId: question.id, choices: result.choices === undefined ? [] : Array.isArray(result.choices) ? result.choices as string[] : [result.choices as string],
            ...(typeof result.text === 'string' ? { text: result.text } : {}), ...(typeof result.comment === 'string' ? { comment: result.comment } : {}) });
        }
        if (answers.length === request.questions.length) answer = { kind: 'ask_user', answers };
      }
    }
    if (signal.aborted || this.#closed || !answer) return;
    if (!('cancelled' in answer)) validateInteractionAnswer(interaction, answer);
    accepted(await this.daemon.request('interaction.answer', { interactionId: interaction.id, answer }, { session: this.session }));
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
