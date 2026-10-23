import { createHash } from 'node:crypto';
import { stripVTControlCharacters } from 'node:util';
import type { AgentSession } from '@felan-ai/agent-core';
import { LIMITS, PresentationSchema, parseSchema,
  type Interaction, type Presentation } from '@felan-ai/session-protocol';
import { createUiVocabulary, type UiVocabulary } from './ui-vocabulary.js';
import type { SessionUiPort } from './session-execution.js';

type Ui = NonNullable<NonNullable<Parameters<AgentSession['bindExtensions']>[0]>['uiContext']>;
type PresentationUpdate = Presentation | { id: string; remove: true };
export class UnsupportedExtensionUiError extends Error {
  readonly code = 'unsupported';
  constructor(readonly surface: string) {
    super(`Extension UI ${surface} is unsupported in daemon sessions.`);
    this.name = 'UnsupportedExtensionUiError';
  }
}

export function createSessionExtensionUi(options: {
  port: SessionUiPort;
}): {
  context: Ui;
  vocabulary: UiVocabulary;
  activate(publish: (update: PresentationUpdate) => void): void;
  dispose(): void;
} {
  const lifetime = new AbortController();
  const presentations = new Map<string, Presentation>();
  let publish: ((update: PresentationUpdate) => void) | undefined;
  let workingMessage: string | undefined;
  let workingVisible = true;
  let toolsExpanded = false;

  const check = () => {
    if (lifetime.signal.aborted) throw Object.assign(new Error('Session extension UI is disposed.'), { code: 'unavailable' });
  };
  const present = (value: PresentationUpdate) => {
    check();
    if ('remove' in value) { publish?.(value); presentations.delete(value.id); return; }
    const parsed = parseSchema(PresentationSchema, value);
    if (!presentations.has(parsed.id) && presentations.size >= LIMITS.pageEntries) throw new Error('Session presentation capacity reached.');
    publish?.(parsed); presentations.set(parsed.id, parsed);
  };
  const notify: Ui['notify'] = (message, level = 'info') => present({ id: `notification:${level}`, kind: 'notification', level, text: plainText(message) });
  const unsupported = (surface: string): never => {
    const error = new UnsupportedExtensionUiError(surface);
    notify(error.message, 'warning');
    throw error;
  };
  const publishWorking = () => present(workingVisible && workingMessage !== undefined
    ? { id: 'working', kind: 'status', key: 'working', value: { kind: 'text', text: workingMessage }, fallback: workingMessage.slice(0, 1024) || 'Working' }
    : { id: 'working', remove: true });
  const request = (value: Interaction['request'], dialog?: { signal?: AbortSignal; timeout?: number; deferrable?: boolean; transient?: boolean; audience?: 'session' | 'owner' | 'host' }) => {
    check();
    if (!publish) throw Object.assign(new Error('Session interaction requested before the runtime became active.'), { code: 'unavailable' });
    if ((dialog?.audience === 'host' || dialog?.audience === 'owner') && !options.port.canPresent(value, dialog.audience)) {
      return Promise.resolve({ state: 'cancelled' as const, reason: 'unsupported' as const });
    }
    return options.port.request(value, {
      signal: dialog?.signal ? AbortSignal.any([lifetime.signal, dialog.signal]) : lifetime.signal,
      ...(dialog?.timeout === undefined ? {} : { timeout: Math.ceil(dialog.timeout) }),
      ...(dialog?.deferrable === undefined ? {} : { deferrable: dialog.deferrable }),
      ...(dialog?.transient === undefined ? {} : { transient: dialog.transient }),
      ...(dialog?.audience === undefined ? {} : { audience: dialog.audience }),
      ...(dialog?.audience === 'owner' ? { authority: 'owner' } : {}),
    });
  };
  const vocabulary = createUiVocabulary({
    canRequest: (form, dialog) => !!publish && !lifetime.signal.aborted
      && options.port.canPresent({ kind: 'form', form }, dialog.audience),
    publish: present,
    async request(form, dialog) {
      const value = { kind: 'form' as const, form };
      const detached = new AbortController();
      const release = dialog.audience === 'host' ? options.port.subscribeClients(() => {
        if (!options.port.canPresent(value, 'host')) detached.abort();
      }) : () => {};
      try {
        const outcome = await request(value, { signal: AbortSignal.any([dialog.signal, detached.signal]),
          ...(dialog.timeoutMs === undefined ? {} : { timeout: dialog.timeoutMs }),
          ...(dialog.deferrable === undefined ? {} : { deferrable: dialog.deferrable }),
          ...(dialog.transient === undefined ? {} : { transient: dialog.transient }), audience: dialog.audience ?? 'session' });
        if (outcome.state !== 'answered') return outcome;
        if (outcome.answer.kind !== 'form') throw new Error('UI form answer kind changed.');
        return { state: 'answered', answer: outcome.answer };
      } finally { release(); }
    },
  });
  const context: Ui = {
    async select(title, choices, dialog) {
      const result = await request({ kind: 'select', title: plainText(title), multiple: false,
        choices: choices.map((choice, index) => ({ id: String(index), title: plainText(choice) })) }, dialog);
      return result.state === 'answered' && result.answer.kind === 'select' ? choices[Number(result.answer.choices[0])] : undefined;
    },
    async confirm(title, message, dialog) {
      const result = await request({ kind: 'confirm', title: plainText(title), message: plainText(message) }, dialog);
      return result.state === 'answered' && result.answer.kind === 'confirm' ? result.answer.confirmed : false;
    },
    async input(title, placeholder, dialog) {
      const result = await request({ kind: 'input', title: plainText(title), ...(placeholder === undefined ? {} : { placeholder: plainText(placeholder) }) }, dialog);
      return result.state === 'answered' && result.answer.kind === 'input' ? result.answer.text : undefined;
    },
    async editor(title, initialValue = '') {
      const result = await request({ kind: 'editor', title: plainText(title), initialValue });
      return result.state === 'answered' && result.answer.kind === 'editor' ? result.answer.text : undefined;
    },
    notify,
    setStatus(key, text) { present(text === undefined ? { id: keyed('status', key), remove: true }
      : { id: keyed('status', key), kind: 'status', key, value: { kind: 'text', text: plainText(text) }, fallback: plainText(text).slice(0, 1024) || 'Status' }); },
    setWidget(key, content, widget) {
      if (typeof content === 'function') return unsupported('component widget');
      present(content === undefined ? { id: keyed('widget', key), remove: true }
        : { id: keyed('widget', key), kind: 'widget', text: content.map(plainText).join('\n'), placement: widget?.placement ?? 'aboveEditor' });
    },
    setTitle(title) { present({ id: 'title', kind: 'title', text: plainText(title) }); },
    setWorkingMessage(message) { check(); workingMessage = message === undefined ? undefined : plainText(message); publishWorking(); },
    setWorkingVisible(visible) { check(); workingVisible = visible; publishWorking(); },
    setWorkingIndicator() { check(); },
    setHiddenThinkingLabel() { check(); },
    getToolsExpanded() { check(); return toolsExpanded; },
    setToolsExpanded(expanded) { check(); toolsExpanded = expanded; },
    onTerminalInput() { return unsupported('terminal input'); },
    setFooter() { return unsupported('footer component'); },
    setHeader() { return unsupported('header component'); },
    async custom() { return unsupported('custom component'); },
    pasteToEditor() { return unsupported('editor paste'); },
    setEditorText() { return unsupported('editor text'); },
    getEditorText() { return unsupported('editor text'); },
    addAutocompleteProvider() { return unsupported('autocomplete'); },
    setEditorComponent() { return unsupported('editor component'); },
    getEditorComponent() { return unsupported('editor component'); },
    theme: new Proxy({} as Ui['theme'], { get: () => unsupported('theme') }),
    getAllThemes() { return unsupported('theme catalog'); },
    getTheme() { return unsupported('theme'); },
    setTheme() { return unsupported('theme'); },
  };

  return {
    context,
    vocabulary,
    activate(next) {
      check();
      if (publish) throw new Error('Session extension UI is already active.');
      for (const value of presentations.values()) next(value);
      publish = next;
    },
    dispose() { lifetime.abort(); presentations.clear(); publish = undefined; },
  };
}

function keyed(kind: string, key: string): string {
  return `${kind}:${createHash('sha256').update(key).digest('hex')}`;
}

function plainText(value: string): string {
  return stripVTControlCharacters(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, '');
}
