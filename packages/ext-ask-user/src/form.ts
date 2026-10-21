import { Type } from 'typebox';
import { IdSchema, parseSchema, parseUiForm, validateUiFormAnswer, type UiAction, type UiField, type UiForm,
  type UiFormAnswer, type UiValues } from '@felan-ai/session-protocol';
import type { AskUserQuestion, AskUserQuestionAnswer, AskUserResponse } from './contracts.js';
import { MAX_ASK_USER_QUESTIONS } from './normalize.js';

export const ASK_USER_FORM_HINT = { id: 'ask-user.wizard', version: '2' } as const;
const MAX_TEXT_BYTES = 32 * 1024;
const closed = { additionalProperties: false } as const;
const requiredText = Type.String({ minLength: 1 });
const QuestionsSchema = Type.Object({ questions: Type.Array(Type.Object({
  id: IdSchema, header: requiredText, question: requiredText, context: Type.Optional(requiredText),
  options: Type.Array(Type.Object({ title: requiredText, description: Type.Optional(requiredText) }, closed)),
  allowMultiple: Type.Boolean(), allowFreeform: Type.Boolean(), allowComment: Type.Boolean(),
}, closed), { minItems: 1, maxItems: MAX_ASK_USER_QUESTIONS }) }, closed);
const AnswersSchema = Type.Array(Type.Object({ questionId: IdSchema, response: Type.Union([
  Type.Null(),
  Type.Object({ kind: Type.Literal('freeform'), text: requiredText }, closed),
  Type.Object({ kind: Type.Literal('selection'), selections: Type.Array(requiredText, { minItems: 1, uniqueItems: true }),
    comment: Type.Optional(Type.String()) }, closed),
]) }, closed));

export const askUserActions: UiAction[] = [
  { id: 'submit', label: 'Submit answers', target: 'element', outcome: 'submit' },
  { id: 'cancel', label: 'Cancel', target: 'element', outcome: 'cancel' },
];

export function askUserFields(questions: readonly AskUserQuestion[]): UiField[] {
  const wizard = questions.length > 1;
  const fields: UiField[] = [];
  for (const [index, question] of questions.entries()) {
    const choices = question.options.length > 0;
    const mode = wizard || choices && question.allowFreeform;
    const label = `Question ${index + 1}`;
    if (mode) fields.push({ id: `${question.id}.mode`, kind: 'enum', label: `${label}: Answer type`, required: true, options: [
      ...(choices ? [{ id: 'selection', label: 'Choose listed options' }] : []),
      ...(question.allowFreeform ? [{ id: 'freeform', label: 'Write an answer' }] : []),
      ...(wizard ? [{ id: 'skip', label: 'Skip this question' }] : []),
    ] });
    if (choices) {
      const options = question.options.map((option, optionIndex) => ({ id: `option${optionIndex + 1}`, label: option.title }));
      const selection = { id: `${question.id}.selection`, label: `${label}: Listed options`, required: !mode, options };
      fields.push(question.allowMultiple
        ? { ...selection, kind: 'multi_select', maxSelections: options.length }
        : { ...selection, kind: 'enum' });
    }
    if (question.allowFreeform) fields.push({
      id: `${question.id}.text`, kind: 'string', label: `${label}: Written answer`, required: !mode && !choices,
      multiline: true, maxLength: MAX_TEXT_BYTES,
    });
    if (choices && question.allowComment) fields.push({
      id: `${question.id}.comment`, kind: 'string', label: `${label}: Optional comment on listed options`, required: false,
      multiline: true, maxLength: MAX_TEXT_BYTES,
    });
  }
  return fields;
}

function sameJson(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length
      && left.every((value, index) => sameJson(value, right[index]));
  }
  const a = left as Record<string, unknown>;
  const b = right as Record<string, unknown>;
  return Object.keys(a).length === Object.keys(b).length
    && Object.keys(a).every(key => Object.hasOwn(b, key) && sameJson(a[key], b[key]));
}

export function readAskUserForm(form: UiForm): AskUserQuestion[] | null {
  try {
    if (form.hint?.id !== ASK_USER_FORM_HINT.id || form.hint.version !== ASK_USER_FORM_HINT.version) return null;
    const source = parseUiForm(form);
    const { questions } = parseSchema(QuestionsSchema, source.hint?.data);
    if (questions.some(question => question.options.length === 0 && !question.allowFreeform
      || new Set(question.options.map(option => option.title)).size !== question.options.length)
      || !sameJson(source.input.fields, askUserFields(questions))
      || askUserActions.some(expected => !source.actions.some(action => action.id === expected.id
        && action.outcome === expected.outcome && action.target === expected.target))) return null;
    return questions;
  } catch { return null; }
}

export function encodeAskUserFormAnswer(form: UiForm, answers: readonly AskUserQuestionAnswer[] | null): UiFormAnswer {
  const questions = readAskUserForm(form);
  if (!questions) throw new Error('Invalid or unsupported ask-user form.');
  if (answers === null) return validateUiFormAnswer(form, { kind: 'form', actionId: 'cancel', outcome: 'cancel', values: {} });
  let parsed: AskUserQuestionAnswer[];
  try { parsed = parseSchema(AnswersSchema, answers); }
  catch (error) { throw new Error('Invalid ask-user answers: use either a selection or a freeform response.', { cause: error }); }
  if (!parsed.some(answer => answer.response !== null)) throw new Error('Answer at least one question.');
  const byId = new Map<string, AskUserResponse | null>();
  for (const answer of parsed) {
    if (!questions.some(question => question.id === answer.questionId)) throw new Error(`Unknown ask-user question: ${answer.questionId}.`);
    if (byId.has(answer.questionId)) throw new Error(`Duplicate ask-user answer: ${answer.questionId}.`);
    byId.set(answer.questionId, answer.response);
  }
  const values: UiValues = {};
  for (const question of questions) {
    const response = byId.get(question.id);
    if (questions.length > 1 || question.options.length > 0 && question.allowFreeform) {
      values[`${question.id}.mode`] = response?.kind ?? 'skip';
    }
    if (response?.kind === 'freeform') values[`${question.id}.text`] = response.text;
    if (response?.kind === 'selection') {
      const selected = response.selections.map(title => {
        const index = question.options.findIndex(option => option.title === title);
        if (index < 0) throw new Error(`${question.id}: Unknown option: ${title}.`);
        return `option${index + 1}`;
      });
      if (!question.allowMultiple && selected.length !== 1) throw new Error(`${question.id}: Select exactly one option.`);
      values[`${question.id}.selection`] = question.allowMultiple ? selected : selected[0]!;
      if (response.comment !== undefined) values[`${question.id}.comment`] = response.comment;
    }
  }
  const answer = validateUiFormAnswer(form, { kind: 'form', actionId: 'submit', outcome: 'submit', values });
  decodeAskUserFormAnswer(questions, answer);
  return answer;
}

export function decodeAskUserFormAnswer(questions: readonly AskUserQuestion[], answer: UiFormAnswer): AskUserQuestionAnswer[] | null {
  const checked = validateUiFormAnswer({ title: 'Answer questions', fallback: 'Answer the questions or cancel.',
    input: { fields: askUserFields(questions) }, actions: askUserActions }, answer);
  if (checked.outcome === 'cancel') return null;
  const answers = questions.map(question => ({
    questionId: question.id, response: readResponse(question, questions.length > 1, checked.values),
  }));
  if (answers.every(answer => answer.response === null)) throw new Error('Answer at least one question.');
  return answers;
}

function readResponse(question: AskUserQuestion, wizard: boolean, values: UiValues): AskUserResponse | null {
  const choices = question.options.length > 0;
  const mode = wizard || choices && question.allowFreeform
    ? values[`${question.id}.mode`]
    : choices ? 'selection' : 'freeform';
  const selection = values[`${question.id}.selection`];
  const text = values[`${question.id}.text`];
  const comment = values[`${question.id}.comment`];
  const hasSelection = selection !== undefined && (!Array.isArray(selection) || selection.length > 0);
  const hasText = typeof text === 'string' && text.trim().length > 0;
  const hasComment = typeof comment === 'string' && comment.trim().length > 0;
  if (mode === 'skip' && wizard && !hasSelection && !hasText && !hasComment) return null;
  if (mode === 'freeform' && question.allowFreeform && hasText && !hasSelection && !hasComment) {
    return { kind: 'freeform', text: text as string };
  }
  if (mode !== 'selection' || !choices || !hasSelection || hasText) throw new Error(`${question.id}: Provide a non-empty answer of the selected type, without conflicting fields.`);
  const ids = typeof selection === 'string' ? [selection] : selection;
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > (question.allowMultiple ? question.options.length : 1)) {
    throw new Error(`${question.id}: Invalid selection count.`);
  }
  const options = new Map(question.options.map((option, index) => [`option${index + 1}`, option.title]));
  const selections = ids.map(id => {
    const title = options.get(id);
    if (title === undefined) throw new Error(`${question.id}: Unknown option identity.`);
    return title;
  });
  return { kind: 'selection', selections, ...(hasComment ? { comment: comment as string } : {}) };
}
