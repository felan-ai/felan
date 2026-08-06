import type {
  AskUserHostOutcome,
  AskUserInput,
  AskUserOption,
  AskUserOptionInput,
  AskUserQuestion,
  AskUserQuestionAnswer,
  AskUserQuestionInput,
  AskUserRequest,
  AskUserResponse,
} from './contracts.js';

export const MAX_ASK_USER_QUESTIONS = 4;

export type AskUserValidationResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string };

export function normalizeAskUserRequest(input: AskUserInput): AskUserValidationResult<AskUserRequest> {
  const rawQuestions = input.questions === undefined ? [input] : input.questions;
  if (rawQuestions.length === 0) return invalid('ask_user requires at least one question');
  if (rawQuestions.length > MAX_ASK_USER_QUESTIONS) {
    return invalid(`ask_user supports at most ${MAX_ASK_USER_QUESTIONS} questions per call`);
  }
  if (input.timeout !== undefined && (!Number.isFinite(input.timeout) || input.timeout <= 0)) {
    return invalid('timeout must be a positive number of milliseconds');
  }

  const defaults: Partial<AskUserQuestionInput> = input.questions === undefined
    ? {}
    : {
      ...(input.context === undefined ? {} : { context: input.context }),
      ...(input.options === undefined ? {} : { options: input.options }),
      ...(input.allowMultiple === undefined ? {} : { allowMultiple: input.allowMultiple }),
      ...(input.allowFreeform === undefined ? {} : { allowFreeform: input.allowFreeform }),
      ...(input.allowComment === undefined ? {} : { allowComment: input.allowComment }),
    };
  const questions: AskUserQuestion[] = [];
  for (let index = 0; index < rawQuestions.length; index += 1) {
    const normalized = normalizeQuestion(rawQuestions[index]!, index, defaults);
    if (!normalized.ok) return normalized;
    questions.push(normalized.value);
  }

  const questionTexts = questions.map((question) => question.question.toLocaleLowerCase());
  if (new Set(questionTexts).size !== questionTexts.length) {
    return invalid('Question texts must be unique when using questions[]');
  }

  return {
    ok: true,
    value: {
      questions,
      ...(input.displayMode === undefined ? {} : { displayMode: input.displayMode }),
      ...(input.overlayToggleKey === undefined ? {} : { overlayToggleKey: input.overlayToggleKey }),
      ...(input.commentToggleKey === undefined ? {} : { commentToggleKey: input.commentToggleKey }),
      ...(input.timeout === undefined ? {} : { timeout: input.timeout }),
    },
  };
}

export function validateAskUserHostOutcome(
  outcome: unknown,
  request: AskUserRequest,
): AskUserValidationResult<AskUserHostOutcome> {
  if (!isRecord(outcome) || typeof outcome.status !== 'string') {
    return invalid('Ask-user host returned an invalid outcome');
  }
  if (outcome.status === 'cancelled') {
    if (!['user', 'timeout', 'abort', 'unavailable'].includes(String(outcome.reason))) {
      return invalid('Ask-user host returned an invalid cancellation reason');
    }
    const message = optionalText(outcome.message);
    if (!message.ok) return message;
    return {
      ok: true,
      value: {
        status: 'cancelled',
        reason: outcome.reason as 'user' | 'timeout' | 'abort' | 'unavailable',
        ...(message.value === undefined ? {} : { message: message.value }),
      },
    };
  }
  if (outcome.status === 'deferred') {
    const message = optionalText(outcome.message);
    if (!message.ok) return message;
    const interactionId = normalizeRequiredText(outcome.interactionId);
    if (!interactionId) return invalid('Ask-user host returned deferred without an interaction id');
    return {
      ok: true,
      value: {
        status: 'deferred',
        interactionId,
        ...(message.value === undefined ? {} : { message: message.value }),
      },
    };
  }
  if (outcome.status !== 'answered' || !Array.isArray(outcome.answers)) {
    return invalid('Ask-user host returned an invalid outcome status');
  }

  const answers = validateAnswers(outcome.answers, request, true);
  if (!answers.ok) return answers;
  if (!answers.value.some((answer) => answer.response !== null)) {
    return invalid('Ask-user host returned answered without an answer');
  }
  return { ok: true, value: { status: 'answered', answers: answers.value } };
}

export function validateAskUserProgress(
  answers: unknown,
  request: AskUserRequest,
): AskUserValidationResult<readonly AskUserQuestionAnswer[]> {
  if (!Array.isArray(answers)) return invalid('Ask-user host progress is invalid');
  return validateAnswers(answers, request, false);
}

function normalizeQuestion(
  input: Partial<AskUserQuestionInput>,
  index: number,
  defaults: Partial<AskUserQuestionInput>,
): AskUserValidationResult<AskUserQuestion> {
  const question = normalizeRequiredText(input.question);
  if (!question) return invalid(`Question ${index + 1} is missing question text`);
  const header = normalizeRequiredText(input.header) ?? `Q${index + 1}`;
  const context = normalizeRequiredText(input.context) ?? normalizeRequiredText(defaults.context);
  const options = normalizeOptions(input.options ?? defaults.options ?? []);
  if (!options.ok) return options;
  const allowFreeform = input.allowFreeform ?? defaults.allowFreeform ?? true;

  return {
    ok: true,
    value: {
      id: `q${index + 1}`,
      question,
      header,
      ...(context === undefined ? {} : { context }),
      options: options.value,
      allowMultiple: input.allowMultiple ?? defaults.allowMultiple ?? false,
      allowFreeform: options.value.length === 0 ? true : allowFreeform,
      allowComment: input.allowComment ?? defaults.allowComment ?? false,
    },
  };
}

function normalizeOptions(options: readonly AskUserOptionInput[]): AskUserValidationResult<AskUserOption[]> {
  const normalized: AskUserOption[] = [];
  for (const option of options) {
    const title = normalizeRequiredText(typeof option === 'string' ? option : option?.title);
    if (!title) return invalid('Option titles must contain text');
    const description = typeof option === 'string' ? undefined : normalizeRequiredText(option.description);
    normalized.push({ title, ...(description === undefined ? {} : { description }) });
  }
  const titles = normalized.map((option) => option.title.toLocaleLowerCase());
  if (new Set(titles).size !== titles.length) return invalid('Option titles must be unique within a question');
  return { ok: true, value: normalized };
}

function validateAnswers(
  rawAnswers: readonly unknown[],
  request: AskUserRequest,
  requireComplete: boolean,
): AskUserValidationResult<readonly AskUserQuestionAnswer[]> {
  const questions = new Map(request.questions.map((question) => [question.id, question]));
  const seen = new Set<string>();
  const answers: AskUserQuestionAnswer[] = [];
  for (const rawAnswer of rawAnswers) {
    if (!isRecord(rawAnswer) || typeof rawAnswer.questionId !== 'string') {
      return invalid('Ask-user host returned an invalid question answer');
    }
    const question = questions.get(rawAnswer.questionId);
    if (!question) return invalid(`Ask-user host returned an unknown question id: ${rawAnswer.questionId}`);
    if (seen.has(question.id)) return invalid(`Ask-user host returned duplicate answer for ${question.id}`);
    seen.add(question.id);
    const response = validateResponse(rawAnswer.response, question);
    if (!response.ok) return invalid(`${question.header}: ${response.error}`);
    answers.push({ questionId: question.id, response: response.value });
  }
  if (requireComplete && seen.size !== request.questions.length) {
    return invalid('Ask-user host omitted one or more question answers');
  }
  return { ok: true, value: answers };
}

function validateResponse(
  response: unknown,
  question: AskUserQuestion,
): AskUserValidationResult<AskUserResponse | null> {
  if (response === null) return { ok: true, value: null };
  if (!isRecord(response)) return invalid('response is invalid');
  if (response.kind === 'freeform') {
    if (!question.allowFreeform) return invalid('freeform answers are not allowed');
    const text = normalizeRequiredText(response.text);
    return text ? { ok: true, value: { kind: 'freeform', text } } : invalid('answer cannot be empty');
  }
  if (response.kind !== 'selection' || !Array.isArray(response.selections)) {
    return invalid('response kind is invalid');
  }
  if (question.options.length === 0) return invalid('this question expects a freeform answer');
  const byTitle = new Map(question.options.map((option) => [option.title.toLocaleLowerCase(), option.title]));
  const selections: string[] = [];
  for (const rawSelection of response.selections) {
    const selection = normalizeRequiredText(rawSelection);
    const canonical = selection ? byTitle.get(selection.toLocaleLowerCase()) : undefined;
    if (!canonical) return invalid(`unknown option: ${selection ?? '(empty)'}`);
    if (!selections.includes(canonical)) selections.push(canonical);
  }
  if (selections.length === 0) return invalid('select at least one option');
  if (!question.allowMultiple && selections.length > 1) return invalid('select only one option');
  const comment = optionalText(response.comment);
  if (!comment.ok) return comment;
  if (comment.value !== undefined && !question.allowComment) return invalid('comments are not enabled');
  return {
    ok: true,
    value: {
      kind: 'selection',
      selections,
      ...(comment.value === undefined ? {} : { comment: comment.value }),
    },
  };
}

function optionalText(value: unknown): AskUserValidationResult<string | undefined> {
  if (value === undefined) return { ok: true, value: undefined };
  if (typeof value !== 'string') return invalid('Optional text values must be strings');
  const normalized = normalizeRequiredText(value);
  return normalized ? { ok: true, value: normalized } : invalid('Optional text values cannot be empty');
}

function normalizeRequiredText(value: unknown): string | undefined {
  return typeof value === 'string' ? value.trim() || undefined : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalid<T = never>(error: string): AskUserValidationResult<T> {
  return { ok: false, error };
}
