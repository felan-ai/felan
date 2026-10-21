import { ASK_USER_FORM_HINT, askUserActions, askUserFields, decodeAskUserFormAnswer } from './form.js';
import type { ExtensionUi, UiForm } from '@felan-ai/agent-core';
import { parseUiForm, validateUiFormAnswer } from '@felan-ai/session-protocol';
import type { AskUserHost, AskUserRequest } from './contracts.js';

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
          const answers = decodeAskUserFormAnswer(request.questions, answer);
          if (answers === null) return { status: 'cancelled', reason: 'user' };
          return { status: 'answered', answers };
        }
        default: throw new Error('Generic UI returned an invalid outcome.');
      }
    },
  };
}

function createForm(request: AskUserRequest): UiForm {
  const wizard = request.questions.length > 1;
  const sections = request.questions.map((question, index) => {
    const choices = question.options.length > 0;
    const label = `Question ${index + 1}`;
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
      hint: { ...ASK_USER_FORM_HINT, data: { questions: request.questions } },
      title: wizard ? `Answer ${request.questions.length} questions` : 'Answer question',
      markdown: sections.join('\n\n'),
      fallback: wizard ? 'Answer the questions or explicitly skip individual questions. At least one answer is required.' : 'Answer the question or cancel.',
      input: { fields: askUserFields(request.questions) },
      actions: askUserActions,
    });
  } catch (error) {
    throw new Error('Ask-user content cannot be represented within generic form limits (128 KiB hint data).', { cause: error });
  }
}

function markdownText(value: string): string {
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`)
    .replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;')
    .replace(/[\\`*_{}\[\]()#+.!|~\-]/gu, '\\$&');
}

export { ASK_USER_FORM_HINT } from './data.js';
