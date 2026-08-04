import type {
  AgentRuntime,
  ExtensionContext,
  FelanExtensionAPI,
  AgentRuntimeKind,
  ExecOptions,
  ExecResult,
} from '@felan-ai/agent-core';
import { describe, expect, it, vi } from 'vitest';
import prewalkExtension from '../index.js';
import {
  CONTINUATION_MESSAGE_TYPE,
  CONTROL_MESSAGE_PREFIX,
  IMPLEMENTATION_MESSAGE_TYPE,
  PLANNING_MESSAGE_TYPE,
} from '../prompts.js';

type Handler = (event: any, ctx: ExtensionContext) => any;

class ProbeRuntime implements AgentRuntime {
  readonly cwd = '/workspace';
  readonly execCalls: Array<{ command: string; args: readonly string[]; options?: ExecOptions }> = [];
  readonly shellCalls: Array<{ command: string; options?: Parameters<AgentRuntime['shell']>[1] }> = [];

  constructor(
    readonly kind: AgentRuntimeKind,
    private readonly execute: () => ExecResult,
  ) {}

  async exec(command: string, args: readonly string[], options?: ExecOptions): Promise<ExecResult> {
    this.execCalls.push(options ? { command, args: [...args], options } : { command, args: [...args] });
    return this.execute();
  }

  async shell(command: string, options?: Parameters<AgentRuntime['shell']>[1]): Promise<ExecResult> {
    this.shellCalls.push(options ? { command, options } : { command });
    return { stdout: '', stderr: '', code: 0, killed: false };
  }

  async readFile(): Promise<Uint8Array> {
    throw new Error('readFile is unavailable in this test runtime');
  }

  async writeFile(): Promise<void> {
    throw new Error('writeFile is unavailable in this test runtime');
  }

  async listFiles(): Promise<string[]> {
    throw new Error('listFiles is unavailable in this test runtime');
  }

  async mkdir(): Promise<void> {
    throw new Error('mkdir is unavailable in this test runtime');
  }

  async remove(): Promise<void> {
    throw new Error('remove is unavailable in this test runtime');
  }
}

const plannerModel = { provider: 'openai-codex', id: 'gpt-5.6-sol', name: 'Sol' } as any;
const targetModel = { provider: 'openai-codex', id: 'gpt-5.6-luna', name: 'Luna' } as any;
const alternateTarget = { provider: 'anthropic', id: 'claude-opus', name: 'Opus' } as any;
const externalModel = { provider: 'anthropic', id: 'claude-sonnet', name: 'Sonnet' } as any;

function validTodos() {
  return Array.from({ length: 5 }, (_, index) => ({
    content: `Task ${index + 1}`,
    activeForm: `Doing task ${index + 1}`,
    status: index === 0 ? 'in_progress' : 'pending',
  }));
}

function assistant(
  stopReason: 'stop' | 'toolUse' | 'error' = 'stop',
  content: any[] = [{ type: 'text', text: 'Plan' }],
) {
  return {
    role: 'assistant',
    content,
    api: 'openai-codex-responses',
    provider: 'openai-codex',
    model: 'gpt-5.6-sol',
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp: Date.now(),
  };
}

function toolResult(toolCallId: string, toolName: string, isError = false, details?: unknown) {
  return {
    role: 'toolResult',
    toolCallId,
    toolName,
    content: [{ type: 'text', text: isError ? 'failed' : 'ok' }],
    details,
    isError,
    timestamp: Date.now(),
  };
}

function createHarness(
  options: {
    activeTools?: string[];
    models?: any[];
    authenticated?: boolean;
    idle?: boolean;
    beads?: boolean;
    mode?: 'tui' | 'rpc' | 'json' | 'print';
    flags?: Record<string, boolean | string>;
    runtimeKind?: AgentRuntimeKind;
    probeThrows?: boolean;
  } = {},
) {
  const handlers = new Map<string, Handler[]>();
  const commands = new Map<string, any>();
  const flags = new Map(Object.entries(options.flags ?? {}));
  const registeredFlags = new Map<string, any>();
  const models = options.models ?? [plannerModel, targetModel, alternateTarget, externalModel];
  let currentModel = plannerModel;
  let thinkingLevel = 'max';
  let authenticated = options.authenticated ?? true;
  let idle = options.idle ?? true;

  const runtime = new ProbeRuntime(options.runtimeKind ?? 'host', () => {
      if (options.probeThrows) throw new Error('bd unavailable');
      return {
        stdout: options.beads ? '{}' : '',
        stderr: '',
        code: options.beads ? 0 : 1,
        killed: false,
      };
  });
  const ui = {
    notify: vi.fn(),
    setStatus: vi.fn(),
  };
  const waitForIdle = vi.fn(async () => undefined);

  const ctx = {
    ui,
    hasUI: options.mode !== 'json' && options.mode !== 'print',
    mode: options.mode ?? 'tui',
    cwd: '/workspace',
    get model() {
      return currentModel;
    },
    modelRegistry: {
      find: vi.fn((provider: string, modelId: string) => (
        models.find((model) => model.provider === provider && model.id === modelId)
      )),
      hasConfiguredAuth: vi.fn(() => authenticated),
    },
    isIdle: vi.fn(() => idle),
    waitForIdle,
  } as unknown as ExtensionContext;

  async function emit(type: string, event: any = { type }) {
    let result: any;
    for (const handler of handlers.get(type) ?? []) {
      const handlerResult = await handler(event, ctx);
      if (handlerResult !== undefined) result = handlerResult;
    }
    return result;
  }

  const setModel = vi.fn(async (model: any) => {
    const previousModel = currentModel;
    currentModel = model;
    await emit('model_select', { type: 'model_select', model, previousModel, source: 'set' });
    return true;
  });
  const setThinkingLevel = vi.fn((level: string) => {
    thinkingLevel = level;
  });
  const sendMessage = vi.fn();
  const sendUserMessage = vi.fn();
  const facadeExec = vi.fn((
    command: string,
    args: string[],
    execOptions?: Parameters<AgentRuntime['exec']>[2],
  ) => runtime.exec(command, args, execOptions));

  const pi = {
    runtime,
    on: vi.fn((event: string, handler: Handler) => {
      const eventHandlers = handlers.get(event) ?? [];
      eventHandlers.push(handler);
      handlers.set(event, eventHandlers);
    }),
    registerCommand: vi.fn((name: string, command: any) => commands.set(name, command)),
    registerFlag: vi.fn((name: string, flagOptions: any) => {
      registeredFlags.set(name, flagOptions);
      if (!flags.has(name) && flagOptions.default !== undefined) flags.set(name, flagOptions.default);
    }),
    getFlag: vi.fn((name: string) => flags.get(name)),
    getActiveTools: vi.fn(() => options.activeTools ?? ['read', 'bash', 'todo_write', 'edit', 'write']),
    exec: facadeExec,
    getThinkingLevel: vi.fn(() => thinkingLevel),
    setThinkingLevel,
    setModel,
    sendMessage,
    sendUserMessage,
  } as unknown as FelanExtensionAPI;

  prewalkExtension(pi);

  return {
    pi,
    ctx,
    ui,
    runtime,
    registeredFlags,
    facadeExec,
    emit,
    command: commands.get('prewalk'),
    setModel,
    setThinkingLevel,
    sendMessage,
    sendUserMessage,
    waitForIdle,
    get currentModel() {
      return currentModel;
    },
    get thinkingLevel() {
      return thinkingLevel;
    },
    setCurrentModel(model: any) {
      currentModel = model;
    },
    setThinking(level: string) {
      thinkingLevel = level;
    },
    setAuthenticated(value: boolean) {
      authenticated = value;
    },
    setIdle(value: boolean) {
      idle = value;
    },
  };
}

async function startPlanning(harness: ReturnType<typeof createHarness>, task = 'Implement the feature') {
  await harness.command.handler(task, harness.ctx);
  await harness.emit('before_agent_start', {
    type: 'before_agent_start',
    prompt: task,
    systemPrompt: 'system',
    systemPromptOptions: {},
  });
}

async function qualifyHandoff(harness: ReturnType<typeof createHarness>) {
  await startPlanning(harness);
  await harness.emit('turn_start', { type: 'turn_start', turnIndex: 0, timestamp: Date.now() });
  await harness.emit('tool_call', {
    type: 'tool_call',
    toolCallId: 'todo',
    toolName: 'todo_write',
    input: { todos: validTodos() },
  });
  await harness.emit('tool_call', {
    type: 'tool_call',
    toolCallId: 'mutation',
    toolName: 'edit',
    input: { path: 'src/index.ts', oldText: 'a', newText: 'b' },
  });
  await harness.emit('turn_end', {
    type: 'turn_end',
    turnIndex: 0,
    message: assistant('toolUse', [
      { type: 'text', text: 'Plan' },
      { type: 'toolCall', id: 'todo', name: 'todo_write', arguments: {} },
      { type: 'toolCall', id: 'mutation', name: 'edit', arguments: {} },
    ]),
    toolResults: [
      toolResult('mutation', 'edit'),
      toolResult('todo', 'todo_write', false, { newTodos: validTodos() }),
    ],
  });
}

async function contextMessages(harness: ReturnType<typeof createHarness>, messages: any[]) {
  const result = await harness.emit('context', { type: 'context', messages });
  return result.messages as any[];
}

describe('flags and commands', () => {
  it('registers namespaced Pi flags with defaults', () => {
    const harness = createHarness();

    expect(harness.registeredFlags.get('prewalk-target-model')).toMatchObject({
      type: 'string',
      default: 'openai-codex/gpt-5.6-luna',
    });
    expect(harness.registeredFlags.get('prewalk-restore-planner')).toMatchObject({
      type: 'boolean',
      default: true,
    });
  });

  it('arms and sends an inline TUI task without changing sessions', async () => {
    const harness = createHarness();

    await harness.command.handler('Implement the parser', harness.ctx);

    expect(harness.sendUserMessage).toHaveBeenCalledWith('Implement the parser');
    expect(harness.setModel).not.toHaveBeenCalled();
    expect(harness.ui.setStatus).toHaveBeenLastCalledWith(
      'prewalk',
      'Prewalk armed → openai-codex/gpt-5.6-luna',
    );
  });

  it.each(['json', 'print'] as const)('keeps %s mode alive for an inline task', async (mode) => {
    const harness = createHarness({ mode });

    await harness.command.handler('Implement the parser', harness.ctx);

    expect(harness.sendUserMessage).not.toHaveBeenCalled();
    expect(harness.sendMessage).toHaveBeenCalledWith(
      {
        customType: 'pi-prewalk-task',
        content: 'Implement the parser',
        display: true,
      },
      { triggerTurn: true },
    );
    expect(harness.waitForIdle).toHaveBeenCalledOnce();
    expect((await contextMessages(harness, [])).at(-1)?.customType).toBe(PLANNING_MESSAGE_TYPE);
  });

  it('arms the next prompt when no task is supplied', async () => {
    const harness = createHarness();

    await harness.command.handler('', harness.ctx);
    expect(harness.sendUserMessage).not.toHaveBeenCalled();

    await harness.emit('before_agent_start', {
      type: 'before_agent_start',
      prompt: 'Next prompt',
      systemPrompt: 'system',
      systemPromptOptions: {},
    });
    expect((await contextMessages(harness, [])).at(-1)?.customType).toBe(PLANNING_MESSAGE_TYPE);
  });

  it('handles exact status and off commands without starting inference', async () => {
    const harness = createHarness();

    await harness.command.handler('status', harness.ctx);
    await harness.command.handler('off', harness.ctx);

    expect(harness.sendUserMessage).not.toHaveBeenCalled();
    expect(harness.sendMessage).not.toHaveBeenCalled();
    expect(harness.setModel).not.toHaveBeenCalled();
    expect(harness.ui.notify).toHaveBeenCalledWith(
      'Prewalk: idle | target openai-codex/gpt-5.6-luna | restore planner on',
      'info',
    );
  });

  it('uses flag overrides and warns once for malformed flag values', async () => {
    const overridden = createHarness({
      flags: {
        'prewalk-target-model': 'anthropic/claude-opus',
        'prewalk-restore-planner': false,
      },
    });
    await overridden.command.handler('status', overridden.ctx);
    expect(overridden.ui.notify).toHaveBeenCalledWith(
      'Prewalk: idle | target anthropic/claude-opus | restore planner off',
      'info',
    );

    const malformed = createHarness({ flags: { 'prewalk-target-model': 'invalid' } });
    await malformed.emit('session_start', { type: 'session_start', reason: 'startup' });
    await malformed.emit('session_start', { type: 'session_start', reason: 'reload' });
    const warnings = malformed.ui.notify.mock.calls.filter(([, type]) => type === 'warning');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]![0]).toContain('Using defaults');
  });
});

describe('runtime routing and host/cloud parity', () => {
  it.each(['host', 'docker', 'daytona'] as const)(
    'probes Beads through %s AgentRuntime exec with literal argv and timeout',
    async (runtimeKind) => {
      const harness = createHarness({ beads: true, runtimeKind });

      await harness.command.handler('', harness.ctx);

      expect(harness.runtime.kind).toBe(runtimeKind);
      expect(harness.facadeExec).toHaveBeenCalledWith(
        'bd',
        ['-C', '/workspace', '--readonly', '--json', 'status', '--no-activity'],
        { timeout: 5_000 },
      );
      expect(harness.runtime.execCalls).toEqual([{
        command: 'bd',
        args: ['-C', '/workspace', '--readonly', '--json', 'status', '--no-activity'],
        options: { timeout: 5_000 },
      }]);
      expect(harness.runtime.shellCalls).toEqual([]);
      expect(harness.ui.notify).toHaveBeenCalledWith(expect.stringContaining('armed with Beads'), 'info');
    },
  );

  it('treats runtime probe failures as no Beads workspace', async () => {
    const harness = createHarness({ probeThrows: true, activeTools: ['read', 'edit', 'write'] });

    await harness.command.handler('Task', harness.ctx);

    expect(harness.sendUserMessage).not.toHaveBeenCalled();
    expect(harness.ui.notify).toHaveBeenCalledWith(
      'Prewalk requires the active todo_write tool.',
      'error',
    );
  });
});

describe('planning gate and context', () => {
  it('retains explicit capability refusal when Felan has no todo_write', async () => {
    const harness = createHarness({ activeTools: ['read', 'bash', 'edit', 'write'] });

    await harness.command.handler('Task', harness.ctx);

    expect(harness.sendUserMessage).not.toHaveBeenCalled();
    expect(harness.ui.notify).toHaveBeenCalledWith(
      'Prewalk requires the active todo_write tool.',
      'error',
    );
  });

  it('refuses to arm while the agent is busy', async () => {
    const harness = createHarness({ idle: false });
    await harness.command.handler('Task', harness.ctx);
    expect(harness.sendUserMessage).not.toHaveBeenCalled();
    expect(harness.ui.notify).toHaveBeenCalledWith(
      'Prewalk can only be armed while the agent is idle.',
      'warning',
    );
  });

  it('detects a Beads workspace and hands off after Beads tracking', async () => {
    const harness = createHarness({ beads: true });
    await startPlanning(harness);

    const planning = await contextMessages(harness, []);
    expect(planning.at(-1)?.content).toContain('Use the beads skill and direct bd CLI commands');
    expect(planning.at(-1)?.content).toContain('instead of todo_write');

    await harness.emit('turn_start', { type: 'turn_start', turnIndex: 0, timestamp: Date.now() });
    await harness.emit('tool_call', {
      type: 'tool_call',
      toolCallId: 'beads',
      toolName: 'bash',
      input: { command: "bd create --title 'Implement feature' --type task" },
    });
    await harness.emit('tool_call', {
      type: 'tool_call',
      toolCallId: 'mutation',
      toolName: 'edit',
      input: { path: 'src/index.ts', oldText: 'a', newText: 'b' },
    });
    await harness.emit('turn_end', {
      type: 'turn_end',
      turnIndex: 0,
      message: assistant('toolUse'),
      toolResults: [toolResult('beads', 'bash'), toolResult('mutation', 'edit')],
    });

    expect(harness.setModel).toHaveBeenCalledWith(targetModel);
    const implementing = await contextMessages(harness, []);
    expect(implementing.at(-1)?.content).toContain('close each completed Bead');
    expect(implementing.at(-1)?.content).toContain('instead of todo_write');
  });

  it('blocks invalid planning checklists before todo_write executes', async () => {
    const harness = createHarness();
    await startPlanning(harness);
    await harness.emit('turn_start', { type: 'turn_start', turnIndex: 0, timestamp: Date.now() });

    const blocked = await harness.emit('tool_call', {
      type: 'tool_call',
      toolCallId: 'todo',
      toolName: 'todo_write',
      input: { todos: validTodos().slice(0, 4) },
    });

    expect(blocked).toEqual({
      block: true,
      reason: 'Prewalk requires 5-9 todo items before the first mutation.',
    });
  });

  it('preserves unrelated history while replacing only its own phase message', async () => {
    const harness = createHarness();
    await startPlanning(harness);
    const original = [
      { role: 'user', content: 'Task', timestamp: 1 },
      toolResult('old-todo', 'todo_write', false, { newTodos: validTodos() }),
      { role: 'custom', customType: 'other-extension', content: 'keep', display: false, timestamp: 2 },
      { role: 'custom', customType: `${CONTROL_MESSAGE_PREFIX}stale`, content: 'remove', display: false, timestamp: 3 },
    ];

    const planning = await contextMessages(harness, original);
    expect(planning).toHaveLength(4);
    expect(planning[0]).toEqual(original[0]);
    expect(planning[0]).not.toBe(original[0]);
    expect(planning[1]).toEqual(original[1]);
    expect(planning[2]).toEqual(original[2]);
    expect(planning.at(-1)?.customType).toBe(PLANNING_MESSAGE_TYPE);

    await qualifyHandoff(harness);
    const implementing = await contextMessages(harness, planning);
    const ownMessages = implementing.filter(
      (message) => message.role === 'custom' && message.customType.startsWith(CONTROL_MESSAGE_PREFIX),
    );
    expect(ownMessages).toHaveLength(1);
    expect(ownMessages[0].customType).toBe(IMPLEMENTATION_MESSAGE_TYPE);
    expect(implementing).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'toolResult', toolName: 'todo_write' }),
    ]));
  });

  it('queues a hidden continuation once per no-progress stretch', async () => {
    const harness = createHarness();
    await startPlanning(harness);

    await harness.emit('turn_start', { type: 'turn_start', turnIndex: 0, timestamp: Date.now() });
    await harness.emit('turn_end', {
      type: 'turn_end',
      turnIndex: 0,
      message: assistant(),
      toolResults: [],
    });
    expect(harness.sendMessage).toHaveBeenCalledWith(
      { customType: CONTINUATION_MESSAGE_TYPE, content: '', display: false },
      { deliverAs: 'followUp' },
    );

    await harness.emit('turn_start', { type: 'turn_start', turnIndex: 1, timestamp: Date.now() });
    await harness.emit('turn_end', {
      type: 'turn_end',
      turnIndex: 1,
      message: assistant(),
      toolResults: [],
    });
    expect(harness.sendMessage).toHaveBeenCalledTimes(1);

    await harness.emit('turn_start', { type: 'turn_start', turnIndex: 2, timestamp: Date.now() });
    await harness.emit('tool_call', {
      type: 'tool_call', toolCallId: 'read', toolName: 'read', input: { path: 'x' },
    });
    await harness.emit('turn_end', {
      type: 'turn_end',
      turnIndex: 2,
      message: assistant('toolUse'),
      toolResults: [toolResult('read', 'read')],
    });
    await harness.emit('turn_start', { type: 'turn_start', turnIndex: 3, timestamp: Date.now() });
    await harness.emit('turn_end', {
      type: 'turn_end',
      turnIndex: 3,
      message: assistant(),
      toolResults: [],
    });
    expect(harness.sendMessage).toHaveBeenCalledTimes(2);
  });

  it('does not continue provider errors', async () => {
    const harness = createHarness();
    await startPlanning(harness);
    await harness.emit('turn_start', { type: 'turn_start', turnIndex: 0, timestamp: Date.now() });
    await harness.emit('turn_end', {
      type: 'turn_end', turnIndex: 0, message: assistant('error', []), toolResults: [],
    });

    expect(harness.sendMessage).not.toHaveBeenCalled();
  });
});

describe('model handoff and restoration', () => {
  it('switches once at turn_end and restores model before thinking at agent_settled', async () => {
    const harness = createHarness();

    await qualifyHandoff(harness);
    expect(harness.setModel).toHaveBeenCalledTimes(1);
    expect(harness.setModel).toHaveBeenNthCalledWith(1, targetModel);
    expect(harness.currentModel).toBe(targetModel);
    expect((await contextMessages(harness, [])).at(-1)?.customType).toBe(IMPLEMENTATION_MESSAGE_TYPE);

    harness.setThinking('low');
    await harness.emit('agent_settled', { type: 'agent_settled' });

    expect(harness.setModel).toHaveBeenNthCalledWith(2, plannerModel);
    expect(harness.setThinkingLevel).toHaveBeenCalledWith('max');
    expect(harness.setModel.mock.invocationCallOrder[1]).toBeLessThan(
      harness.setThinkingLevel.mock.invocationCallOrder[0]!,
    );
    expect(harness.currentModel).toBe(plannerModel);
    expect(harness.thinkingLevel).toBe('max');
    expect(await contextMessages(harness, [])).toEqual([]);
  });

  it('restores the planner when turned off after handoff', async () => {
    const harness = createHarness();
    await qualifyHandoff(harness);

    await harness.command.handler('off', harness.ctx);

    expect(harness.setModel).toHaveBeenNthCalledWith(2, plannerModel);
    expect(harness.currentModel).toBe(plannerModel);
  });

  it('uses session_shutdown as a restoration backstop', async () => {
    const harness = createHarness();
    await qualifyHandoff(harness);
    harness.setThinking('low');

    await harness.emit('session_shutdown', { type: 'session_shutdown', reason: 'reload' });

    expect(harness.currentModel).toBe(plannerModel);
    expect(harness.thinkingLevel).toBe('max');
  });

  it('keeps the target when restoration is disabled', async () => {
    const harness = createHarness({ flags: { 'prewalk-restore-planner': false } });
    await qualifyHandoff(harness);

    await harness.emit('agent_settled', { type: 'agent_settled' });

    expect(harness.setModel).toHaveBeenCalledTimes(1);
    expect(harness.currentModel).toBe(targetModel);
    expect(harness.setThinkingLevel).not.toHaveBeenCalled();
  });

  it('clears after one failed restoration without retrying', async () => {
    const harness = createHarness();
    await qualifyHandoff(harness);
    harness.setModel.mockResolvedValueOnce(false);

    await harness.emit('agent_settled', { type: 'agent_settled' });
    await harness.emit('agent_settled', { type: 'agent_settled' });

    expect(harness.setModel).toHaveBeenCalledTimes(2);
    expect(harness.ui.notify).toHaveBeenCalledWith(expect.stringContaining('could not restore'), 'error');
  });
});

describe('model failures and manual control', () => {
  it('cancels when the target model is unavailable', async () => {
    const harness = createHarness({ models: [plannerModel] });
    await qualifyHandoff(harness);

    expect(harness.setModel).not.toHaveBeenCalled();
    expect(harness.ui.notify).toHaveBeenCalledWith(
      'Prewalk target model is unavailable: openai-codex/gpt-5.6-luna.',
      'error',
    );
    expect(await contextMessages(harness, [])).toEqual([]);
  });

  it('cancels when target authentication is unavailable', async () => {
    const harness = createHarness({ authenticated: false });
    await qualifyHandoff(harness);

    expect(harness.setModel).not.toHaveBeenCalled();
    expect(harness.ui.notify).toHaveBeenCalledWith(expect.stringContaining('not authenticated'), 'error');
  });

  it.each([
    ['returns false', (harness: ReturnType<typeof createHarness>) => harness.setModel.mockResolvedValueOnce(false)],
    ['throws', (harness: ReturnType<typeof createHarness>) => (
      harness.setModel.mockRejectedValueOnce(new Error('switch failed'))
    )],
  ])('cancels when setModel %s', async (_label, arrange) => {
    const harness = createHarness();
    arrange(harness);

    await qualifyHandoff(harness);

    expect(await contextMessages(harness, [])).toEqual([]);
    expect(harness.ui.notify).toHaveBeenCalledWith(expect.stringContaining('could not switch'), 'error');
  });

  it('cancels planning on an external model selection and retains that model', async () => {
    const harness = createHarness();
    await startPlanning(harness);
    harness.setCurrentModel(externalModel);

    await harness.emit('model_select', {
      type: 'model_select', model: externalModel, previousModel: plannerModel, source: 'cycle',
    });
    await harness.emit('agent_settled', { type: 'agent_settled' });

    expect(harness.currentModel).toBe(externalModel);
    expect(harness.setModel).not.toHaveBeenCalled();
    expect(await contextMessages(harness, [])).toEqual([]);
  });

  it('does not restore over a manual model selection after handoff', async () => {
    const harness = createHarness();
    await qualifyHandoff(harness);
    harness.setCurrentModel(externalModel);
    await harness.emit('model_select', {
      type: 'model_select', model: externalModel, previousModel: targetModel, source: 'cycle',
    });

    await harness.emit('agent_settled', { type: 'agent_settled' });

    expect(harness.setModel).toHaveBeenCalledTimes(1);
    expect(harness.currentModel).toBe(externalModel);
  });

  it('uses the target model selected by the namespaced flag', async () => {
    const harness = createHarness({ flags: { 'prewalk-target-model': 'anthropic/claude-opus' } });

    await qualifyHandoff(harness);

    expect(harness.setModel).toHaveBeenCalledWith(alternateTarget);
  });
});
