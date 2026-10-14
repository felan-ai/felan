import { Type, type Static } from 'typebox';
import { DEFAULT_CONFIG, parseDisplayLines, type PowerlineConfig } from './renderers/powerline/config.js';
import { DEFAULT_ASK_USER_CONFIG, normalizeAskUserShortcut } from './ask-user-preferences.js';
import { LIMITS, enumOf, parseSchema } from '@felan-ai/session-protocol';

const key = Type.String({ minLength: 1, maxLength: 128, 'x-maxBytes': 128, pattern: '^[^\\x00-\\x1f\\x7f]+$' });
export const TuiKeybindingsSchema = Type.Record(Type.String({ pattern: '^[A-Za-z][A-Za-z0-9.-]{0,127}$' }),
  Type.Union([key, Type.Array(key, { maxItems: 16, uniqueItems: true })]), { maxProperties: 256, additionalProperties: false, 'x-maxEncodedBytes': LIMITS.structuredBytes });
const shortcut = Type.String({ maxLength: 128, pattern: '^[^\\x00-\\x1f\\x7f]*$' });
const displayMode = enumOf(['inline', 'overlay'] as const);
export const TuiPresentationSchema = Type.Object({
  askUser: Type.Object({ displayMode, singleSelectLayout: enumOf(['auto', 'list'] as const), overlayToggleKey: shortcut, commentToggleKey: shortcut }, { additionalProperties: false }),
  tasks: Type.Object({ displayMode }, { additionalProperties: false }),
  promptHistory: Type.Object({ displayMode }, { additionalProperties: false }),
  contextView: Type.Object({ displayMode }, { additionalProperties: false }),
  powerline: Type.Object({ style: enumOf(['minimal', 'powerline', 'capsule'] as const), charset: enumOf(['text', 'unicode'] as const), autoWrap: Type.Boolean(),
    padding: Type.Number({ minimum: 0, maximum: 4096 }), lines: Type.Array(Type.Unknown(), { maxItems: 32 }) }, { additionalProperties: false }),
}, { additionalProperties: false });
export type TuiPresentationPreferences = Omit<Static<typeof TuiPresentationSchema>, 'powerline'> & { powerline: PowerlineConfig['display'] };
export const defaultPresentationPreferences: TuiPresentationPreferences = { askUser: DEFAULT_ASK_USER_CONFIG, tasks: { displayMode: 'inline' }, promptHistory: { displayMode: 'inline' }, contextView: { displayMode: 'inline' }, powerline: DEFAULT_CONFIG.display };
export function validatePresentationPreferences(input: unknown): TuiPresentationPreferences {
  const value = parseSchema(TuiPresentationSchema, input);
  for (const shortcut of [value.askUser.overlayToggleKey, value.askUser.commentToggleKey]) if (normalizeAskUserShortcut(shortcut) === undefined) throw new Error('Invalid ask-user shortcut.');
  return { ...value, powerline: { ...value.powerline, lines: parseDisplayLines(value.powerline.lines) } };
}
export const TuiPreferencesSchema = Type.Object({
  presentation: Type.Optional(TuiPresentationSchema),
  hideThinking: Type.Boolean(), showImages: Type.Boolean(),
  imageWidthCells: Type.Integer({ minimum: 1, maximum: 4096 }), outputPad: Type.Integer({ minimum: 0, maximum: 16 }),
  toolDisplay: enumOf(['grouped', 'full'] as const), keybindings: TuiKeybindingsSchema,
  hardwareCursor: Type.Optional(Type.Boolean()), clearOnShrink: Type.Optional(Type.Boolean()), terminalProgress: Type.Optional(Type.Boolean()),
  editorPadding: Type.Optional(Type.Integer({ minimum: 0, maximum: 3 })),
  autocompleteMaxVisible: Type.Optional(Type.Integer({ minimum: 3, maximum: 20 })),
  mermaid: Type.Optional(enumOf(['off', 'final', 'streaming'] as const)),
  quietStartup: Type.Optional(Type.Union([Type.Boolean(), Type.Literal('header')])),
  fullscreenScrollbar: Type.Optional(enumOf(['auto', 'always', 'hidden'] as const)),
  fullscreenCopyOnSelect: Type.Optional(Type.Boolean()),
  fullscreenWheelScrollLines: Type.Optional(Type.Union([Type.Literal('auto'), Type.Integer({ minimum: 1, maximum: 100 })])),
}, { additionalProperties: false, 'x-maxEncodedBytes': LIMITS.structuredBytes });
export const TuiPreferencesUpdateSchema = Type.Partial(TuiPreferencesSchema, {
  minProperties: 1, additionalProperties: false, 'x-maxEncodedBytes': LIMITS.structuredBytes,
});
export type TuiPreferences = Omit<Static<typeof TuiPreferencesSchema>, 'presentation'> & { presentation?: TuiPresentationPreferences };
export type TuiPreferencesUpdate = Partial<TuiPreferences>;
