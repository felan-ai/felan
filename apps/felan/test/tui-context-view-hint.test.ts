import type { ExtensionContext, UiDocument } from '@felan-ai/agent-core';
import type { Component } from '@earendil-works/pi-tui';
import { describe, expect, it, vi } from 'vitest';
import { CONTEXT_DOCUMENT_HINT } from '@felan-ai/ext-context-view';
import { presentContextDocument } from '../src/tui/renderers/context-view.js';

const document: UiDocument = {
  id: 'context', kind: 'document', revision: 3, title: 'Context usage', fallback: 'Context usage', hint: CONTEXT_DOCUMENT_HINT,
  markdown: Array.from({ length: 100 }, (_, index) => `- Skill ${index}`).join('\n'),
  actions: [{ id: 'close', label: 'Close report', target: 'element', outcome: 'cancel' }],
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

describe('context document hint', () => {
  it('scrolls through all details and maps close to the document revision', async () => {
    const h = harness();
    const result = presentContextDocument(document, h.ui, new AbortController().signal);
    expect(h.component().render(80).join('\n')).toContain('Skill 0');
    h.component().handleInput?.('\x1b[F');
    const bottom = h.component().render(80).join('\n');
    expect(bottom).toContain('Skill 99');
    expect(bottom).not.toContain('Skill 0');
    h.component().handleInput?.('\r');
    await expect(result).resolves.toEqual({ elementId: 'context', revision: 3, actionId: 'close', outcome: 'cancel', values: {} });
  });

  it('settles on abort and does not create a view for an already aborted signal', async () => {
    const h = harness(); const controller = new AbortController();
    const result = presentContextDocument(document, h.ui, controller.signal);
    controller.abort();
    await expect(result).resolves.toBeUndefined();
    await expect(presentContextDocument(document, h.ui, controller.signal)).resolves.toBeUndefined();
    expect(h.ui.custom).toHaveBeenCalledOnce();
  });
});
