import { ASK_USER_FORM_HINT } from './data.js';
import type { ExtensionUi, UiField, UiForm, UiValues } from '@felan-ai/agent-core';
import { parseUiForm, validateUiFormAnswer } from '@felan-ai/session-protocol';
import type { AskUserHost, AskUserQuestion, AskUserRequest, AskUserResponse } from './contracts.js';

const MAX_TEXT_BYTES = 32 * 1024;

export function createUiAskUserHost(ui: ExtensionUi): AskUserHost {
  return {
    async ask(request, execution) {
      if (execution.signal.aborted) return { status: 'cancelled', reason: 'abort' };
      const form = createForm(request);
      const result = await ui.request(form, {
        signal: execution.signal, deferrable: true,
        ...(request.timeout === undefined ? {} : { timeoutMs: request.timeout }),
      });
      if (execution.signal.aborted) return { status: 'cancelled', reason: 'abort' };
      switch (result.state) {
        case 'deferred': return { status: 'deferred', interactionId: result.interactionId };
        case 'cancelled':
          switch (result.reason) {
            case 'user': case 'abort': case 'timeout': return { status: 'cancelled', reason: result.reason };
            case 'unsupported': return { status: 'cancelled', reason: 'unavailable' };
            case 'drain': case 'restart': return { status: 'cancelled', reason: 'abort', message: `Ask-user prompt interrupted by host ${result.reason}.` };
            default: throw new Error('Generic UI returned an invalid cancellation reason.');
          }
        case 'answered': {
          const answer = validateUiFormAnswer(form, result.answer);
          if (answer.outcome === 'cancel') return { status: 'cancelled', reason: 'user' };
          const answers = request.questions.map(question => ({
            questionId: question.id,
            response: readResponse(question, request.questions.length > 1, answer.values),
          }));
          if (answers.every(answer => answer.response === null)) throw new Error('Answer at least one question.');
          return { status: 'answered', answers };
        }
        default: throw new Error('Generic UI returned an invalid outcome.');
      }
    },
  };
}

function createForm(request: AskUserRequest): UiForm {
  const wizard = request.questions.length > 1;
  const fields: UiField[] = [];
  const sections = request.questions.map((question, index) => {
    const choices = question.options.length > 0;
    const mode = wizard || choices && question.allowFreeform;
    const label = `Question ${index + 1}`;
    if (mode) {
      fields.push({ id: `${question.id}.mode`, kind: 'enum', label: `${label}: Answer type`, required: true, options: [
        ...(choices ? [{ id: 'selection', label: 'Choose listed options' }] : []),
        ...(question.allowFreeform ? [{ id: 'freeform', label: 'Write an answer' }] : []),
        ...(wizard ? [{ id: 'skip', label: 'Skip this question' }] : []),
      ] });
    }
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
    return [
      `## ${label}: ${markdownText(question.header)}`,
      markdownText(question.question),
      ...(question.context === undefined ? [] : [markdownText(question.context)]),
      ...(choices ? [question.options.map(option => `- ${markdownText(option.title)}${option.description === undefined ? '' : `: ${markdownText(option.description)}`}`).join('\n'),
        question.allowMultiple ? 'Select one or more listed options.' : 'Select exactly one listed option.'] : []),
      ...(choices && question.allowFreeform ? ['Choose listed options or write an answer, not both. Comments apply only to listed options.'] : []),
      ...(wizard ? ['Choose an answer type. Leave other answer fields empty; skipping requires all fields for this question to be empty.'] : []),
    ].join('\n\n');
  });
  try {
    return parseUiForm({
      hint: ASK_USER_FORM_HINT,
      title: wizard ? `Answer ${request.questions.length} questions` : 'Answer question',
      markdown: sections.join('\n\n'),
      fallback: wizard ? 'Answer the questions or explicitly skip individual questions. At least one answer is required.' : 'Answer the question or cancel.',
      input: { fields },
      actions: [
        { id: 'submit', label: 'Submit answers', target: 'element', outcome: 'submit' },
        { id: 'cancel', label: 'Cancel', target: 'element', outcome: 'cancel' },
      ],
    });
  } catch (error) {
    throw new Error('Ask-user content cannot be represented within generic form limits (1024 UTF-8 bytes per option label, 128 KiB Markdown, 256 KiB aggregate).', { cause: error });
  }
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

function markdownText(value: string): string {
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`)
    .replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;')
    .replace(/[\\`*_{}\[\]()#+.!|~\-]/gu, '\\$&');
}

export { ASK_USER_FORM_HINT } from './data.js';
