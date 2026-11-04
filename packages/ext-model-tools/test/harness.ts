import { MODELS_SERVICE, createExtensionServiceAccess, createFelanServiceRegistry, type AgentRuntime, type ExtensionContext, type FelanExtensionAPI, type ModelsService, type SessionStartEvent, type ToolDefinition } from '@felan-ai/agent-core';
import { vi } from 'vitest';
import modelToolsExtension from '../src/extension.js';

type SessionStartHandler = (event: SessionStartEvent, context: ExtensionContext) => void | Promise<void>;

export async function harness(runtime: Partial<AgentRuntime> = {}, models?: ModelsService): Promise<{
  tools: Map<string, ToolDefinition>;
  handlers: Map<'session_start', SessionStartHandler[]>;
  registerTool(tool: ToolDefinition): void;
  startSession(): Promise<void>;
  execute(name: string, input: unknown, signal?: AbortSignal): ReturnType<ToolDefinition['execute']>;
}> {
  const tools = new Map<string, ToolDefinition>();
  const handlers = new Map<'session_start', SessionStartHandler[]>();
  const registerTool = vi.fn((tool: ToolDefinition) => { tools.set(tool.name, tool); });
  const registry = createFelanServiceRegistry();
  if (models) registry.set(MODELS_SERVICE, models);
  await modelToolsExtension({
    services: createExtensionServiceAccess(registry, modelToolsExtension.serviceRequirements!),
    runtime: runtime as AgentRuntime,
    registerTool,
    on: (event: 'session_start', handler: SessionStartHandler) => {
      const registered = handlers.get(event) ?? [];
      registered.push(handler);
      handlers.set(event, registered);
    },
  } as unknown as FelanExtensionAPI);
  return {
    tools,
    handlers,
    registerTool,
    async startSession() {
      for (const handler of handlers.get('session_start') ?? []) {
        await handler({ type: 'session_start', reason: 'startup' }, {} as ExtensionContext);
      }
    },
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
