import type { ExtensionContext, UiDocument } from '@felan-ai/agent-core';
import type { Component } from '@earendil-works/pi-tui';
import { describe, expect, it, vi } from 'vitest';
import { INSIGHTS_DOCUMENT_HINT } from '@felan-ai/ext-insights';
import { presentInsightsDocument } from '../src/tui/renderers/insights.js';

const document: UiDocument = {
  id: 'insights', kind: 'document', revision: 3, title: 'Session insights', fallback: 'Session insights', hint: INSIGHTS_DOCUMENT_HINT,
  markdown: Array.from({ length: 100 }, (_, index) => `- Report row ${index}`).join('\n'),
  actions: [{ id: 'next', label: 'Next', target: 'element', outcome: 'submit' }],
};

function harness() {
  let component!: Component;
  const custom = vi.fn<ExtensionContext['ui']['custom']>(factory => new Promise(resolve => {
    const plain = (text: string) => text;
    component = factory({ terminal: { rows: 15 }, requestRender: vi.fn() } as never,
      { fg: (_name: string, text: string) => text, bold: plain, italic: plain, strikethrough: plain, underline: plain } as never,
      {} as never, resolve) as Component;
  }));
  return { ui: { custom } as Pick<ExtensionContext['ui'], 'custom'>, custom, component: () => component };
}

describe('insights document hint', () => {
  it('scrolls through the report and returns the declared page action', async () => {
    const h = harness(); const result = presentInsightsDocument(document, h.ui, new AbortController().signal);
    expect(h.component().render(80).join('\n')).toContain('Report row 0');
    h.component().handleInput?.('\x1b[F');
    expect(h.component().render(80).join('\n')).toContain('Report row 99');
    h.component().handleInput?.('\x1b[C');
    await expect(result).resolves.toEqual({ elementId: 'insights', revision: 3, actionId: 'next', outcome: 'submit', values: {} });
  });

  it('ignores unavailable page actions and dismisses without a fabricated response', async () => {
    const h = harness(); const result = presentInsightsDocument({ ...document, actions: [] }, h.ui, new AbortController().signal);
    h.component().handleInput?.('\x1b[C');
    h.component().handleInput?.('\x1b');
    await expect(result).resolves.toBeUndefined();
  });

  it('closes a single-page report through its declared cancel action', async () => {
    const h = harness();
    const result = presentInsightsDocument({ ...document, actions: [{ id: 'close', label: 'Close report', target: 'element', outcome: 'cancel' }] }, h.ui, new AbortController().signal);
    h.component().handleInput?.('\x1b');
    await expect(result).resolves.toMatchObject({ elementId: document.id, actionId: 'close', outcome: 'cancel' });
  });

  it('cancels promptly on abort and skips an already aborted view', async () => {
    const h = harness(); const controller = new AbortController();
    const result = presentInsightsDocument(document, h.ui, controller.signal);
    controller.abort();
    await expect(result).resolves.toBeUndefined();
    await expect(presentInsightsDocument(document, h.ui, controller.signal)).resolves.toBeUndefined();
    expect(h.custom).toHaveBeenCalledOnce();
  });
});
