import { Type, type Static } from 'typebox';
import { ProtocolValidationError } from './limits.js';
import { CounterSchema, IdSchema, enumOf, parseSchema, unboundedText } from './schema.js';
import { UiFormAnswerSchema, UiFormRequestSchema, parseUiForm, validateUiFormAnswer } from './ui.js';

export const INTERACTION_KINDS = ['select', 'confirm', 'input', 'editor', 'tool_approval', 'dependency', 'form'] as const;
export const InteractionKindSchema = enumOf(INTERACTION_KINDS);
export const InteractionAuthoritySchema = enumOf(['owner', 'local-console'] as const);
export type InteractionAuthority = Static<typeof InteractionAuthoritySchema>;
const choices = Type.Array(Type.Object({ id: IdSchema, title: unboundedText(1), description: Type.Optional(unboundedText()) }), { minItems: 1 });
export const InteractionRequestSchema = Type.Union([
  Type.Object({ kind: Type.Literal('select'), title: unboundedText(1), choices, multiple: Type.Boolean() }),
  Type.Object({ kind: Type.Literal('confirm'), title: unboundedText(1), message: unboundedText() }),
  Type.Object({ kind: Type.Literal('input'), title: unboundedText(1), placeholder: Type.Optional(unboundedText()), initialValue: Type.Optional(unboundedText()) }),
  Type.Object({ kind: Type.Literal('editor'), title: unboundedText(1), initialValue: unboundedText() }),
  Type.Object({ kind: Type.Literal('tool_approval'), toolCallId: IdSchema, toolName: IdSchema, summary: unboundedText(), options: choices }),
  Type.Object({ kind: Type.Literal('dependency'), dependency: IdSchema, message: unboundedText() }),
  UiFormRequestSchema,
]);
export const InteractionAnswerSchema = Type.Union([
  Type.Object({ kind: Type.Literal('select'), choices: Type.Array(IdSchema, { minItems: 1, uniqueItems: true }) }),
  Type.Object({ kind: Type.Literal('confirm'), confirmed: Type.Boolean() }),
  Type.Object({ kind: Type.Literal('input'), text: unboundedText() }),
  Type.Object({ kind: Type.Literal('editor'), text: unboundedText() }),
  Type.Object({ kind: Type.Literal('tool_approval'), optionId: IdSchema }),
  Type.Object({ kind: Type.Literal('dependency'), approved: Type.Boolean() }),
  UiFormAnswerSchema,
]);
export const InteractionCancellationSchema = Type.Object({ cancelled: Type.Literal(true), reason: enumOf(['user', 'abort', 'timeout', 'unsupported', 'drain', 'restart'] as const) });
export const UserCancellationSchema = Type.Object({ cancelled: Type.Literal(true), reason: Type.Literal('user') });

const common = {
  id: IdSchema,
  scope: Type.Union([Type.Object({ kind: Type.Literal('host'), recipient: Type.Optional(IdSchema) }), Type.Object({ kind: Type.Literal('session'), session: IdSchema, root: IdSchema })]),
  request: InteractionRequestSchema,
  authority: Type.Optional(InteractionAuthoritySchema),
  deferrable: Type.Optional(Type.Boolean()),
  createdAt: CounterSchema, expiresAt: Type.Optional(CounterSchema),
};
export const InteractionSchema = Type.Union([
  Type.Object({ ...common, state: Type.Literal('waiting') }),
  Type.Object({ ...common, state: Type.Literal('deferred'), expiresAt: CounterSchema }),
  Type.Object({ ...common, state: Type.Literal('answered'), responder: IdSchema, resolvedAt: CounterSchema, result: InteractionAnswerSchema }),
  Type.Object({ ...common, state: enumOf(['cancelled', 'expired'] as const), resolvedAt: CounterSchema, result: InteractionCancellationSchema }),
]);
export type Interaction = Static<typeof InteractionSchema>;
export type InteractionAnswer = Static<typeof InteractionAnswerSchema>;

export function parseInteraction(value: unknown): Interaction {
  const interaction = parseSchema(InteractionSchema, value);
  if (interaction.request.kind === 'form') {
    parseUiForm(interaction.request.form);
  }
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
  if (request.kind === 'form' && answer.kind === 'form') {
    validateUiFormAnswer(request.form, answer);
  }
  return answer;
}
