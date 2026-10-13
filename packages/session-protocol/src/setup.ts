import { Type, type Static } from 'typebox';
import { IdSchema, enumOf, text } from './schema.js';

const choice = Type.Object({ id: IdSchema, label: text(4096, 1), description: Type.Optional(text(4096)) }, { additionalProperties: false });
export const SetupPromptSchema = Type.Union([
  Type.Object({ id: IdSchema, kind: Type.Literal('input'), message: text(8192, 1), secret: Type.Boolean(), placeholder: Type.Optional(text(4096)) }, { additionalProperties: false }),
  Type.Object({ id: IdSchema, kind: Type.Literal('select'), message: text(8192, 1), choices: Type.Array(choice, { minItems: 1, maxItems: 128 }) }, { additionalProperties: false }),
]);
export const SetupJobSchema = Type.Object({
  id: IdSchema, kind: enumOf(['login', 'logout', 'dependencies'] as const),
  state: enumOf(['running', 'waiting', 'cancelling', 'completed', 'cancelled', 'failed'] as const),
  message: text(8192), prompt: Type.Optional(SetupPromptSchema),
  links: Type.Optional(Type.Array(Type.Object({ label: text(4096, 1), url: text(4096, 1), autoOpen: Type.Optional(Type.Literal(true)) }, { additionalProperties: false }), { maxItems: 16 })),
}, { additionalProperties: false, 'x-maxEncodedBytes': 64 * 1024 });
export const SetupStartSchema = Type.Union([
  Type.Object({ kind: Type.Literal('logout'), provider: IdSchema, confirmed: Type.Literal(true) }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('login'), provider: IdSchema, method: enumOf(['oauth', 'api_key'] as const), confirmed: Type.Literal(true) }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('dependencies'), choices: Type.Array(Type.Object({ id: IdSchema, action: enumOf(['install', 'enable', 'disable', 'skip'] as const) }, { additionalProperties: false }),
    { minItems: 1, maxItems: 16 }), confirmed: Type.Literal(true) }, { additionalProperties: false }),
]);
export const SetupCatalogSchema = Type.Object({
  providers: Type.Array(Type.Object({ id: IdSchema, label: text(4096, 1), configured: Type.Boolean(), subscription: Type.Boolean(), apiKeyLogin: Type.Boolean(), apiKeyName: Type.Optional(text(4096, 1)),
    status: Type.Optional(Type.Object({ type: enumOf(['oauth', 'api_key'] as const), source: Type.Optional(text(4096, 1)) }, { additionalProperties: false })), oauthLabel: Type.Optional(text(4096, 1)),
    methods: Type.Array(enumOf(['oauth', 'api_key'] as const), { minItems: 1, maxItems: 2, uniqueItems: true }) }, { additionalProperties: false }), { maxItems: 128 }),
  credentials: Type.Array(Type.Object({ id: IdSchema, label: text(4096, 1), type: enumOf(['oauth', 'api_key'] as const), subscription: Type.Boolean() }, { additionalProperties: false }), { maxItems: 128 }),
  dependencies: Type.Array(Type.Object({ id: IdSchema, label: text(4096, 1), description: text(8192), enabled: Type.Boolean(),
    available: Type.Boolean(), installable: Type.Boolean(), needsSetup: Type.Boolean(), version: Type.Optional(text(128)), reason: Type.Optional(text(4096)) }, { additionalProperties: false }), { maxItems: 16 }),
}, { additionalProperties: false, 'x-maxEncodedBytes': 128 * 1024 });
export type SetupJob = Static<typeof SetupJobSchema>;
export type SetupPrompt = Static<typeof SetupPromptSchema>;
export type SetupStart = Static<typeof SetupStartSchema>;
export type SetupCatalog = Static<typeof SetupCatalogSchema>;
