import { isDeepStrictEqual } from 'node:util';
import { Type, type Static } from 'typebox';
import { JsonValueSchema, assertJson, parseSchema, text } from '@felan-ai/session-protocol';
import type { SessionEnvironment } from './session-runtime.js';

const paths = Type.Array(text(4096, 1), { maxItems: 128 });
export const SessionConfigurationSchema = Type.Object({
  version: Type.Literal(1),
  composition: text(128, 1),
  environment: Type.Object({ cwd: text(4096, 1), agentDir: text(4096, 1), sessionDir: text(4096, 1),
    sessionStorageBase: text(4096, 1), agentStorageRoot: text(4096, 1), writableRoots: paths,
    workerRoots: Type.Optional(paths) }, { additionalProperties: false }),
  configuration: JsonValueSchema,
}, { additionalProperties: false });
export type SessionConfiguration = Static<typeof SessionConfigurationSchema>;

export function parseSessionConfiguration(value: unknown): SessionConfiguration {
  assertJson(value, 64 * 1024);
  return parseSchema(SessionConfigurationSchema, value);
}

export function assertSessionConfigurationEnvironment(snapshot: SessionConfiguration, composition: string, environment: SessionEnvironment): void {
  if (snapshot.composition !== composition || !isDeepStrictEqual(snapshot.environment, environment)) {
    throw Object.assign(new Error('Session configuration or provider storage mapping changed; explicit reload is required.'), { code: 'configuration_recovery_required' });
  }
}
