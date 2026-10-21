import type { ExtensionUi } from '@felan-ai/agent-core';
import { validateUiFormAnswer, type JsonValue, type UiForm } from '@felan-ai/session-protocol';
import { describe, expect, it } from 'vitest';
import { ASK_USER_FORM_HINT, decodeAskUserFormAnswer, encodeAskUserFormAnswer, readAskUserForm,
  type AskUserInput, type AskUserQuestion, type AskUserQuestionAnswer } from '../src/data.js';
import { askUserActions, askUserFields } from '../src/form.js';
import { normalizeAskUserRequest } from '../src/normalize.js';
import { createUiAskUserHost } from '../src/ui.js';

async function createForm(input: AskUserInput) {
  const request = normalizeAskUserRequest(input);
  if (!request.ok) throw new Error(request.error);
  return createRequestForm(request.value.questions);
}

async function createRequestForm(questions: readonly AskUserQuestion[]) {
  let form!: UiForm;
  const host = createUiAskUserHost({ request: async value => {
    form = value;
    return { state: 'deferred', interactionId: 'test' };
  } } as ExtensionUi);
  await host.ask({ questions }, { requestId: 'test', sessionId: 'test', signal: new AbortController().signal,
    extensionContext: {} as never, reportProgress() {} });
  return { form, questions };
}

const cases: { name: string; input: AskUserInput; answers: AskUserQuestionAnswer[] }[] = [
  { name: 'single-select', input: { question: 'Pick one?', header: 'Scope', context: 'Line one\n\n## Literal heading',
    options: [{ title: 'One: [literal]', description: 'More\n\n- literal details' }, { title: 'Two' }], allowFreeform: false },
  answers: [{ questionId: 'q1', response: { kind: 'selection', selections: ['One: [literal]'] } }] },
  { name: 'multi-select', input: { question: 'Pick several?', options: ['One', 'Two'], allowMultiple: true, allowFreeform: false },
    answers: [{ questionId: 'q1', response: { kind: 'selection', selections: ['Two', 'One'] } }] },
  { name: 'freeform-only', input: { question: 'Write something?' },
    answers: [{ questionId: 'q1', response: { kind: 'freeform', text: ' A written answer\nwith whitespace ' } }] },
  { name: 'selection with comment', input: { question: 'Pick and explain?', options: ['One', 'Two'], allowComment: true },
    answers: [{ questionId: 'q1', response: { kind: 'selection', selections: ['Two'], comment: 'Because\nthis fits.' } }] },
  { name: 'four-question wizard', input: { questions: [
    { question: 'Pick one?', options: ['One', 'Two'], allowFreeform: false },
    { question: 'Pick several?', options: ['One', 'Two'], allowMultiple: true, allowComment: true },
    { question: 'Write something?', options: ['Default'] }, { question: 'Anything else?' },
  ] }, answers: [
    { questionId: 'q1', response: { kind: 'selection', selections: ['Two'] } },
    { questionId: 'q2', response: { kind: 'selection', selections: ['One', 'Two'], comment: 'Both.' } },
    { questionId: 'q3', response: { kind: 'freeform', text: 'Another approach.' } },
    { questionId: 'q4', response: null },
  ] },
];

describe('ask-user form codec', () => {
  it.each(cases)('round-trips $name without parsing Markdown', async ({ input, answers }) => {
    const { form, questions } = await createForm(input);
    expect(form.hint).toEqual({ ...ASK_USER_FORM_HINT, data: { questions } });
    expect(readAskUserForm(form)).toEqual(questions);
    expect(readAskUserForm({ ...form, markdown: 'No question text here.' })).toEqual(questions);
    const encoded = encodeAskUserFormAnswer(form, answers);
    expect(validateUiFormAnswer(form, encoded)).toEqual(encoded);
    expect(decodeAskUserFormAnswer(questions, encoded)).toEqual(answers);
    expect(encodeAskUserFormAnswer(form, null)).toEqual({ kind: 'form', actionId: 'cancel', outcome: 'cancel', values: {} });
    expect(decodeAskUserFormAnswer(questions, encodeAskUserFormAnswer(form, null))).toBeNull();
  });

  it('uses stable field and option identities and explicitly skips omitted wizard answers', async () => {
    const { form, questions } = await createForm(cases[4]!.input);
    const answers = cases[4]!.answers.slice(0, 3);
    const encoded = encodeAskUserFormAnswer(form, answers);
    expect(encoded.values).toEqual({
      'q1.mode': 'selection', 'q1.selection': 'option2',
      'q2.mode': 'selection', 'q2.selection': ['option1', 'option2'], 'q2.comment': 'Both.',
      'q3.mode': 'freeform', 'q3.text': 'Another approach.', 'q4.mode': 'skip',
    });
    expect(decodeAskUserFormAnswer(questions, encoded)).toEqual(cases[4]!.answers);
  });

  it('preserves host-provided IDs and repeated question text without re-normalizing', async () => {
    const original = await createForm(cases[0]!.input);
    const questions = [{ ...original.questions[0]!, id: 'first' }, { ...original.questions[0]!, id: 'second' }];
    const { form } = await createRequestForm(questions);
    expect(readAskUserForm(form)).toEqual(questions);
    const answers: AskUserQuestionAnswer[] = [{ questionId: 'second', response: { kind: 'selection', selections: ['Two'] } }];
    expect(decodeAskUserFormAnswer(questions, encodeAskUserFormAnswer(form, answers))).toEqual([
      { questionId: 'first', response: null }, ...answers,
    ]);
  });

  it('accepts reordered object keys but rejects unsupported or malformed hint payloads', async () => {
    const { form, questions } = await createForm(cases[0]!.input);
    const { hint: _hint, ...generic } = form;
    expect(readAskUserForm(generic)).toBeNull();
    expect(readAskUserForm({ ...form, hint: { id: 'ask-user.wizard', version: '1' } })).toBeNull();
    expect(readAskUserForm({ ...form, hint: { ...ASK_USER_FORM_HINT, id: 'other' } })).toBeNull();
    const question = questions[0]!;
    for (const data of [undefined, null, [], {}, { questions: [] }, { questions: [...questions, ...questions] },
      { questions: [{ ...question, allowFreeform: 'yes' }] }, { questions: [{ ...question, header: '' }] },
      { questions: [{ ...question, options: [{ title: 'Same' }, { title: 'Same' }] }] },
      { questions: [{ ...question, unknown: true }] }, { questions, unknown: true }, { questions: [{ ...question, id: 'q4' }] }]) {
      expect(readAskUserForm({ ...form, hint: { ...ASK_USER_FORM_HINT, data: data as JsonValue } })).toBeNull();
    }
    const reordered = form.input.fields.map(field => Object.fromEntries(Object.entries(field).reverse()));
    expect(readAskUserForm({ ...form, input: { fields: reordered as UiForm['input']['fields'] } })).toEqual(questions);
  });

  it('requires matching fields and submit/cancel action semantics', async () => {
    const { form } = await createForm(cases[3]!.input);
    for (const fields of [[], form.input.fields.slice(1), [...form.input.fields].reverse(),
      form.input.fields.map(field => ({ ...field, required: !field.required })),
      form.input.fields.map(field => field.kind === 'enum' && field.id.endsWith('.selection')
        ? { ...field, options: field.options.map(option => ({ ...option, label: 'Different' })) } : field),
      form.input.fields.map(field => field.kind === 'string' ? { ...field, maxLength: 1 } : field)]) {
      expect(readAskUserForm({ ...form, input: { fields } })).toBeNull();
    }
    for (const actions of [[], form.actions.slice(1), form.actions.slice(0, 1),
      form.actions.map(action => ({ ...action, outcome: action.outcome === 'submit' ? 'cancel' as const : 'submit' as const })),
      form.actions.map(action => ({ ...action, target: 'item' as const }))]) {
      expect(readAskUserForm({ ...form, actions })).toBeNull();
    }
    expect(() => encodeAskUserFormAnswer({ ...form, input: { fields: [] } }, null)).toThrow('ask-user form');
  });

  it('rejects invalid question identities and conflicting or empty responses', async () => {
    const { form } = await createForm({ question: 'Choose?', options: ['One', 'Two'], allowComment: true });
    const response = { kind: 'selection', selections: ['One'] };
    const invalid: unknown[] = [[], [{ questionId: 'q1', response: null }],
      [{ questionId: 'q2', response }], [{ questionId: 'q1', response }, { questionId: 'q1', response }],
      [{ questionId: 'q1', response: { ...response, selections: ['Unknown'] } }],
      [{ questionId: 'q1', response: { ...response, selections: [] } }],
      [{ questionId: 'q1', response: { ...response, selections: ['One', 'Two'] } }],
      [{ questionId: 'q1', response: { ...response, selections: ['One', 'One'] } }],
      [{ questionId: 'q1', response: { ...response, text: 'Both selection and freeform' } }],
      [{ questionId: 'q1', response: { kind: 'freeform', text: 'Text', selections: ['One'] } }],
      [{ questionId: 'q1', response: { kind: 'freeform', text: 'Text', comment: 'Not allowed' } }],
      [{ questionId: 'q1', response: { kind: 'freeform', text: '' } }],
      [{ questionId: 'q1', response: { kind: 'freeform', text: '   ' } }],
      [{ questionId: 'q1', response: { kind: 'freeform', text: '😀'.repeat(8193) } }]];
    for (const answers of invalid) expect(() => encodeAskUserFormAnswer(form, answers as AskUserQuestionAnswer[])).toThrow();
    expect(encodeAskUserFormAnswer(form, [{ questionId: 'q1', response: { kind: 'freeform', text: 'Other' } }]).values)
      .toEqual({ 'q1.mode': 'freeform', 'q1.text': 'Other' });
    const disabled = await createForm({ question: 'Choose?', options: ['One'], allowFreeform: false });
    expect(() => encodeAskUserFormAnswer(disabled.form, [{ questionId: 'q1', response: { kind: 'freeform', text: 'Other' } }])).toThrow();
    expect(() => encodeAskUserFormAnswer(disabled.form, [{ questionId: 'q1', response: { kind: 'selection', selections: ['One'], comment: 'No' } }])).toThrow();
  });

  it('retains the all-skipped error and rejects invalid generic envelopes', async () => {
    const { questions } = await createForm(cases[4]!.input);
    expect(() => decodeAskUserFormAnswer(questions, { kind: 'form', actionId: 'submit', outcome: 'submit',
      values: { 'q1.mode': 'skip', 'q2.mode': 'skip', 'q3.mode': 'skip', 'q4.mode': 'skip' } })).toThrow('Answer at least one question.');
    expect(() => decodeAskUserFormAnswer(questions, { kind: 'form', actionId: 'cancel', outcome: 'cancel', values: { 'q1.text': 'No' } })).toThrow();
    expect(() => decodeAskUserFormAnswer(questions, { kind: 'form', actionId: 'unknown', outcome: 'cancel', values: {} })).toThrow();
  });
});

describe('ask-user form contract', () => {
  it('keeps the v2 field contract stable; changing it requires a new hint version', () => {
    const questions: AskUserQuestion[] = [
      { id: 'q1', header: 'Scope', question: 'Pick?', options: [{ title: 'One' }, { title: 'Two' }], allowMultiple: true, allowFreeform: true, allowComment: true },
      { id: 'q2', header: 'Notes', question: 'Why?', options: [], allowMultiple: false, allowFreeform: true, allowComment: false },
    ];
    expect({ hint: ASK_USER_FORM_HINT, actions: askUserActions, fields: askUserFields(questions) }).toMatchInlineSnapshot(`
      {
        "actions": [
          {
            "id": "submit",
            "label": "Submit answers",
            "outcome": "submit",
            "target": "element",
          },
          {
            "id": "cancel",
            "label": "Cancel",
            "outcome": "cancel",
            "target": "element",
          },
        ],
        "fields": [
          {
            "id": "q1.mode",
            "kind": "enum",
            "label": "Question 1: Answer type",
            "options": [
              {
                "id": "selection",
                "label": "Choose listed options",
              },
              {
                "id": "freeform",
                "label": "Write an answer",
              },
              {
                "id": "skip",
                "label": "Skip this question",
              },
            ],
            "required": true,
          },
          {
            "id": "q1.selection",
            "kind": "multi_select",
            "label": "Question 1: Listed options",
            "maxSelections": 2,
            "options": [
              {
                "id": "option1",
                "label": "One",
              },
              {
                "id": "option2",
                "label": "Two",
              },
            ],
            "required": false,
          },
          {
            "id": "q1.text",
            "kind": "string",
            "label": "Question 1: Written answer",
            "maxLength": 32768,
            "multiline": true,
            "required": false,
          },
          {
            "id": "q1.comment",
            "kind": "string",
            "label": "Question 1: Optional comment on listed options",
            "maxLength": 32768,
            "multiline": true,
            "required": false,
          },
          {
            "id": "q2.mode",
            "kind": "enum",
            "label": "Question 2: Answer type",
            "options": [
              {
                "id": "freeform",
                "label": "Write an answer",
              },
              {
                "id": "skip",
                "label": "Skip this question",
              },
            ],
            "required": true,
          },
          {
            "id": "q2.text",
            "kind": "string",
            "label": "Question 2: Written answer",
            "maxLength": 32768,
            "multiline": true,
            "required": false,
          },
        ],
        "hint": {
          "id": "ask-user.wizard",
          "version": "2",
        },
      }
    `);
  });
});
