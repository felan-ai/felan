import type { Api, Model } from '@felan-ai/agent-core';
import type { CodexConfig } from './config.js';
import { supportsCodexResponsesRequest } from './model-policy.js';

export type CodexServiceTier = 'default' | 'priority' | 'ultrafast';

export function resolveCodexServiceTier(
  model: Model<Api> | undefined,
  config: CodexConfig,
): CodexServiceTier | undefined {
  if (!supportsCodexResponsesRequest(model)) return undefined;
  const priority = config.priority ?? (config.fast ? 'fast' : undefined);
  if (priority === 'normal') return 'default';
  if (priority === 'ultrafast'
    && (model!.id === 'gpt-6-astra' || model!.id === 'gpt-6.1-sol')) {
    return 'ultrafast';
  }
  return priority === undefined ? undefined : 'priority';
}
