import type { AgentRuntime, StreamFunction } from '@felan-ai/agent-core';
import {
  createCodexStreamFunctionWrapper,
  readCodexConfig,
} from '@felan-ai/ext-codex';
import { builtinExtensionPackages } from './extensions.js';

export async function createLocalCodexStreamFunctionWrapper(
  extensionPackages: readonly string[],
  runtime: AgentRuntime,
  agentDir: string,
): Promise<((original: StreamFunction) => StreamFunction) | undefined> {
  if (!extensionPackages.includes(builtinExtensionPackages.codex)) return undefined;
  return createCodexStreamFunctionWrapper(await readCodexConfig(runtime, agentDir));
}
