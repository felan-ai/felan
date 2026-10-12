import { stripVTControlCharacters } from 'node:util';
import type { ExtensionContext } from '@felan-ai/agent-core';
import type { AskUserRequest } from '@felan-ai/ext-ask-user';
import { createTuiAskUserPresenter, type AskUserPresenterUi } from '@felan-ai/ext-ask-user/tui';
import {
  LIMITS, PresenterSchema, RUNTIME_UI_PRESENTER, parseInteraction, parseRuntimeUiState, parseSchema, validateInteractionAnswer,
  type Interaction, type InteractionAnswer, type JsonValue, type Presentation,
} from '@felan-ai/session-protocol';

type Presenter = { id: string; version: string };
type CustomHandler = (data: JsonValue, signal: AbortSignal, document?: JsonValue, interaction?: Interaction) => Promise<JsonValue | undefined>;
export interface PresentationUpdates {
  read(): readonly Presentation[];
  subscribe(listener: () => void): () => void;
}
export type PresentationUpdatesSource = PresentationUpdates | ((interaction: Interaction) => PresentationUpdates);

export function interactionUpdates(source: PresentationUpdatesSource, interaction?: Interaction): PresentationUpdates {
  if (typeof source !== 'function') return source;
  if (!interaction) throw new Error('Presentation requires its interaction scope.');
  return source(interaction);
}
export type InteractionPresenterUi = Omit<AskUserPresenterUi, 'input'> & Pick<ExtensionContext['ui'], 'confirm'> & {
  input(title: string, placeholder?: string, options?: NonNullable<Parameters<AskUserPresenterUi['input']>[2]> & { initialValue?: string }): Promise<string | undefined>;
  editor(title: string, initialValue: string, options: { signal: AbortSignal; timeout?: number }): Promise<string | undefined>;
};
export type InteractionPresentation =
  | { state: 'answered'; answer: InteractionAnswer }
  | { state: 'cancelled'; reason: 'user' | 'abort' | 'timeout' }
  | { state: 'unsupported'; message: string };

export class ClientInteractionPresenters {
  private readonly custom = new Map<string, { presenter: Presenter; handler: CustomHandler }>();
  private readonly askUser = createTuiAskUserPresenter();

  constructor(private readonly ui: InteractionPresenterUi, private readonly options: {
    openOAuthUrl?: (url: string, signal: AbortSignal, interaction?: Interaction) => Promise<void | boolean>;
  } = {}) {}

  get interactionKinds(): Array<Interaction['request']['kind']> {
    return ['select', 'confirm', 'input', 'editor', 'ask_user', 'tool_approval', 'trust', 'dependency',
      ...(this.options.openOAuthUrl ? ['oauth' as const] : []), ...(this.custom.size ? ['custom' as const] : [])];
  }

  get presenters(): Presenter[] {
    return [{ ...RUNTIME_UI_PRESENTER }, ...[...this.custom.values()].map(item => ({ ...item.presenter }))];
  }

  registerCustom(presenter: Presenter, handler: CustomHandler): () => void {
    const parsed = parseSchema(PresenterSchema, presenter);
    const key = JSON.stringify([parsed.id, parsed.version]);
    if (parsed.id === RUNTIME_UI_PRESENTER.id || this.custom.has(key)) throw new Error('Presenter identity is already registered.');
    if (this.custom.size >= LIMITS.catalogEntries - 1) throw new Error('Presenter capacity reached.');
    const entry = { presenter: parsed, handler };
    this.custom.set(key, entry);
    return () => { if (this.custom.get(key) === entry) this.custom.delete(key); };
  }

  async present(value: Interaction, signal: AbortSignal): Promise<InteractionPresentation> {
    const item = parseInteraction(value);
    if (signal.aborted) return { state: 'cancelled', reason: 'abort' };
    if (item.expiresAt !== undefined && item.expiresAt <= Date.now()) return { state: 'cancelled', reason: 'timeout' };
    if (!['waiting', 'deferred'].includes(item.state) || !item.eligibleClientKinds.includes('tui')) return this.unsupported('Interaction is no longer available to this client.');
    const request = item.request;
    const dialog = { signal, ...(item.expiresAt === undefined ? {} : { timeout: Math.max(1, item.expiresAt - Date.now()) }) };
    let answer: InteractionAnswer | undefined;
    let cancellation: 'user' | 'abort' | 'timeout' = 'user';
    switch (request.kind) {
      case 'oauth': {
        if (!this.options.openOAuthUrl) return this.unsupported('Local OAuth browser presentation is unavailable.');
        if (await this.options.openOAuthUrl(request.url, signal, item) === false) break;
        if (!signal.aborted) await this.ui.select(plainText(request.instructions), ['Cancel authorization'], dialog);
        break;
      }
      case 'select': {
        if (request.multiple) {
          const labels = request.choices.map((choice, index) => `${index + 1}. ${plainText(choice.title)}`);
          const result = await this.askUser.present({ questions: [{ id: 'selection', header: 'Selection', question: plainText(request.title),
            options: labels.map((title, index) => ({ title, ...(request.choices[index]!.description === undefined ? {} : { description: plainText(request.choices[index]!.description!) }) })),
            allowMultiple: true, allowFreeform: false, allowComment: false }], ...(dialog.timeout === undefined ? {} : { timeout: dialog.timeout }) }, { ui: this.ui, signal });
          if (result.status === 'answered') {
            const response = result.answers[0]?.response;
            if (response?.kind !== 'selection') throw new Error('Presenter returned an invalid multi-selection.');
            answer = { kind: 'select', choices: response.selections.map(label => {
              const index = labels.indexOf(label);
              if (index === -1) throw new Error('Presenter returned an unknown selection.');
              return request.choices[index]!.id;
            }) };
          } else if (result.status === 'cancelled') cancellation = result.reason === 'timeout' ? 'timeout' : result.reason === 'abort' ? 'abort' : 'user';
        } else {
          const selected = await this.choose(request.title, request.choices, dialog);
          if (selected !== undefined) answer = { kind: 'select', choices: [selected] };
        }
        break;
      }
      case 'confirm': answer = { kind: 'confirm', confirmed: await this.ui.confirm(plainText(request.title), plainText(request.message), dialog) }; break;
      case 'input': {
        const text = await this.ui.input(plainText(request.title), request.placeholder === undefined ? undefined : plainText(request.placeholder),
          { ...dialog, ...(request.initialValue === undefined ? {} : { initialValue: request.initialValue }) });
        if (text !== undefined) answer = { kind: 'input', text };
        break;
      }
      case 'editor': {
        const text = await this.ui.editor(plainText(request.title), request.initialValue, dialog);
        if (text !== undefined) answer = { kind: 'editor', text };
        break;
      }
      case 'tool_approval': {
        const optionId = await this.choose(`${request.toolName}\n\n${request.summary}`, request.options, dialog);
        if (optionId !== undefined) answer = { kind: 'tool_approval', optionId };
        break;
      }
      case 'trust': answer = { kind: 'trust', trusted: await this.ui.confirm('Trust workspace', plainText(`${request.cwd}\n\n${request.message}`), dialog) }; break;
      case 'dependency': answer = { kind: 'dependency', approved: await this.ui.confirm(plainText(request.dependency), plainText(request.message), dialog) }; break;
      case 'ask_user': {
        const normalized: AskUserRequest = {
          ...request, questions: request.questions.map((q, index) => ({ ...q, question: plainText(q.question), header: plainText(q.header ?? `Q${index + 1}`),
            ...(q.context === undefined ? {} : { context: plainText(q.context) }),
            options: (q.options ?? []).map((option, choice) => ({ title: `${choice + 1}. ${plainText(option.title)}`,
              ...(option.description === undefined ? {} : { description: plainText(option.description) }) })),
            allowMultiple: q.allowMultiple ?? false, allowFreeform: q.allowFreeform ?? true, allowComment: q.allowComment ?? false })),
          ...(dialog.timeout === undefined ? {} : { timeout: dialog.timeout }),
        };
        const result = await this.askUser.present(normalized, { ui: this.ui, signal });
        if (result.status === 'answered') answer = { kind: 'ask_user', answers: result.answers.map(row => {
          if (!row.response) throw new Error('Incomplete ask-user answer.');
          const question = request.questions.find(q => q.id === row.questionId)!;
          return row.response.kind === 'freeform' ? { questionId: row.questionId, choices: [], text: row.response.text }
            : { questionId: row.questionId, choices: row.response.selections.map(title => {
              const choice = normalized.questions.find(q => q.id === row.questionId)!.options.findIndex(option => option.title === title);
              const option = question.options?.[choice];
              if (!option) throw new Error('Presenter returned an unknown option.');
              return option.id;
            }), ...(row.response.comment === undefined ? {} : { comment: row.response.comment }) };
        }) };
        if (result.status === 'cancelled') cancellation = result.reason === 'timeout' ? 'timeout' : result.reason === 'abort' ? 'abort' : 'user';
        break;
      }
      case 'custom': {
        const entry = this.custom.get(JSON.stringify([request.presenter.id, request.presenter.version]));
        if (!entry) return this.unsupported(`Presenter ${request.presenter.id}@${request.presenter.version} is unavailable.`);
        const data = await entry.handler(request.data, signal, request.document, item);
        if (data !== undefined) answer = { kind: 'custom', presenter: request.presenter, data };
        break;
      }
      default: return this.unsupported('No presenter is registered for this interaction.');
    }
    if (signal.aborted || answer === undefined || item.expiresAt !== undefined && item.expiresAt <= Date.now()) return { state: 'cancelled', reason: signal.aborted ? 'abort'
      : item.expiresAt !== undefined && item.expiresAt <= Date.now() ? 'timeout' : cancellation };
    return { state: 'answered', answer: validateInteractionAnswer(item, answer) };
  }

  private async choose(title: string, choices: readonly { id: string; title: string; description?: string }[], dialog: { signal: AbortSignal; timeout?: number }): Promise<string | undefined> {
    const labels = choices.map((choice, index) => `${index + 1}. ${plainText(choice.title)}${choice.description === undefined ? '' : ` — ${plainText(choice.description)}`}`);
    const selected = await this.ui.select(plainText(title), labels, dialog);
    if (selected === undefined) return undefined;
    const index = labels.indexOf(selected);
    if (index === -1) throw new Error('Presenter returned an unknown selection.');
    return choices[index]!.id;
  }

  private unsupported(message: string): InteractionPresentation {
    this.ui.notify(plainText(message), 'warning');
    return { state: 'unsupported', message };
  }
}

function plainText(value: string): string {
  return stripVTControlCharacters(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, '');
}

export function runtimeUiState(presentation: Presentation) {
  return presentation.kind === 'custom' && presentation.presenter.id === RUNTIME_UI_PRESENTER.id && presentation.presenter.version === RUNTIME_UI_PRESENTER.version
    ? parseRuntimeUiState(presentation.data) : undefined;
}
