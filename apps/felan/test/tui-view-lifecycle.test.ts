import type { ExtensionContext } from '@felan-ai/agent-core';
import type { Component } from '@earendil-works/pi-tui';
import type { SessionSnapshot, UiActionRequest, UiDocument, UiPresentation, UiView } from '@felan-ai/session-protocol';
import { afterEach, expect, it, vi } from 'vitest';
import type { ClientInteractionPresenters } from '../src/client/presenters.js';
import { GENERIC_UI_CAPABILITIES } from '../src/client/ui.js';
import type { TuiSessionController } from '../src/tui/controller.js';
import { TerminalInteractions } from '../src/tui/interactions.js';
import { presentContextDocument } from '../src/tui/renderers/context-view.js';
import { presentFusionPickerView, presentFusionReviewDocument } from '../src/tui/renderers/fusion.js';
import { presentMemoryHistory } from '../src/tui/renderers/memory.js';
import { presentProcessesElement } from '../src/tui/renderers/processes.js';
import { presentTasksElement } from '../src/tui/renderers/tasks.js';
import { defaultClientTheme } from '../src/tui/theme.js';
import { snapshot } from './client-fixtures.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
const cases = [
  ['context', 'document'], ['memory', 'view'], ['memory', 'document'], ['tasks', 'view'], ['tasks', 'document'],
  ['fusion', 'view'], ['fusion', 'document'], ['processes', 'view'], ['processes', 'document'],
] as const;

function fixture(name: typeof cases[number][0], kind: 'view' | 'document') {
  const source: UiDocument | UiView = {
    id: `${name}-${kind}`, kind, revision: 1, title: `${name} ${kind}`, fallback: 'Fixture view',
    actions: [{ id: name === 'fusion' && kind === 'view' ? 'cancel' : 'close', label: 'Close', target: 'element', outcome: 'cancel' }],
    ...(kind === 'view' ? { fields: [{ id: 'name', label: 'Name', valueKind: 'text' as const }], items: [] }
      : { markdown: 'Fixture document' }),
  } as UiDocument | UiView;
  if (name === 'tasks' && source.kind === 'document') source.data = { taskId: 'T-AAAAAA', prerequisites: 0, dependents: 0,
    records0: JSON.stringify([{ field: 'id', value: 'T-AAAAAA' }, { field: 'title', value: 'tasks document' }]) };
  let current: SessionSnapshot = { ...snapshot(), presentation: [source], run: { state: 'waiting', id: 'run' } };
  const listeners = new Set<() => void>();
  let clientStatus = 'ready'; let attachmentStatus = 'live';
  const emit = () => { for (const listener of listeners) listener(); };
  const panels: Component[] = [];
  const custom: ExtensionContext['ui']['custom'] = factory => new Promise(resolve => {
    panels.push(factory({ terminal: { rows: 30 }, requestRender: vi.fn() } as never, defaultClientTheme(), {} as never, resolve) as Component);
  });
  const ui = { custom, input: vi.fn(async () => undefined) };
  const actions = vi.fn(async () => undefined);
  const presentElement = (element: UiPresentation, signal: AbortSignal) => {
    if (name === 'context') return presentContextDocument(element, ui, signal);
    if (name === 'memory') return presentMemoryHistory(element, ui, signal);
    if (name === 'tasks') return presentTasksElement(element, ui, signal, actions);
    if (name === 'processes') return presentProcessesElement(element, ui, signal, actions);
    return kind === 'view' ? presentFusionPickerView(element, ui, signal) : presentFusionReviewDocument(element, ui, signal);
  };
  const perform = vi.fn(async (_op: string, action: UiActionRequest) => {
    expect(action).toEqual({ elementId: source.id, revision: 1, actionId: source.actions[0]!.id, outcome: 'cancel', values: {} });
    current = { ...current, presentation: [], run: { state: 'idle', id: 'run' } };
    emit();
    return { outcome: 'accepted', result: {} };
  });
  const controller = {
    sessionId: 'session', get snapshot() { return current; }, get state() { return { status: 'live', snapshot: current }; },
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    perform, setNotice: vi.fn(), client: { get status() { return clientStatus; }, capabilities: { capabilities: GENERIC_UI_CAPABILITIES, operations: ['ui.action'] },
      readAttachment: () => ({ state: { status: attachmentStatus } }), getInteractions: () => [] },
  } as unknown as TuiSessionController;
  const interactions = new TerminalInteractions(controller, { presentElement } as unknown as ClientInteractionPresenters);
  cleanups.push(() => interactions.dispose());
  return { panels, perform, interactions, current: () => current,
    setConnection(status: string, attachment: string) { clientStatus = status; attachmentStatus = attachment; emit(); },
    reopen() { current = { ...current, presentation: [source], run: { state: 'waiting', id: 'run' } }; emit(); } };
}

it.each(cases)('%s %s Escape closes semantically, goes idle, and reopens identical data', async (name, kind) => {
  const f = fixture(name, kind);
  for (let index = 0; index < 2; index++) {
    if (index) f.reopen();
    await vi.waitFor(() => expect(f.panels).toHaveLength(index + 1));
    expect(f.panels[index]!.render(100).join('\n')).toContain(`${name} ${kind}`);
    f.panels[index]!.handleInput!('\x1b');
    await vi.waitFor(() => expect(f.interactions.busy).toBe(false));
    expect(f.current().run.state).toBe('idle');
    expect(f.perform).toHaveBeenCalledTimes(index + 1);
  }
});

it('keeps an open view mounted through reconnect and delays its close action until reattachment', async () => {
  const f = fixture('context', 'document');
  await vi.waitFor(() => expect(f.panels).toHaveLength(1));
  f.setConnection('disconnected', 'disconnected');
  expect(f.panels[0]!.render(100).join('\n')).toContain('context document');
  f.panels[0]!.handleInput!('\x1b');
  await Promise.resolve();
  expect(f.interactions.busy).toBe(true);
  expect(f.perform).not.toHaveBeenCalled();
  f.setConnection('ready', 'live');
  await vi.waitFor(() => expect(f.interactions.busy).toBe(false));
  expect(f.panels).toHaveLength(1);
  expect(f.perform).toHaveBeenCalledOnce();
});
