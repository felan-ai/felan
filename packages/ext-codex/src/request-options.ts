import type { ExtensionContext } from '@felan-ai/agent-core';
import type { CodexConfig } from './config.js';
import { supportsCodexResponsesRequest } from './model-policy.js';

export function applyCodexRequestOptions(
  payload: unknown,
  ctx: Pick<ExtensionContext, 'model'>,
  config: CodexConfig,
): unknown | undefined {
  if (!supportsCodexResponsesRequest(ctx.model) || !isRecord(payload)) return undefined;
  const text = isRecord(payload.text) ? payload.text : {};
  return {
    ...payload,
    ...(config.fast ? { service_tier: 'priority' } : {}),
    text: { ...text, verbosity: config.verbosity },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
