import { createElementNavigation } from './navigation.js';
import type { ExtensionContext } from '@felan-ai/agent-core';
import { parseUiPresentation, validateUiAction, type UiActionRequest, type UiPresentation } from '@felan-ai/session-protocol';
import { Text } from '@earendil-works/pi-tui';
import type { AgentToolPresentation } from '../../subagents/agent-transcript.js';
import { ProcessViewPanel, type ProcessViewNavigation } from './processes/process-view.js';

export const renderBackgroundBashCall: NonNullable<AgentToolPresentation['renderCall']> = (args, theme) => {
  const value = typeof args === 'object' && args !== null ? args as Record<string, unknown> : {};
  const command = typeof value.command === 'string' ? value.command : '';
  const suffix = value.tty === true ? ' (pty)' : value.background === true ? ' (background)' : '';
  return new Text(theme.fg('toolTitle', theme.bold(`$ ${command}`)) + theme.fg('muted', suffix), 0, 0);
};

export { BackgroundBashCompletionComponent } from './processes/completion-message.js';
export type { BackgroundProcessViewSource } from '@felan-ai/ext-background-bash/data';
export { ProcessViewPanel, presentProcessView } from './processes/process-view.js';
export type { ProcessViewNavigation } from './processes/process-view.js';

export { PROCESSES_HINT } from '@felan-ai/ext-background-bash/data';

const activeElements = new WeakMap<AbortSignal, (source: UiPresentation) => boolean>();

export function updateProcessesElement(source: UiPresentation, signal: AbortSignal): boolean {
  return activeElements.get(signal)?.(source) ?? false;
}

const elementNavigation = createElementNavigation<ProcessViewNavigation>();

export async function presentProcessesElement(value: UiPresentation, ui: Pick<ExtensionContext['ui'], 'custom'>,
  signal: AbortSignal, actions: (source: UiPresentation, signal: AbortSignal, actionId?: string, itemId?: string) => Promise<UiActionRequest | undefined>): Promise<UiActionRequest | undefined> {
  const parsed = parseUiPresentation(value);
  if (parsed.kind !== 'view' && parsed.kind !== 'document') throw new Error('Expected a view or document.');
  let source: Extract<UiPresentation, { kind: 'view' | 'document' }> = parsed;
  if (signal.aborted) return undefined;
  type Choice = { actionId: string; itemId?: string } | 'actions' | undefined;
  let panel: ProcessViewPanel | undefined;
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
      panel = new ProcessViewPanel(undefined, theme, () => {}, () => tui.requestRender(), elementNavigation.get(source.id), { source, action: choose, dismiss: () => choose('close') });
      activeElements.set(signal, value => {
        if (settled || signal.aborted) return false;
        const next = parseUiPresentation(value);
        if ((next.kind !== 'view' && next.kind !== 'document') || next.id !== source.id || next.kind !== source.kind) return false;
        source = next;
        panel!.update(next);
        return true;
      });
      if (signal.aborted) abort();
      return panel;
    }, undefined);
  } finally { activeElements.delete(signal); signal.removeEventListener('abort', abort); if (panel) elementNavigation.set(source.id, panel.navigation); panel?.dispose(); }
  if (signal.aborted || choice === undefined) return undefined;
  const result = choice === 'actions' ? await actions(source, signal) : source.actions.find(action => action.id === choice.actionId)?.input?.fields.length
    ? await actions(source, signal, choice.actionId, choice.itemId) : { elementId: source.id, revision: source.revision,
    actionId: choice.actionId, outcome: source.actions.find(action => action.id === choice.actionId)!.outcome,
    values: {}, ...(choice.itemId === undefined ? {} : { itemId: choice.itemId }) };
  return signal.aborted || result === undefined ? undefined : validateUiAction(source, result);
}
