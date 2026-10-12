import type { AgentRuntime, ToolDefinition } from '@felan-ai/agent-core';
import { createCodexExecutionTools } from './execution-tools.js';
import { createCodexToolRenderers } from './tui.js';
export { CODEX_TOOL_NAMES, registerPatchResultEvent } from './execution-tools.js';

export function createCodexTools(runtime: AgentRuntime): ToolDefinition<any, any, any>[] {
  const renderers = createCodexToolRenderers();
  return createCodexExecutionTools(runtime).map(tool => ({ ...tool, ...renderers.apply_patch }));
}
