import { MODELS_SERVICE, createExtensionServiceAccess, createFelanServiceRegistry, type AgentRuntime, type FelanExtensionAPI, type ModelsService, type ToolDefinition } from '@felan-ai/agent-core';
import { vi } from 'vitest';
import modelToolsExtension from '../src/extension.js';

export async function harness(runtime: Partial<AgentRuntime> = {}, models?: ModelsService): Promise<{
  tools: Map<string, ToolDefinition>;
  execute(name: string, input: unknown, signal?: AbortSignal): ReturnType<ToolDefinition['execute']>;
}> {
  const tools = new Map<string, ToolDefinition>();
  const registry = createFelanServiceRegistry();
  if (models) registry.set(MODELS_SERVICE, models);
  await modelToolsExtension({
    services: createExtensionServiceAccess(registry, modelToolsExtension.serviceRequirements!),
    runtime: runtime as AgentRuntime,
    registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
  } as unknown as FelanExtensionAPI);
  return {
    tools,
    execute: (name: string, input: unknown, signal?: AbortSignal) => tools.get(name)!.execute('test', input, signal, undefined, {} as never),
  };
}

export function fakeModelsService(overrides: Partial<ModelsService> = {}): ModelsService {
  return {
    getAvailable: vi.fn(async () => { throw new Error('Text model discovery is not used by model tools.'); }),
    completeSimple: vi.fn(async () => { throw new Error('Text completion is not used by model tools.'); }),
    streamSimple: vi.fn(() => { throw new Error('Text streaming is not used by model tools.'); }),
    getAvailableOfType: vi.fn(async () => []),
    generateImages: vi.fn(async () => { throw new Error('Image generation must be configured explicitly.'); }),
    ...overrides,
  };
}
