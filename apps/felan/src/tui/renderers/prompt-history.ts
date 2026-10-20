import { createElementNavigation } from './navigation.js';
import { decodeUiMarkdown } from '../../client/ui.js';
import type { ExtensionContext } from '@felan-ai/agent-core';
import { parseUiPresentation, validateUiAction, type UiActionRequest, type UiPresentation } from '@felan-ai/session-protocol';
import { PromptHistoryPicker, type PromptHistoryNavigation } from './prompt-history/picker.js';
export { PromptHistoryPicker } from './prompt-history/picker.js';
export type { PromptHistoryNavigation } from './prompt-history/picker.js';

export const promptHistoryOverlay = { overlay: true as const,
  overlayOptions: { width: '80%' as const, minWidth: 64, maxHeight: '90%' as const, margin: 2 } };

export { PROMPT_HISTORY_HINT } from '@felan-ai/ext-prompt-history/data';

const elementNavigation = createElementNavigation<PromptHistoryNavigation>();

const promptPages = createElementNavigation<{ total: number; pages: Map<number, string>; using: boolean }>();

export async function presentPromptHistoryElement(value: UiPresentation, ui: Pick<ExtensionContext['ui'], 'custom'>,
  signal: AbortSignal, actions: (source: UiPresentation, signal: AbortSignal, actionId?: string, itemId?: string) => Promise<UiActionRequest | undefined>,
  setEditorText: (text: string) => void, displayMode: 'inline' | 'overlay' = 'inline'): Promise<UiActionRequest | undefined> {
  const source = parseUiPresentation(value);
  if (source.kind !== 'view' && source.kind !== 'document') throw new Error('Expected a view or document.');
  if (signal.aborted) return undefined;
  const itemId = source.kind === 'document' && typeof source.data?.itemId === 'string' ? source.data.itemId : undefined;
  const page = source.kind === 'document' ? source.data?.pageIndex : undefined;
  const total = source.kind === 'document' ? source.data?.pageCount : undefined;
  const hasPages = typeof page === 'number' && Number.isSafeInteger(page) && page >= 0
    && typeof total === 'number' && Number.isSafeInteger(total) && total > page && total <= 65536;
  let text: { total: number; pages: Map<number, string>; using: boolean } | undefined;
  const textAction = (): UiActionRequest | undefined => {
    if (!text || !hasPages || source.kind !== 'document') return undefined;
    if (text.pages.size === text.total) {
      setEditorText(Array.from({ length: text.total }, (_, index) => text!.pages.get(index)!).join(''));
      text.using = false;
      if (itemId) promptPages.delete(itemId);
      const close = source.actions.find(action => action.id === 'close');
      return close ? { elementId: source.id, revision: source.revision, actionId: close.id, outcome: close.outcome, values: {} } : undefined;
    }
    const index = page as number;
    const missing = Array.from({ length: text.total }, (_, index) => index).find(index => !text!.pages.has(index))!;
    const action = source.actions.find(action => action.id === (missing < index ? 'previous' : 'next'));
    if (!action) throw new Error('Full prompt navigation is unavailable.');
    return { elementId: source.id, revision: source.revision, actionId: action.id, outcome: action.outcome, values: {} };
  };
  if (source.kind === 'document' && hasPages) {
    text = (itemId ? promptPages.get(itemId) : undefined) ?? { total: total as number, pages: new Map(), using: false };
    text.total = total as number;
    text.pages.set(page as number, decodeUiMarkdown(source.markdown, { plainText: true }));
    if (itemId) promptPages.set(itemId, text);
    if (text.using) return textAction();
  }
  type Choice = { actionId: string; itemId?: string; values?: Record<string, string> } | 'actions' | 'use' | undefined;
  let panel: PromptHistoryPicker | undefined;
  let finish: (choice: Choice) => void = () => {};
  const abort = () => { panel?.dispose(); finish(undefined); };
  signal.addEventListener('abort', abort, { once: true });
  let choice: Choice;
  try {
    choice = await ui.custom<Choice>((tui, theme, _keys, done) => {
      let settled = false;
      finish = result => { if (!settled) { settled = true; panel?.dispose(); done(result); } };
      const choose = (actionId?: string, itemId?: string) => {
        if (actionId === undefined) { finish('actions'); return; }
        const action = source.actions.find(entry => entry.id === actionId);
        if (!action || action.target === 'item' && (source.kind !== 'view' || !source.items.some(item => item.id === itemId))) return;
        finish({ actionId, ...(itemId === undefined ? {} : { itemId }) });
      };
      panel = new PromptHistoryPicker(undefined, theme, () => tui.requestRender(), () => finish(undefined), displayMode, elementNavigation.get(source.id), { source, action: choose, use: () => { if (hasPages) finish('use'); }, search: (query, scope) => finish({ actionId: 'search', values: { query, scope } }) });
      if (signal.aborted) abort();
      return panel;
    }, displayMode === 'overlay' ? promptHistoryOverlay : undefined);
  } finally { signal.removeEventListener('abort', abort); if (panel) elementNavigation.set(source.id, panel.getNavigation()); panel?.dispose(); }
  if (signal.aborted) return undefined;
  if (choice === undefined) {
    if (itemId) promptPages.delete(itemId);
    if (source.kind === 'view') for (const item of source.items) promptPages.delete(item.id);
    const close = source.actions.find(action => action.id === 'close');
    return close ? validateUiAction(source, { elementId: source.id, revision: source.revision, actionId: close.id, outcome: close.outcome, values: {} }) : undefined;
  }
  if (choice === 'use' && text) { text.using = true; return textAction(); }
  if (choice === 'use') return undefined;
  if (choice !== 'actions' && choice.actionId === 'detail' && choice.itemId) promptPages.set(choice.itemId, { total: 0, pages: new Map(), using: true });
  const result = choice !== 'actions' && choice.values ? { elementId: source.id, revision: source.revision,
    actionId: choice.actionId, outcome: source.actions.find(action => action.id === choice.actionId)!.outcome, values: choice.values }
    : choice === 'actions' ? await actions(source, signal) : source.actions.find(action => action.id === choice.actionId)?.input?.fields.length
    ? await actions(source, signal, choice.actionId, choice.itemId) : { elementId: source.id, revision: source.revision,
    actionId: choice.actionId, outcome: source.actions.find(action => action.id === choice.actionId)!.outcome,
    values: {}, ...(choice.itemId === undefined ? {} : { itemId: choice.itemId }) };
  return signal.aborted || result === undefined ? undefined : validateUiAction(source, result);
}
