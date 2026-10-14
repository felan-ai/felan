import { decodeUiMarkdown } from '../../src/client/ui.js';
import type { Component } from '@earendil-works/pi-tui';
import type { ExtensionContext, UiForm } from '@felan-ai/agent-core';
import { createUnavailableExtensionUi } from '@felan-ai/agent-core';
import { describe, expect, it, vi } from 'vitest';
import { createPrewalkUiHost, PREWALK_FORM_HINT } from '../../../../packages/ext-prewalk/src/ui.js';
import { presentPrewalkForm } from '../../src/tui/renderers/prewalk.js';

function presenter(drive: (component: Component) => void) {
  const ui = { custom: vi.fn((factory: (...args: any[]) => Component) => new Promise(resolve => {
    const component = factory({ terminal: { rows: 30 }, requestRender: vi.fn() },
      { fg: (_color: string, text: string) => text, bold: (text: string) => text,
        italic: (text: string) => text, underline: (text: string) => text, strikethrough: (text: string) => text },
      { getKeys: () => [], matches: (data: string, binding: string) => binding === 'tui.select.confirm' || binding === 'tui.input.submit'
        ? data === '\r' : binding === 'tui.select.down' ? data === 'j' : binding === 'tui.select.cancel' && data === '\u001b' }, resolve);
    drive(component);
  })) } as unknown as Pick<ExtensionContext['ui'], 'custom'>;
  return ui;
}

async function form(plan = '# Full plan\n\nKeep all details.'): Promise<UiForm> {
  let captured!: UiForm;
  const host = createPrewalkUiHost({ ...createUnavailableExtensionUi(), request: async value => {
    captured = value;
    return { state: 'cancelled', reason: 'user' };
  } });
  await host.host.review({ ui: {} } as never, plan);
  await host.dispose();
  return captured;
}

describe('Prewalk form hint', () => {
  it('renders escaped plan text and fenced code literally without double-decoding entities', async () => {
    const plan = '# Plan\n\nArray<T> and a && b\n\n```ts\nconst value = arr[0];\n```\n\nLiteral &lt;tag&gt; and &#91;';
    const source = await form(plan);
    expect(source.markdown).toContain('Array&lt;T&gt; and a &amp;&amp; b');
    expect(decodeUiMarkdown(source.markdown!)).toBe(plan);
    const ui = presenter(component => {
      const rendered = component.render(100).join('\n');
      expect(rendered).toContain('Array<T> and a && b');
      expect(rendered).toContain('arr[0]');
      expect(rendered).toContain('Literal &lt;tag&gt; and &#91;');
      expect(rendered).not.toContain('Array&lt;T&gt;');
      expect(rendered).not.toContain('arr&#91;0&#93;');
      component.handleInput?.('\r');
    });
    expect(await presentPrewalkForm(source, ui, new AbortController().signal)).toMatchObject({ actionId: 'approve' });
  });

  it.each([
    { keys: ['\r'], actionId: 'approve', outcome: 'submit', values: {} },
    { keys: ['j', 'j', '\r'], actionId: 'cancel', outcome: 'cancel', values: {} },
    { keys: ['j', '\r', ...'More tests', '\r'], actionId: 'feedback', outcome: 'submit', values: { feedback: 'More tests' } },
  ])('reuses the plan review for $actionId', async ({ keys, actionId, outcome, values }) => {
    const source = await form();
    expect(source.hint).toEqual(PREWALK_FORM_HINT);
    const ui = presenter(component => {
      expect(component.render(80).join('\n')).toContain('Keep all details.');
      keys.forEach(key => component.handleInput?.(key));
    });
    expect(await presentPrewalkForm(source, ui, new AbortController().signal))
      .toEqual({ kind: 'form', actionId, outcome, values });
  });

  it('keeps oversized feedback open and permits dismissal without approving', async () => {
    const source = await form();
    source.input.fields = [{ id: 'feedback', kind: 'string', label: 'Feedback', required: false, multiline: true, maxLength: 3 }];
    const ui = presenter(component => {
      ['j', '\r', ...'long', '\r'].forEach(key => component.handleInput?.(key));
      expect(component.render(80).join('\n')).toContain('response is too large');
      component.handleInput?.('\u001b'); component.handleInput?.('\u001b');
    });
    expect(await presentPrewalkForm(source, ui, new AbortController().signal)).toBeUndefined();
  });

  it('does not open an aborted plan review', async () => {
    const ui = presenter(() => { throw new Error('Unexpected review'); });
    const control = new AbortController(); control.abort();
    expect(await presentPrewalkForm(await form(), ui, control.signal)).toBeUndefined();
    expect(ui.custom).not.toHaveBeenCalled();
  });
});
