import type { ExtensionContext } from '@felan-ai/agent-core';
import type { CodexConfig } from './config.js';
import { supportsCodexResponsesRequest } from './model-policy.js';

export function applyCodexRequestOptions(
  payload: unknown,
  ctx: Pick<ExtensionContext, 'model'>,
  config: CodexConfig,
): unknown | undefined {
  if (!supportsCodexResponsesRequest(ctx.model) || !isRecord(payload)) return undefined;
  const normalizedPayload = normalizeCodexFunctionToolStrictness(payload) ?? payload;
  const text = isRecord(normalizedPayload.text) ? normalizedPayload.text : {};
  return {
    ...normalizedPayload,
    ...(config.fast ? { service_tier: 'priority' } : {}),
    text: { ...text, verbosity: config.verbosity },
  };
}

function normalizeCodexFunctionToolStrictness(
  payload: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (!Array.isArray(payload.tools)) return undefined;
  let changed = false;
  const tools = payload.tools.map((tool) => {
    if (!isRecord(tool) || tool.type !== 'function' || tool.strict !== null) return tool;
    changed = true;
    return { ...tool, strict: false };
  });
  return changed ? { ...payload, tools } : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
