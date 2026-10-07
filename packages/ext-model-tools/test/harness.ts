import type { AgentRuntime, FelanExtensionAPI, ToolDefinition } from '@felan-ai/agent-core';
import { createModelToolsExtension, type ModelToolsRuntime } from '../src/index.js';

export async function harness(runtime: Partial<AgentRuntime> = {}, models?: ModelToolsRuntime): Promise<{
  tools: Map<string, ToolDefinition>;
  execute(name: string, input: unknown, signal?: AbortSignal): ReturnType<ToolDefinition['execute']>;
}> {
  const tools = new Map<string, ToolDefinition>();
  await createModelToolsExtension(models)({
    runtime: runtime as AgentRuntime,
    registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
  } as unknown as FelanExtensionAPI);
  return {
    tools,
    execute: (name: string, input: unknown, signal?: AbortSignal) => tools.get(name)!.execute('test', input, signal, undefined, {} as never),
  };
}
