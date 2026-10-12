import { Type, type Static } from 'typebox';
import { AbsolutePathSchema, IdSchema, SetupPromptSchema, enumOf, parseSchema, text } from '@felan-ai/session-protocol';

const input = Type.Union([
  Type.Object({ kind: Type.Literal('start'), agentDir: AbsolutePathSchema, provider: IdSchema, method: enumOf(['oauth', 'api_key'] as const) }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('answer'), promptId: IdSchema, text: text(64 * 1024) }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('cancel') }, { additionalProperties: false }),
], { 'x-maxEncodedBytes': 96 * 1024 });
const output = Type.Union([
  Type.Object({ kind: Type.Literal('prompt'), prompt: SetupPromptSchema }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('dismiss'), promptId: IdSchema }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('info'), message: text(8192) }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('link'), label: text(4096, 1), url: text(4096, 1) }, { additionalProperties: false }),
  Type.Object({ kind: enumOf(['done', 'failed'] as const) }, { additionalProperties: false }),
], { 'x-maxEncodedBytes': 64 * 1024 });
export type AuthWorkerInput = Static<typeof input>;
export type AuthWorkerOutput = Static<typeof output>;
export const parseAuthWorkerInput = (value: unknown): AuthWorkerInput => parseSchema(input, value);
export const parseAuthWorkerOutput = (value: unknown): AuthWorkerOutput => parseSchema(output, value);
