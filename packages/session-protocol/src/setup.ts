import { Type, type Static } from 'typebox';
import { IdSchema, enumOf, text, unboundedText } from './schema.js';

const choice = Type.Object({ id: IdSchema, label: unboundedText(1), description: Type.Optional(unboundedText()) }, { additionalProperties: false });
export const SetupPromptSchema = Type.Union([
  Type.Object({ id: IdSchema, kind: Type.Literal('input'), message: unboundedText(1), secret: Type.Boolean(), placeholder: Type.Optional(unboundedText()) }, { additionalProperties: false }),
  Type.Object({ id: IdSchema, kind: Type.Literal('select'), message: unboundedText(1), choices: Type.Array(choice, { minItems: 1 }) }, { additionalProperties: false }),
]);
export const SetupJobSchema = Type.Object({
  id: IdSchema, kind: enumOf(['login', 'logout', 'dependencies'] as const),
  state: enumOf(['running', 'waiting', 'cancelling', 'completed', 'cancelled', 'failed'] as const),
  message: unboundedText(), prompt: Type.Optional(SetupPromptSchema),
  links: Type.Optional(Type.Array(Type.Object({ label: unboundedText(1), url: unboundedText(1), autoOpen: Type.Optional(Type.Literal(true)) }, { additionalProperties: false }))),
}, { additionalProperties: false });
export const SetupStartSchema = Type.Union([
  Type.Object({ kind: Type.Literal('logout'), provider: IdSchema }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('login'), provider: IdSchema, method: enumOf(['oauth', 'api_key'] as const) }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('dependencies'), choices: Type.Array(Type.Object({ id: IdSchema, action: enumOf(['install', 'enable', 'disable', 'skip'] as const) }, { additionalProperties: false }),
    { minItems: 1 }) }, { additionalProperties: false }),
]);
export const SetupCatalogSchema = Type.Object({
  providers: Type.Array(Type.Object({ id: IdSchema, label: unboundedText(1), configured: Type.Boolean(), subscription: Type.Boolean(), apiKeyLogin: Type.Boolean(), apiKeyName: Type.Optional(unboundedText(1)),
    status: Type.Optional(Type.Object({ type: enumOf(['oauth', 'api_key'] as const), source: Type.Optional(unboundedText(1)) }, { additionalProperties: false })), oauthLabel: Type.Optional(unboundedText(1)),
    methods: Type.Array(enumOf(['oauth', 'api_key'] as const), { minItems: 1, maxItems: 2, uniqueItems: true }) }, { additionalProperties: false })),
  credentials: Type.Array(Type.Object({ id: IdSchema, label: unboundedText(1), type: enumOf(['oauth', 'api_key'] as const), subscription: Type.Boolean() }, { additionalProperties: false })),
  dependencies: Type.Array(Type.Object({ id: IdSchema, label: unboundedText(1), description: unboundedText(), enabled: Type.Boolean(),
    available: Type.Boolean(), installable: Type.Boolean(), needsSetup: Type.Boolean(), version: Type.Optional(text(128)), reason: Type.Optional(unboundedText()) }, { additionalProperties: false })),
}, { additionalProperties: false });
export type SetupJob = Static<typeof SetupJobSchema>;
export type SetupPrompt = Static<typeof SetupPromptSchema>;
export type SetupStart = Static<typeof SetupStartSchema>;
export type SetupCatalog = Static<typeof SetupCatalogSchema>;
