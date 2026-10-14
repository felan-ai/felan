import { describe, expect, it } from 'vitest';
import {
  LIMITS, OPERATION_CATALOG, OperationSchemas, UI_CAPABILITIES, UiActionRequestSchema, UiFormAnswerSchema,
  UiHintSchema, parseInteraction, parsePresentation, parseSchema, parseSessionEvent, parseSessionSnapshot,
  parseUiForm, parseUiPresentation, validateInteractionAnswer, validateUiAction, validateUiFormAnswer,
  type UiAction, type UiForm, type UiView,
} from '../src/index.js';
import { interaction, snapshot } from './fixtures.js';

const submit: UiAction = { id: 'approve', label: 'Approve', target: 'element', outcome: 'submit' };
const cancel: UiAction = { id: 'cancel', label: 'Cancel', target: 'element', outcome: 'cancel' };
const form: UiForm = { title: 'Review', markdown: '# Plan', fallback: 'Review plan', input: { fields: [] }, actions: [submit, cancel] };
const view: UiView = {
  id: 'history', kind: 'view', revision: 3, title: 'History', fallback: 'History',
  fields: [{ id: 'title', label: 'Title', valueKind: 'text' }],
  items: [{ id: 'row', values: { title: 'Saved prompt' }, fallback: 'Saved prompt' }],
  actions: [{ id: 'detail', label: 'Details', target: 'item', outcome: 'submit' }],
};
const request = { elementId: 'history', revision: 3, actionId: 'detail', outcome: 'submit', itemId: 'row', values: {} };

describe('explicit UI contracts', () => {
  it('negotiates generic UI capabilities and explicit affirmative meanings', () => {
    const hello = parseSchema(OperationSchemas.hello, { clientVersion: 'test', protocol: 1, kind: 'acp',
      interactionKinds: ['form'], capabilities: [...UI_CAPABILITIES], target: { kind: 'production' } });
    expect(hello.capabilities).toEqual(UI_CAPABILITIES);
    expect(() => parseSchema(UiFormAnswerSchema, { kind: 'form', values: {} })).toThrow();
    expect(parseInteraction({ ...interaction, request: { kind: 'form', form } }).request.kind).toBe('form');
  });

  it('supports zero-field forms and keeps cancel distinct from submit', () => {
    const item = parseInteraction({ ...interaction, request: { kind: 'form', form } });
    for (const action of [submit, cancel]) {
      expect(validateInteractionAnswer(item, { kind: 'form', actionId: action.id, outcome: action.outcome, values: {} })).toEqual({
        kind: 'form', actionId: action.id, outcome: action.outcome, values: {},
      });
    }
    expect(() => validateInteractionAnswer(item, { kind: 'form', actionId: 'cancel', outcome: 'submit', values: {} })).toThrow('mismatch');
    expect(() => validateInteractionAnswer(item, { kind: 'form', actionId: 'approve', outcome: 'cancel', values: {} })).toThrow('mismatch');
    expect(() => validateUiFormAnswer(form, { kind: 'form', actionId: 'unknown', outcome: 'submit', values: {} })).toThrow();
    expect(() => validateUiFormAnswer(form, { kind: 'form', values: {} })).toThrow();
    const required = { ...form, input: { fields: [{ id: 'feedback', label: 'Feedback', kind: 'string', maxLength: 128, required: true, multiline: true }] } };
    expect(() => validateUiFormAnswer(parseUiForm(required), { kind: 'form', actionId: 'cancel', outcome: 'cancel', values: {} })).not.toThrow();
    expect(() => validateUiFormAnswer(parseUiForm(required), { kind: 'form', actionId: 'cancel', outcome: 'cancel', values: { feedback: 'approve' } })).toThrow();
    expect(() => validateUiFormAnswer(parseUiForm(required), { kind: 'form', actionId: 'approve', outcome: 'submit', values: {} })).toThrow('required');
  });

  it('validates defaults without treating them as an implicit answer', () => {
    const fields = [
      { id: 'text', kind: 'string', label: 'Text', required: true, maxLength: 4, multiline: true },
      { id: 'count', kind: 'number', label: 'Count', required: false, minimum: 1, maximum: 3 },
      { id: 'enabled', kind: 'boolean', label: 'Enabled', required: false },
      { id: 'choice', kind: 'enum', label: 'Choice', required: false, options: [{ id: 'one', label: 'One' }] },
      { id: 'many', kind: 'multi_select', label: 'Many', required: false, options: [{ id: 'one', label: 'One' }], maxSelections: 1 },
    ];
    const defaults = { text: '😀', count: 2, enabled: true, choice: 'one', many: ['one'] };
    const configured = parseUiForm({ ...form, input: { fields, defaults } });
    expect(configured.input.defaults).toEqual(defaults);
    expect(() => validateUiFormAnswer(configured, { kind: 'form', actionId: 'approve', outcome: 'submit', values: {} })).toThrow('required');
    for (const patch of [{ text: '😀x' }, { count: 0 }, { enabled: 'true' }, { choice: 'two' }, { many: ['one', 'one'] }, { foreign: 'x' }]) {
      expect(() => parseUiForm({ ...form, input: { fields, defaults: { ...defaults, ...patch } } })).toThrow();
    }
    expect(() => parseUiForm({ ...form, input: { fields: [fields[0], fields[0]] } })).toThrow('unique');
    expect(() => parseUiForm({ ...form, input: { fields: [{ ...fields[1], minimum: 5 }] } })).toThrow('range');
    expect(() => parseUiForm({ ...form, input: { fields: [{ ...fields[3], multiline: true }] } })).toThrow();
    expect(() => parseUiForm({ ...form, input: { fields: [{ ...fields[3], options: [{ id: 'one', label: 'A' }, { id: 'one', label: 'B' }] }] } })).toThrow('unique');
    expect(() => parseUiForm({ ...form, input: { fields: [{ ...fields[4], maxSelections: 2 }] } })).toThrow('bound');
  });

  it('does not need or trust a presenter hint for data or actions', () => {
    for (const hint of [undefined, { id: 'unknown.presenter', version: '99' }]) {
      const current = parseUiPresentation({ ...view, ...(hint ? { hint } : {}) });
      expect(current).toEqual({ ...view, ...(hint ? { hint } : {}) });
      expect(validateUiAction(view, request)).toEqual(request);
      const configured = parseUiForm({ ...form, ...(hint ? { hint } : {}) });
      expect(validateUiFormAnswer(configured, { kind: 'form', actionId: 'cancel', outcome: 'cancel', values: {} }).outcome).toBe('cancel');
    }
    expect(() => parseSchema(UiHintSchema, { id: 'hint', version: '1', actions: [submit] })).toThrow();
  });

  it('binds actions to exact element, revision, outcome and current row', () => {
    expect(validateUiAction(view, request)).toEqual(request);
    for (const patch of [{ elementId: 'foreign' }, { revision: 2 }, { actionId: 'unknown' }]) {
      expect(() => validateUiAction(view, { ...request, ...patch })).toThrow('stale');
    }
    for (const patch of [{ itemId: 'foreign' }, { itemId: undefined }, { outcome: 'cancel' }, { values: { hidden: 'value' } }]) {
      const value = { ...request, ...patch };
      const { itemId, ...withoutItem } = value;
      expect(() => validateUiAction(view, itemId === undefined ? withoutItem : value)).toThrow();
    }
    expect(() => validateUiAction(view, { ...request, revision: 0 })).toThrow();
    expect(() => validateUiAction(view, { ...request, revision: Number.MAX_SAFE_INTEGER + 1 })).toThrow();
    expect(() => parseSchema(UiActionRequestSchema, { ...request, undeclared: true })).toThrow();
    expect(parseSchema(OperationSchemas['ui.action'], request)).toEqual(request);
    expect(OPERATION_CATALOG['ui.action']).toMatchObject({ scope: 'session', mutation: true, storage: 'durable' });
  });

  it('keeps bounded structured document data independent of its title and actions', () => {
    const document = { id: 'paged', kind: 'document', revision: 1, title: 'Any title', markdown: 'Text', fallback: 'Text',
      data: { pageIndex: 0, pageCount: 2 }, actions: [] };
    expect(parseUiPresentation(document)).toEqual(document);
    expect(parsePresentation(document)).toEqual(document);
    expect(() => parseUiPresentation({ ...document, data: { pageIndex: Number.POSITIVE_INFINITY } })).toThrow();
    expect(() => parseUiPresentation({ ...document, data: { nested: { unknown: true } } })).toThrow();
    expect(parseUiPresentation({ ...document, data: { text: 'x'.repeat(32769) } }).kind).toBe('document');
  });

  it('validates action input and rejects item targets outside views', () => {
    const document = { id: 'doc', kind: 'document', revision: 1, title: 'Plan', markdown: 'Safe', fallback: 'Plan',
      actions: [{ ...submit, input: { fields: [{ id: 'feedback', label: 'Feedback', kind: 'string', required: true, maxLength: 4, multiline: true }] } }, cancel] };
    const source = parseUiPresentation(document);
    if (source.kind === 'status') throw new Error('Expected document');
    const action = { elementId: 'doc', revision: 1, actionId: 'approve', outcome: 'submit', values: { feedback: '😀' } };
    expect(validateUiAction(source, action)).toEqual(action);
    expect(() => validateUiAction(source, { ...action, values: { feedback: '😀x' } })).toThrow();
    expect(() => validateUiAction(source, { ...action, itemId: 'row' })).toThrow();
    expect(() => parseUiPresentation({ ...document, actions: view.actions })).toThrow('view');
    expect(() => parseUiPresentation({ ...document, actions: [{ ...cancel, input: { fields: [] } }] })).toThrow('Cancel');
    expect(() => parseUiForm({ ...form, actions: document.actions })).toThrow('form input');
    expect(() => parseUiForm({ ...form, actions: [submit, submit] })).toThrow('unique');
  });

  it('supports declared query and paging controls without opaque custom payloads', () => {
    const source = { ...view, query: { actionId: 'search', values: { query: 'saved' } }, paging: { nextActionId: 'next' },
      actions: [...view.actions, { ...submit, id: 'search', input: { fields: [{ id: 'query', label: 'Query', kind: 'string', required: true, maxLength: 128 }] } },
        { ...submit, id: 'next' }] };
    expect(parseUiPresentation(source)).toEqual(source);
    expect(() => parseUiPresentation({ ...source, query: { actionId: 'search', values: { foreign: 'x' } } })).toThrow();
    expect(() => parseUiPresentation({ ...source, paging: { nextActionId: 'detail' } })).toThrow('navigation');
    expect(() => parseUiPresentation({ ...source, paging: { nextActionId: 'search' } })).toThrow();
    expect(() => parseUiPresentation({ ...source, paging: {} })).toThrow();
    expect(() => parseUiPresentation({ ...source, paging: { previousActionId: 'next', nextActionId: 'next' } })).toThrow('unique');
  });

  it('checks row identities and scalar value kinds including real UTC dates', () => {
    for (const values of [{ unknown: 'x' }, { title: false }, { title: 2 }]) {
      expect(() => parseUiPresentation({ ...view, items: [{ ...view.items[0], values }] })).toThrow('kinds');
    }
    expect(() => parseUiPresentation({ ...view, items: [...view.items, ...view.items] })).toThrow('unique');
    expect(() => parseUiPresentation({ ...view, fields: [...view.fields, ...view.fields] })).toThrow('unique');
    for (const [valueKind, value] of [['number', 3], ['boolean', false], ['date', '2026-10-12T00:00:00.000Z']] as const) {
      expect(() => parseUiPresentation({ ...view, fields: [{ ...view.fields[0], valueKind }], items: [{ ...view.items[0], values: { title: value } }] })).not.toThrow();
    }
    for (const value of ['2026-02-30T00:00:00.000Z', 'invalid', '2026-10-12']) {
      expect(() => parseUiPresentation({ ...view, fields: [{ ...view.fields[0], valueKind: 'date' }], items: [{ ...view.items[0], values: { title: value } }] })).toThrow();
    }
  });

  it('keeps progress actionable and statuses typed', () => {
    const progress = { id: 'job', kind: 'progress', revision: 1, label: 'Working', state: 'running', fraction: 0.5, actions: [cancel], fallback: 'Working' };
    expect(parsePresentation(progress)).toEqual(progress);
    expect(() => parsePresentation({ ...progress, actions: [cancel, cancel] })).toThrow('unique');
    const status = { id: 'cost', kind: 'status', key: 'cost', fallback: 'Cost' };
    for (const value of [{ kind: 'text', text: 'Ready' }, { kind: 'money', value: 0.5, currency: 'USD' },
      { kind: 'tokens', value: 10 }, { kind: 'percent', value: 100 }, { kind: 'duration', milliseconds: 50 }]) {
      expect(parsePresentation({ ...status, value })).toEqual({ ...status, value });
    }
    for (const value of [{ kind: 'tokens', value: -1 }, { kind: 'tokens', value: 1.5 }, { kind: 'percent', value: 101 },
      { kind: 'money', value: 1, currency: 'usd' }, { kind: 'duration', milliseconds: -1 }]) {
      expect(() => parsePresentation({ ...status, value })).toThrow();
    }
  });

  it('accepts large form answers and does not downgrade malformed known UI elements', () => {
    const fields = Array.from({ length: 3 }, (_, i) => ({ id: `f${i}`, label: 'Field', kind: 'string', required: false, maxLength: 32 * 1024 }));
    const values = Object.fromEntries(fields.map(field => [field.id, 'x'.repeat(24 * 1024)]));
    expect(parseUiForm({ ...form, input: { fields, defaults: values } }).input.defaults).toEqual(values);
    expect(validateUiFormAnswer(parseUiForm({ ...form, input: { fields } }), {
      kind: 'form', actionId: 'approve', outcome: 'submit', values,
    }).values).toEqual(values);
    expect(() => parsePresentation({ id: 'bad', kind: 'view', fallback: 'Cannot downgrade' })).toThrow();
    expect(() => parseUiPresentation({ ...view, items: Array(101).fill(view.items[0]) })).toThrow();
    expect(() => parseUiForm({ ...form, input: { fields: Array(33).fill(fields[0]) } })).toThrow();
  });

  it('rejects unsafe Markdown and preserves safe content through stored events and snapshots', () => {
    const document = { id: 'doc', kind: 'document', revision: 1, title: 'Report', markdown: '[Read](https://example.com)', actions: [], fallback: 'Report' };
    for (const markdown of ['<script>bad</script>', '[run](javascript:alert(1))', '[run](file:///private)', '[run][ref]\n\n[ref]: javascript:alert(1)',
      '> [run][ref]\n>\n> [ref]: javascript:alert(1)', '- [run][ref]\n\n  [ref]: data:text/html,bad',
      '[run][re\\]f]\n\n[re\\]f]: javascript:alert(1)', '[run][multi line]\n\n[multi\nline]: javascript:alert(1)']) {
      expect(() => parsePresentation({ ...document, markdown })).toThrow();
      expect(() => parseUiForm({ ...form, markdown })).toThrow();
    }
    expect(parseSessionEvent({ v: 1, session: 'session', rev: 8, change: { type: 'presentation.updated', presentation: document } }).change)
      .toEqual({ type: 'presentation.updated', presentation: document });
    expect(parseSessionSnapshot({ ...snapshot, presentation: [document, view] }).presentation).toEqual([document, view]);
    const item = parseInteraction({ ...interaction, request: { kind: 'form', form }, state: 'answered',
      responder: 'client', resolvedAt: interaction.createdAt, result: { kind: 'form', actionId: 'cancel', outcome: 'cancel', values: {} } });
    expect(item.state).toBe('answered');
    if (item.state === 'answered') expect(item.result).toMatchObject({ outcome: 'cancel' });
  });
});
