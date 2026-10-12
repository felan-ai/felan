import { Type, type Static } from 'typebox';
import { LIMITS, ProtocolValidationError } from './limits.js';
import { ClientKindSchema, CounterSchema, IdSchema, JsonValueSchema, PresenterSchema, enumOf, parseSchema, text } from './schema.js';

export const INTERACTION_KINDS = ['select', 'confirm', 'input', 'editor', 'ask_user', 'tool_approval', 'oauth', 'trust', 'dependency', 'custom'] as const;
export const InteractionKindSchema = enumOf(INTERACTION_KINDS);
const choices = Type.Array(Type.Object({ id: IdSchema, title: text(4096, 1), description: Type.Optional(text(8192)) }), { minItems: 1, maxItems: LIMITS.choices });
const question = Type.Object({
  id: IdSchema, question: text(16384, 1), header: Type.Optional(text(1024)), context: Type.Optional(text(32768)),
  options: Type.Optional(choices), allowMultiple: Type.Optional(Type.Boolean()), allowFreeform: Type.Optional(Type.Boolean()), allowComment: Type.Optional(Type.Boolean()),
});
const customDocument = Type.Unsafe<Static<typeof JsonValueSchema>>({ ...JsonValueSchema, 'x-maxEncodedBytes': LIMITS.interactionBytes });
export const InteractionRequestSchema = Type.Union([
  Type.Object({ kind: Type.Literal('select'), title: text(4096, 1), choices, multiple: Type.Boolean() }),
  Type.Object({ kind: Type.Literal('confirm'), title: text(4096, 1), message: text(32768) }),
  Type.Object({ kind: Type.Literal('input'), title: text(4096, 1), placeholder: Type.Optional(text(4096)), initialValue: Type.Optional(text(32768)) }),
  Type.Object({ kind: Type.Literal('editor'), title: text(4096, 1), initialValue: text(LIMITS.answerBytes) }),
  Type.Object({ kind: Type.Literal('ask_user'), questions: Type.Array(question, { minItems: 1, maxItems: LIMITS.wizardPages }),
    displayMode: Type.Optional(enumOf(['overlay', 'inline'] as const)), singleSelectLayout: Type.Optional(enumOf(['auto', 'list'] as const)),
    overlayToggleKey: Type.Optional(text(128)), commentToggleKey: Type.Optional(text(128)) }),
  Type.Object({ kind: Type.Literal('tool_approval'), toolCallId: IdSchema, toolName: IdSchema, summary: text(32768), options: choices }),
  Type.Object({ kind: Type.Literal('oauth'), provider: IdSchema, url: text(4096, 1), instructions: text(32768), provisioningId: IdSchema }),
  Type.Object({ kind: Type.Literal('trust'), cwd: text(LIMITS.pathBytes, 1), message: text(32768) }),
  Type.Object({ kind: Type.Literal('dependency'), dependency: IdSchema, message: text(32768) }),
  Type.Object({ kind: Type.Literal('custom'), presenter: PresenterSchema, data: JsonValueSchema, document: Type.Optional(customDocument) }),
]);
export const InteractionAnswerSchema = Type.Union([
  Type.Object({ kind: Type.Literal('select'), choices: Type.Array(IdSchema, { minItems: 1, maxItems: LIMITS.choices, uniqueItems: true }) }),
  Type.Object({ kind: Type.Literal('confirm'), confirmed: Type.Boolean() }),
  Type.Object({ kind: Type.Literal('input'), text: text(LIMITS.answerBytes) }),
  Type.Object({ kind: Type.Literal('editor'), text: text(LIMITS.answerBytes) }),
  Type.Object({ kind: Type.Literal('ask_user'), answers: Type.Array(Type.Object({ questionId: IdSchema, choices: Type.Array(IdSchema, { maxItems: LIMITS.choices, uniqueItems: true }),
    text: Type.Optional(text(32768)), comment: Type.Optional(text(32768)) }), { minItems: 1, maxItems: LIMITS.wizardPages }) }),
  Type.Object({ kind: Type.Literal('tool_approval'), optionId: IdSchema }),
  Type.Object({ kind: Type.Literal('oauth'), provisioningId: IdSchema }),
  Type.Object({ kind: Type.Literal('trust'), trusted: Type.Boolean() }),
  Type.Object({ kind: Type.Literal('dependency'), approved: Type.Boolean() }),
  Type.Object({ kind: Type.Literal('custom'), presenter: PresenterSchema, data: JsonValueSchema }),
], { 'x-maxEncodedBytes': LIMITS.answerBytes });
export const InteractionCancellationSchema = Type.Object({ cancelled: Type.Literal(true), reason: enumOf(['user', 'abort', 'timeout', 'unsupported', 'drain', 'restart'] as const) });
export const UserCancellationSchema = Type.Object({ cancelled: Type.Literal(true), reason: Type.Literal('user') });

const common = {
  id: IdSchema,
  scope: Type.Union([Type.Object({ kind: Type.Literal('host'), recipient: Type.Optional(IdSchema) }), Type.Object({ kind: Type.Literal('session'), session: IdSchema, root: IdSchema })]),
  request: InteractionRequestSchema,
  eligibleClientKinds: Type.Array(ClientKindSchema, { minItems: 1, maxItems: 3, uniqueItems: true }),
  createdAt: CounterSchema, expiresAt: Type.Optional(CounterSchema),
};
export const InteractionSchema = Type.Union([
  Type.Object({ ...common, state: Type.Literal('waiting') }),
  Type.Object({ ...common, state: Type.Literal('deferred'), expiresAt: CounterSchema }),
  Type.Object({ ...common, state: Type.Literal('answered'), responder: IdSchema, resolvedAt: CounterSchema, result: InteractionAnswerSchema }),
  Type.Object({ ...common, state: enumOf(['cancelled', 'expired'] as const), resolvedAt: CounterSchema, result: InteractionCancellationSchema }),
], { 'x-maxEncodedBytes': LIMITS.interactionBytes });
export type Interaction = Static<typeof InteractionSchema>;
export type InteractionAnswer = Static<typeof InteractionAnswerSchema>;

export function parseInteraction(value: unknown): Interaction {
  const interaction = parseSchema(InteractionSchema, value);
  if (interaction.expiresAt !== undefined && interaction.expiresAt < interaction.createdAt) throw new ProtocolValidationError('invalid_request', 'Invalid interaction expiry');
  if ('resolvedAt' in interaction && interaction.resolvedAt < interaction.createdAt) throw new ProtocolValidationError('invalid_request', 'Invalid interaction resolution time');
  if (interaction.state === 'answered') validateInteractionAnswer(interaction, interaction.result);
  return interaction;
}

export function validateInteractionAnswer(interaction: Interaction, value: unknown): InteractionAnswer {
  const answer = parseSchema(InteractionAnswerSchema, value);
  const request = interaction.request;
  if (request.kind !== answer.kind) throw new ProtocolValidationError('invalid_request', 'Interaction answer kind mismatch');
  const invalid = () => { throw new ProtocolValidationError('invalid_request', 'Invalid interaction answer selection'); };
  if (request.kind === 'select' && answer.kind === 'select') {
    if ((!request.multiple && answer.choices.length !== 1) || answer.choices.some(id => !request.choices.some(choice => choice.id === id))) invalid();
  }
  if (request.kind === 'tool_approval' && answer.kind === 'tool_approval' && !request.options.some(choice => choice.id === answer.optionId)) invalid();
  if (request.kind === 'ask_user' && answer.kind === 'ask_user') {
    if (answer.answers.length !== request.questions.length || new Set(answer.answers.map(item => item.questionId)).size !== answer.answers.length) invalid();
    for (const item of answer.answers) {
      const page = request.questions.find(candidate => candidate.id === item.questionId);
      if (!page || (!page.allowMultiple && item.choices.length > 1) || item.choices.some(id => !page.options?.some(choice => choice.id === id)) ||
        (page.allowFreeform === false && item.text !== undefined) || (!page.allowComment && item.comment !== undefined) || (!item.choices.length && !item.text)) invalid();
    }
  }
  if (request.kind === 'oauth' && answer.kind === 'oauth' && request.provisioningId !== answer.provisioningId) invalid();
  if (request.kind === 'custom' && answer.kind === 'custom' && (request.presenter.id !== answer.presenter.id || request.presenter.version !== answer.presenter.version)) invalid();
  return answer;
}
