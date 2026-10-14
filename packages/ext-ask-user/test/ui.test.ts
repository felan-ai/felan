import {
  createUnavailableExtensionUi, getExtensionConfigDefinition,
  type ExtensionUi, type FelanExtensionAPI, type ToolDefinition, type UiRequestResult, type UiValues,
} from '@felan-ai/agent-core';
import { parseUiForm } from '@felan-ai/session-protocol';
import { describe, expect, it, vi } from 'vitest';
import extension from '../src/extension.js';

function answered(values: UiValues): UiRequestResult {
  return { state: 'answered', answer: { kind: 'form', actionId: 'submit', outcome: 'submit', values } };
}

function harness(implementation: ExtensionUi['request'] = async () => answered({ 'q1.text': 'A written answer' })) {
  const request = vi.fn(implementation);
  let tool!: ToolDefinition;
  extension({
    config: {},
    ui: { ...createUnavailableExtensionUi(), request },
    get services() { throw new Error('Default root must not request services.'); },
    registerCapability: vi.fn(),
    registerTool: (definition: ToolDefinition) => { tool = definition; },
  } as unknown as FelanExtensionAPI);
  const context = {
    get mode() { throw new Error('Client mode must not govern generic UI.'); },
    get hasUI() { throw new Error('hasUI must not govern generic UI.'); },
    get ui() { throw new Error('Pi context dialogs must not replace generic UI.'); },
    sessionManager: { getSessionId: () => 'session-1' },
  } as unknown as Parameters<ToolDefinition['execute']>[4];
  return {
    request,
    execute: (input: Record<string, unknown>, signal?: AbortSignal) => tool.execute('ask-1', input, signal, undefined, context),
  };
}

const choices = { question: 'Choose?', options: [{ title: 'Alpha' }, { title: 'Beta' }], allowComment: true };

describe('ask-user generic UI root', () => {
  it('needs no service and preserves config metadata, signal, timeout, and the required freeform answer', async () => {
    expect(extension.serviceRequirements).toEqual({});
    expect(getExtensionConfigDefinition(extension)).toBeUndefined();
    const f = harness();
    const signal = new AbortController().signal;
    const result = await f.execute({ question: 'Describe the plan?', context: 'Explain the tradeoff.', timeout: 1200,
      displayMode: 'overlay', singleSelectLayout: 'list' }, signal);
    expect(result.details).toMatchObject({ status: 'answered', response: { kind: 'freeform', text: 'A written answer' } });
    expect(f.request).toHaveBeenCalledOnce();
    const [form, options] = f.request.mock.calls[0]!;
    expect(options).toEqual({ signal, deferrable: true, timeoutMs: 1200 });
    expect(form.hint).toEqual({ id: 'ask-user.wizard', version: '1' });
    expect(form.input).toEqual({ fields: [{ id: 'q1.text', kind: 'string', label: 'Question 1: Written answer', required: true,
      multiline: true, maxLength: 32 * 1024 }] });
    expect(form.markdown).toContain('Describe the plan?');
    expect(form.markdown).toContain('Explain the tradeoff\\.');
    expect(form.actions).toEqual([
      { id: 'submit', label: 'Submit answers', target: 'element', outcome: 'submit' },
      { id: 'cancel', label: 'Cancel', target: 'element', outcome: 'cancel' },
    ]);
  });

  it('maps one wizard to a form with explicit modes, stable options, comments, freeform, and an explicit skip', async () => {
    const f = harness(async () => answered({
      'q1.mode': 'selection', 'q1.selection': 'option2',
      'q2.mode': 'selection', 'q2.selection': ['option1', 'option2'], 'q2.comment': 'Both are useful',
      'q3.mode': 'freeform', 'q3.text': 'Something else',
      'q4.mode': 'skip',
    }));
    const result = await f.execute({ questions: [
      { question: 'Which scope?', header: 'Scope', options: [{ title: 'Small', description: 'A focused change' }, { title: 'Full' }], allowFreeform: false },
      { question: 'Which checks?', options: [{ title: 'Unit' }, { title: 'Integration' }], allowMultiple: true, allowComment: true },
      { question: 'Which approach?', options: [{ title: 'Default' }] },
      { question: 'Anything else?' },
    ] });
    expect(result.details).toMatchObject({ kind: 'wizard', status: 'answered', responses: {
      q1: { kind: 'selection', selections: ['Full'] },
      q2: { kind: 'selection', selections: ['Unit', 'Integration'], comment: 'Both are useful' },
      q3: { kind: 'freeform', text: 'Something else' },
      q4: null,
    } });
    expect(f.request).toHaveBeenCalledOnce();
    const form = f.request.mock.calls[0]![0];
    expect(form.hint).toEqual({ id: 'ask-user.wizard', version: '1' });
    expect(form.input.defaults).toBeUndefined();
    expect(form.input.fields).toContainEqual(expect.objectContaining({
      id: 'q1.mode', kind: 'enum', required: true,
      options: [{ id: 'selection', label: 'Choose listed options' }, { id: 'skip', label: 'Skip this question' }],
    }));
    expect(form.input.fields).toContainEqual(expect.objectContaining({
      id: 'q2.selection', kind: 'multi_select', maxSelections: 2, required: false,
      options: [{ id: 'option1', label: 'Unit' }, { id: 'option2', label: 'Integration' }],
    }));
    expect(form.markdown).toContain('A focused change');
    expect(form.markdown).toContain('Which approach?');
  });

  it('maps choice-only single and multi-select without inventing a default', async () => {
    for (const allowMultiple of [false, true]) {
      const f = harness(async () => answered({ 'q1.selection': allowMultiple ? ['option2'] : 'option2' }));
      expect((await f.execute({ ...choices, allowMultiple, allowFreeform: false })).details)
        .toMatchObject({ status: 'answered', response: { kind: 'selection', selections: ['Beta'] } });
      const form = f.request.mock.calls[0]![0];
      expect(form.input.fields.find(field => field.id === 'q1.selection')).toMatchObject({ required: true, kind: allowMultiple ? 'multi_select' : 'enum' });
      expect(form.input.fields.some(field => field.id === 'q1.mode' || field.id === 'q1.text')).toBe(false);
      expect(form.input.defaults).toBeUndefined();
    }
  });

  it.each([
    {},
    { 'q1.mode': 'selection' },
    { 'q1.mode': 'selection', 'q1.selection': [] },
    { 'q1.mode': 'selection', 'q1.selection': ['option1', 'option1'] },
    { 'q1.mode': 'selection', 'q1.selection': ['option3'] },
    { 'q1.mode': 'selection', 'q1.selection': ['option1', 'option2', 'option3'] },
    { 'q1.mode': 'selection', 'q1.selection': ['option1'], 'q1.text': 'Conflicting answer' },
    { 'q1.mode': 'freeform', 'q1.text': '' },
    { 'q1.mode': 'freeform', 'q1.text': '   ' },
    { 'q1.mode': 'freeform', 'q1.text': 'Other', 'q1.selection': ['option1'] },
    { 'q1.mode': 'freeform', 'q1.text': 'Other', 'q1.comment': 'Comment on no selection' },
    { 'q1.mode': 'freeform', 'q1.text': 'Other', unknown: true },
    { 'q1.mode': 'skip' },
    { 'q1.mode': 'freeform', 'q1.text': 'x'.repeat(32 * 1024 + 1) },
  ] satisfies UiValues[])('rejects incomplete, conflicting, or invalid generic answer %j', async values => {
    const f = harness(async () => answered(values));
    const result = await f.execute({ ...choices, allowMultiple: true });
    expect(result).toMatchObject({ isError: true });
    expect(result.details).not.toHaveProperty('status', 'answered');
  });

  it('rejects multiple values for a single choice and rejects comments when not enabled', async () => {
    for (const values of [{ 'q1.selection': ['option1', 'option2'] }, { 'q1.selection': 'option1', 'q1.comment': 'Not allowed' }]) {
      const f = harness(async () => answered(values));
      expect(await f.execute({ ...choices, allowComment: false, allowFreeform: false })).toMatchObject({ isError: true });
    }
  });

  it('accepts empty inactive fields but never all-skipped or conflicting wizard answers', async () => {
    const f = harness(async () => answered({ 'q1.mode': 'freeform', 'q1.text': 'Other', 'q1.selection': [], 'q1.comment': '' }));
    expect((await f.execute({ ...choices, allowMultiple: true })).details).toMatchObject({ status: 'answered', response: { kind: 'freeform', text: 'Other' } });
    const questions = [{ question: 'First?', options: [{ title: 'One' }] }, { question: 'Second?' }];
    for (const values of [
      { 'q1.mode': 'skip', 'q2.mode': 'skip' },
      { 'q1.mode': 'skip', 'q1.selection': 'option1', 'q2.mode': 'freeform', 'q2.text': 'Answer' },
    ]) {
      expect(await harness(async () => answered(values)).execute({ questions })).toMatchObject({ isError: true });
    }
  });

  it('preserves deferred identity without waiting on a presenter', async () => {
    const f = harness(async () => ({ state: 'deferred', interactionId: 'interaction-42' }));
    expect((await f.execute(choices)).details).toMatchObject({ status: 'deferred', interactionId: 'interaction-42' });
  });

  it.each([
    ['user', 'user'], ['timeout', 'timeout'], ['abort', 'abort'],
    ['unsupported', 'unavailable'], ['drain', 'abort'], ['restart', 'abort'],
  ] as const)('maps cancellation %s to %s', async (reason, expected) => {
    const f = harness(async () => ({ state: 'cancelled', reason }));
    const result = await f.execute(choices);
    expect(result.details).toMatchObject({ status: 'cancelled', reason: expected });
    if (reason === 'drain' || reason === 'restart') expect(result.details).toHaveProperty('message', `Ask-user prompt interrupted by host ${reason}.`);
  });

  it('uses only the declared cancel action and rejects malformed generic envelopes', async () => {
    const cancelled = harness(async () => ({ state: 'answered', answer: { kind: 'form', actionId: 'cancel', outcome: 'cancel', values: {} } }));
    expect((await cancelled.execute(choices)).details).toMatchObject({ status: 'cancelled', reason: 'user' });
    const invalid: unknown[] = [
      { state: 'answered', answer: { kind: 'form', actionId: 'invented', outcome: 'submit', values: { 'q1.text': 'Guess' } } },
      { state: 'answered', answer: { kind: 'form', actionId: 'submit', outcome: 'cancel', values: {} } },
      { state: 'answered', answer: { kind: 'form', actionId: 'cancel', outcome: 'cancel', values: { 'q1.text': 'Not cancellation' } } },
      { state: 'deferred', interactionId: '' },
      { state: 'cancelled', reason: 'invented' },
      { state: 'invented' },
    ];
    for (const result of invalid) expect(await harness(async () => result as UiRequestResult).execute({ question: 'Answer?' })).toMatchObject({ isError: true });
  });

  it('does not request UI on pre-abort and propagates abort while the generic UI is pending', async () => {
    const controller = new AbortController();
    controller.abort();
    const before = harness();
    expect((await before.execute(choices, controller.signal)).details).toMatchObject({ status: 'cancelled', reason: 'abort' });
    expect(before.request).not.toHaveBeenCalled();
    const running = new AbortController();
    let complete!: (result: UiRequestResult) => void;
    const during = harness(() => new Promise(resolve => { complete = resolve; }));
    const pending = during.execute(choices, running.signal);
    expect(during.request.mock.calls[0]![1]?.signal).toBe(running.signal);
    running.abort();
    complete(answered({ 'q1.mode': 'selection', 'q1.selection': 'option1' }));
    expect((await pending).details).toMatchObject({ status: 'cancelled', reason: 'abort' });
  });

  it('preserves long display content and renders Markdown input literally', async () => {
    const context = `Context ${'evidence '.repeat(1000)} <script>alert(1)</script> [unsafe](javascript:alert)\n[label]: file:///secret\n\u001b[31m`;
    const f = harness();
    expect((await f.execute({ question: 'What about <b>literal</b> & `code`?', header: '## Scope', context })).details).toHaveProperty('status', 'answered');
    const form = f.request.mock.calls[0]![0];
    expect(parseUiForm(form)).toEqual(form);
    expect(form.markdown).toContain('evidence '.repeat(1000));
    expect(form.markdown).toContain('&lt;script&gt;alert\\(1\\)&lt;/script&gt;');
    expect(form.markdown).toContain('\\[unsafe\\]\\(javascript:alert\\)');
    expect(form.markdown).toContain('\\\\u001b');
    expect(form.markdown).not.toContain('\u001b');
    expect(form.hint).toEqual({ id: 'ask-user.wizard', version: '1' });
  });

  it('rejects unrepresentable content instead of truncating questions, context, descriptions, or options', async () => {
    for (const input of [
      { question: 'Choose?', options: Array.from({ length: 65 }, (_, index) => ({ title: `Choice ${index}` })) },
      { question: 'Choose?', options: [{ title: '🙂'.repeat(257) }] },
      { question: 'q'.repeat(128 * 1024 + 1) },
      { question: 'Context?', context: 'c'.repeat(128 * 1024 + 1) },
      { question: 'Description?', options: [{ title: 'One', description: 'd'.repeat(128 * 1024 + 1) }] },
    ]) {
      const f = harness();
      expect(await f.execute(input)).toMatchObject({ isError: true });
      expect(f.request).not.toHaveBeenCalled();
    }
    const f = harness(async () => answered({ 'q1.selection': 'option64' }));
    const titles = Array.from({ length: 64 }, (_, index) => index === 63 ? '🙂'.repeat(256) : `Choice ${index}`);
    expect((await f.execute({ question: 'Boundary?', options: titles, allowFreeform: false })).details)
      .toMatchObject({ status: 'answered', response: { kind: 'selection', selections: [titles[63]] } });
    expect(f.request.mock.calls[0]![0].input.fields[0]).toHaveProperty('options', titles.map((label, index) => ({ id: `option${index + 1}`, label })));
  });
});
