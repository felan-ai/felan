import type { FelanPlatformService } from '@felan-ai/agent-core';
import type { CreateFelanApiExtensionOptions } from './contracts.js';
import { executeFelanApiRequest, resolveFelanApiConfig } from './request.js';

export type FelanPlatformOptions = Required<Pick<CreateFelanApiExtensionOptions, 'apiKey' | 'baseUrl' | 'docsBaseUrl' | 'fetch'>>
  & Pick<CreateFelanApiExtensionOptions, 'teamSlug' | 'timeoutMs'>;

export function createFelanPlatformService(options: FelanPlatformOptions): FelanPlatformService {
  for (const key of ['apiKey', 'baseUrl', 'docsBaseUrl'] as const) {
    if (typeof options[key] !== 'string' || !options[key].trim()) {
      throw new Error(`Felan Platform service requires an explicit ${key}.`);
    }
  }
  if (typeof options.fetch !== 'function') throw new Error('Felan Platform service requires an explicit fetch.');
  const config = resolveFelanApiConfig(options);
  return {
    ...(options.teamSlug === undefined ? {} : { teamSlug: options.teamSlug }),
    execute: (request, signal) => executeFelanApiRequest(config, request, signal),
  };
}
