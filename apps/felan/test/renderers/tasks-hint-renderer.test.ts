import { describe, expect, it, vi } from 'vitest';
import type { ExtensionContext, UiActionRequest, UiDocument, UiPresentation, UiView } from '@felan-ai/agent-core';
import { presentTasksElement, TASKS_HINT } from '../../src/tui/renderers/tasks.js';

const theme = { fg: (_name: string, text: string) => text, bold: (text: string) => text, italic: (text: string) => text, underline: (text: string) => text, strikethrough: (text: string) => text };
const view: UiView = {
  kind: 'view', id: 'view', revision: 3, hint: TASKS_HINT, title: 'Test view', fallback: 'One item',
  fields: Object.entries({ title: 'Compile library', priority: 1, availability: 'ready', owner: '' }).map(([id, value]) => ({ id, label: id, valueKind: typeof value === 'number' ? 'number' : typeof value === 'boolean' ? 'boolean' : 'text' })),
  items: [{ id: 'item', fallback: 'An item', values: { title: 'Compile library', priority: 1, availability: 'ready', owner: '' } }],
  actions: [{ id: 'detail', label: 'Read details', target: 'item', outcome: 'submit' },
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

describe('TASKS_HINT', () => {
  it('renders generic rows richly and returns the declared item action', async () => {
    const { ui } = fixture(panel => {
      expect(panel.render(100).join('\n')).toContain('Compile library');
      panel.handleInput('\r');
    });
    const actions = vi.fn();
    expect(await presentTasksElement(view, ui, new AbortController().signal, actions)).toEqual({
      elementId: 'view', revision: 3, actionId: 'detail', itemId: 'item', outcome: 'submit', values: {},
    });
    expect(actions).not.toHaveBeenCalled();
  });

  it('preserves every declared action and its inputs through the generic action menu', async () => {
    const { ui } = fixture(panel => panel.handleInput('a'));
    const actions = vi.fn(async (source: UiPresentation) => answer(source));
    expect(await presentTasksElement(view, ui, new AbortController().signal, actions)).toEqual(answer(view));
    expect(actions.mock.calls[0]?.[0]).toEqual(view);
  });

  it.each(['\x1b[D', '\x7f'])('renders task details and returns back for %j', async key => {
    const document: UiDocument = { kind: 'document', id: 'document', revision: 8, title: 'Details', fallback: 'Detail text',
      markdown: 'Full detail text: \\[literal\\] \\*text\\* &lt;tag&gt;', hint: TASKS_HINT, actions: [{ id: 'back', label: 'Back', target: 'element', outcome: 'submit' }] };
    document.data = { taskId: 'T-AAAAAA', prerequisites: 0, dependents: 1, records0: JSON.stringify([
      ...Object.entries({ id: 'T-AAAAAA', title: 'Compile', status: 'pending', availability: 'ready', priority: '2', ownerSessionId: '',
        description: '[literal] *text* <tag>\nnext line', acceptanceCriteria: '', blockedReason: '', notes: '', result: '',
        createdAt: '2026', updatedAt: '2026', completedAt: '' }).map(([field, value]) => ({ field, value })),
      { relation: 'dependent', id: 'T-BBBBBB', title: 'Check', availability: 'waiting' },
    ]) };
    const { ui } = fixture(panel => {
      panel.handleInput('\x1b[H');
      const rendered = panel.render(120).join('\n');
      for (const text of ['T-AAAAAA  backspace/← tasks • ↑↓ scroll • g graph • r refresh • q/esc close',
        'Lifecycle', 'Status: pending', 'Availability: ready', 'Priority: P2', 'Execution', 'Owner: -',
        'Dependencies', 'Depends on (0):', '- None', 'Unblocks (1):', '- T-BBBBBB · waiting · Check',
        'Work context', 'Description: [literal] *text* <tag>', '    next line', 'Acceptance criteria: -', 'Notes: -']) {
        expect(rendered).toContain(text);
      }
      expect(rendered).not.toContain('##');
      panel.handleInput('\x1b[F');
      expect(panel.render(120).join('\n')).toContain('Result: -');
      panel.handleInput(key);
    });
    expect(await presentTasksElement(document, ui, new AbortController().signal, vi.fn())).toEqual({
      elementId: 'document', revision: 8, actionId: 'back', outcome: 'submit', values: {},
    });
  });

  it('opens the declared graph and returns from a scrollable graph', async () => {
    const graphAction = { id: 'graph', label: 'Graph', target: 'element' as const, outcome: 'submit' as const };
    const { ui } = fixture(panel => panel.handleInput('g'));
    expect(await presentTasksElement({ ...view, actions: [...view.actions, graphAction] }, ui, new AbortController().signal, vi.fn()))
      .toMatchObject({ actionId: 'graph' });
    const graph: UiView = { ...view, fields: [...view.fields, { id: 'depth', label: 'Depth', valueKind: 'number' }],
      items: [{ ...view.items[0]!, values: { ...view.items[0]!.values, depth: 0,
        graphRevision: 2, total: 2, completed: 0, active: 0, ready: 1, blocked: 1 } }],
      actions: [{ id: 'back', label: 'Back', target: 'element', outcome: 'submit' }] };
    const f = fixture(panel => {
      expect(panel.render(120).join('\n')).toContain('Task Graph  ↑↓ scroll • g tasks');
      expect(panel.render(120).join('\n')).toContain('Layer 0');
      expect(panel.render(120).join('\n')).toContain('Tasks r2: 0/2 completed · 0 active · 1 ready · 1 blocked');
      panel.handleInput('g');
    });
    expect(await presentTasksElement(graph, f.ui, new AbortController().signal, vi.fn())).toMatchObject({ actionId: 'back' });
  });

  it('does not invent an item action for an empty view', async () => {
    const { ui } = fixture(panel => { panel.handleInput('\r'); panel.handleInput('\x1b'); });
    expect(await presentTasksElement({ ...view, items: [] }, ui, new AbortController().signal, vi.fn())).toEqual({
      elementId: 'view', revision: 3, actionId: 'close', outcome: 'cancel', values: {},
    });
  });

  it('aborts an open screen without returning an action', async () => {
    const controller = new AbortController();
    const { ui } = fixture(() => controller.abort());
    expect(await presentTasksElement(view, ui, controller.signal, vi.fn())).toBeUndefined();
  });

  it('does not open a screen after cancellation', async () => {
    const controller = new AbortController(); controller.abort();
    const { ui, custom } = fixture(() => {});
    expect(await presentTasksElement(view, ui, controller.signal, vi.fn())).toBeUndefined();
    expect(custom).not.toHaveBeenCalled();
  });
});
