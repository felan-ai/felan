import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  ExtensionContext,
  FelanExtensionAPI,
  ToolDefinition,
  ExtensionUi,
  UiInteractiveElement,
  UiPresentOptions,
} from '@felan-ai/agent-core';
import { createUnavailableExtensionUi, getExtensionConfigDefinition, HostAgentRuntime } from '@felan-ai/agent-core';
import serviceBackedExtension from '../../../../packages/ext-tasks/src/extension.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTasksExtension } from '../../../../packages/ext-tasks/src/extension.js';

type Handler = (event: any, context: ExtensionContext) => unknown;

const temporaryPaths: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('@felan-ai/ext-tasks', () => {
  it('uses common UI without a feature-specific service requirement', async () => {
    expect(serviceBackedExtension.serviceRequirements).toBeUndefined();
    const harness = await createHarness('main', 'print', {}, createUnavailableExtensionUi());
    expect([...harness.tools.keys()]).toEqual(['TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet']);
    await harness.shutdown();
  });

  it('binds portable create and update actions to the current session and shared task store', async () => {
    let current!: UiInteractiveElement;
    let callbacks!: UiPresentOptions;
    const commonUi = createUnavailableExtensionUi();
    const ui: ExtensionUi = { ...commonUi, present: vi.fn<ExtensionUi['present']>(async (element, options) => {
      current = element; callbacks = options!;
      return { update: async value => {
        expect(value.kind).toBe(element.kind); expect(value.id).toBe(element.id); current = value;
      }, close: async () => {} };
    }) };
    const harness = await createHarness('worker-a', 'print', {}, ui);
    const command = harness.commands.get('tasks') as { handler: (args: string, ctx: ExtensionContext) => Promise<void> };
    const work = command.handler('', harness.context);
    await vi.waitFor(() => expect(ui.present).toHaveBeenCalledOnce());
    const act = async (actionId: string, values: Record<string, string> = {}) => {
      await callbacks.onAction!({ elementId: current.id, revision: current.revision, actionId, outcome: actionId === 'close' ? 'cancel' : 'submit', values }, {
        requestId: actionId, signal: new AbortController().signal,
      });
    };
    try {
      await act('create', { title: 'Portable task', acceptanceCriteria: 'Verified behavior' });
      await act('update', { status: 'in_progress' });
      const active = await harness.execute('TaskList', { view: 'active' });
      expect((active.details as any).tasks[0].ownerSessionId).toBe('worker-a');
      await act('update', { status: 'completed', result: 'Verified through tools and UI' });
      const completed = await harness.execute('TaskList', { view: 'completed' });
      expect((completed.details as any).tasks[0]).toMatchObject({ title: 'Portable task', result: 'Verified through tools and UI' });
    } finally { await act('close'); await work; await harness.shutdown(); }
  });

  it('does not declare host display configuration', () => {
    expect(getExtensionConfigDefinition(serviceBackedExtension)).toBeUndefined();
  });

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
    expect(harness.promptOptions.sections.session_tasks).toBeUndefined();

    await harness.execute('TaskCreate', { title: 'Plan implementation' });
    const withTasks = await harness.emit('before_agent_start', { systemPrompt: 'base' });
    expect(withTasks[0]).toBeUndefined();
    expect(harness.promptOptions.sections.session_tasks).toMatch(/# Session Tasks.*Plan implementation/su);
    await harness.shutdown();
  });

  it('installs TUI controls and updates extension status on session start', async () => {
    const harness = await createHarness('main', 'tui');
    await harness.emit('session_start', { reason: 'new' });
    expect([...harness.commands.keys()]).toEqual(['tasks']);
    expect(harness.shortcuts).toHaveLength(1);

    const created = await harness.execute('TaskCreate', { title: 'Visible task' });
    const taskId = (created.details as any).task.id as string;
    expect(harness.statuses.at(-1)).toEqual([
      'tasks',
      'Tasks 1 · 0 · 0',
    ]);

    await harness.execute('TaskUpdate', { task_id: taskId, status: 'in_progress' });
    expect(harness.statuses.at(-1)).toEqual([
      'tasks',
      'Tasks 0 · 1 · 0',
    ]);

    await harness.execute('TaskUpdate', {
      task_id: taskId,
      status: 'completed',
      result: 'Verified',
    });
    expect(harness.statuses.at(-1)).toEqual([
      'tasks',
      'Tasks 0 · 0 · 1',
    ]);
    await harness.shutdown();
    expect(harness.statuses.at(-1)).toEqual(['tasks', undefined]);
  });


  it('keeps commands available without importing a presenter and refuses unavailable UI', async () => {
    const harness = await createHarness('main', 'tui', {});
    await harness.emit('session_start');
    expect([...harness.commands.keys()]).toEqual(['tasks']);
    expect(harness.shortcuts).toHaveLength(1);
    expect(harness.tools.get('TaskCreate')!.renderCall).toBeUndefined();
    const command = harness.commands.get('tasks') as { handler: (args: string, ctx: ExtensionContext) => Promise<void> };
    await expect(command.handler('', harness.context)).rejects.toMatchObject({ name: 'ExtensionUiUnavailableError' });
    await harness.shutdown();
  });


});

async function createHarness(
  sessionId = 'main',
  mode: ExtensionContext['mode'] = 'print',
  config: Readonly<Record<string, unknown>> = {},
  commonUi?: ExtensionUi,
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
  const promptOptions = { sections: {} as Record<string, string> };
  const commands = new Map<string, unknown>();
  const shortcuts: unknown[] = [];
  const capabilities: Array<{ id: string; instructions: string }> = [];
  const statuses: Array<[string, string | undefined]> = [];
  const custom = vi.fn();
  const ui = {
    notify: vi.fn(),
    setStatus: (key: string, value: string | undefined) => statuses.push([key, value]),
    custom,
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
    config,
    services: { get: () => { throw new Error('Unexpected feature service lookup'); } },
    ui: commonUi ?? createUnavailableExtensionUi(),
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
  await (commonUi ? serviceBackedExtension : createTasksExtension())(pi);

  const emit = async (event: string, value: Record<string, unknown> = {}) => {
    const results = [];
    for (const handler of handlers.get(event) ?? []) {
      results.push(await handler({ type: event, systemPromptOptions: promptOptions, ...value }, ctx));
    }
    return results;
  };
  const execute = async (name: string, params: Record<string, unknown>) => {
    return tools.get(name)!.execute('call', params, undefined, undefined, ctx as Parameters<ToolDefinition['execute']>[4]);
  };
  const shutdown = async () => {
    await emit('session_shutdown', { reason: 'exit' });
  };
  return {
    capabilities,
    commands,
    context: ctx,
    custom,
    emit,
    execute,
    handlers,
    shortcuts,
    statuses,
    promptOptions,
    tools,
    shutdown,
  };
}

function resultText(result: { content: Array<{ type: string; text?: string }> }): string | undefined {
  return result.content.find((entry) => entry.type === 'text')?.text;
}
