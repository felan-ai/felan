import type {
  FelanExtension,
  ToolDefinition,
} from '@felan-ai/agent-core';
import { associateExtensionConfig, StringEnum } from '@felan-ai/agent-core';
import { Type, type Static } from 'typebox';
import type {
  AskUserHost,
  AskUserHostOutcome,
  AskUserInput,
  AskUserQuestion,
  AskUserQuestionAnswer,
  AskUserRequest,
  AskUserResponse,
  AskUserToolDetails,
  AskUserToolErrorDetails,
} from './contracts.js';
import {
  MAX_ASK_USER_QUESTIONS,
  normalizeAskUserRequest,
  prepareAskUserArguments,
  validateAskUserHostOutcome,
  validateAskUserProgress,
} from './normalize.js';
import { ASK_USER_CONFIG } from './config.js';

const OptionSchema = Type.Object({
  title: Type.String({ minLength: 1, description: 'Short title for this option' }),
  description: Type.Optional(Type.String({ minLength: 1, description: 'Longer description explaining this option' })),
}, { additionalProperties: false });

const QuestionSchema = Type.Object({
  question: Type.String({ minLength: 1, description: 'The focused question to ask the user' }),
  header: Type.Optional(Type.String({ minLength: 1, description: 'Short label for this question in wizard navigation' })),
  context: Type.Optional(Type.String({ minLength: 1, description: 'Relevant context to show before this question' })),
  options: Type.Optional(Type.Array(OptionSchema, { description: 'List of options for the user to choose from' })),
  allowMultiple: Type.Optional(Type.Boolean({ description: 'Allow selecting multiple options for this question. Default: false' })),
  allowFreeform: Type.Optional(Type.Boolean({ description: 'Add a freeform text option for this question. Default: true' })),
  allowComment: Type.Optional(Type.Boolean({ description: 'Collect an optional comment for this question. Default: false' })),
}, { additionalProperties: false });

const AskUserParameters = Type.Object({
  question: Type.Optional(Type.String({ minLength: 1, description: 'The question to ask the user. Use this for single-question calls.' })),
  header: Type.Optional(Type.String({ minLength: 1, description: "Short label for this question in wizard navigation, e.g. 'Scope' or 'Library'." })),
  context: Type.Optional(Type.String({ minLength: 1, description: 'Relevant context to show before the question (summary of findings)' })),
  options: Type.Optional(Type.Array(OptionSchema, { description: 'List of options for the user to choose from' })),
  allowMultiple: Type.Optional(Type.Boolean({ description: 'Allow selecting multiple options. Default: false' })),
  allowFreeform: Type.Optional(Type.Boolean({ description: 'Add a freeform text option. Default: true' })),
  allowComment: Type.Optional(Type.Boolean({ description: 'Collect an optional comment after selecting one or more options. Default: false' })),
  questions: Type.Optional(Type.Array(QuestionSchema, {
    minItems: 1,
    maxItems: MAX_ASK_USER_QUESTIONS,
    description: `Related questions to ask together as a wizard. Limit ${MAX_ASK_USER_QUESTIONS}. Use this instead of separate ask_user calls when multiple related clarifications are known. Omit for a single-question call.`,
  })),
  displayMode: Type.Optional(StringEnum(['overlay', 'inline'] as const, {
    description: "UI rendering mode. 'overlay' shows a centered modal, 'inline' renders in-place. Omit to respect the host preference.",
  })),
  singleSelectLayout: Type.Optional(StringEnum(['auto', 'list'] as const, {
    description: "Single-select layout. 'auto' uses a details pane on wide terminals; 'list' always keeps descriptions below options. Omit to respect the host preference.",
  })),
  overlayToggleKey: Type.Optional(Type.String({
    minLength: 1,
    description: "Shortcut for hiding/showing the overlay popup, e.g. 'alt+o'. Pass 'off' to disable.",
  })),
  commentToggleKey: Type.Optional(Type.String({
    minLength: 1,
    description: "Shortcut for toggling optional extra context, e.g. 'ctrl+g'. Pass 'off' to disable.",
  })),
  timeout: Type.Optional(Type.Number({ exclusiveMinimum: 0, description: 'Auto-dismiss after N milliseconds.' })),
}, { additionalProperties: false });

type AskUserParams = Static<typeof AskUserParameters>;
type AskUserDetails = AskUserToolDetails | AskUserToolErrorDetails;

export function createAskUserExtension(host: AskUserHost): FelanExtension {
  const extension: FelanExtension = (pi) => {
    pi.registerCapability({
      id: 'ask-user',
      instructions: [
        'Use ask_user when the user’s intent is ambiguous, a decision requires explicit input, or multiple valid options materially change the work.',
        'Gather relevant context first and include a concise summary with the question.',
        `Batch known related clarifications into one wizard of at most ${MAX_ASK_USER_QUESTIONS} questions; use a single question when follow-up choices depend on the first answer.`,
      ].join(' '),
    });

    const tool: ToolDefinition<typeof AskUserParameters, AskUserDetails> = {
      name: 'ask_user',
      label: 'Ask User',
      description: 'Ask the user one focused question, or batch up to four related questions into a wizard with optional multiple-choice answers. Before calling, gather context and pass a short summary through context.',
      promptSnippet: 'Ask the user focused questions interactively, batching related questions into a wizard when possible',
      promptGuidelines: [
        'Before calling ask_user, gather context with tools and pass a short summary via the context field.',
        'Use ask_user when intent is ambiguous, a decision requires explicit input, or multiple valid options exist.',
        `Batch known related clarifications with questions[] in one wizard of at most ${MAX_ASK_USER_QUESTIONS} questions.`,
        'Use the single-question shape when one answer resolves the decision boundary or follow-ups depend on that answer.',
        'Keep wizard questions focused and independent.',
        'When the tool reports deferred delivery, end the turn without further actions and wait for the user response.',
      ],
      executionMode: 'sequential',
      parameters: AskUserParameters,
      prepareArguments: (args: unknown) => prepareAskUserArguments(args) as AskUserParams,
      async execute(toolCallId, params: AskUserParams, signal, onUpdate, extensionContext) {
        const normalized = normalizeAskUserRequest(params as AskUserInput);
        if (!normalized.ok) return toolError(normalized.error);
        const request = normalized.value;
        const effectiveSignal = signal ?? new AbortController().signal;
        if (effectiveSignal.aborted) return outcomeResult(request, { status: 'cancelled', reason: 'abort' });

        onUpdate?.({
          content: [{ type: 'text', text: 'Waiting for user input...' }],
          details: detailsFor(request, 'pending', []),
        });

        try {
          const outcome = await raceAbort(
            host.ask(request, {
              requestId: toolCallId,
              sessionId: extensionContext.sessionManager.getSessionId(),
              signal: effectiveSignal,
              extensionContext,
              reportProgress(rawAnswers) {
                const progress = validateAskUserProgress(rawAnswers, request);
                if (!progress.ok) return;
                onUpdate?.({
                  content: [{ type: 'text', text: formatProgress(request, progress.value) }],
                  details: detailsFor(request, 'pending', progress.value),
                });
              },
            }),
            effectiveSignal,
          );
          const validated = validateAskUserHostOutcome(outcome, request);
          if (!validated.ok) return toolError(validated.error);
          return outcomeResult(request, validated.value);
        } catch (error) {
          return toolError(`Ask-user host failed: ${errorMessage(error)}`);
        }
      },
      ...host.toolPresentation,
    };

    pi.registerTool(tool);
  };
  associateExtensionConfig(extension, ASK_USER_CONFIG);
  return extension;
}

function outcomeResult(request: AskUserRequest, outcome: AskUserHostOutcome) {
  const details = detailsFor(
    request,
    outcome.status,
    outcome.status === 'answered' ? outcome.answers : [],
    outcome,
  );
  if (outcome.status === 'answered') {
    return {
      content: [{ type: 'text' as const, text: formatAnswered(request, outcome.answers) }],
      details,
    };
  }
  if (outcome.status === 'deferred') {
    const message = outcome.message ? ` ${outcome.message}` : '';
    return {
      content: [{
        type: 'text' as const,
        text: `Question sent to the user (interaction: ${outcome.interactionId}).${message} End this turn without taking further action and wait for the user's response in a new turn.`,
      }],
      details,
    };
  }
  const text = outcome.message ?? cancellationText(request.questions.length, outcome.reason);
  return {
    content: [{ type: 'text' as const, text }],
    ...(outcome.reason === 'unavailable' ? { isError: true } : {}),
    details,
  };
}

function detailsFor(
  request: AskUserRequest,
  status: AskUserToolDetails['status'],
  answers: readonly AskUserQuestionAnswer[],
  outcome?: AskUserHostOutcome,
): AskUserToolDetails {
  const responses = Object.fromEntries(request.questions.map((question) => [question.id, null])) as Record<string, AskUserResponse | null>;
  for (const answer of answers) responses[answer.questionId] = answer.response;
  const metadata = outcome?.status === 'cancelled'
    ? { reason: outcome.reason, ...(outcome.message === undefined ? {} : { message: outcome.message }) }
    : outcome?.status === 'deferred'
      ? {
        ...(outcome.message === undefined ? {} : { message: outcome.message }),
        interactionId: outcome.interactionId,
      }
      : {};
  if (request.questions.length === 1) {
    return {
      kind: 'single',
      status,
      question: request.questions[0]!,
      response: responses[request.questions[0]!.id] ?? null,
      ...metadata,
    };
  }
  return { kind: 'wizard', status, questions: request.questions, responses, ...metadata };
}

function formatAnswered(
  request: AskUserRequest,
  answers: readonly AskUserQuestionAnswer[],
): string {
  const byId = new Map(answers.map((answer) => [answer.questionId, answer.response]));
  if (request.questions.length === 1) {
    return `User answered: ${formatResponse(byId.get(request.questions[0]!.id)!)}`;
  }
  return `User answered questions:\n${request.questions.map((question) => {
    const response = byId.get(question.id);
    return `- ${question.header} — ${question.question}: ${response ? formatResponse(response) : 'Skipped'}`;
  }).join('\n')}`;
}

function formatProgress(
  request: AskUserRequest,
  answers: readonly AskUserQuestionAnswer[],
): string {
  const answered = answers.filter((answer) => answer.response !== null).length;
  return answered === 0
    ? 'Waiting for user input...'
    : `Waiting for user input... ${answered}/${request.questions.length} answered`;
}

function formatResponse(response: AskUserResponse): string {
  if (response.kind === 'freeform') return response.text;
  const selections = response.selections.join(', ');
  return response.comment ? `${selections} — ${response.comment}` : selections;
}

function cancellationText(questionCount: number, reason: 'user' | 'timeout' | 'abort' | 'unavailable'): string {
  if (reason === 'timeout') return 'User did not answer before the prompt timed out';
  if (reason === 'abort') return 'Ask-user prompt was aborted';
  if (reason === 'unavailable') return 'Ask-user presentation is unavailable in this host mode';
  return questionCount === 1 ? 'User cancelled the question' : 'User cancelled the questions';
}

async function raceAbort(
  operation: Promise<AskUserHostOutcome>,
  signal: AbortSignal,
): Promise<AskUserHostOutcome> {
  if (signal.aborted) return { status: 'cancelled', reason: 'abort' };
  let removeListener: () => void = () => {};
  const aborted = new Promise<AskUserHostOutcome>((resolve) => {
    const onAbort = () => resolve({ status: 'cancelled', reason: 'abort' });
    signal.addEventListener('abort', onAbort, { once: true });
    removeListener = () => signal.removeEventListener('abort', onAbort);
  });
  try {
    return await Promise.race([operation, aborted]);
  } finally {
    removeListener();
  }
}

function toolError(error: string) {
  return {
    content: [{ type: 'text' as const, text: error }],
    isError: true,
    details: { error },
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type {
  AskUserAnsweredOutcome,
  AskUserCancellationReason,
  AskUserCancelledOutcome,
  AskUserDeferredOutcome,
  AskUserDisplayMode,
  AskUserHost,
  AskUserHostExecutionContext,
  AskUserHostOutcome,
  AskUserInput,
  AskUserOption,
  AskUserOptionAliasInput,
  AskUserOptionInput,
  AskUserQuestion,
  AskUserQuestionAnswer,
  AskUserQuestionInput,
  AskUserRequest,
  AskUserResponse,
  AskUserSingleSelectLayout,
  AskUserToolDetails,
  AskUserToolErrorDetails,
  AskUserToolPresentation,
} from './contracts.js';
export {
  ASK_USER_CONFIG,
  DEFAULT_ASK_USER_CONFIG,
  askUserConfigFromSettings,
  normalizeAskUserShortcut,
} from './config.js';
export type { AskUserConfig } from './config.js';
export {
  MAX_ASK_USER_QUESTIONS,
  normalizeAskUserRequest,
  validateAskUserHostOutcome,
} from './normalize.js';
