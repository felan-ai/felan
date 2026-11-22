import type { Api, Model } from '@felan-ai/agent-core';
import type { CodexConfig } from './config.js';
import { supportsCodexResponsesRequest } from './model-policy.js';

export type CodexServiceTier = 'default' | 'priority' | 'ultrafast';

const ULTRAFAST_MODEL_IDS: ReadonlySet<string> = new Set(['gpt-6-astra', 'gpt-6.1-sol', 'gpt-6.2-astra', 'gpt-6.2-sol']);

export function resolveCodexServiceTier(
  model: Model<Api> | undefined,
  config: CodexConfig,
): CodexServiceTier | undefined {
  if (!supportsCodexResponsesRequest(model)) return undefined;
  const priority = config.priority ?? (config.fast ? 'fast' : undefined);
  if (priority === 'normal') return 'default';
  if (priority === 'ultrafast' && ULTRAFAST_MODEL_IDS.has(model!.id)) return 'ultrafast';
  return priority === undefined ? undefined : 'priority';
}
