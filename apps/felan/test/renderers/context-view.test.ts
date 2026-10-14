import { expect, it, vi } from 'vitest';
import type { ExtensionContext, UiDocument } from '@felan-ai/agent-core';
import { presentContextDocument } from '../../src/tui/renderers/context-view.js';

const document: UiDocument = { kind: 'document', id: 'context', revision: 1, title: 'Context',
  markdown: Array.from({ length: 40 }, (_, i) => `Row ${i}\n`).join('\n'), fallback: 'Context report',
  actions: [{ id: 'close', target: 'element', label: 'Close', outcome: 'cancel' }] };
const theme = { fg: (_name: string, value: string) => value, bold: (value: string) => value, italic: (value: string) => value,
  strikethrough: (value: string) => value, underline: (value: string) => value };

it.each(['inline', 'overlay'] as const)('renders and scrolls context %s, returning the close action', async mode => {
  const custom = vi.fn((factory: (...args: any[]) => any, _options?: unknown) => new Promise(resolve => {
    const panel = factory({ terminal: { rows: 24 }, requestRender: vi.fn() }, theme, {}, resolve);
    panel.handleInput('\x1b[H');
    expect(panel.render(80).join('\n')).toContain('Row 0');
    panel.handleInput('\x1b[F');
    expect(panel.render(80).join('\n')).toContain('Row 39');
    panel.handleInput('\x1b');
  }));
  const ui = { custom } as unknown as Pick<ExtensionContext['ui'], 'custom'>;
  expect(await presentContextDocument(document, ui, new AbortController().signal, mode)).toMatchObject({ actionId: 'close', outcome: 'cancel' });
  expect(custom.mock.calls[0]?.[1]).toEqual(mode === 'inline' ? undefined : {
    overlay: true, overlayOptions: { width: '85%', minWidth: 72, maxHeight: '90%', margin: 2 },
  });
});

it('does not open context after cancellation', async () => {
  const abort = new AbortController(); abort.abort();
  const custom = vi.fn();
  expect(await presentContextDocument(document, { custom } as unknown as Pick<ExtensionContext['ui'], 'custom'>, abort.signal)).toBeUndefined();
  expect(custom).not.toHaveBeenCalled();
});
