import { Type, type Static } from 'typebox';
import { LIMITS } from './limits.js';
import { CounterSchema, IdSchema, JsonValueSchema, PresenterSchema, parseSchema, text } from './schema.js';

export const RUNTIME_UI_PRESENTER = Object.freeze({ id: 'felan.runtime-ui', version: '1' });
export const HEADLESS_JSON_PRESENTER = Object.freeze({ id: 'felan.headless-json', version: '1' });

export const PresentationEventSchema = Type.Object({
  v: Type.Literal(1), session: IdSchema,
  presentationEvent: Type.Object({ presenter: PresenterSchema, sequence: CounterSchema,
    data: Type.Unsafe<Static<typeof JsonValueSchema>>({ ...JsonValueSchema, 'x-maxEncodedBytes': LIMITS.pageBytes }) }, { additionalProperties: false }),
}, { additionalProperties: false });
export type PresentationEvent = Static<typeof PresentationEventSchema>;

export const RuntimeUiStateSchema = Type.Object({
  workingMessage: Type.Optional(text(LIMITS.statusTextBytes)),
  workingVisible: Type.Optional(Type.Boolean()),
  workingIndicator: Type.Optional(Type.Object({
    frames: Type.Optional(Type.Array(text(256), { maxItems: 64 })),
    intervalMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 60_000 })),
  }, { additionalProperties: false })),
  hiddenThinkingLabel: Type.Optional(text(LIMITS.statusTextBytes)),
  toolsExpanded: Type.Optional(Type.Boolean()),
}, { additionalProperties: false, 'x-maxEncodedBytes': LIMITS.structuredBytes });

export type RuntimeUiState = Static<typeof RuntimeUiStateSchema>;

export function parseRuntimeUiState(value: unknown): RuntimeUiState {
  return parseSchema(RuntimeUiStateSchema, value);
}
