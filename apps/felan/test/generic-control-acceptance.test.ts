import {
  createUnavailableExtensionUi, type ExtensionContext, type ExtensionUi, type UiInteractiveElement,
  type UiPresentOptions, type UiValues,
} from '@felan-ai/agent-core';
import { parseUiForm, parseUiPresentation, type UiForm } from '@felan-ai/session-protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createUiAskUserHost } from '../../../packages/ext-ask-user/src/ui.js';
import { createPrewalkUiHost } from '../../../packages/ext-prewalk/src/ui.js';
import { CONTEXT_DOCUMENT_HINT, createContextViewUiHost } from '../../../packages/ext-context-view/src/ui.js';
import type { ContextReport } from '../../../packages/ext-context-view/src/report.js';
import { createTasksUi } from '../../../packages/ext-tasks/src/portable-ui.js';
import { createTask, emptyTaskState } from '../../../packages/ext-tasks/src/graph.js';
import type { TaskDataSource } from '../../../packages/ext-tasks/src/host.js';
import { presentUiElement, presentUiForm, type GenericUiDriver } from '../src/client/ui.js';

const signal = () => new AbortController().signal;
const context = new Proxy({} as ExtensionContext, { get() { throw new Error('No client-mode or legacy UI access is permitted.'); } });
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

function bridge() {
  const forms: UiForm[] = [];
  const elements: Array<{ source: UiInteractiveElement; options: UiPresentOptions; closed: boolean }> = [];
  let values: UiValues = {};
  let choose = 'submit';
  let acknowledged: Promise<void> = Promise.resolve();
  const driver: GenericUiDriver = {
    choose: vi.fn(async () => choose), fields: vi.fn(async () => values), display: vi.fn(async () => {}),
  };
  const ui: ExtensionUi = { ...createUnavailableExtensionUi(),
    request: async (input, options) => {
      const { hint: _hint, ...form } = parseUiForm(input);
      forms.push(form);
      const answer = await presentUiForm(form, driver, options?.signal ?? signal());
      if (!answer) return { state: 'cancelled', reason: 'user' };
      await acknowledged;
      return { state: 'answered', answer };
    },
    present: async (input, options = {}) => {
      parseUiPresentation(input);
      const row = { source: structuredClone(input), options, closed: false };
      elements.push(row);
      return {
        update: async next => {
          expect(row.closed).toBe(false);
          expect(next.id).toBe(row.source.id); expect(next.kind).toBe(row.source.kind);
          expect(next.revision).toBeGreaterThan(row.source.revision);
          parseUiPresentation(next); row.source = structuredClone(next);
        },
        close: async () => { row.closed = true; },
      };
    },
  };
  return { ui, driver, forms, elements,
    answer(action: string, next: UiValues = {}, ack = Promise.resolve()) { choose = action; values = next; acknowledged = ack; },
    current() { const row = [...elements].reverse().find(row => !row.closed); if (!row) throw new Error('No active presentation.'); return row; },
    async act(actionId: string, next: UiValues = {}, itemId?: string) {
      const row = this.current();
      const { hint: _hint, ...source } = row.source;
      const choices: Array<{ action: UiInteractiveElement['actions'][number]; itemId?: string }> = [];
      for (const action of source.actions) {
        if (action.target === 'item' && source.kind === 'view') {
          for (const item of source.items) choices.push({ action, itemId: item.id });
        } else if (action.target === 'element') choices.push({ action });
      }
      const index = choices.findIndex(choice => choice.action.id === actionId && choice.itemId === itemId);
      if (index < 0) throw new Error('Requested control is not declared.');
      choose = String(index); values = next;
      const request = await presentUiElement(source, driver, signal());
      if (!request || !row.options.onAction) throw new Error('No executable action.');
      await row.options.onAction(request, { requestId: 'acceptance-action', signal: signal() });
      return request;
    },
  };
}

function report(): ContextReport {
  return { breakdown: { systemPrompt: 1, systemTools: 2, extensions: 3, contextFiles: 4, skills: 5, memory: 6, messages: 7, other: 8, available: 64 },
    usedTokens: 36, contextWindow: 100, usagePercent: 36, estimated: true, systemToolCount: 1, extensionToolCount: 1,
    contextFileCount: 1, skillCount: 1, memory: { summary: 1, index: 2, schema: 3, recalls: 4 },
    modelLabel: 'Fixture model', extensionDetails: [{ label: 'Fixture extension', toolCount: 1, tokens: 3 }],
    skillDetails: [{ label: 'Fixture skill', tokens: 5, promptVisible: true }] };
}

describe('independent generic-control acceptance', () => {
  it('passes real Prewalk entry/review forms through no-hint rendering and waits for the response', async () => {
    const b = bridge(); const host = createPrewalkUiHost(b.ui);
    let acknowledge!: () => void;
    b.answer('enter', {}, new Promise(resolve => { acknowledge = resolve; }));
    let completed = false;
    const entry = host.host.confirmEntry!(context, 'Explicit planning approval', signal()).then(value => { completed = true; return value; });
    cleanups.push(async () => { acknowledge(); await entry.catch(() => {}); await host.dispose(); });
    await vi.waitFor(() => expect(b.forms).toHaveLength(1));
    expect(completed).toBe(false); expect(b.forms[0]?.hint).toBeUndefined();
    acknowledge(); expect(await entry).toBe(true);
    b.answer('feedback', { feedback: 'Keep the existing API.' });
    expect(await host.host.review(context, '# Plan\n\nPreserve the API.', signal())).toEqual({ action: 'Provide feedback', feedback: 'Keep the existing API.' });
    b.answer('cancel'); expect(await host.host.review(context, '# Plan', signal())).toEqual({ action: 'Cancel Prewalk' });
    await host.dispose();
  });

  it('runs a real ask-user wizard through generic fields without fabricating selections', async () => {
    const b = bridge();
    const request = { questions: [
      { id: 'q1', header: 'Checks', question: 'Which checks?', options: [{ title: 'Unit' }, { title: 'Integration' }], allowMultiple: true, allowFreeform: false, allowComment: true },
      { id: 'q2', header: 'Approach', question: 'Explain the approach.', options: [], allowMultiple: false, allowFreeform: true, allowComment: false },
    ] };
    const execution = { requestId: 'wizard', sessionId: 'session', signal: signal(), extensionContext: context, reportProgress() {} };
    const host = createUiAskUserHost(b.ui);
    b.answer('submit', { 'q1.mode': 'selection', 'q1.selection': ['option1', 'option2'], 'q1.comment': 'Both are required.', 'q2.mode': 'freeform', 'q2.text': 'Use existing boundaries.' });
    expect(await host.ask(request, execution)).toEqual({ status: 'answered', answers: [
      { questionId: 'q1', response: { kind: 'selection', selections: ['Unit', 'Integration'], comment: 'Both are required.' } },
      { questionId: 'q2', response: { kind: 'freeform', text: 'Use existing boundaries.' } },
    ] });
    b.answer('submit', { 'q1.mode': 'selection', 'q2.mode': 'skip' });
    await expect(host.ask(request, execution)).rejects.toThrow();
    b.answer('cancel'); expect(await host.ask(request, execution)).toEqual({ status: 'cancelled', reason: 'user' });
    expect(b.forms.every(form => form.hint === undefined)).toBe(true);
  });

  it('reads and closes the real context document using its declared canonical action', async () => {
    const b = bridge();
    const host = createContextViewUiHost(b.ui);
    let complete = false;
    const lifetime = new AbortController();
    const work = host.show(report(), lifetime.signal).then(() => { complete = true; });
    cleanups.push(async () => { lifetime.abort(); await work; });
    await vi.waitFor(() => expect(b.elements).toHaveLength(1));
    const row = b.current();
    expect(row.source.hint).toEqual(CONTEXT_DOCUMENT_HINT);
    expect(row.source).toMatchObject({ kind: 'document', markdown: expect.stringContaining('Fixture extension') });
    expect(complete).toBe(false);
    const action = await b.act('close'); await work;
    expect(action).toMatchObject({ elementId: row.source.id, revision: 1, actionId: 'close', outcome: 'cancel', values: {} });
    expect(row.closed).toBe(true); expect(complete).toBe(true);
  });

  it('filters, pages and opens real task documents while read-only controls stay read-only', async () => {
    const b = bridge(); let state = emptyTaskState();
    for (let index = 0; index < 25; index++) state = createTask(state, { title: `Task ${index}`, description: `Full task description ${index}` },
      `T-${index.toString(16).toUpperCase().padStart(6, '0')}`, '2026-01-01').state;
    const source: TaskDataSource = { snapshot: async () => state, subscribe: () => () => {} };
    const lifetime = new AbortController();
    const work = createTasksUi(b.ui).show(source, lifetime.signal);
    cleanups.push(async () => { lifetime.abort(); await work; });
    await vi.waitFor(() => expect(b.elements).toHaveLength(1));
    expect(b.current().source.actions.some(action => action.id === 'create' || action.id === 'update')).toBe(false);
    expect(b.current().source.hint).toEqual({ id: 'felan.tasks', version: '1' });
    await b.act('next');
    const page = b.current().source;
    if (page.kind !== 'view') throw new Error('Expected the task list.');
    expect(page.items).toHaveLength(5);
    const selected = page.items[0]!;
    await b.act('detail', {}, selected.id);
    expect(b.current().source).toMatchObject({ kind: 'document', markdown: expect.stringContaining('Full task description') });
    await b.act('back'); await b.act('filter', { filter: 'all', search: 'Task 24' });
    const filtered = b.current().source;
    if (filtered.kind !== 'view') throw new Error('Expected filtered tasks.');
    expect(filtered.items.map(item => item.values.title)).toEqual(['Task 24']);
    await expect(b.act('create', { title: 'Not authorized' })).rejects.toThrow('not declared');
    await b.act('close'); await work;
  });

  it('does not turn standalone unavailable UI into approvals, answered choices, or completed views', async () => {
    const ui = createUnavailableExtensionUi();
    const prewalk = createPrewalkUiHost(ui);
    expect(await prewalk.host.confirmEntry!(context, 'Approval required', signal())).toBe(false);
    expect(await prewalk.host.review(context, '# Plan', signal())).toBeUndefined();
    await prewalk.dispose();
    const ask = createUiAskUserHost(ui);
    expect(await ask.ask({ questions: [{ id: 'q1', header: 'Question', question: 'Explain', options: [], allowMultiple: false, allowFreeform: true, allowComment: false }] },
      { requestId: 'standalone', sessionId: 'session', signal: signal(), extensionContext: context, reportProgress() {} }))
      .toEqual({ status: 'cancelled', reason: 'unavailable' });
    await expect(createContextViewUiHost(ui).show(report(), signal()))
      .rejects.toThrow('unavailable');
  });
});
