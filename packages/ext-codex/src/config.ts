import type { AgentRuntime } from '@felan-ai/agent-core';

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

const CONFIG_FIELDS: ReadonlySet<string> = new Set([
  'fast',
  'verbosity',
  'forceCachedWebSockets',
]);

export async function readCodexConfig(
  runtime: AgentRuntime,
  agentDir: string,
): Promise<CodexConfig> {
  if (!runtime.readAgentFile) return DEFAULT_CODEX_CONFIG;
  let content: Uint8Array;
  try {
    content = await runtime.readAgentFile('codex.json');
  } catch (error) {
    if (isMissingFile(error)) return DEFAULT_CODEX_CONFIG;
    throw new Error(`Failed to read ${agentDir}/codex.json: ${errorMessage(error)}`, { cause: error });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(content));
  } catch (error) {
    throw new Error(`Invalid ${agentDir}/codex.json: ${errorMessage(error)}`, { cause: error });
  }
  return validateCodexConfig(parsed, `${agentDir}/codex.json`);
}

export function validateCodexConfig(value: unknown, source = 'codex.json'): CodexConfig {
  if (!isRecord(value)) throw new Error(`${source} must contain a JSON object`);
  for (const field of Object.keys(value)) {
    if (!CONFIG_FIELDS.has(field)) throw new Error(`${source} contains unknown field: ${field}`);
  }
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

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
