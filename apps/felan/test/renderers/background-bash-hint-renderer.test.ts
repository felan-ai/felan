import { describe, expect, it, vi } from 'vitest';
import type { ExtensionContext, UiActionRequest, UiDocument, UiPresentation, UiView } from '@felan-ai/agent-core';
import { presentProcessesElement, updateProcessesElement, PROCESSES_HINT } from '../../src/tui/renderers/processes.js';

const theme = { fg: (_name: string, text: string) => text, bold: (text: string) => text, italic: (text: string) => text, underline: (text: string) => text, strikethrough: (text: string) => text };
const view: UiView = {
  kind: 'view', id: 'view', revision: 3, hint: PROCESSES_HINT, title: 'Test view', fallback: 'One item',
  fields: Object.entries({ command: 'npm run build', status: 'running', clipped: false, started: 0, stdin: true }).map(([id, value]) => ({ id, label: id, valueKind: typeof value === 'number' ? 'number' : typeof value === 'boolean' ? 'boolean' : 'text' })),
  items: [{ id: 'item', fallback: 'An item', values: { command: 'npm run build', status: 'running', clipped: false, started: 0, stdin: true } }],
  actions: [{ id: 'read', label: 'Read details', target: 'item', outcome: 'submit' },
    { id: 'change', label: 'Change', target: 'element', outcome: 'submit', input: { fields: [{ id: 'text', label: 'Text', kind: 'string', required: true, maxLength: 20 }] } },
    { id: 'close', label: 'Close', target: 'element', outcome: 'cancel' }],
};

const historyView: UiView = { ...view, id: 'history-shortcuts', query: { actionId: 'search', values: { query: '' } },
  paging: { previousActionId: 'previous', nextActionId: 'next' },
  actions: [...view.actions,
    ...['history', 'previous', 'next', 'refresh'].map(id => ({ id, label: id, target: 'element' as const, outcome: 'submit' as const })),
    { id: 'search', label: 'Search all history', target: 'element', outcome: 'submit', input: { fields: [
      { id: 'query', label: 'Command or ID', kind: 'string', required: true, maxLength: 256 },
    ] } },
  ] };

function fixture(run: (panel: { handleInput(key: string): void; render(width: number): string[] }) => void) {
  const custom = vi.fn((callback: (...args: any[]) => any) => new Promise(resolve => {
    const panel = callback({ requestRender: vi.fn() }, theme, {}, resolve);
    run(panel);
  }));
  return { custom, ui: { custom } as unknown as Pick<ExtensionContext['ui'], 'custom'> };
}

const answer = (source: UiPresentation): UiActionRequest => ({ elementId: source.id, revision: 'revision' in source ? source.revision : 0,
  actionId: 'change', outcome: 'submit', values: { text: 'updated' } });

describe('PROCESSES_HINT', () => {
  it('opens search with Ctrl+R through the declared generic input, not normal typing', async () => {
    const { ui } = fixture(panel => { panel.handleInput('x'); panel.handleInput('\x12'); });
    const signal = new AbortController().signal;
    const result: UiActionRequest = { elementId: historyView.id, revision: historyView.revision, actionId: 'search', outcome: 'submit', values: { query: 'needle' } };
    const actions = vi.fn(async () => result);
    expect(await presentProcessesElement(historyView, ui, signal, actions)).toEqual(result);
    expect(actions).toHaveBeenCalledExactlyOnceWith(historyView, signal, 'search', undefined);
  });

  it.each([['h', 'history'], [']', 'next'], ['\x04', 'next'], ['[', 'previous'], ['\x15', 'previous']] as const)(
    'maps %s to its explicit history/paging action', async (key, actionId) => {
      const { ui } = fixture(panel => panel.handleInput(key));
      expect(await presentProcessesElement(historyView, ui, new AbortController().signal, vi.fn())).toMatchObject({ actionId });
    });

  it('labels recent/history, search, and scan navigation, and h returns to recent', async () => {
    const source: UiView = { ...historyView, items: [], fallback: '12 records scanned. No matches in this batch; more history remains.',
      actions: historyView.actions.map(action => action.id === 'history' ? { ...action, id: 'recent', label: 'Recent 10' } : action) };
    const { ui } = fixture(panel => {
      const output = panel.render(200).join('\n');
      expect(output).toContain(source.fallback);
      expect(output).toContain('ctrl+r search history');
      expect(output).toContain('h recent 10');
      expect(output).toContain('ctrl+d next/scan');
      panel.handleInput('h');
    });
    expect(await presentProcessesElement(source, ui, new AbortController().signal, vi.fn())).toMatchObject({ actionId: 'recent' });
  });

  it('keeps ordinary typing inert in recent mode and never invents history navigation', async () => {
    const { ui } = fixture(panel => { panel.handleInput('x'); panel.handleInput('h'); panel.handleInput(']'); panel.handleInput('\x12'); panel.handleInput('q'); });
    const actions = vi.fn();
    expect(await presentProcessesElement(view, ui, new AbortController().signal, actions)).toMatchObject({ actionId: 'close' });
    expect(actions).not.toHaveBeenCalled();
  });

  it('renders generic rows richly and returns the declared item action', async () => {
    const { ui } = fixture(panel => {
      expect(panel.render(100).join('\n')).toContain('npm run build');
      panel.handleInput('\r');
    });
    const actions = vi.fn();
    expect(await presentProcessesElement(view, ui, new AbortController().signal, actions)).toEqual({
      elementId: 'view', revision: 3, actionId: 'read', itemId: 'item', outcome: 'submit', values: {},
    });
    expect(actions).not.toHaveBeenCalled();
  });

  it('preserves every declared action and its inputs through the generic action menu', async () => {
    const { ui } = fixture(panel => panel.handleInput('a'));
    const actions = vi.fn(async (source: UiPresentation) => answer(source));
    expect(await presentProcessesElement(view, ui, new AbortController().signal, actions)).toEqual(answer(view));
    expect(actions.mock.calls[0]?.[0]).toEqual(view);
  });

  it('renders documents and returns only declared navigation', async () => {
    const document: UiDocument = { kind: 'document', id: 'document', revision: 8, title: 'Details', fallback: 'Detail text',
      markdown: 'Full detail text: \\[literal\\] \\*text\\* &lt;tag&gt;', hint: PROCESSES_HINT, actions: [{ id: 'list', label: 'Back', target: 'element', outcome: 'submit' }] };
    const { ui } = fixture(panel => {
      expect(panel.render(100).join('\n')).toContain('Full detail text: [literal] *text* <tag>');
      panel.handleInput('\x1b[D');
    });
    expect(await presentProcessesElement(document, ui, new AbortController().signal, vi.fn())).toEqual({
      elementId: 'document', revision: 8, actionId: 'list', outcome: 'submit', values: {},
    });
  });

  it('does not invent an item action for an empty view', async () => {
    const { ui } = fixture(panel => { panel.handleInput('\r'); panel.handleInput('\x1b'); });
    expect(await presentProcessesElement({ ...view, items: [] }, ui, new AbortController().signal, vi.fn())).toEqual({
      elementId: 'view', revision: 3, actionId: 'close', outcome: 'cancel', values: {},
    });
  });

  it('aborts an open screen without returning an action', async () => {
    const controller = new AbortController();
    const { ui } = fixture(() => controller.abort());
    expect(await presentProcessesElement(view, ui, controller.signal, vi.fn())).toBeUndefined();
  });

  it('does not open a screen after cancellation', async () => {
    const controller = new AbortController(); controller.abort();
    const { ui, custom } = fixture(() => {});
    expect(await presentProcessesElement(view, ui, controller.signal, vi.fn())).toBeUndefined();
    expect(custom).not.toHaveBeenCalled();
  });
});

it('resets selection for a new search while preserving it on updates in the same scope', async () => {
  let panel!: { handleInput(key: string): void; render(width: number): string[] };
  const f = fixture(value => { panel = value; });
  const controller = new AbortController();
  const source: UiView = { ...historyView, id: 'search-selection', items: [...view.items, { ...view.items[0]!, id: 'second' }] };
  const work = presentProcessesElement(source, f.ui, controller.signal, vi.fn());
  panel.handleInput('\x1b[B');
  expect(updateProcessesElement({ ...source, revision: 4 }, controller.signal)).toBe(true);
  expect(panel.render(200).join('\n')).toContain('▶ second');
  expect(updateProcessesElement({ ...source, revision: 5, query: { actionId: 'search', values: { query: 'new' } } }, controller.signal)).toBe(true);
  expect(panel.render(200).join('\n')).toContain('▶ item');
  panel.handleInput('\r');
  expect(await work).toMatchObject({ actionId: 'read', itemId: 'item', revision: 5 });
});

it('updates the mounted panel in place without polling or losing selection', async () => {
  vi.useFakeTimers();
  try {
    let panel!: { handleInput(key: string): void; render(width: number): string[] };
    const f = fixture(value => { panel = value; });
    const control = new AbortController();
    const source: UiView = { ...view, items: [...view.items, { ...view.items[0]!, id: 'second' }] };
    const work = presentProcessesElement(source, f.ui, control.signal, vi.fn());
    panel.handleInput('\x1b[B');
    await vi.advanceTimersByTimeAsync(5000);
    expect(vi.getTimerCount()).toBe(0);
    expect(f.custom).toHaveBeenCalledOnce();
    const next: UiView = { ...source, revision: 4, items: source.items.map(item => ({ ...item, values: { ...item.values, status: 'completed' } })) };
    expect(updateProcessesElement(next, control.signal)).toBe(true);
    expect(panel.render(100).join('\n')).toContain('▶ second  completed');
    panel.handleInput('\x1b[A');
    panel.handleInput('\r');
    expect(await work).toMatchObject({ revision: 4, itemId: 'item', actionId: 'read' });
    expect(updateProcessesElement(next, control.signal)).toBe(false);
  } finally { vi.useRealTimers(); }
});
