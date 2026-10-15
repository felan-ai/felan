import { Type, type Static } from 'typebox';
import { CounterSchema, IdSchema, enumOf, parseSchema, text, unboundedText } from './schema.js';
import { ProtocolValidationError } from './limits.js';

export const MESSAGE_DISPLAY_ID = 'felan.message-display';
export const MESSAGE_DISPLAY_KEY = 'felanMessage';
const CostSchema = Type.Number({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const stopReasons = ['stop', 'length', 'toolUse', 'error', 'aborted'] as const;
export const StopReasonSchema = enumOf(stopReasons);
export type StopReason = (typeof stopReasons)[number];
export function stopReasonOf(value: unknown): StopReason | undefined { return stopReasons.find(reason => reason === value); }
export const AssistantDisplaySchema = Type.Object({
  kind: Type.Literal('assistant'), timestamp: CounterSchema,
  api: text(256, 1), provider: text(256, 1), model: text(256, 1),
  stopReason: StopReasonSchema,
  errorMessage: Type.Optional(unboundedText()),
  usage: Type.Object({ input: CounterSchema, output: CounterSchema, cacheRead: CounterSchema, cacheWrite: CounterSchema,
    totalTokens: CounterSchema, cost: Type.Object({ input: CostSchema, output: CostSchema, cacheRead: CostSchema, cacheWrite: CostSchema, total: CostSchema },
      { additionalProperties: false }) }, { additionalProperties: false }),
}, { additionalProperties: false });
export const ToolDisplaySchema = Type.Object({ kind: Type.Literal('tool'), timestamp: CounterSchema, name: text(256, 1) }, { additionalProperties: false });
export const MessageDisplaySchema = Type.Union([AssistantDisplaySchema, ToolDisplaySchema]);
export const ActiveMessageDisplaySchema = Type.Object({ message: IdSchema, display: AssistantDisplaySchema }, { additionalProperties: false });
export type MessageDisplay = Static<typeof MessageDisplaySchema>;
export type ActiveMessageDisplay = Static<typeof ActiveMessageDisplaySchema>;

export function parseMessageDisplay(value: unknown): MessageDisplay { return parseSchema(MessageDisplaySchema, value); }
export function parseActiveMessageDisplay(value: unknown): ActiveMessageDisplay { return parseSchema(ActiveMessageDisplaySchema, value); }
export function readMessageDisplay(details: unknown): MessageDisplay | undefined {
  if (!details || typeof details !== 'object' || !Object.hasOwn(details, MESSAGE_DISPLAY_KEY)) return undefined;
  const property = Object.getOwnPropertyDescriptor(details, MESSAGE_DISPLAY_KEY)!;
  if (!('value' in property)) throw new ProtocolValidationError('invalid_request', 'Expected display data, not an accessor');
  return parseMessageDisplay(property.value);
}
