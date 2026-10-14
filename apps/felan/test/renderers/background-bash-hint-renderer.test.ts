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
