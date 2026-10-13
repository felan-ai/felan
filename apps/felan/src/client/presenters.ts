import { stripVTControlCharacters } from 'node:util';
import type { ExtensionContext } from '@felan-ai/agent-core';
import { createTuiAskUserPresenter, type AskUserPresenterUi } from '../tui/renderers/ask-user.js';
import {
  parseInteraction, validateInteractionAnswer,
  type Interaction, type InteractionAnswer, type Presentation,
  type UiPresentation,
} from '@felan-ai/session-protocol';
import { createGenericTuiDriver } from '../tui/generic-ui.js';
import { presentUiElement, presentUiForm } from './ui.js';
import { UiHintRenderers } from './hint-renderers.js';

export type InteractionPresenterUi = Omit<AskUserPresenterUi, 'input'> & Pick<ExtensionContext['ui'], 'confirm'> & {
  input(title: string, placeholder?: string, options?: NonNullable<Parameters<AskUserPresenterUi['input']>[2]> & { initialValue?: string }): Promise<string | undefined>;
  editor(title: string, initialValue: string, options: { signal: AbortSignal; timeout?: number }): Promise<string | undefined>;
};
export type InteractionPresentation =
  | { state: 'answered'; answer: InteractionAnswer }
  | { state: 'cancelled'; reason: 'user' | 'abort' | 'timeout' }
  | { state: 'unsupported'; message: string };

export class ClientInteractionPresenters {
  readonly hints = new UiHintRenderers();
  private readonly askUser = createTuiAskUserPresenter();

  constructor(private readonly ui: InteractionPresenterUi) {}

  get interactionKinds(): Array<Interaction['request']['kind']> {
    return ['select', 'confirm', 'input', 'editor', 'form', 'tool_approval', 'dependency'];
  }

  presentElement(source: UiPresentation, signal: AbortSignal, interactive = true) {
    return presentUiElement(source, createGenericTuiDriver(this.ui), signal, interactive, this.hints);
  }

  async present(value: Interaction, signal: AbortSignal): Promise<InteractionPresentation> {
    const item = parseInteraction(value);
    if (signal.aborted) return { state: 'cancelled', reason: 'abort' };
    if (item.expiresAt !== undefined && item.expiresAt <= Date.now()) return { state: 'cancelled', reason: 'timeout' };
    if (!['waiting', 'deferred'].includes(item.state) || !this.interactionKinds.includes(item.request.kind)) return this.unsupported('Interaction is no longer available to this client.');
    const request = item.request;
    const dialog = { signal, ...(item.expiresAt === undefined ? {} : { timeout: Math.max(1, item.expiresAt - Date.now()) }) };
    let answer: InteractionAnswer | undefined;
    let cancellation: 'user' | 'abort' | 'timeout' = 'user';
    switch (request.kind) {
      case 'form': {
        const deadline = dialog.timeout !== undefined && dialog.timeout <= 2_147_483_647
          ? AbortSignal.any([signal, AbortSignal.timeout(dialog.timeout)]) : signal;
        answer = await presentUiForm(request.form, createGenericTuiDriver(this.ui), deadline, this.hints);
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
      case 'dependency': answer = { kind: 'dependency', approved: await this.ui.confirm(plainText(request.dependency), plainText(request.message), dialog) }; break;
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
