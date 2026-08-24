import type { AgentRuntime, StreamFunction } from '@felan-ai/agent-core';
import {
  createCodexStreamFunctionWrapper,
  DEFAULT_CODEX_CONFIG,
  validateCodexConfig,
  type CodexConfig,
} from '@felan-ai/ext-codex';
import { builtinExtensionPackages } from './extensions.js';

export async function createLocalCodexStreamFunctionWrapper(
  extensionPackages: readonly string[],
  runtime: AgentRuntime,
  agentDir: string,
  config: unknown = DEFAULT_CODEX_CONFIG,
): Promise<((original: StreamFunction) => StreamFunction) | undefined> {
  if (!extensionPackages.includes(builtinExtensionPackages.codex)) return undefined;
  return createCodexStreamFunctionWrapper(validateCodexConfig(config, `${agentDir}/settings.json`));
}
