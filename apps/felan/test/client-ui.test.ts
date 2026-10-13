import { describe, expect, it, vi } from 'vitest';
import { parseInteraction, type UiDocument, type UiForm, type UiInput, type UiView } from '@felan-ai/session-protocol';
import { presentUiElement, presentUiForm, presentationText, statusText, type GenericUiDriver } from '../src/client/ui.js';
import { createGenericTuiDriver } from '../src/tui/generic-ui.js';
import { ClientInteractionPresenters, type InteractionPresenterUi } from '../src/client/presenters.js';

const signal = () => new AbortController().signal;
const input: UiInput = { fields: [{ id: 'answer', kind: 'string', label: 'Answer', required: true, maxLength: 30 }], defaults: { answer: 'Draft' } };
const form: UiForm = { title: 'Question', markdown: 'Full **context**', fallback: 'Answer or cancel', input,
  actions: [{ id: 'send', label: 'Send', target: 'element', outcome: 'submit' }, { id: 'cancel', label: 'Cancel', target: 'element', outcome: 'cancel' }] };
function driver(): GenericUiDriver {
  return { choose: vi.fn(async () => 'send'), fields: vi.fn(async () => ({ answer: 'Exact answer' })), display: vi.fn(async () => {}) };
}

describe('generic client UI vocabulary', () => {
  it('renders complete text statuses without internal IDs or redundant key labels', () => {
    const memory = { id: 'ui:binding:status:opaque', kind: 'status', key: 'memory',
      value: { kind: 'text', text: 'Memory: 1 pending' }, fallback: 'Memory: 1 pending' } as const;
    expect(statusText(memory)).toBe('Memory: 1 pending');
    expect(presentationText(memory)).toBe('Memory: 1 pending');
    expect(statusText({ ...memory, value: { kind: 'text', text: 'Ready' } })).toBe('Ready');
    expect(statusText({ ...memory, key: 'context', value: { kind: 'percent', value: 25 } })).toBe('context: 25%');
  });

  it('keeps form IDs, values, defaults and outcomes identical without a presenter hint', async () => {
    const ui = driver();
    expect(await presentUiForm(form, ui, signal())).toEqual({ kind: 'form', actionId: 'send', outcome: 'submit', values: { answer: 'Exact answer' } });
    expect(ui.fields).toHaveBeenCalledWith('Question', input, expect.any(AbortSignal));
    expect(ui.choose).toHaveBeenCalledWith(expect.stringContaining('Full **context**'), [{ id: 'send', label: 'Send' }, { id: 'cancel', label: 'Cancel' }], expect.any(AbortSignal));
    expect(await presentUiForm({ ...form, hint: { id: 'unknown', version: '1' } }, ui, signal())).toMatchObject({ actionId: 'send', values: { answer: 'Exact answer' } });
  });

  it('supports explicit cancellation and zero-field submissions without fabricated field values', async () => {
    const ui = driver(); vi.mocked(ui.choose).mockResolvedValue('cancel');
    expect(await presentUiForm(form, ui, signal())).toMatchObject({ actionId: 'cancel', outcome: 'cancel', values: {} });
    expect(ui.fields).not.toHaveBeenCalled();
    vi.mocked(ui.choose).mockResolvedValue('send'); vi.mocked(ui.fields).mockResolvedValue({});
    expect(await presentUiForm({ ...form, input: { fields: [] } }, ui, signal())).toMatchObject({ actionId: 'send', values: {} });
    await expect(presentUiForm(form, ui, signal())).rejects.toThrow();
    vi.mocked(ui.choose).mockResolvedValue('not-declared');
    await expect(presentUiForm(form, ui, signal())).rejects.toThrow('Unknown form action');
  });

  it('exposes view queries, item controls, and paging using declared action-specific inputs', async () => {
    const view: UiView = { id: 'view', kind: 'view', revision: 7, title: 'Tasks', fallback: 'Task list',
      fields: [{ id: 'name', label: 'Name', valueKind: 'text' }], items: [{ id: 'one', values: { name: 'First' }, fallback: 'First' }],
      query: { actionId: 'query', values: { answer: 'Current query' } }, paging: { nextActionId: 'next' },
      actions: [{ id: 'query', label: 'Search', target: 'element', outcome: 'submit', input },
        { id: 'open', label: 'Open', target: 'item', outcome: 'submit' }, { id: 'next', label: 'Next page', target: 'element', outcome: 'submit' }] };
    const ui = driver(); vi.mocked(ui.choose).mockResolvedValue('0');
    expect(await presentUiElement(view, ui, signal())).toMatchObject({ elementId: 'view', revision: 7, actionId: 'query', values: { answer: 'Exact answer' } });
    expect(ui.fields).toHaveBeenLastCalledWith('Search', { ...input, defaults: { answer: 'Current query' } }, expect.any(AbortSignal));
    vi.mocked(ui.choose).mockResolvedValue('1'); vi.mocked(ui.fields).mockResolvedValue({});
    expect(await presentUiElement(view, ui, signal())).toEqual({ elementId: 'view', revision: 7, actionId: 'open', itemId: 'one', outcome: 'submit', values: {} });
    vi.mocked(ui.choose).mockResolvedValue('2');
    expect(await presentUiElement(view, ui, signal())).toMatchObject({ actionId: 'next', values: {} });
  });

  it('presents read-only content without inventing controls when capabilities are absent', async () => {
    const ui = driver();
    const document: UiDocument = { id: 'document', kind: 'document', revision: 1, title: 'Report', markdown: 'Full report', fallback: 'Report',
      actions: [{ id: 'close', label: 'Close', target: 'element', outcome: 'cancel' }] };
    expect(await presentUiElement(document, ui, signal(), false)).toBeUndefined();
    expect(ui.choose).not.toHaveBeenCalled();
    expect(ui.display).toHaveBeenCalledWith(expect.stringContaining('Full report'), expect.any(AbortSignal));
    expect(ui.display).toHaveBeenCalledWith(expect.stringContaining('Controls unavailable'), expect.any(AbortSignal));
    expect(presentationText({ id: 'status', kind: 'status', key: 'cost', value: { kind: 'money', value: 1.25, currency: 'USD' }, fallback: 'Cost' })).toContain('USD');
    expect(presentationText({ id: 'progress', kind: 'progress', revision: 1, label: 'Import', state: 'running', fraction: 0.5, fallback: 'Importing', actions: [] })).toContain('50%');
    await expect(presentUiElement({ ...document, markdown: '<script>bad</script>' }, ui, signal())).rejects.toThrow();
  });

  it('collects TUI typed values and preserves option identities and explicit defaults', async () => {
    const select = vi.fn().mockResolvedValueOnce('2. Yes (default)').mockResolvedValueOnce('2. Same')
      .mockResolvedValueOnce('2. [ ] Second').mockResolvedValueOnce('Done');
    const editor = vi.fn(async () => 'edited'); const textInput = vi.fn(async () => '2.5');
    const ui = { select, editor, input: textInput, notify: vi.fn() } as unknown as InteractionPresenterUi;
    const values = await createGenericTuiDriver(ui).fields('Form', { fields: [
      { id: 'flag', kind: 'boolean', label: 'Flag', required: true },
      { id: 'choice', kind: 'enum', label: 'Choice', required: true, options: [{ id: 'a', label: 'Same' }, { id: 'b', label: 'Same' }] },
      { id: 'many', kind: 'multi_select', label: 'Many', required: true, options: [{ id: 'a', label: 'First' }, { id: 'b', label: 'Second' }], maxSelections: 2 },
      { id: 'text', kind: 'string', label: 'Text', required: true, multiline: true, maxLength: 30 },
      { id: 'number', kind: 'number', label: 'Number', required: true },
    ], defaults: { flag: true, many: ['a'], text: 'draft', number: 1 } }, signal());
    expect(values).toEqual({ flag: true, choice: 'b', many: ['a', 'b'], text: 'edited', number: 2.5 });
    expect(editor).toHaveBeenCalledWith('Form\nText', 'draft', expect.any(Object));
  });

  it('renders a scrollable safe document and answers a no-hint form through the installed TUI presenter', async () => {
    const custom = vi.fn(async (factory: Parameters<InteractionPresenterUi['custom']>[0]) => {
      let result: unknown;
      const component = await factory({ terminal: { rows: 10 }, requestRender: vi.fn() } as never,
        { fg: (_color: string, text: string) => text, bold: (text: string) => text } as never, {} as never, value => { result = value; });
      expect(component.render(50).join('\n')).not.toContain('FINAL LINE');
      for (let index = 0; index < 12; index++) component.handleInput?.('\x1b[6~');
      expect(component.render(50).join('\n')).toContain('FINAL LINE');
      component.handleInput?.('\r');
      return result;
    });
    const ui = { custom, select: vi.fn(async () => '1. Send'), input: vi.fn(async () => 'Typed'), notify: vi.fn() } as unknown as InteractionPresenterUi;
    const item = parseInteraction({ id: 'form', state: 'waiting', scope: { kind: 'session', session: 'session', root: 'session' },
      createdAt: Date.now(), request: { kind: 'form', form: { ...form,
        markdown: [...Array.from({ length: 20 }, (_, index) => `Line ${index}`), 'FINAL LINE'].join('\n\n') } } });
    expect(await new ClientInteractionPresenters(ui).present(item, signal())).toEqual({ state: 'answered',
      answer: { kind: 'form', actionId: 'send', outcome: 'submit', values: { answer: 'Typed' } } });
    expect(custom).toHaveBeenCalledOnce();
  });
});
