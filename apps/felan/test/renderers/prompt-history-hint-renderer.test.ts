import { describe, expect, it, vi } from 'vitest';
import type { ExtensionContext, UiActionRequest, UiDocument, UiPresentation, UiView } from '@felan-ai/agent-core';
import { presentPromptHistoryElement, PROMPT_HISTORY_HINT } from '../../src/tui/renderers/prompt-history.js';

const theme = { fg: (_name: string, text: string) => text, bold: (text: string) => text, italic: (text: string) => text, underline: (text: string) => text, strikethrough: (text: string) => text };
const view: UiView = {
  kind: 'view', id: 'view', revision: 3, hint: PROMPT_HISTORY_HINT, title: 'Test view', fallback: 'One item',
  fields: Object.entries({ preview: 'Explain the build', project: '/workspace', session: 'Session', timestamp: 0, clipped: true }).map(([id, value]) => ({ id, label: id, valueKind: typeof value === 'number' ? 'number' : typeof value === 'boolean' ? 'boolean' : 'text' })),
  items: [{ id: 'item', fallback: 'An item', values: { preview: 'Explain the build', project: '/workspace', session: 'Session', timestamp: 0, clipped: true } }],
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

describe('PROMPT_HISTORY_HINT', () => {
  it('renders generic rows richly and returns the declared item action', async () => {
    const { ui } = fixture(panel => {
      expect(panel.render(100).join('\n')).toContain('Explain the build');
      panel.handleInput('\r');
    });
    const actions = vi.fn();
    expect(await presentPromptHistoryElement(view, ui, new AbortController().signal, actions)).toEqual({
      elementId: 'view', revision: 3, actionId: 'detail', itemId: 'item', outcome: 'submit', values: {},
    });
    expect(actions).not.toHaveBeenCalled();
  });

  it('preserves every declared action and its inputs through the generic action menu', async () => {
    const { ui } = fixture(panel => panel.handleInput('\x1ba'));
    const actions = vi.fn(async (source: UiPresentation) => answer(source));
    expect(await presentPromptHistoryElement(view, ui, new AbortController().signal, actions)).toEqual(answer(view));
    expect(actions.mock.calls[0]?.[0]).toEqual(view);
  });

  it('renders documents and returns only declared navigation', async () => {
    const document: UiDocument = { kind: 'document', id: 'document', revision: 8, title: 'Details', fallback: 'Detail text',
      markdown: 'Full detail text: \\[literal\\] \\*text\\* &lt;tag&gt;', hint: PROMPT_HISTORY_HINT, actions: [{ id: 'back', label: 'Back', target: 'element', outcome: 'submit' }] };
    const { ui } = fixture(panel => {
      expect(panel.render(100).join('\n')).toContain('Full detail text: [literal] *text* <tag>');
      panel.handleInput('\x1b[D');
    });
    expect(await presentPromptHistoryElement(document, ui, new AbortController().signal, vi.fn())).toEqual({
      elementId: 'document', revision: 8, actionId: 'back', outcome: 'submit', values: {},
    });
  });

  it('does not invent an item action for an empty view', async () => {
    const { ui } = fixture(panel => { panel.handleInput('\r'); panel.handleInput('\x1b'); });
    expect(await presentPromptHistoryElement({ ...view, items: [] }, ui, new AbortController().signal, vi.fn())).toMatchObject({ actionId: 'close', outcome: 'cancel' });
  });

  it('aborts an open screen without returning an action', async () => {
    const controller = new AbortController();
    const { ui } = fixture(() => controller.abort());
    expect(await presentPromptHistoryElement(view, ui, controller.signal, vi.fn())).toBeUndefined();
  });

  it('does not open a screen after cancellation', async () => {
    const controller = new AbortController(); controller.abort();
    const { ui, custom } = fixture(() => {});
    expect(await presentPromptHistoryElement(view, ui, controller.signal, vi.fn())).toBeUndefined();
    expect(custom).not.toHaveBeenCalled();
  });
  it('cycles scope directly, searches typed text, and inserts the full selected prompt', async () => {
    const source: UiView = { ...view, id: 'wire-view', query: { actionId: 'search', values: { query: '', scope: 'session' } },
      actions: [...view.actions, { id: 'search', label: 'Search', target: 'element', outcome: 'submit', input: { fields: [
        { id: 'query', label: 'Query', kind: 'string', required: true, maxLength: 4096 },
        { id: 'scope', label: 'Scope', kind: 'enum', required: true, options: ['session', 'project', 'all'].map(id => ({ id, label: id })) },
      ] } }] };
    const signal = new AbortController().signal;
    const actions = vi.fn(); const setEditor = vi.fn();
    const scoped = await presentPromptHistoryElement(source, fixture(panel => panel.handleInput('\x12')).ui, signal, actions, setEditor);
    expect(scoped).toMatchObject({ actionId: 'search', values: { query: '', scope: 'project' } });
    vi.useFakeTimers();
    try {
      const search = presentPromptHistoryElement(source, fixture(panel => { panel.handleInput('n'); panel.handleInput('e'); }).ui, signal, actions, setEditor);
      await vi.advanceTimersByTimeAsync(120);
      expect(await search).toMatchObject({ actionId: 'search', values: { query: 'ne', scope: 'session' } });
    } finally { vi.useRealTimers(); }
    expect(await presentPromptHistoryElement(source, fixture(panel => panel.handleInput('\r')).ui, signal, actions, setEditor))
      .toMatchObject({ actionId: 'detail', itemId: 'item' });
    const document: UiDocument = { kind: 'document', id: 'unrelated-wire-document', revision: 4, hint: PROMPT_HISTORY_HINT,
      title: 'Full prompt', fallback: 'Full prompt', markdown: 'Full prompt, not the preview', data: { itemId: 'item', pageIndex: 0, pageCount: 1 },
      actions: [{ id: 'close', label: 'Close', target: 'element', outcome: 'cancel' }] };
    expect(await presentPromptHistoryElement(document, fixture(() => { throw new Error('Selection should insert without another picker'); }).ui, signal, actions, setEditor))
      .toMatchObject({ actionId: 'close', outcome: 'cancel' });
    expect(setEditor).toHaveBeenCalledExactlyOnceWith('Full prompt, not the preview');
    expect(actions).not.toHaveBeenCalled();
  });

});

it('keeps one-Enter insertion pending across a refreshed results view and reads every page', async () => {
  const source = { ...view, id: 'wire-refresh' };
  const signal = new AbortController().signal;
  const setEditor = vi.fn();
  await presentPromptHistoryElement(source, fixture(panel => panel.handleInput('\r')).ui, signal, vi.fn(), setEditor);
  const refresh = new AbortController();
  await presentPromptHistoryElement({ ...source, revision: 4 }, fixture(() => refresh.abort()).ui, refresh.signal, vi.fn(), setEditor);
  const page = (index: number): UiDocument => ({ kind: 'document', id: 'wire-document', revision: 5 + index,
    title: 'Full prompt', fallback: 'Full prompt', markdown: index ? 'second' : 'first\n', data: { itemId: 'item', pageIndex: index, pageCount: 2 },
    actions: [{ id: 'close', label: 'Close', target: 'element', outcome: 'cancel' },
      { id: index ? 'previous' : 'next', label: 'Page', target: 'element', outcome: 'submit' }] });
  const noDialog = fixture(() => { throw new Error('Enter must insert without a preview confirmation'); }).ui;
  expect(await presentPromptHistoryElement(page(0), noDialog, signal, vi.fn(), setEditor)).toMatchObject({ actionId: 'next' });
  expect(setEditor).not.toHaveBeenCalled();
  expect(await presentPromptHistoryElement(page(1), noDialog, signal, vi.fn(), setEditor)).toMatchObject({ actionId: 'close' });
  expect(setEditor).toHaveBeenCalledExactlyOnceWith('first\nsecond');
});

it('keeps action-menu detail as a preview and clears insertion state after cancellation', async () => {
  const source = { ...view };
  const signal = new AbortController().signal;
  const setEditor = vi.fn();
  const document: UiDocument = { kind: 'document', id: 'preview-document', revision: 4,
    title: 'Full prompt', fallback: 'Full prompt', markdown: 'Preview only',
    data: { itemId: 'item', pageIndex: 0, pageCount: 1 },
    actions: [{ id: 'close', label: 'Close', target: 'element', outcome: 'cancel' }] };
  await presentPromptHistoryElement(source, fixture(panel => panel.handleInput('\r')).ui, signal, vi.fn(), setEditor);
  await presentPromptHistoryElement(source, fixture(panel => panel.handleInput('\x1b')).ui, signal, vi.fn(), setEditor);
  const detail = vi.fn(async () => ({ elementId: source.id, revision: source.revision,
    actionId: 'detail', itemId: 'item', outcome: 'submit' as const, values: {} }));
  await presentPromptHistoryElement(source, fixture(panel => panel.handleInput('\x1ba')).ui, signal, detail, setEditor);
  const preview = fixture(panel => { expect(panel.render(100).join('\n')).toContain('Preview only'); panel.handleInput('\x1b'); });
  await presentPromptHistoryElement(document, preview.ui, signal, vi.fn(), setEditor);
  expect(preview.custom).toHaveBeenCalledOnce();
  expect(setEditor).not.toHaveBeenCalled();
});

it('renders the selected history row with accent and bold emphasis', async () => {
  const styled = { ...theme, fg: (name: string, text: string) => `<${name}>${text}</${name}>`, bold: (text: string) => `<bold>${text}</bold>` };
  const ui = { custom: (callback: (...args: any[]) => any) => new Promise(resolve => {
    const panel = callback({ requestRender: vi.fn() }, styled, {}, resolve);
    expect(panel.render(100).join('\n')).toContain('<accent><bold>› Explain the build…</bold></accent>');
    panel.handleInput('\x1b');
  }) } as unknown as Pick<ExtensionContext['ui'], 'custom'>;
  await presentPromptHistoryElement(view, ui, new AbortController().signal, vi.fn(), vi.fn());
});
