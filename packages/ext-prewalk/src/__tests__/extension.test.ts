import type {
  ExtensionContext,
  FelanExtensionAPI,
} from '@felan-ai/agent-core';
import { describe, expect, it, vi } from 'vitest';
import prewalkExtension from '../index.js';
import {
  CONTINUATION_INSTRUCTION,
  CONTINUATION_MESSAGE_TYPE,
  CONTROL_MESSAGE_PREFIX,
  IMPLEMENTATION_MESSAGE_TYPE,
  PLANNING_MESSAGE_TYPE,
} from '../prompts.js';

type Handler = (event: any, ctx: ExtensionContext) => any;

const plannerModel = { provider: 'openai-codex', id: 'gpt-5.6-sol', name: 'Sol' } as any;
const targetModel = { provider: 'openai-codex', id: 'gpt-5.6-luna', name: 'Luna' } as any;
const alternateTarget = { provider: 'anthropic', id: 'claude-opus', name: 'Opus' } as any;
const externalModel = { provider: 'anthropic', id: 'claude-sonnet', name: 'Sonnet' } as any;
const anthropicPlanner = { provider: 'anthropic', id: 'claude-opus-4-6', name: 'Opus' } as any;
const anthropicTarget = { provider: 'anthropic', id: 'claude-haiku-4-5', name: 'Haiku' } as any;

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
    currentModel?: any;
    scopedModels?: any[];
    authenticated?: boolean;
    idle?: boolean;
    mode?: 'tui' | 'rpc' | 'json' | 'print';
    flags?: Record<string, boolean | string>;
  } = {},
) {
  const handlers = new Map<string, Handler[]>();
  const commands = new Map<string, any>();
  const tools = new Map<string, any>();
  const flags = new Map(Object.entries(options.flags ?? {}));
  const registeredFlags = new Map<string, any>();
  const capabilities: Array<{ id: string; instructions: string }> = [];
  const models = options.models ?? [plannerModel, targetModel, alternateTarget, externalModel];
  let currentModel = Object.hasOwn(options, 'currentModel') ? options.currentModel : plannerModel;
  let thinkingLevel = 'max';
  let authenticated = options.authenticated ?? true;
  let idle = options.idle ?? true;

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
      getAvailable: vi.fn(() => authenticated ? models : []),
      hasConfiguredAuth: vi.fn(() => authenticated),
    },
    scopedModels: (options.scopedModels ?? []).map((model) => ({ model })),
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
  const pi = {
    registerCapability: (capability: { id: string; instructions: string }) => capabilities.push(capability),
    registerTool: vi.fn((tool: any) => tools.set(tool.name, tool)),
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
    getActiveTools: vi.fn(() => options.activeTools ?? ['read', 'TaskCreate', 'TaskUpdate', 'edit', 'write']),
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
    registeredFlags,
    capabilities,
    tools,
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

async function enterPrewalk(harness: ReturnType<typeof createHarness>) {
  return harness.tools.get('enter_prewalk').execute(
    'enter-prewalk',
    {},
    undefined,
    undefined,
    harness.ctx,
  );
}

async function recordTaskGraph(harness: ReturnType<typeof createHarness>, prefix = 'task') {
  await harness.emit('tool_call', {
    type: 'tool_call',
    toolCallId: `${prefix}-create`,
    toolName: 'TaskCreate',
    input: { title: 'Implement the feature', acceptance_criteria: 'Run the relevant tests' },
  });
  await harness.emit('tool_call', {
    type: 'tool_call',
    toolCallId: `${prefix}-claim`,
    toolName: 'TaskUpdate',
    input: { task_id: 'T-ABC123', status: 'in_progress' },
  });
}

function taskGraphResults(prefix = 'task') {
  return [
    toolResult(`${prefix}-create`, 'TaskCreate'),
    toolResult(`${prefix}-claim`, 'TaskUpdate', false, { task: { id: 'T-ABC123', status: 'in_progress' } }),
  ];
}

async function qualifyHandoff(harness: ReturnType<typeof createHarness>) {
  await startPlanning(harness);
  await handoffPlanningRun(harness);
}

async function handoffPlanningRun(harness: ReturnType<typeof createHarness>) {
  await harness.emit('turn_start', { type: 'turn_start', turnIndex: 0, timestamp: Date.now() });
  await recordTaskGraph(harness);
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
      { type: 'toolCall', id: 'task-create', name: 'TaskCreate', arguments: {} },
      { type: 'toolCall', id: 'task-claim', name: 'TaskUpdate', arguments: {} },
      { type: 'toolCall', id: 'mutation', name: 'edit', arguments: {} },
    ]),
    toolResults: [
      ...taskGraphResults(),
      toolResult('mutation', 'edit'),
    ],
  });
}

async function contextMessages(harness: ReturnType<typeof createHarness>, messages: any[]) {
  const result = await harness.emit('context', { type: 'context', messages });
  return result.messages as any[];
}

describe('flags and commands', () => {
  it('registers static Prewalk guidance', () => {
    const harness = createHarness();

    expect(harness.capabilities).toEqual([
      expect.objectContaining({
        id: 'prewalk',
        instructions: expect.stringMatching(/complex repository work.*multi-file changes.*small localized edits.*call enter_prewalk/s),
      }),
    ]);
  });

  it('registers the sequential model-entry tool with no parameters', () => {
    const harness = createHarness();
    const tool = harness.tools.get('enter_prewalk');

    expect([...harness.tools.keys()]).toEqual(['enter_prewalk']);
    expect(tool.executionMode).toBe('sequential');
    expect(tool.parameters).toMatchObject({
      type: 'object',
      properties: {},
      additionalProperties: false,
    });
    expect(tool.description).toContain('complex repository task');
    expect(tool.description).toContain('small localized edits');
  });

  it('registers namespaced Pi flags with defaults', () => {
    const harness = createHarness();

    expect(harness.registeredFlags.get('prewalk-target-model')).toMatchObject({
      type: 'string',
      default: 'low',
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
      'Prewalk armed',
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

  it('handles exact status and exit commands without starting inference', async () => {
    const harness = createHarness();

    await harness.command.handler('status', harness.ctx);
    await harness.command.handler('exit', harness.ctx);

    expect(harness.sendUserMessage).not.toHaveBeenCalled();
    expect(harness.sendMessage).not.toHaveBeenCalled();
    expect(harness.setModel).not.toHaveBeenCalled();
    expect(harness.ui.notify).toHaveBeenCalledWith(
      'Prewalk: idle | target low | restore planner on',
      'info',
    );
  });

  it.each(['off', 'exit', 'cancel'])('accepts /prewalk %s as a local exit alias', async (command) => {
    const harness = createHarness();
    await harness.command.handler('', harness.ctx);

    await harness.command.handler(command, harness.ctx);

    expect(await contextMessages(harness, [])).toEqual([]);
    expect(harness.sendUserMessage).not.toHaveBeenCalled();
    expect(harness.sendMessage).not.toHaveBeenCalled();
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

describe('model entry', () => {
  it('enters the current run while busy and injects planning guidance', async () => {
    const harness = createHarness({ idle: false });

    const result = await enterPrewalk(harness);

    expect(result.isError).not.toBe(true);
    expect(result.details).toEqual({ phase: 'planning', targetModel: 'low' });
    expect((await contextMessages(harness, [])).at(-1)?.customType).toBe(PLANNING_MESSAGE_TYPE);
    expect(harness.setModel).not.toHaveBeenCalled();
    expect(harness.ui.setStatus).toHaveBeenLastCalledWith('prewalk', 'Prewalk planning');
  });

  it('rejects entry without a mutation tool or selected planner model', async () => {
    const withoutMutation = createHarness({ activeTools: ['read', 'grep'] });
    const mutationError = await enterPrewalk(withoutMutation);
    expect(mutationError).toMatchObject({
      isError: true,
      details: { phase: 'idle' },
    });
    expect(mutationError.content[0].text).toContain('requires an active mutation tool');

    const withoutModel = createHarness({ currentModel: undefined });
    const modelError = await enterPrewalk(withoutModel);
    expect(modelError).toMatchObject({
      isError: true,
      details: { phase: 'idle' },
    });
    expect(modelError.content[0].text).toContain('selected planner model');
  });

  it('does not reset an active run on duplicate entry', async () => {
    const harness = createHarness();
    await enterPrewalk(harness);
    harness.setThinking('low');

    const duplicate = await enterPrewalk(harness);
    expect(duplicate).toMatchObject({
      isError: true,
      details: { phase: 'planning' },
    });

    await harness.emit('turn_start', { type: 'turn_start', turnIndex: 1, timestamp: Date.now() });
    await recordTaskGraph(harness, 'duplicate-task');
    await harness.emit('tool_call', {
      type: 'tool_call', toolCallId: 'mutation', toolName: 'edit', input: {},
    });
    await harness.emit('turn_end', {
      type: 'turn_end',
      turnIndex: 1,
      message: assistant('toolUse'),
      toolResults: [...taskGraphResults('duplicate-task'), toolResult('mutation', 'edit')],
    });
    await harness.emit('agent_settled', { type: 'agent_settled' });

    expect(harness.setThinkingLevel).toHaveBeenLastCalledWith('max');
  });

  it('requires a later model turn before the first mutation can hand off', async () => {
    const harness = createHarness();
    await harness.emit('turn_start', { type: 'turn_start', turnIndex: 0, timestamp: Date.now() });
    const entryResult = await enterPrewalk(harness);
    await harness.emit('tool_call', {
      type: 'tool_call', toolCallId: 'same-turn-mutation', toolName: 'edit', input: {},
    });
    await harness.emit('turn_end', {
      type: 'turn_end',
      turnIndex: 0,
      message: assistant('toolUse'),
      toolResults: [
        toolResult('enter-prewalk', 'enter_prewalk', false, entryResult.details),
        toolResult('same-turn-mutation', 'edit'),
      ],
    });
    expect(harness.setModel).not.toHaveBeenCalled();

    await harness.emit('turn_start', { type: 'turn_start', turnIndex: 1, timestamp: Date.now() });
    await recordTaskGraph(harness, 'planned-task');
    await harness.emit('tool_call', {
      type: 'tool_call', toolCallId: 'planned-mutation', toolName: 'edit', input: {},
    });
    await harness.emit('turn_end', {
      type: 'turn_end',
      turnIndex: 1,
      message: assistant('toolUse'),
      toolResults: [...taskGraphResults('planned-task'), toolResult('planned-mutation', 'edit')],
    });

    expect(harness.setModel).toHaveBeenCalledWith(targetModel);
  });

  it('scrubs successful entry control messages but preserves failed calls', async () => {
    const harness = createHarness();
    await enterPrewalk(harness);
    const successfulHistory = [
      { role: 'user', content: 'Implement this', timestamp: 1 },
      assistant('toolUse', [
        { type: 'thinking', thinking: 'This task needs Prewalk.' },
        { type: 'toolCall', id: 'enter-prewalk', name: 'enter_prewalk', arguments: {} },
      ]),
      toolResult('enter-prewalk', 'enter_prewalk'),
    ];

    const planning = await contextMessages(harness, successfulHistory);
    expect(planning).toEqual([
      successfulHistory[0],
      expect.objectContaining({ customType: PLANNING_MESSAGE_TYPE }),
    ]);
    await harness.command.handler('exit', harness.ctx);
    expect(await contextMessages(harness, successfulHistory)).toEqual([successfulHistory[0]]);

    const failedHarness = createHarness({ activeTools: ['read'] });
    await enterPrewalk(failedHarness);
    const failedHistory = [
      assistant('toolUse', [{
        type: 'toolCall', id: 'failed-entry', name: 'enter_prewalk', arguments: {},
      }]),
      toolResult('failed-entry', 'enter_prewalk', true),
    ];
    expect(await contextMessages(failedHarness, failedHistory)).toEqual(failedHistory);
  });

  it('lets the user exit a tool-entered planning run', async () => {
    const harness = createHarness({ idle: false });
    await enterPrewalk(harness);

    await harness.command.handler('exit', harness.ctx);

    expect(await contextMessages(harness, [])).toEqual([]);
    expect(harness.setModel).not.toHaveBeenCalled();
  });
});

describe('planning handoff and context', () => {
  it('arms with Codex apply_patch without checking Tasks tools', async () => {
    const harness = createHarness({ activeTools: ['read', 'exec_command', 'apply_patch'] });

    await harness.command.handler('Task', harness.ctx);

    expect(harness.sendUserMessage).toHaveBeenCalledWith('Task');
    expect(harness.ui.notify).toHaveBeenCalledWith(
      'Prewalk armed. The next task will plan, initialize Tasks when both task tools are active, make one mutation, then hand off to low.',
      'info',
    );
  });

  it('does not treat shell tools as mutation tools', async () => {
    const harness = createHarness({ activeTools: ['read', 'bash', 'exec_command', 'write_stdin'] });

    await harness.command.handler('Task', harness.ctx);

    expect(harness.sendUserMessage).not.toHaveBeenCalled();
    expect(harness.ui.notify).toHaveBeenCalledWith(
      'Prewalk requires an active mutation tool (edit, write, or apply_patch).',
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

  it('keeps Tasks in the guidance and hands off after a successful mutation', async () => {
    const harness = createHarness();
    await startPlanning(harness);

    const planning = await contextMessages(harness, []);
    expect(planning.at(-1)?.content).toContain('Use TaskCreate');
    expect(planning.at(-1)?.content).toContain('Use TaskUpdate');

    await harness.emit('turn_start', { type: 'turn_start', turnIndex: 0, timestamp: Date.now() });
    await recordTaskGraph(harness);
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
      toolResults: [...taskGraphResults(), toolResult('mutation', 'edit')],
    });

    expect(harness.setModel).toHaveBeenCalledWith(targetModel);
    expect(harness.ui.setStatus).toHaveBeenLastCalledWith('prewalk', 'Prewalk implementing');
    const implementing = await contextMessages(harness, []);
    expect(implementing.at(-1)?.content).toContain('existing session task graph');
    expect(implementing.at(-1)?.content).toContain('verified result');
  });

  it('waits for the task graph before handing off when both task tools are active', async () => {
    const harness = createHarness();
    await startPlanning(harness);

    await harness.emit('turn_start', { type: 'turn_start', turnIndex: 0, timestamp: Date.now() });
    await harness.emit('tool_call', {
      type: 'tool_call', toolCallId: 'early-mutation', toolName: 'edit', input: {},
    });
    await harness.emit('turn_end', {
      type: 'turn_end',
      turnIndex: 0,
      message: assistant('toolUse'),
      toolResults: [toolResult('early-mutation', 'edit')],
    });
    expect(harness.setModel).not.toHaveBeenCalled();

    await harness.emit('turn_start', { type: 'turn_start', turnIndex: 1, timestamp: Date.now() });
    await recordTaskGraph(harness, 'gated-task');
    await harness.emit('tool_call', {
      type: 'tool_call', toolCallId: 'ready-mutation', toolName: 'edit', input: {},
    });
    await harness.emit('turn_end', {
      type: 'turn_end',
      turnIndex: 1,
      message: assistant('toolUse'),
      toolResults: [...taskGraphResults('gated-task'), toolResult('ready-mutation', 'edit')],
    });

    expect(harness.setModel).toHaveBeenCalledWith(targetModel);
  });

  it('does not open the task gate after failed task calls', async () => {
    const harness = createHarness();
    await startPlanning(harness);

    await harness.emit('turn_start', { type: 'turn_start', turnIndex: 0, timestamp: Date.now() });
    await harness.emit('tool_call', {
      type: 'tool_call', toolCallId: 'failed-create', toolName: 'TaskCreate', input: { title: 'Feature' },
    });
    await harness.emit('tool_call', {
      type: 'tool_call',
      toolCallId: 'failed-claim',
      toolName: 'TaskUpdate',
      input: { task_id: 'T-ABC123', status: 'in_progress' },
    });
    await harness.emit('tool_call', {
      type: 'tool_call', toolCallId: 'failed-task-mutation', toolName: 'edit', input: {},
    });
    await harness.emit('turn_end', {
      type: 'turn_end',
      turnIndex: 0,
      message: assistant('toolUse'),
      toolResults: [
        toolResult('failed-create', 'TaskCreate', true),
        toolResult('failed-claim', 'TaskUpdate', true),
        toolResult('failed-task-mutation', 'edit'),
      ],
    });

    expect(harness.setModel).not.toHaveBeenCalled();
  });

  it('keeps mutation-only handoff when the task tools are unavailable', async () => {
    const harness = createHarness({ activeTools: ['read', 'edit', 'write'] });
    await startPlanning(harness);

    await harness.emit('turn_start', { type: 'turn_start', turnIndex: 0, timestamp: Date.now() });
    await harness.emit('tool_call', {
      type: 'tool_call', toolCallId: 'mutation-only', toolName: 'edit', input: {},
    });
    await harness.emit('turn_end', {
      type: 'turn_end',
      turnIndex: 0,
      message: assistant('toolUse'),
      toolResults: [toolResult('mutation-only', 'edit')],
    });

    expect(harness.setModel).toHaveBeenCalledWith(targetModel);
  });

  it('preserves unrelated history while replacing only its own phase message', async () => {
    const harness = createHarness();
    await startPlanning(harness);
    const original = [
      { role: 'user', content: 'Task', timestamp: 1 },
      toolResult('old-task', 'TaskUpdate', false, { task: { id: 'T-ABC123' } }),
      { role: 'custom', customType: 'other-extension', content: 'keep', display: false, timestamp: 2 },
      { role: 'custom', customType: `${CONTROL_MESSAGE_PREFIX}stale`, content: 'remove', display: false, timestamp: 3 },
      { role: 'custom', customType: CONTINUATION_MESSAGE_TYPE, content: '', display: false, timestamp: 4 },
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
      expect.objectContaining({ role: 'toolResult', toolName: 'TaskUpdate' }),
    ]));
  });

  it('keeps planning guidance at a stable context prefix as history grows', async () => {
    const harness = createHarness();
    await startPlanning(harness);
    const userMessage = { role: 'user', content: 'Task', timestamp: 1 };

    const first = await contextMessages(harness, [userMessage]);
    expect(first).toEqual([
      userMessage,
      expect.objectContaining({ customType: PLANNING_MESSAGE_TYPE }),
    ]);

    const plannerTurn = assistant('toolUse', [
      { type: 'toolCall', id: 'read-source', name: 'read', arguments: { path: 'src/index.ts' } },
    ]);
    const readResult = toolResult('read-source', 'read');
    const second = await contextMessages(harness, [userMessage, plannerTurn, readResult]);

    expect(second.slice(0, first.length)).toEqual(first);
    expect(second.slice(first.length)).toEqual([plannerTurn, readResult]);
  });

  it('replaces planning controls with stable implementation guidance at handoff', async () => {
    const harness = createHarness();
    await startPlanning(harness);
    const userMessage = { role: 'user', content: 'Task', timestamp: 1 };
    const plannerTurn = assistant();
    const continuationMessage = {
      role: 'custom',
      customType: CONTINUATION_MESSAGE_TYPE,
      content: CONTINUATION_INSTRUCTION,
      display: false,
      timestamp: 2,
    };
    const planningHistory = [userMessage, plannerTurn, continuationMessage];
    const planning = await contextMessages(harness, planningHistory);
    expect(planning.some((message) => message.customType === CONTINUATION_MESSAGE_TYPE)).toBe(true);

    await handoffPlanningRun(harness);
    const firstImplementation = await contextMessages(harness, planningHistory);
    expect(firstImplementation).toEqual([
      userMessage,
      plannerTurn,
      expect.objectContaining({ customType: IMPLEMENTATION_MESSAGE_TYPE }),
    ]);

    const targetTurn = { ...assistant(), model: targetModel.id };
    const secondImplementation = await contextMessages(
      harness,
      [...planningHistory, targetTurn],
    );
    expect(secondImplementation.slice(0, firstImplementation.length)).toEqual(firstImplementation);
    expect(secondImplementation.at(-1)).toEqual(targetTurn);

    await harness.emit('agent_settled', { type: 'agent_settled' });
    expect(await contextMessages(harness, secondImplementation)).toEqual([
      userMessage,
      plannerTurn,
      targetTurn,
    ]);
  });

  it('re-anchors planning guidance when compaction replaces its context prefix', async () => {
    const harness = createHarness();
    await startPlanning(harness);
    await contextMessages(harness, [{ role: 'user', content: 'Task', timestamp: 1 }]);

    const summary = { role: 'compactionSummary', summary: 'Existing work', timestamp: 2 };
    const compacted = await contextMessages(harness, [summary]);
    expect(compacted).toEqual([
      summary,
      expect.objectContaining({ customType: PLANNING_MESSAGE_TYPE }),
    ]);

    const plannerTurn = assistant();
    const next = await contextMessages(harness, [summary, plannerTurn]);
    expect(next.slice(0, compacted.length)).toEqual(compacted);
    expect(next.at(-1)).toEqual(plannerTurn);
  });

  it('queues a hidden continuation once per no-progress stretch', async () => {
    const harness = createHarness();
    await startPlanning(harness);
    const userMessage = { role: 'user', content: 'Task', timestamp: 1 };
    const firstContext = await contextMessages(harness, [userMessage]);
    const stoppedTurn = assistant();

    await harness.emit('turn_start', { type: 'turn_start', turnIndex: 0, timestamp: Date.now() });
    await harness.emit('turn_end', {
      type: 'turn_end',
      turnIndex: 0,
      message: stoppedTurn,
      toolResults: [],
    });
    expect(harness.sendMessage).toHaveBeenCalledWith(
      {
        customType: CONTINUATION_MESSAGE_TYPE,
        content: CONTINUATION_INSTRUCTION,
        display: false,
      },
      { deliverAs: 'followUp' },
    );
    const continuationMessage = {
      role: 'custom',
      ...harness.sendMessage.mock.calls[0]![0],
      timestamp: 2,
    };
    const continuedContext = await contextMessages(
      harness,
      [userMessage, stoppedTurn, continuationMessage],
    );
    expect(continuedContext.slice(0, firstContext.length)).toEqual(firstContext);
    expect(continuedContext.slice(firstContext.length)).toEqual([stoppedTurn, continuationMessage]);

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
  it('prefers the planner provider when resolving the implementation tier', async () => {
    const harness = createHarness({
      currentModel: anthropicPlanner,
      models: [anthropicPlanner, targetModel, anthropicTarget],
    });

    await qualifyHandoff(harness);

    expect(harness.setModel).toHaveBeenCalledWith(anthropicTarget);
  });

  it('resolves tiers only from the current session model scope', async () => {
    const harness = createHarness({
      currentModel: anthropicPlanner,
      models: [anthropicPlanner, targetModel, anthropicTarget],
      scopedModels: [targetModel],
    });

    await qualifyHandoff(harness);

    expect(harness.setModel).toHaveBeenCalledWith(targetModel);
  });

  it('skips a tier handoff when the target is already the planner model', async () => {
    const harness = createHarness({ currentModel: targetModel, models: [targetModel] });

    await qualifyHandoff(harness);

    expect(harness.setModel).not.toHaveBeenCalled();
    expect(harness.ui.notify).toHaveBeenCalledWith(
      `Prewalk target ${targetModel.provider}/${targetModel.id} already matches the planner model; continuing without a model handoff.`,
      'info',
    );
    expect(await contextMessages(harness, [])).toEqual([]);
  });

  it('skips an exact-target handoff when the target is already the planner model', async () => {
    const harness = createHarness({
      currentModel: targetModel,
      flags: { 'prewalk-target-model': `${targetModel.provider}/${targetModel.id}` },
    });

    await qualifyHandoff(harness);

    expect(harness.setModel).not.toHaveBeenCalled();
    expect(harness.ui.notify).toHaveBeenCalledWith(
      `Prewalk target ${targetModel.provider}/${targetModel.id} already matches the planner model; continuing without a model handoff.`,
      'info',
    );
  });

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

  it('defers exit restoration until an active target run settles', async () => {
    const harness = createHarness();
    await qualifyHandoff(harness);
    harness.setIdle(false);

    await harness.command.handler('exit', harness.ctx);
    await harness.command.handler('off', harness.ctx);

    expect(harness.setModel).toHaveBeenCalledTimes(1);
    expect(harness.ui.setStatus).toHaveBeenLastCalledWith(
      'prewalk',
      'Prewalk implementing · exit pending',
    );
    expect(harness.ui.notify).toHaveBeenCalledWith('Prewalk exit is already pending.', 'info');

    harness.setIdle(true);
    await harness.emit('agent_settled', { type: 'agent_settled' });

    expect(harness.setModel).toHaveBeenNthCalledWith(2, plannerModel);
    expect(harness.currentModel).toBe(plannerModel);
  });

  it('deduplicates an exit command while planner restoration is in progress', async () => {
    const harness = createHarness();
    await qualifyHandoff(harness);
    let finishRestoration!: (restored: boolean) => void;
    const pendingRestoration = new Promise<boolean>((resolve) => {
      finishRestoration = resolve;
    });
    harness.setModel.mockImplementationOnce(() => pendingRestoration);

    const settling = harness.emit('agent_settled', { type: 'agent_settled' });
    await vi.waitFor(() => {
      expect(harness.ui.setStatus).toHaveBeenLastCalledWith(
        'prewalk',
        'Prewalk restoring',
      );
    });
    const exit = harness.command.handler('exit', harness.ctx);

    expect(harness.setModel).toHaveBeenCalledTimes(2);
    finishRestoration(true);
    await Promise.all([settling, exit]);

    expect(harness.setModel).toHaveBeenCalledTimes(2);
    expect(harness.setThinkingLevel).toHaveBeenCalledWith('max');
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
  it('cancels when the selected tier has no authenticated model', async () => {
    const harness = createHarness({ models: [plannerModel] });
    await qualifyHandoff(harness);

    expect(harness.setModel).not.toHaveBeenCalled();
    expect(harness.ui.notify).toHaveBeenCalledWith(
      'Prewalk has no authenticated model for the low tier.',
      'error',
    );
    expect(await contextMessages(harness, [])).toEqual([]);
  });

  it('excludes unauthenticated models from tier selection', async () => {
    const harness = createHarness({ authenticated: false });
    await qualifyHandoff(harness);

    expect(harness.setModel).not.toHaveBeenCalled();
    expect(harness.ui.notify).toHaveBeenCalledWith(
      'Prewalk has no authenticated model for the low tier.',
      'error',
    );
  });

  it('retains explicit authentication errors for exact model overrides', async () => {
    const harness = createHarness({
      authenticated: false,
      flags: { 'prewalk-target-model': 'anthropic/claude-opus' },
    });
    await qualifyHandoff(harness);

    expect(harness.setModel).not.toHaveBeenCalled();
    expect(harness.ui.notify).toHaveBeenCalledWith(
      'Prewalk target model is not authenticated: anthropic/claude-opus.',
      'error',
    );
  });

  it('rejects an exact target outside the current session model scope', async () => {
    const harness = createHarness({
      scopedModels: [targetModel],
      flags: { 'prewalk-target-model': 'anthropic/claude-opus' },
    });

    await qualifyHandoff(harness);

    expect(harness.setModel).not.toHaveBeenCalled();
    expect(harness.ui.notify).toHaveBeenCalledWith(
      'Prewalk target model is outside the current session model scope: anthropic/claude-opus.',
      'error',
    );
  });

  it('allows an exact target inside the current session model scope', async () => {
    const harness = createHarness({
      scopedModels: [alternateTarget],
      flags: { 'prewalk-target-model': 'anthropic/claude-opus' },
    });

    await qualifyHandoff(harness);

    expect(harness.setModel).toHaveBeenCalledWith(alternateTarget);
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

  it('reapplies a manual selection that races an in-flight handoff', async () => {
    const harness = createHarness();
    await startPlanning(harness);
    await harness.emit('turn_start', { type: 'turn_start', turnIndex: 0, timestamp: Date.now() });
    await recordTaskGraph(harness, 'raced-task');
    await harness.emit('tool_call', {
      type: 'tool_call', toolCallId: 'mutation', toolName: 'edit', input: {},
    });
    let finishHandoff!: () => void;
    const pendingHandoff = new Promise<void>((resolve) => {
      finishHandoff = resolve;
    });
    harness.setModel.mockImplementationOnce(async (model: any) => {
      await pendingHandoff;
      const previousModel = harness.currentModel;
      harness.setCurrentModel(model);
      await harness.emit('model_select', {
        type: 'model_select', model, previousModel, source: 'set',
      });
      return true;
    });

    const turnEnd = harness.emit('turn_end', {
      type: 'turn_end',
      turnIndex: 0,
      message: assistant('toolUse'),
      toolResults: [...taskGraphResults('raced-task'), toolResult('mutation', 'edit')],
    });
    await vi.waitFor(() => expect(harness.setModel).toHaveBeenCalledWith(targetModel));
    harness.setCurrentModel(externalModel);
    harness.setThinking('medium');
    await harness.emit('model_select', {
      type: 'model_select', model: externalModel, previousModel: plannerModel, source: 'cycle',
    });
    finishHandoff();
    await turnEnd;

    expect(harness.setModel).toHaveBeenNthCalledWith(2, externalModel);
    expect(harness.currentModel).toBe(externalModel);
    expect(harness.thinkingLevel).toBe('medium');
    expect(harness.setThinkingLevel).toHaveBeenLastCalledWith('medium');
    expect(await contextMessages(harness, [])).toEqual([]);
  });

  it('reapplies a manual selection that races planner restoration', async () => {
    const harness = createHarness();
    await qualifyHandoff(harness);
    let finishRestoration!: () => void;
    const pendingRestoration = new Promise<void>((resolve) => {
      finishRestoration = resolve;
    });
    harness.setModel.mockImplementationOnce(async (model: any) => {
      await pendingRestoration;
      const previousModel = harness.currentModel;
      harness.setCurrentModel(model);
      await harness.emit('model_select', {
        type: 'model_select', model, previousModel, source: 'set',
      });
      return true;
    });

    const settling = harness.emit('agent_settled', { type: 'agent_settled' });
    await vi.waitFor(() => expect(harness.setModel).toHaveBeenCalledTimes(2));
    harness.setCurrentModel(externalModel);
    harness.setThinking('low');
    await harness.emit('model_select', {
      type: 'model_select', model: externalModel, previousModel: targetModel, source: 'cycle',
    });
    finishRestoration();
    await settling;

    expect(harness.setModel).toHaveBeenNthCalledWith(3, externalModel);
    expect(harness.currentModel).toBe(externalModel);
    expect(harness.thinkingLevel).toBe('low');
    expect(harness.setThinkingLevel).toHaveBeenLastCalledWith('low');
  });

  it('waits for an in-flight handoff before shutdown restoration', async () => {
    const harness = createHarness();
    await startPlanning(harness);
    await harness.emit('turn_start', { type: 'turn_start', turnIndex: 0, timestamp: Date.now() });
    await recordTaskGraph(harness, 'shutdown-task');
    await harness.emit('tool_call', {
      type: 'tool_call', toolCallId: 'mutation', toolName: 'edit', input: {},
    });
    let finishHandoff!: () => void;
    const pendingHandoff = new Promise<void>((resolve) => {
      finishHandoff = resolve;
    });
    harness.setModel.mockImplementationOnce(async (model: any) => {
      await pendingHandoff;
      const previousModel = harness.currentModel;
      harness.setCurrentModel(model);
      await harness.emit('model_select', {
        type: 'model_select', model, previousModel, source: 'set',
      });
      return true;
    });

    const turnEnd = harness.emit('turn_end', {
      type: 'turn_end',
      turnIndex: 0,
      message: assistant('toolUse'),
      toolResults: [...taskGraphResults('shutdown-task'), toolResult('mutation', 'edit')],
    });
    await vi.waitFor(() => expect(harness.setModel).toHaveBeenCalledWith(targetModel));
    const shutdown = harness.emit('session_shutdown', { type: 'session_shutdown', reason: 'quit' });
    finishHandoff();
    await Promise.all([turnEnd, shutdown]);

    expect(harness.setModel).toHaveBeenNthCalledWith(2, plannerModel);
    expect(harness.currentModel).toBe(plannerModel);
    expect(harness.thinkingLevel).toBe('max');
  });

  it('uses the target model selected by the namespaced flag', async () => {
    const harness = createHarness({ flags: { 'prewalk-target-model': 'anthropic/claude-opus' } });

    await qualifyHandoff(harness);

    expect(harness.setModel).toHaveBeenCalledWith(alternateTarget);
  });
});
