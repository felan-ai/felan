import { describe, expect, it, vi } from 'vitest';
import type { UiDocument, UiView } from '@felan-ai/session-protocol';
import { presentUiElement } from '../../src/client/ui.js';
import { presentTasksElement } from '../../src/tui/renderers/tasks.js';
import { presentProcessesElement } from '../../src/tui/renderers/processes.js';
import { presentPromptHistoryElement } from '../../src/tui/renderers/prompt-history.js';

const theme = { fg: (_role: string, text: string) => text, bold: (text: string) => text };
function ui(run: (panel: { handleInput(key: string): void; render(width: number): string[] }) => void) {
  return { custom: vi.fn((factory: (...args: any[]) => any) => new Promise(resolve => {
    run(factory({ requestRender: vi.fn() }, theme, {}, resolve));
  })) } as any;
}
const view = (id: string): UiView => ({ kind: 'view', id, revision: 1, title: 'Items', fallback: 'Items',
  fields: [{ id: 'title', label: 'Title', valueKind: 'text' }], items: ['one', 'two'].map(id => ({ id, values: { title: id }, fallback: id })),
  actions: [{ id: 'detail', label: 'Detail', target: 'item', outcome: 'submit' }, { id: 'read', label: 'Read', target: 'item', outcome: 'submit' },
    { id: 'close', label: 'Close', target: 'element', outcome: 'cancel' }] });
const document = (id: string, page: number, markdown: string): UiDocument => ({ kind: 'document', id, revision: page,
  title: 'Title does not encode pagination', data: { itemId: 'full-prompt-item', pageIndex: page - 1, pageCount: 2 }, fallback: 'Full prompt', markdown,
  actions: [{ id: page === 1 ? 'next' : 'previous', label: 'Page', target: 'element', outcome: 'submit' }] });

describe('client-owned element behavior', () => {
  it.each([['tasks', presentTasksElement, 'detail'], ['processes', presentProcessesElement, 'read'],
    ['history', presentPromptHistoryElement, 'detail']] as const)('restores %s selection by item identity on live updates', async (name, present, actionId) => {
    const source = view(`selection-${name}`);
    const signal = new AbortController().signal;
    const editor = vi.fn();
    const closed = await present(source, ui(panel => { panel.handleInput('\x1b[B'); panel.handleInput('\x1b'); }), signal, vi.fn(), editor);
    expect(closed).toMatchObject({ actionId: 'close', outcome: 'cancel' });
    const updated = { ...source, revision: 2, items: [...source.items].reverse() };
    expect(await present(updated, ui(panel => panel.handleInput('\r')), signal, vi.fn(), editor)).toMatchObject({ actionId, itemId: 'two' });
  });

  it('uses the full prompt, not its preview or last page, without sending a message', async () => {
    const setEditorText = vi.fn();
    const actions = vi.fn();
    const signal = new AbortController().signal;
    const first = document('full-prompt', 1, 'first \\[literal\\] &amp; &#x1;\n');
    const request = await presentPromptHistoryElement(first, ui(panel => panel.handleInput('\r')), signal, actions, setEditorText);
    expect(request).toMatchObject({ actionId: 'next', revision: 1 });
    expect(setEditorText).not.toHaveBeenCalled();
    const second = document('full-prompt', 2, 'last &lt;text&gt;');
    expect(await presentPromptHistoryElement(second, ui(() => { throw new Error('No second picker is needed.'); }), signal, actions, setEditorText)).toBeUndefined();
    expect(setEditorText).toHaveBeenCalledExactlyOnceWith('first [literal] & \u0001\nlast <text>');
    expect(actions).not.toHaveBeenCalled();
    const revisit = await presentPromptHistoryElement(second, ui(panel => panel.handleInput('u')), signal, actions, setEditorText);
    expect(revisit).toMatchObject({ actionId: 'previous' });
    expect(setEditorText).toHaveBeenCalledTimes(1);
  });

  it('passes a search shortcut directly to its declared input action', async () => {
    const source: UiView = { ...view('history-search'), actions: [{ id: 'search', label: 'Search', target: 'element', outcome: 'submit',
      input: { fields: [{ id: 'query', label: 'Query', kind: 'string', required: true, maxLength: 100 }] } }] };
    const signal = new AbortController().signal;
    const actions = vi.fn(async () => undefined);
    await presentPromptHistoryElement(source, ui(panel => panel.handleInput('\x12')), signal, actions, vi.fn());
    expect(actions).toHaveBeenCalledExactlyOnceWith(source, signal, 'search', undefined);
    const driver = { choose: vi.fn(), display: vi.fn(), fields: vi.fn(async () => ({ query: 'needle' })) };
    expect(await presentUiElement(source, driver, signal, true, undefined, { actionId: 'search' })).toMatchObject({ actionId: 'search', values: { query: 'needle' } });
    expect(driver.choose).not.toHaveBeenCalled();
  });
});
