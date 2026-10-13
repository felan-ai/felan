import { describe, expect, it, vi } from 'vitest';
import type { UiDocument, UiForm } from '@felan-ai/session-protocol';
import { decodeUiMarkdown } from '../../src/client/ui.js';
import { presentContextDocument } from '../../src/tui/renderers/context-view.js';
import { presentInsightsDocument } from '../../src/tui/renderers/insights.js';
import { presentFusionReviewDocument } from '../../src/tui/renderers/fusion.js';
import { presentMemoryHistory } from '../../src/tui/renderers/memory.js';
import { presentTasksElement } from '../../src/tui/renderers/tasks.js';
import { presentProcessesElement } from '../../src/tui/renderers/processes.js';
import { presentPromptHistoryElement } from '../../src/tui/renderers/prompt-history.js';
import { presentPrewalkForm } from '../../src/tui/renderers/prewalk.js';
import { presentAskUserForm } from '../../src/tui/renderers/ask-user.js';

const markdown = 'Literal &lt;T&gt; &amp; &#91;x&#93; &quot;q&quot;';
function harness() {
  const lines: string[] = [];
  const plain = (text: string) => text;
  const theme = { fg: (_key: string, text: string) => text, bg: (_key: string, text: string) => text,
    bold: plain, italic: plain, underline: plain, strikethrough: plain };
  const ui = { custom: vi.fn(async (factory: (...args: any[]) => any) => {
    const component = factory({ terminal: { rows: 40 }, requestRender: vi.fn(), pushOverlay: vi.fn() }, theme,
      { getKeys: () => [], matches: () => false }, vi.fn());
    lines.push(...component.render(140));
    return undefined;
  }), notify: vi.fn(), input: vi.fn(), select: vi.fn(), onTerminalInput: () => () => {} } as any;
  return { ui, lines };
}

it('decodes entities once, preserving literal encoded text and markdown escapes', () => {
  expect(decodeUiMarkdown('&amp;lt;x&amp;gt; &#91;y&#93; &#x26; \\*literal\\*')).toBe('&lt;x&gt; [y] & \\*literal\\*');
  expect(decodeUiMarkdown('\\[x\\] &lt;T&gt;', { plainText: true })).toBe('[x] <T>');
});

describe('hint markdown entity decoding', () => {
  it.each([
    ['context', presentContextDocument], ['insights', presentInsightsDocument], ['fusion', presentFusionReviewDocument],
    ['memory', presentMemoryHistory], ['tasks', presentTasksElement], ['processes', presentProcessesElement],
    ['history', presentPromptHistoryElement],
  ] as const)('renders %s entities as text', async (name, present) => {
    const h = harness();
    const document: UiDocument = { id: `entities-${name}`, kind: 'document', revision: 1, title: 'Literal', fallback: 'Literal', markdown,
      actions: [{ id: 'close', label: 'Close', target: 'element', outcome: 'cancel' }] };
    await present(document, h.ui, new AbortController().signal, vi.fn(), vi.fn());
    expect(h.lines.join('\n')).toContain('Literal <T> & [x] "q"');
    expect(h.lines.join('\n')).not.toContain('&lt;');
  });

  it('renders Prewalk entities without decoding the plan twice', async () => {
    const h = harness();
    const form: UiForm = { title: 'Plan', fallback: 'Plan', markdown, input: { fields: [
      { id: 'feedback', kind: 'string', label: 'Feedback', required: false, maxLength: 1000 },
    ] }, actions: [
      { id: 'approve', label: 'Approve plan', target: 'element', outcome: 'submit' },
      { id: 'feedback', label: 'Provide feedback', target: 'element', outcome: 'submit' },
      { id: 'cancel', label: 'Cancel Prewalk', target: 'element', outcome: 'cancel' },
    ] };
    await presentPrewalkForm(form, h.ui, new AbortController().signal);
    expect(h.lines.join('\n')).toContain('Literal <T> & [x] "q"');
  });

  it('renders ask-user entities in the question', async () => {
    const h = harness();
    const form: UiForm = { title: 'Question', fallback: 'Question', markdown: `## Question 1: Header\n\n${markdown}\n\nChoose an answer type.`,
      input: { fields: [{ id: 'q.text', kind: 'string', label: 'Answer', required: false, maxLength: 1000 }] },
      actions: [{ id: 'submit', label: 'Submit', target: 'element', outcome: 'submit' }, { id: 'cancel', label: 'Cancel', target: 'element', outcome: 'cancel' }] };
    await presentAskUserForm(form, { ui: h.ui, signal: new AbortController().signal });
    expect(h.lines.join('\n')).toContain('Literal <T> & [x] "q"');
  });
});
