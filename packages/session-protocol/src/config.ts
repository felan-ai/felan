import { Type } from 'typebox';
import { IdSchema, JsonValueSchema, ThinkingSchema, enumOf, unboundedText } from './schema.js';
import { LIMITS } from './limits.js';

export const ConfigValuesSchema = Type.Object({
  extensionConfig: Type.Optional(Type.Record(IdSchema, Type.Record(IdSchema, JsonValueSchema))),
  codemode: Type.Optional(enumOf(['off', 'on', 'only'] as const)),
  imageAutoResize: Type.Optional(Type.Boolean()), blockImages: Type.Optional(Type.Boolean()),
  autoCompact: Type.Optional(Type.Boolean()), skillCommands: Type.Optional(Type.Boolean()),
  steeringMode: Type.Optional(enumOf(['one-at-a-time', 'all'] as const)),
  followUpMode: Type.Optional(enumOf(['one-at-a-time', 'all'] as const)),
  transport: Type.Optional(enumOf(['sse', 'websocket', 'websocket-cached', 'auto'] as const)),
  cacheWarming: Type.Optional(enumOf(['off', 'streaming', 'idle'] as const)),
  httpIdleTimeoutMs: Type.Optional(Type.Integer({ minimum: 0, maximum: 2147483647 })),
  modelThinkingLevels: Type.Optional(Type.Record(IdSchema, ThinkingSchema)),
  scopedModels: Type.Optional(Type.Array(IdSchema, { uniqueItems: true })),
  defaultModel: Type.Optional(IdSchema),
  defaultThinking: Type.Optional(ThinkingSchema),
  classifierModel: Type.Optional(IdSchema),
  builtinExtensions: Type.Optional(Type.Record(Type.String({ pattern: `^[A-Za-z][A-Za-z0-9_-]{0,${LIMITS.idBytes - 1}}$` }), Type.Boolean(), { additionalProperties: false })),
}, { additionalProperties: false });

export const ConfigScopeSchema = enumOf(['session', 'project', 'global'] as const);

export const ExtensionSettingsSchema = Type.Array(Type.Object({
  id: IdSchema, title: unboundedText(1),
  fields: Type.Array(Type.Object({
    id: IdSchema, label: unboundedText(1), description: unboundedText(),
    type: enumOf(['boolean', 'string', 'number', 'json'] as const),
    sensitive: Type.Optional(Type.Boolean()),
    values: Type.Optional(Type.Array(JsonValueSchema)),
  })),
}));
