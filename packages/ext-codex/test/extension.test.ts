import type {
  AgentRuntime,
  Api,
  ExtensionContext,
  FelanExtensionAPI,
  Model,
} from '@felan-ai/agent-core';
import { describe, expect, it, vi } from 'vitest';
import codexExtension from '../src/index.js';

type Handler = (event: any, ctx: ExtensionContext) => unknown;

describe('Codex extension activation', () => {
  it('replaces only ordinary coding tools and preserves unrelated tools for eligible models', async () => {
    const harness = createHarness();
    await codexExtension(harness.pi);

    await harness.emit('session_start', {}, context('openai-codex', 'gpt-5.3-codex'));

    expect(harness.activeTools).toEqual([
      'grep', 'find', 'ls', 'ask_user', 'Agent', 'TaskCreate',
      'exec_command', 'write_stdin', 'apply_patch', 'view_image',
    ]);
    expect(harness.registerTool.mock.calls.map(([tool]) => tool.name)).toEqual([
      'exec_command', 'write_stdin', 'apply_patch', 'view_image',
    ]);
  });

  it('restores ordinary tools when switching away and activates on a later GPT selection', async () => {
    const harness = createHarness();
    await codexExtension(harness.pi);
    await harness.emit('session_start', {}, context('openai', 'gpt-5.4'));

    await harness.emit('model_select', { model: model('anthropic', 'claude-opus') }, context('anthropic', 'claude-opus'));
    expect(harness.activeTools).toEqual([
      'grep', 'find', 'ls', 'ask_user', 'Agent', 'TaskCreate',
      'read', 'bash', 'edit', 'write',
    ]);

    await harness.emit('model_select', { model: model('openai', 'gpt-5.4') }, context('openai', 'gpt-5.4'));
    expect(harness.activeTools).toContain('exec_command');
    expect(harness.activeTools).not.toContain('bash');
  });

  it('keeps ordinary tools for non-GPT OpenAI models', async () => {
    const harness = createHarness();
    await codexExtension(harness.pi);
    await harness.emit('session_start', {}, context('openai', 'o3'));

    expect(harness.activeTools).toEqual([
      'read', 'bash', 'edit', 'write', 'grep', 'find', 'ls', 'ask_user', 'Agent', 'TaskCreate',
    ]);
  });

  it('activates view_image only for models with image input', async () => {
    const harness = createHarness();
    await codexExtension(harness.pi);
    await harness.emit('session_start', {}, {
      mode: 'print',
      model: { ...model('openai', 'gpt-5.4'), input: ['text'] },
    } as ExtensionContext);

    expect(harness.activeTools).not.toContain('view_image');
    expect(harness.activeTools).toEqual(expect.arrayContaining([
      'exec_command', 'write_stdin', 'apply_patch',
    ]));
  });

  it('does not register or unregister shared providers', async () => {
    const harness = createHarness();
    await codexExtension(harness.pi);
    expect(harness.registerProvider).not.toHaveBeenCalled();

    await harness.emit('session_shutdown', {}, context('openai', 'gpt-5.4'));

    expect(harness.unregisterProvider).not.toHaveBeenCalled();
  });
});

function createHarness() {
  const handlers = new Map<string, Handler[]>();
  const activeTools = ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls', 'ask_user', 'Agent', 'TaskCreate'];
  const registerTool = vi.fn();
  const registerProvider = vi.fn();
  const unregisterProvider = vi.fn();
  const pi = {
    runtime: unusedRuntime(),
    agentDir: '/agent',
    registerCapability: vi.fn(),
    registerTool,
    registerProvider,
    unregisterProvider,
    getActiveTools: () => [...activeTools],
    setActiveTools: (names: string[]) => activeTools.splice(0, activeTools.length, ...names),
    on: (name: string, handler: Handler) => {
      const list = handlers.get(name) ?? [];
      list.push(handler);
      handlers.set(name, list);
    },
  } as unknown as FelanExtensionAPI;
  return {
    pi,
    activeTools,
    registerTool,
    registerProvider,
    unregisterProvider,
    async emit(name: string, event: unknown, ctx: ExtensionContext) {
      for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
    },
  };
}

function context(provider: string, id: string): ExtensionContext {
  return { mode: 'print', model: model(provider, id) } as ExtensionContext;
}

function model(provider: string, id: string): Model<Api> {
  return { provider, id, api: 'openai-responses', input: ['text', 'image'] } as Model<Api>;
}

function unusedRuntime(): AgentRuntime {
  const unused = async (): Promise<never> => { throw new Error('unused'); };
  return {
    kind: 'host',
    cwd: '/workspace',
    storage: () => ({ root: '/storage', readFile: unused, writeFile: unused, listFiles: unused, mkdir: unused, remove: unused }),
    exec: unused,
    shell: unused,
    readFile: unused,
    writeFile: unused,
    listFiles: unused,
    mkdir: unused,
    remove: unused,
  };
}
