import { Type, type Static } from 'typebox';
import { LIMITS } from './limits.js';
import { enumOf } from './schema.js';

const key = Type.String({ minLength: 1, maxLength: 128, 'x-maxBytes': 128, pattern: '^[^\\x00-\\x1f\\x7f]+$' });
export const TuiKeybindingsSchema = Type.Record(Type.String({ pattern: '^[A-Za-z][A-Za-z0-9.-]{0,127}$' }),
  Type.Union([key, Type.Array(key, { maxItems: 16, uniqueItems: true })]), { maxProperties: 256, additionalProperties: false, 'x-maxEncodedBytes': LIMITS.structuredBytes });
export const TuiPreferencesSchema = Type.Object({
  hideThinking: Type.Boolean(), showImages: Type.Boolean(),
  imageWidthCells: Type.Integer({ minimum: 1, maximum: 4096 }), outputPad: Type.Integer({ minimum: 0, maximum: 16 }),
  toolDisplay: enumOf(['grouped', 'full'] as const), keybindings: TuiKeybindingsSchema,
}, { additionalProperties: false, 'x-maxEncodedBytes': LIMITS.structuredBytes });
export const TuiPreferencesUpdateSchema = Type.Partial(TuiPreferencesSchema, {
  minProperties: 1, additionalProperties: false, 'x-maxEncodedBytes': LIMITS.structuredBytes,
});
export type TuiPreferences = Static<typeof TuiPreferencesSchema>;
export type TuiPreferencesUpdate = Static<typeof TuiPreferencesUpdateSchema>;
