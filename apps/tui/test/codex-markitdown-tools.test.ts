import type {
  AgentRuntime,
  Api,
  ExtensionContext,
  FelanExtension,
  FelanExtensionAPI,
  Model,
} from '@felan-ai/agent-core';
import codexExtension from '@felan-ai/ext-codex';
import markitdownExtension, { setActiveMarkitdownEnabled } from '@felan-ai/ext-markitdown';
import { describe, expect, it, vi } from 'vitest';

type Handler = (event: any, ctx: ExtensionContext) => unknown;

describe('Codex and MarkItDown tool composition', () => {
  it.each([
    ['Codex before MarkItDown', [codexExtension, markitdownExtension]],
    ['MarkItDown before Codex', [markitdownExtension, codexExtension]],
  ] as const)('%s keeps exactly one document reader through model and dependency changes', async (_name, extensions) => {
    const harness = createHarness(true);
    for (const extension of extensions) await extension(harness.pi);

    expect(harness.registeredTools).not.toContain('read_document');
    expect(harness.activeTools).toContain('read');

    await harness.emit('session_start', {}, context('openai-codex', 'gpt-5.3-codex'));
    expect(harness.activeTools).not.toContain('read');
    expect(harness.activeTools).toContain('read_document');

    await harness.emit(
      'model_select',
      { model: model('anthropic', 'claude-opus') },
      context('anthropic', 'claude-opus'),
    );
    expect(harness.activeTools).toContain('read');
    expect(harness.activeTools).not.toContain('read_document');

    await harness.emit(
      'model_select',
      { model: model('openai', 'gpt-5.4') },
      context('openai', 'gpt-5.4'),
    );
    expect(harness.activeTools).not.toContain('read');
    expect(harness.activeTools).toContain('read_document');
    expect(harness.registeredTools.filter((name) => name === 'read_document')).toHaveLength(1);

    setActiveMarkitdownEnabled(harness.runtime, false);
    expect(harness.activeTools).not.toContain('read_document');
    setActiveMarkitdownEnabled(harness.runtime, true);
    expect(harness.activeTools).toContain('read_document');
  });

  it('does not register read_document when Codex cannot replace ordinary tools', async () => {
    const harness = createHarness(false);
    await codexExtension(harness.pi);
    await markitdownExtension(harness.pi);

    await harness.emit('session_start', {}, context('openai-codex', 'gpt-5.3-codex'));

    expect(harness.activeTools).toContain('read');
    expect(harness.activeTools).not.toContain('read_document');
    expect(harness.registeredTools).not.toContain('read_document');
  });

  it('does not register read_document when the Codex extension is absent', async () => {
    const harness = createHarness(true);
    await markitdownExtension(harness.pi);

    await harness.emit('session_start', {}, context('anthropic', 'claude-opus'));

    expect(harness.activeTools).toContain('read');
    expect(harness.activeTools).not.toContain('read_document');
    expect(harness.registeredTools).not.toContain('read_document');
  });
});

function createHarness(processSupport: boolean) {
  const handlers = new Map<string, Handler[]>();
  const eventHandlers = new Map<string, Set<(data: unknown) => void>>();
  const activeTools = ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls'];
  const registeredTools: string[] = [];
  const runtime = unusedRuntime(processSupport);
  const pi = {
    runtime,
    agentDir: '/agent',
    config: {},
    registerCapability: vi.fn(),
    registerCommand: vi.fn(),
    registerTool: (tool: { name: string }) => {
      registeredTools.push(tool.name);
      if (!activeTools.includes(tool.name)) activeTools.push(tool.name);
    },
    getActiveTools: () => [...activeTools],
    setActiveTools: (names: string[]) => activeTools.splice(0, activeTools.length, ...names),
    events: {
      emit: (channel: string, data: unknown) => {
        for (const handler of [...eventHandlers.get(channel) ?? []]) handler(data);
      },
      on: (channel: string, handler: (data: unknown) => void) => {
        const channelHandlers = eventHandlers.get(channel) ?? new Set();
        channelHandlers.add(handler);
        eventHandlers.set(channel, channelHandlers);
        return () => channelHandlers.delete(handler);
      },
    },
    on: (name: string, handler: Handler) => {
      const current = handlers.get(name) ?? [];
      current.push(handler);
      handlers.set(name, current);
    },
  } as unknown as FelanExtensionAPI;
  return {
    pi,
    runtime,
    activeTools,
    registeredTools,
    async emit(name: string, event: unknown, ctx: ExtensionContext): Promise<void> {
      for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
    },
  };
}

function context(provider: string, id: string): ExtensionContext {
  return {
    mode: 'print',
    model: model(provider, id),
    isIdle: () => true,
    compact: vi.fn(),
    sessionManager: { getEntry: () => undefined },
  } as unknown as ExtensionContext;
}

function model(provider: string, id: string): Model<Api> {
  return { provider, id, api: 'openai-responses', input: ['text', 'image'] } as Model<Api>;
}

function unusedRuntime(processSupport: boolean): AgentRuntime {
  const unused = async (): Promise<never> => { throw new Error('unused'); };
  return {
    kind: 'host',
    cwd: '/workspace',
    ...(processSupport ? { processes: { startShell: unused } } : {}),
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
