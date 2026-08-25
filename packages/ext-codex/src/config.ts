import { configField, defineExtensionConfig } from '@felan-ai/agent-core';

export type CodexVerbosity = 'low' | 'medium' | 'high';

export interface CodexConfig {
  readonly fast: boolean;
  readonly verbosity: CodexVerbosity;
  readonly forceCachedWebSockets: boolean;
}

export const DEFAULT_CODEX_CONFIG: CodexConfig = {
  fast: false,
  verbosity: 'low',
  forceCachedWebSockets: true,
};

export const CODEX_CONFIG = defineExtensionConfig({
  id: 'codex',
  title: 'Codex tools',
  fields: {
    fast: configField.boolean({ default: false, description: 'Request priority service tier' }),
    verbosity: configField.enum(['low', 'medium', 'high'], { default: 'low', description: 'Codex response verbosity' }),
    forceCachedWebSockets: configField.boolean({ default: true, description: 'Prefer cached WebSocket transport' }),
  },
});

export function validateCodexConfig(value: unknown, source = 'settings.json.extensionConfig.codex'): CodexConfig {
  if (!isRecord(value)) throw new Error(`${source} must contain a JSON object`);
  if (value.fast !== undefined && typeof value.fast !== 'boolean') {
    throw new Error(`${source}.fast must be a boolean`);
  }
  if (value.forceCachedWebSockets !== undefined && typeof value.forceCachedWebSockets !== 'boolean') {
    throw new Error(`${source}.forceCachedWebSockets must be a boolean`);
  }
  if (
    value.verbosity !== undefined
    && value.verbosity !== 'low'
    && value.verbosity !== 'medium'
    && value.verbosity !== 'high'
  ) {
    throw new Error(`${source}.verbosity must be low, medium, or high`);
  }
  return {
    fast: value.fast ?? DEFAULT_CODEX_CONFIG.fast,
    verbosity: value.verbosity ?? DEFAULT_CODEX_CONFIG.verbosity,
    forceCachedWebSockets: value.forceCachedWebSockets
      ?? DEFAULT_CODEX_CONFIG.forceCachedWebSockets,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

