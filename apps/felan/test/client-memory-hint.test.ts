import { describe, expect, it, vi } from 'vitest';
import type { Component } from '@earendil-works/pi-tui';
import { parseUiPresentation, type UiDocument, type UiView } from '@felan-ai/session-protocol';
import { stripVTControlCharacters } from 'node:util';
import { defaultClientTheme } from '../src/tui/theme.js';
import { MEMORY_HISTORY_HINT, presentMemoryHistory } from '../src/tui/renderers/memory.js';
import type { InteractionPresenterUi } from '../src/client/presenters.js';

const view: UiView = {
  kind: 'view', id: 'memory', revision: 2, title: 'Memory history', fallback: 'Ready', hint: MEMORY_HISTORY_HINT,
  fields: [{ id: 'run', label: 'Run', valueKind: 'text' }, { id: 'project', label: 'Project', valueKind: 'text' },
    { id: 'updated', label: 'Updated', valueKind: 'date' }, { id: 'messages', label: 'Messages', valueKind: 'number' }],
  items: [{ id: 'opaque-run', fallback: 'Run', values: { run: 'Run', project: '/project', updated: '2026-10-13T00:00:00Z', messages: 4 } }],
  actions: [{ id: 'inspect', label: 'Inspect', target: 'item', outcome: 'submit' }, { id: 'close', label: 'Close', target: 'element', outcome: 'cancel' },
    { id: 'next', label: 'Next', target: 'element', outcome: 'submit' }, { id: 'refresh', label: 'Refresh', target: 'element', outcome: 'submit' },
    { id: 'query', label: 'Search', target: 'element', outcome: 'submit', input: { fields: [{ id: 'query', label: 'Search', kind: 'string', required: false, maxLength: 1024 }] } }],
  query: { actionId: 'query', values: { query: 'old' } }, paging: { nextActionId: 'next' },
};

function harness() {
  let component!: Component;
  const custom = vi.fn<InteractionPresenterUi['custom']>(factory => new Promise(resolve => {
    const plain = (text: string) => text;
    component = factory({ terminal: { rows: 24 }, requestRender: vi.fn() } as never,
      { fg: (_name: string, text: string) => text, bold: plain } as never, { matches: () => false } as never, resolve) as Component;
  }));
  const input = vi.fn<InteractionPresenterUi['input']>(async () => 'new');
  return { ui: { custom, input } as Pick<InteractionPresenterUi, 'custom' | 'input'>, input, component: () => component };
}

describe('memory history hint', () => {
  it('renders the retained run picker and returns opaque item identity', async () => {
    const h = harness(); const result = presentMemoryHistory(view, h.ui, new AbortController().signal);
    expect(h.component().render(90).join('\n')).toContain('Run');
    expect(h.component().render(90).join('\n')).not.toMatch(/Tab|scope|Ctrl\+S|Ctrl\+N|Ctrl\+P/);
    h.component().handleInput?.('\r');
    await expect(result).resolves.toEqual({ elementId: 'memory', revision: 2, actionId: 'inspect', itemId: 'opaque-run', outcome: 'submit', values: {} });
  });

  it.each([['\x1b[C', 'next'], ['\x12', 'refresh'], ['\x1b', 'close']])('maps %j to %s', async (key, actionId) => {
    const h = harness(); const result = presentMemoryHistory(view, h.ui, new AbortController().signal);
    h.component().handleInput?.(key);
    if (actionId) await expect(result).resolves.toMatchObject({ actionId, elementId: 'memory', revision: 2 });
    else await expect(result).resolves.toBeUndefined();
  });

  it('sends search through the vocabulary query action', async () => {
    const h = harness(); const result = presentMemoryHistory(view, h.ui, new AbortController().signal);
    h.component().handleInput?.('\x06');
    await expect(result).resolves.toMatchObject({ actionId: 'query', values: { query: 'new' } });
    expect(h.ui.input).toHaveBeenCalledWith('Search', undefined, expect.objectContaining({ initialValue: 'old' }));
  });

  it('scrolls documents, returns to runs and cancels on abort', async () => {
    const document: UiDocument = { kind: 'document', id: 'detail', revision: 1, title: 'Memory run', fallback: 'Memory run',
      markdown: Array.from({ length: 100 }, (_, index) => `- Message ${index}`).join('\n'),
      actions: [{ id: 'back', label: 'Back', target: 'element', outcome: 'submit' }] };
    const h = harness(); const controller = new AbortController();
    const result = presentMemoryHistory(document, h.ui, controller.signal);
    h.component().handleInput?.('\x1b[F');
    expect(h.component().render(80).join('\n')).toContain('Message 99');
    h.component().handleInput?.('\x7f');
    await expect(result).resolves.toMatchObject({ actionId: 'back', outcome: 'submit' });
    const pending = presentMemoryHistory(view, h.ui, controller.signal);
    controller.abort();
    await expect(pending).resolves.toBeUndefined();
  });

  it('can close a detail document without returning to the run picker', async () => {
    const document: UiDocument = { kind: 'document', id: 'detail', revision: 4, title: 'Memory run', fallback: 'Memory run',
      markdown: 'Retained messages', actions: [{ id: 'back', label: 'Back', target: 'element', outcome: 'submit' },
        { id: 'close', label: 'Close', target: 'element', outcome: 'cancel' }] };
    const h = harness(); const result = presentMemoryHistory(document, h.ui, new AbortController().signal);
    expect(h.component().render(80).join('\n')).toContain('q close');
    h.component().handleInput?.('q');
    await expect(result).resolves.toEqual({ elementId: 'detail', revision: 4, actionId: 'close', outcome: 'cancel', values: {} });
  });

  it('renders a retained run as a session transcript with tool and thinking toggles', async () => {
    const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0 } };
    const messages = [
      { role: 'user', content: [{ type: 'text', text: 'Update project memory' }], timestamp: 1 },
      { role: 'assistant', content: [{ type: 'text', text: 'Reading the index' }, { type: 'toolCall', id: 'call-1', name: 'read', arguments: { path: '.memory/index.md' } }],
        provider: 'openai', model: 'gpt', api: 'openai-responses', stopReason: 'toolUse', usage, timestamp: 2 },
      { role: 'toolResult', toolCallId: 'call-1', toolName: 'read', content: [{ type: 'text', text: '# Memory index' }], isError: false, timestamp: 3 },
      { role: 'assistant', content: [{ type: 'text', text: 'Memory is current.' }], provider: 'openai', model: 'gpt', api: 'openai-responses',
        stopReason: 'stop', usage, timestamp: 4 },
    ];
    const document = parseUiPresentation({ kind: 'document', id: 'detail', revision: 1, title: 'Memory: project · completed', fallback: 'Memory run',
      markdown: '### User\n\nUpdate project memory', hint: { ...MEMORY_HISTORY_HINT, data: { transcript: {
        cwd: '/project', page: 1, pages: 2, details: ['Status: completed · Phase: publish'], messages } } },
      actions: [{ id: 'next', label: 'Next page', target: 'element', outcome: 'submit' }, { id: 'close', label: 'Close', target: 'element', outcome: 'cancel' }] });
    let component!: Component;
    const ui = { input: vi.fn(), custom: vi.fn<InteractionPresenterUi['custom']>(factory => new Promise(resolve => {
      component = factory({ terminal: { rows: 60 }, requestRender: vi.fn() } as never, defaultClientTheme() as never,
        { matches: (data: string, action: string) => action === 'app.tools.expand' && data === '\x0f' } as never, resolve) as Component;
    })) } as Pick<InteractionPresenterUi, 'custom' | 'input'>;

    const result = presentMemoryHistory(document, ui, new AbortController().signal);
    const output = stripVTControlCharacters(component.render(100).join('\n'));
    expect(output).toContain('Page 1 of 2');
    expect(output).toContain('Status: completed');
    expect(output).toContain('Update project memory');
    expect(output).toContain('Memory is current.');
    expect(output).not.toContain('"role"');
    expect(output).toMatch(/expand tools/);
    component.handleInput?.('\x0f');
    expect(stripVTControlCharacters(component.render(100).join('\n'))).toMatch(/collapse tools/);
    component.handleInput?.('\x1b[C');
    await expect(result).resolves.toMatchObject({ actionId: 'next', outcome: 'submit' });
  });
});
