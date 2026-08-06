import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  ExtensionContext,
  FelanExtensionAPI,
  ToolDefinition,
} from '@felan-ai/agent-core';
import { HostAgentRuntime } from '@felan-ai/agent-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import tasksExtension from '../src/index.js';

type Handler = (event: any, context: ExtensionContext) => unknown;

const temporaryPaths: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('@felan-ai/ext-tasks', () => {
  it('registers the canonical tools and concise task capability', async () => {
    const harness = await createHarness();

    expect([...harness.tools.keys()]).toEqual(['TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet']);
    expect(harness.capabilities).toEqual([
      expect.objectContaining({
        id: 'tasks',
        instructions: expect.stringMatching(/dependency-heavy.*claim.*one active task per session/su),
      }),
    ]);
    expect(harness.tools.get('TaskUpdate')!.description).toContain('claims a ready task');
    await harness.shutdown();
  });

  it('creates, claims, completes, lists, and reads tasks through the tool surface', async () => {
    const harness = await createHarness('worker-a');
    const created = await harness.execute('TaskCreate', {
      title: 'Implement feature',
      acceptance_criteria: 'Relevant tests pass',
      priority: 1,
    });
    const taskId = (created.details as any).task.id as string;

    await harness.execute('TaskUpdate', { task_id: taskId, status: 'in_progress' });
    await harness.execute('TaskUpdate', {
      task_id: taskId,
      status: 'completed',
      result: 'Implemented and tests pass',
    });
    const listed = await harness.execute('TaskList', { view: 'completed' });
    const detail = await harness.execute('TaskGet', { task_id: taskId });

    expect(resultText(listed)).toContain(`${taskId} [P1] completed`);
    expect(resultText(detail)).toContain('Acceptance criteria: Relevant tests pass');
    expect(resultText(detail)).toContain('Result: Implemented and tests pass');
    await harness.shutdown();
  });

  it('injects only active task state into the next model call', async () => {
    const harness = await createHarness();
    const noTasks = await harness.emit('before_agent_start', { systemPrompt: 'base' });
    expect(noTasks[0]).toBeUndefined();

    await harness.execute('TaskCreate', { title: 'Plan implementation' });
    const withTasks = await harness.emit('before_agent_start', { systemPrompt: 'base' });
    expect(withTasks[0]).toMatchObject({
      systemPrompt: expect.stringMatching(/base.*# Session Tasks.*Plan implementation/su),
    });
    await harness.shutdown();
  });

  it('installs TUI controls and updates extension status on session start', async () => {
    const harness = await createHarness('main', 'tui');
    await harness.emit('session_start', { reason: 'new' });
    expect([...harness.commands.keys()]).toEqual(['tasks']);
    expect(harness.shortcuts).toHaveLength(1);

    await harness.execute('TaskCreate', { title: 'Visible task' });
    expect(harness.statuses.at(-1)?.[1]).toContain('0/1');
    await harness.shutdown();
    expect(harness.statuses.at(-1)).toEqual(['tasks', undefined]);
  });
});

async function createHarness(
  sessionId = 'main',
  mode: ExtensionContext['mode'] = 'print',
) {
  const root = await mkdtemp(join(tmpdir(), 'felan-tasks-extension-'));
  temporaryPaths.push(root);
  const cwd = join(root, 'workspace');
  const sessionStorageRoot = join(root, 'session');
  const agentStorageRoot = join(root, 'agent');
  await Promise.all([
    mkdir(cwd, { recursive: true }),
    mkdir(sessionStorageRoot, { recursive: true }),
    mkdir(agentStorageRoot, { recursive: true }),
  ]);
  const runtime = new HostAgentRuntime(cwd, { sessionStorageRoot, agentStorageRoot });
  const tools = new Map<string, ToolDefinition<any, any, any>>();
  const handlers = new Map<string, Handler[]>();
  const commands = new Map<string, unknown>();
  const shortcuts: unknown[] = [];
  const capabilities: Array<{ id: string; instructions: string }> = [];
  const statuses: Array<[string, string | undefined]> = [];
  const ui = {
    setStatus: (key: string, value: string | undefined) => statuses.push([key, value]),
    custom: vi.fn(),
    theme: {
      fg: (_color: string, text: string) => text,
      bold: (text: string) => text,
    },
  };
  const ctx = {
    cwd,
    mode,
    hasUI: mode === 'tui',
    ui,
    sessionManager: { getSessionId: () => sessionId },
  } as unknown as ExtensionContext;
  const pi = {
    runtime,
    registerCapability: (capability: { id: string; instructions: string }) => capabilities.push(capability),
    registerTool: (tool: ToolDefinition<any, any, any>) => tools.set(tool.name, tool),
    registerCommand: (name: string, command: unknown) => commands.set(name, command),
    registerShortcut: (shortcut: unknown) => shortcuts.push(shortcut),
    on: (event: string, handler: Handler) => {
      const eventHandlers = handlers.get(event) ?? [];
      eventHandlers.push(handler);
      handlers.set(event, eventHandlers);
    },
  } as unknown as FelanExtensionAPI;
  tasksExtension(pi);

  const emit = async (event: string, value: Record<string, unknown> = {}) => {
    const results = [];
    for (const handler of handlers.get(event) ?? []) {
      results.push(await handler({ type: event, ...value }, ctx));
    }
    return results;
  };
  const execute = async (name: string, params: Record<string, unknown>) => {
    return tools.get(name)!.execute('call', params, undefined, undefined, ctx);
  };
  const shutdown = async () => {
    await emit('session_shutdown', { reason: 'exit' });
  };
  return {
    capabilities,
    commands,
    emit,
    execute,
    handlers,
    shortcuts,
    statuses,
    tools,
    shutdown,
  };
}

function resultText(result: { content: Array<{ type: string; text?: string }> }): string | undefined {
  return result.content.find((entry) => entry.type === 'text')?.text;
}
