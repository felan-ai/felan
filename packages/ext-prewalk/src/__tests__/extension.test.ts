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
  PLAN_APPROVED_MESSAGE_TYPE,
  PLAN_REVIEW_MESSAGE_TYPE,
  PLANNING_MESSAGE_TYPE,
  COMPLETION_GAP_INSTRUCTION,
  COMPLETION_MESSAGE_TYPE,
  COMPLETION_REVIEW_INSTRUCTION,
  ENTRY_GUIDANCE,
  ENTRY_MESSAGE_TYPE,
  EXPLORATION_DEPTH_GUIDANCE,
  GATED_VERIFICATION_INSTRUCTION,
  PLANNING_INSTRUCTION,
  VERIFICATION_INSTRUCTION,
} from '../prompts.js';

type Handler = (event: any, ctx: ExtensionContext) => any;

const plannerModel = { provider: 'openai-codex', id: 'gpt-5.6-sol', name: 'Sol', reasoning: true } as any;
const targetModel = { provider: 'openai-codex', id: 'gpt-5.6-luna', name: 'Luna', reasoning: true } as any;
const alternateTarget = { provider: 'anthropic', id: 'claude-opus', name: 'Opus', reasoning: true } as any;
const externalModel = { provider: 'anthropic', id: 'claude-sonnet', name: 'Sonnet', reasoning: true } as any;
const anthropicPlanner = { provider: 'anthropic', id: 'claude-opus-4-6', name: 'Opus', reasoning: true } as any;
const anthropicTarget = { provider: 'anthropic', id: 'claude-haiku-4-5', name: 'Haiku', reasoning: true } as any;
const xhighTarget = { provider: 'openai-codex', id: 'gpt-6-astra', name: 'Astra', reasoning: true } as any;
const xaiPlanner = { provider: 'xai', id: 'grok-4.6', name: 'Grok 4.6', reasoning: true } as any;
const xaiFastTarget = { provider: 'xai', id: 'grok-4.1-fast', name: 'Grok 4.1 Fast', reasoning: true } as any;
const vercelGrokTarget = {
  provider: 'vercel-ai-gateway',
  id: 'spacexai/grok-4.20-non-reasoning',
  name: 'Grok 4.20 Non-Reasoning',
  reasoning: true,
} as any;
const nonReasoningTarget = { provider: 'openai-codex', id: 'gpt-5.6-fast', name: 'Fast', reasoning: false } as any;

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

function implementationAssistant(usage: Record<string, unknown>, stopReason: 'stop' | 'toolUse' = 'stop') {
  return {
    ...assistant(stopReason),
    usage: {
      input: 101,
      output: 203,
      cacheRead: 307,
      cacheWrite: 409,
      cacheWrite1h: 11,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      ...usage,
    },
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
    thinkingLevel?: string;
    entryApproved?: boolean;
    planDecision?: 'approve' | 'feedback' | 'cancel' | 'dismiss';
    planFeedback?: string;
    prewalkOptions?: { entryApproval?: string; planReview?: string };
    savings?: { report(measurement: unknown): Promise<void> };
    classifier?: { evaluate: (state: any, questions: any, signal?: AbortSignal) => Promise<any> };
    childSession?: boolean;
    sessionMessages?: any[];
  } = {},
) {
  const handlers = new Map<string, Handler[]>();
  const commands = new Map<string, any>();
  const tools = new Map<string, any>();
  const flags = new Map(Object.entries(options.flags ?? {}));
  const configValues: Record<string, unknown> = {
    targetModel: 'low', targetThinking: 'medium', restorePlanner: true, entryApproval: 'ask', planReview: 'skip',
  };
  for (const [name, value] of flags) {
    if (name === 'prewalk-target-model') configValues.targetModel = value;
    if (name === 'prewalk-target-thinking') configValues.targetThinking = value;
    if (name === 'prewalk-restore-planner') configValues.restorePlanner = value;
    if (name === 'prewalk-entry-approval') configValues.entryApproval = value;
    if (name === 'prewalk-plan-review') configValues.planReview = value;
  }
  if (options.prewalkOptions && 'entryApproval' in options.prewalkOptions) {
    configValues.entryApproval = options.prewalkOptions.entryApproval;
  }
  if (options.prewalkOptions && 'planReview' in options.prewalkOptions) {
    configValues.planReview = options.prewalkOptions.planReview;
  }
  if (flags.has('prewalk-entry-approval')) configValues.entryApproval = flags.get('prewalk-entry-approval');
  if (flags.has('prewalk-plan-review')) configValues.planReview = flags.get('prewalk-plan-review');
  const registeredFlags = new Map([
    ['prewalk-target-model', { type: 'string', default: 'low' }],
    ['prewalk-target-thinking', { type: 'string', default: 'medium' }],
    ['prewalk-restore-planner', { type: 'boolean', default: true }],
    ['prewalk-entry-approval', { type: 'string', default: 'ask' }],
    ['prewalk-plan-review', { type: 'string', default: 'inherit' }],
  ]);
  const capabilities: Array<{ id: string; instructions: string }> = [];
  const models = options.models ?? [plannerModel, targetModel, alternateTarget, externalModel];
  let currentModel = Object.hasOwn(options, 'currentModel') ? options.currentModel : plannerModel;
  let thinkingLevel = options.thinkingLevel ?? 'max';
  let authenticated = options.authenticated ?? true;
  let idle = options.idle ?? true;
  let planDecision = options.planDecision;
  const tui = { terminal: { rows: 40, columns: 80 }, requestRender: vi.fn() };
  const testKeys: Record<string, string> = {
    'tui.select.up': 'up',
    'tui.select.down': 'down',
    'tui.select.pageUp': 'pageUp',
    'tui.select.pageDown': 'pageDown',
    'tui.select.confirm': 'enter',
    'tui.select.cancel': 'escape',
  };
  const keybindings = {
    getKeys: vi.fn((binding: string) => testKeys[binding] ? [testKeys[binding]] : []),
    matches: vi.fn((data: string, binding: string) => {
      const key = keybindings.getKeys(binding)[0];
      const raw: Record<string, string> = {
        up: '\x1b[A',
        down: '\x1b[B',
        pageUp: '\x1b[5~',
        pageDown: '\x1b[6~',
        escape: '\x1b',
      };
      return key !== undefined && (key === data || raw[key] === data || (key === 'enter' && data === '\r'));
    }),
  };

  const ui = {
    notify: vi.fn(),
    setStatus: vi.fn(),
    confirm: vi.fn(async () => options.entryApproved ?? true),
    select: vi.fn(async () => {
      if (options.planDecision === 'feedback') return 'Provide feedback';
      if (options.planDecision === 'cancel') return 'Cancel Prewalk';
      if (options.planDecision === 'dismiss') return undefined;
      return 'Approve plan';
    }),
    custom: vi.fn(async (factory: any) => {
      if ((options.mode ?? 'tui') !== 'tui') return undefined;
      let result: unknown;
      const component = await factory(tui, {
        fg: (_color: string, text: string) => text,
        bg: (_color: string, text: string) => text,
        bold: (text: string) => text,
        italic: (text: string) => text,
        underline: (text: string) => text,
        strikethrough: (text: string) => text,
      }, keybindings, (value: unknown) => { result = value; });
      component.render(80);
      const decision = planDecision;
      if (decision === 'feedback') component.handleInput?.('\x1b[B');
      if (decision === 'cancel') {
        component.handleInput?.('\x1b[B');
        component.handleInput?.('\x1b[B');
      }
      component.handleInput?.(decision === 'dismiss' ? '\x1b' : '\r');
      if (decision === 'feedback') {
        component.handleInput?.(`\x1b[200~${options.planFeedback ?? ''}\x1b[201~`);
        component.handleInput?.('\r');
      }
      return result;
    }),
    input: vi.fn(async () => options.planFeedback),
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
    sessionManager: {
      getSessionId: () => 'root-session',
      getHeader: () => options.childSession ? { parentSession: '/parent.jsonl' } : { id: 'root' },
      buildContextEntries: () => (options.sessionMessages ?? []).map((message, index) => ({
        type: 'message', id: `message-${index}`, parentId: null, timestamp: '', message,
      })),
    },
  } as unknown as ExtensionContext;

  async function emit(type: string, event: any = { type }) {
    let result: any;
    for (const handler of handlers.get(type) ?? []) {
      const handlerResult = await handler(event, ctx);
      if (handlerResult !== undefined) result = handlerResult;
    }
    return result;
  }

  const setModel = vi.fn(async (model: any, _options?: { updateDefault?: boolean }) => {
    const previousModel = currentModel;
    currentModel = model;
    await emit('model_select', { type: 'model_select', model, previousModel, source: 'set' });
    return true;
  });
  const setThinkingLevel = vi.fn((level: string, _options?: { updateDefault?: boolean }) => {
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
    config: configValues,
    getActiveTools: vi.fn(() => options.activeTools ?? ['read', 'TaskCreate', 'TaskUpdate', 'edit', 'write']),
    getThinkingLevel: vi.fn(() => thinkingLevel),
    setThinkingLevel,
    setModel,
    sendMessage,
    sendUserMessage,
    registeredFlags,
    ...(options.savings === undefined ? {} : { savings: options.savings }),
    ...(options.classifier === undefined ? {} : { runtime: { classifier: options.classifier } }),
  } as unknown as FelanExtensionAPI;

  prewalkExtension(pi);

  return {
    pi,
    ctx,
    ui,
    capabilities,
    tools,
    emit,
    command: commands.get('prewalk'),
    setModel,
    setThinkingLevel,
    sendMessage,
    sendUserMessage,
    registeredFlags,
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
    setPlanDecision(value: 'approve' | 'feedback' | 'cancel' | 'dismiss') {
      planDecision = value;
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

async function preparePlanForReview(harness: ReturnType<typeof createHarness>) {
  await harness.emit('turn_start', { type: 'turn_start', turnIndex: 0, timestamp: Date.now() });
  await recordTaskGraph(harness, 'review-task');
  await harness.emit('turn_end', {
    type: 'turn_end',
    turnIndex: 0,
    message: assistant('toolUse'),
    toolResults: taskGraphResults('review-task'),
  });
  await harness.emit('turn_start', { type: 'turn_start', turnIndex: 1, timestamp: Date.now() });
}

async function exitPlanMode(
  harness: ReturnType<typeof createHarness>,
  plan = '1. Update implementation\n2. Verify behavior',
) {
  return harness.tools.get('exit_plan_mode').execute(
    'exit-plan-mode',
    { plan },
    undefined,
    undefined,
    harness.ctx,
  );
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

async function beforeSettle(
  harness: ReturnType<typeof createHarness>,
  messages: any[] = [assistant('stop', [{ type: 'text', text: 'Done' }])],
  outcome: 'completed' | 'error' | 'aborted' = 'completed',
  options: { continue?: boolean; pendingMessages?: any[] } = {},
) {
  return harness.emit('agent_before_settle', {
    type: 'agent_before_settle', outcome, entries: [], continue: options.continue ?? false,
    context: { contextMessages: messages, pendingMessages: options.pendingMessages ?? [] },
  });
}

async function resolveReviewer(harness: ReturnType<typeof createHarness>) {
  await harness.emit('tool_call', {
    type: 'tool_call', toolCallId: 'completed-review', toolName: 'Agent', input: { subagent_type: 'reviewer' },
  });
  await harness.emit('turn_end', {
    type: 'turn_end', turnIndex: 9, message: assistant('toolUse'),
    toolResults: [{ ...toolResult('completed-review', 'Agent'), details: { agentId: 'review-child' } }],
  });
  await harness.emit('message_end', {
    type: 'message_end',
    message: { role: 'custom', customType: 'felan-subagent-completion', details: {
      notice: { agentId: 'review-child', type: 'reviewer', status: 'completed' },
    } },
  });
}

describe('savings reporting', () => {
  it('reports each implementation turn against a two-thirds planner counterfactual', async () => {
    const report = vi.fn(async (_measurement: unknown) => {});
    const harness = createHarness({ savings: { report } });

    await qualifyHandoff(harness);
    await harness.emit('turn_end', {
      type: 'turn_end',
      turnIndex: 1,
      message: implementationAssistant({}),
      toolResults: [],
    });
    await harness.emit('turn_end', {
      type: 'turn_end',
      turnIndex: 2,
      message: implementationAssistant({ input: 2, output: 4, cacheRead: 6, cacheWrite: 8, cacheWrite1h: 0 }),
      toolResults: [],
    });

    expect(report).toHaveBeenCalledTimes(2);
    expect(report).toHaveBeenNthCalledWith(1, {
      category: 'model-routing',
      operation: 'implementation-turn',
      baseline: {
        model: { provider: plannerModel.provider, id: plannerModel.id },
        tokens: { input: 67, output: 135, cacheRead: 205, cacheWrite: 273, cacheWrite1h: 7 },
      },
      actual: {
        model: { provider: targetModel.provider, id: targetModel.id },
        tokens: { input: 101, output: 203, cacheRead: 307, cacheWrite: 409, cacheWrite1h: 11 },
      },
      basis: { kind: 'estimated-baseline', method: 'planner-two-thirds-usage-v1' },
    });
    expect(report).toHaveBeenNthCalledWith(2, expect.objectContaining({
      baseline: expect.objectContaining({ tokens: { input: 1, output: 3, cacheRead: 4, cacheWrite: 5, cacheWrite1h: 0 } }),
      actual: expect.objectContaining({ tokens: { input: 2, output: 4, cacheRead: 6, cacheWrite: 8, cacheWrite1h: 0 } }),
    }));
  });

  it('does not report planning, same-model, or failed implementation usage', async () => {
    const report = vi.fn(async (_measurement: unknown) => {});
    const planning = createHarness({ savings: { report } });
    await startPlanning(planning);
    await planning.emit('turn_end', {
      type: 'turn_end', turnIndex: 0, message: implementationAssistant({}), toolResults: [],
    });
    expect(report).not.toHaveBeenCalled();

    const sameModel = createHarness({
      savings: { report },
      flags: { 'prewalk-target-model': `${plannerModel.provider}/${plannerModel.id}` },
    });
    await qualifyHandoff(sameModel);
    await sameModel.emit('turn_end', {
      type: 'turn_end', turnIndex: 1, message: implementationAssistant({}), toolResults: [],
    });
    expect(report).not.toHaveBeenCalled();

    const failed = createHarness({ savings: { report } });
    await qualifyHandoff(failed);
    await failed.emit('turn_end', {
      type: 'turn_end',
      turnIndex: 1,
      message: implementationAssistant({ input: 10 }, 'stop'),
      toolResults: [],
    });
    await failed.emit('turn_end', {
      type: 'turn_end',
      turnIndex: 2,
      message: { ...implementationAssistant({ input: 10 }), stopReason: 'aborted' },
      toolResults: [],
    });
    expect(report).toHaveBeenCalledTimes(1);
  });
});

describe('flags and commands', () => {
  it('registers static Prewalk guidance', () => {
    const harness = createHarness();

    expect(harness.capabilities).toEqual([
      expect.objectContaining({
        id: 'prewalk',
        instructions: expect.stringMatching(/complex repository work.*multi-file changes.*small localized edits.*call enter_prewalk/s),
      }),
    ]);
    expect(harness.capabilities[0]?.instructions).toContain(
      'Conversation or repository activity from earlier requests does not prevent entry.',
    );
    expect(harness.capabilities[0]?.instructions).toContain(
      'if its complexity becomes clear after read-only exploration, enter before its first mutation.',
    );
  });

  it('registers the sequential model-entry tool with no parameters', () => {
    const harness = createHarness();
    const tool = harness.tools.get('enter_prewalk');

    expect([...harness.tools.keys()]).toEqual(['enter_prewalk', 'exit_plan_mode']);
    expect(tool.executionMode).toBe('sequential');
    expect(tool.parameters).toMatchObject({
      type: 'object',
      properties: {},
      additionalProperties: false,
    });
    expect(tool.description).toContain('complex repository task');
    expect(tool.description).toContain('small localized edits');
    expect(tool.description).toContain(
      'Conversation or repository activity from earlier requests does not prevent entry.',
    );
    expect(tool.description).toContain('enter before its first mutation.');

    const exitPlanModeTool = harness.tools.get('exit_plan_mode');
    expect(exitPlanModeTool.executionMode).toBe('sequential');
    expect(exitPlanModeTool.parameters).toMatchObject({
      type: 'object',
      properties: {
        plan: expect.objectContaining({ type: 'string', minLength: 1, maxLength: 32_000 }),
      },
      required: ['plan'],
      additionalProperties: false,
    });
    expect(exitPlanModeTool.description).toContain('Approval returns to planning');
    expect(exitPlanModeTool.description).toContain('Feedback keeps planning active');
    expect(exitPlanModeTool.description).toContain('cancellation exits Prewalk');
  });

  it('registers namespaced Pi flags with defaults', () => {
    const harness = createHarness();

    expect(harness.registeredFlags.get('prewalk-target-model')).toMatchObject({
      type: 'string',
      default: 'low',
    });
    expect(harness.registeredFlags.get('prewalk-target-thinking')).toMatchObject({
      type: 'string',
      default: 'medium',
    });
    expect(harness.registeredFlags.get('prewalk-restore-planner')).toMatchObject({
      type: 'boolean',
      default: true,
    });
    expect(harness.registeredFlags.get('prewalk-entry-approval')).toMatchObject({
      type: 'string',
      default: 'ask',
    });
    expect(harness.registeredFlags.get('prewalk-plan-review')).toMatchObject({
      type: 'string',
      default: 'inherit',
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
      'Prewalk: idle | target low | target thinking medium | restore planner on | model entry ask | plan review skip (skip)',
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

  it('uses resolved configuration overrides', async () => {
    const overridden = createHarness({
      flags: {
        'prewalk-target-model': 'anthropic/claude-opus',
        'prewalk-target-thinking': 'high',
        'prewalk-restore-planner': false,
        'prewalk-entry-approval': 'allow',
      },
    });
    await overridden.command.handler('status', overridden.ctx);
    expect(overridden.ui.notify).toHaveBeenCalledWith(
      'Prewalk: idle | target anthropic/claude-opus | target thinking high | restore planner off | model entry allow | plan review skip (skip)',
      'info',
    );

  });
});

describe('model entry', () => {
  it('enters the current run while busy and injects planning guidance', async () => {
    const harness = createHarness({ idle: false });

    const result = await enterPrewalk(harness);

    expect(result.isError).not.toBe(true);
    expect(result.details).toEqual({ phase: 'planning', targetModel: 'low', targetThinking: 'medium' });
    expect((await contextMessages(harness, [])).at(-1)?.customType).toBe(PLANNING_MESSAGE_TYPE);
    expect(harness.setModel).not.toHaveBeenCalled();
    expect(harness.ui.setStatus).toHaveBeenLastCalledWith('prewalk', 'Prewalk planning');
    expect(harness.ui.confirm).toHaveBeenCalledOnce();
  });

  it('uses an initialization policy to allow model entry without prompting', async () => {
    const harness = createHarness({
      idle: false,
      prewalkOptions: { entryApproval: 'allow' },
    });

    const result = await enterPrewalk(harness);

    expect(result.isError).not.toBe(true);
    expect(result.details.phase).toBe('planning');
    expect(harness.ui.confirm).not.toHaveBeenCalled();
    expect(harness.pi.config).toMatchObject({ entryApproval: 'allow' });
  });

  it('denies model entry when the user declines approval', async () => {
    const harness = createHarness({ idle: false, entryApproved: false });

    await expect(enterPrewalk(harness)).rejects.toThrow('user declined');
    expect(await contextMessages(harness, [])).toEqual([]);
  });

  it('denies model entry without prompting when configured deny', async () => {
    const harness = createHarness({
      idle: false,
      prewalkOptions: { entryApproval: 'deny' },
    });

    await expect(enterPrewalk(harness)).rejects.toThrow('disabled');
    expect(harness.ui.confirm).not.toHaveBeenCalled();
  });

  it('lets the namespaced flag override the initialization policy', async () => {
    const harness = createHarness({
      idle: false,
      flags: { 'prewalk-entry-approval': 'deny' },
      prewalkOptions: { entryApproval: 'allow' },
    });

    await expect(enterPrewalk(harness)).rejects.toThrow('disabled');
    expect(harness.ui.confirm).not.toHaveBeenCalled();
  });

  it.each(['json', 'print'] as const)('denies ask policy in non-interactive %s mode', async (mode) => {
    const harness = createHarness({ idle: false, mode });

    await expect(enterPrewalk(harness)).rejects.toThrow(`unavailable in ${mode} mode`);
    expect(harness.ui.confirm).not.toHaveBeenCalled();
  });

  it('does not prompt when the user enters Prewalk explicitly', async () => {
    const harness = createHarness({
      entryApproved: false,
      prewalkOptions: { entryApproval: 'deny' },
    });

    await harness.command.handler('Implement the parser', harness.ctx);

    expect(harness.sendUserMessage).toHaveBeenCalledWith('Implement the parser');
    expect(harness.ui.confirm).not.toHaveBeenCalled();
  });

  it('rejects entry without a mutation tool or selected planner model', async () => {
    const withoutMutation = createHarness({ activeTools: ['read', 'grep'] });
    await expect(enterPrewalk(withoutMutation)).rejects.toThrow('requires an active mutation tool');

    const withoutModel = createHarness({ currentModel: undefined });
    await expect(enterPrewalk(withoutModel)).rejects.toThrow('selected planner model');
  });

  it('does not reset an active run on duplicate entry', async () => {
    const harness = createHarness();
    await enterPrewalk(harness);
    harness.setThinking('low');

    await expect(enterPrewalk(harness)).rejects.toThrow('Prewalk is already planning');

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
    await resolveReviewer(harness);
    await harness.emit('agent_settled', { type: 'agent_settled' });

    expect(harness.setThinkingLevel).toHaveBeenLastCalledWith('max', { updateDefault: false });
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

    expect(harness.setModel).toHaveBeenCalledWith(targetModel, { updateDefault: false });
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
    await expect(enterPrewalk(failedHarness)).rejects.toThrow('requires an active mutation tool');
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

describe('plan review', () => {
  it('presents the plan argument for ask plus inherit and hands off after approval and mutation', async () => {
    const harness = createHarness({ prewalkOptions: { planReview: 'inherit' } });
    await startPlanning(harness);

    expect((await contextMessages(harness, [])).at(-1)?.customType).toBe(PLAN_REVIEW_MESSAGE_TYPE);
    await preparePlanForReview(harness);
    const plan = '1. Update implementation\n2. Verify behavior';
    const approval = await exitPlanMode(harness, plan);

    expect(harness.ui.custom).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({
        overlay: true,
        overlayOptions: expect.objectContaining({ width: '100%', maxHeight: '100%' }),
      }),
    );
    expect(harness.ui.setStatus).toHaveBeenCalledWith('prewalk', 'Prewalk reviewing');
    expect(harness.ui.setStatus).toHaveBeenLastCalledWith('prewalk', 'Prewalk planning');
    expect(approval).toMatchObject({ details: { phase: 'planning', decision: 'approved' } });
    const approvedContext = await contextMessages(harness, [
      assistant('toolUse', [{
        type: 'toolCall', id: 'exit-plan-mode', name: 'exit_plan_mode', arguments: { plan },
      }]),
      toolResult('exit-plan-mode', 'exit_plan_mode'),
    ]);
    expect(approvedContext).toHaveLength(3);
    expect(approvedContext[0]).toMatchObject({
      content: [expect.objectContaining({ name: 'exit_plan_mode', arguments: { plan } })],
    });
    expect(approvedContext.at(-1)?.customType).toBe(PLAN_APPROVED_MESSAGE_TYPE);

    await harness.emit('turn_start', { type: 'turn_start', turnIndex: 2, timestamp: Date.now() });
    await harness.emit('tool_call', {
      type: 'tool_call', toolCallId: 'approved-mutation', toolName: 'edit', input: {},
    });
    await harness.emit('turn_end', {
      type: 'turn_end',
      turnIndex: 2,
      message: assistant('toolUse'),
      toolResults: [toolResult('approved-mutation', 'edit')],
    });

    expect(harness.setModel).toHaveBeenCalledWith(targetModel, { updateDefault: false });
  });

  it('keeps ask plus inherit planning active when a conversational plan settles without the tool', async () => {
    const harness = createHarness({ prewalkOptions: { entryApproval: 'ask', planReview: 'inherit' } });
    await startPlanning(harness);
    await preparePlanForReview(harness);
    await harness.emit('turn_end', {
      type: 'turn_end',
      turnIndex: 1,
      message: assistant('stop', [{ type: 'text', text: 'Plan presented outside exit_plan_mode' }]),
      toolResults: [],
    });
    await harness.emit('agent_settled', { type: 'agent_settled' });

    const approval = await exitPlanMode(harness);

    expect(approval).toMatchObject({ details: { phase: 'planning', decision: 'approved' } });
    expect(harness.ui.notify).not.toHaveBeenCalledWith(
      'Prewalk ended before a qualifying first mutation.',
      'warning',
    );
  });

  it('returns user feedback and remains in planning until a revised plan is approved', async () => {
    const harness = createHarness({
      planDecision: 'feedback',
      planFeedback: 'Keep the public API unchanged.\n\nAdd regression tests.',
      prewalkOptions: { planReview: 'ask' },
    });
    await startPlanning(harness);
    await preparePlanForReview(harness);

    const feedback = await exitPlanMode(harness, '1. Change the API');

    expect(harness.ui.input).not.toHaveBeenCalled();
    expect(harness.ui.custom).toHaveBeenCalledTimes(1);
    expect(feedback).toMatchObject({
      details: {
        phase: 'planning',
        decision: 'feedback',
        feedback: 'Keep the public API unchanged.\n\nAdd regression tests.',
      },
    });
    expect(feedback.content[0]?.text).toContain('Keep the public API unchanged.\n\nAdd regression tests.');
    expect((await contextMessages(harness, [])).at(-1)?.customType).toBe(PLAN_REVIEW_MESSAGE_TYPE);

    harness.setPlanDecision('approve');
    const approval = await exitPlanMode(harness, '1. Preserve the API\n2. Update internals');
    expect(approval).toMatchObject({ details: { decision: 'approved' } });
  });

  it('cancels Prewalk without implementation when the user selects cancel', async () => {
    const harness = createHarness({
      planDecision: 'cancel',
      prewalkOptions: { planReview: 'ask' },
    });
    await startPlanning(harness);
    await preparePlanForReview(harness);

    const cancellation = await exitPlanMode(harness);

    expect(cancellation).toMatchObject({
      details: { phase: 'idle', decision: 'cancelled' },
      terminate: true,
    });
    expect(harness.ui.setStatus).toHaveBeenLastCalledWith('prewalk', undefined);
    expect(harness.setModel).not.toHaveBeenCalled();
    expect(await contextMessages(harness, [])).toEqual([]);
  });

  it('dismisses the dialog without approving or exiting Prewalk', async () => {
    const harness = createHarness({
      planDecision: 'dismiss',
      prewalkOptions: { planReview: 'ask' },
    });
    await startPlanning(harness);
    await preparePlanForReview(harness);

    const dismissal = await exitPlanMode(harness);

    expect(dismissal).toMatchObject({
      details: { phase: 'planning', decision: 'dismissed' },
      terminate: true,
    });
    expect((await contextMessages(harness, [])).at(-1)?.customType).toBe(PLAN_REVIEW_MESSAGE_TYPE);
  });

  it('ignores a stale approval after Prewalk exits while the review dialog is open', async () => {
    const harness = createHarness({ prewalkOptions: { planReview: 'ask' } });
    let resolveReview!: (value: undefined) => void;
    harness.ui.custom.mockImplementationOnce(() => new Promise<undefined>((resolve) => {
      resolveReview = resolve;
    }));
    await startPlanning(harness);
    await preparePlanForReview(harness);

    const pendingReview = exitPlanMode(harness);
    await vi.waitFor(() => {
      expect(harness.ui.setStatus).toHaveBeenCalledWith('prewalk', 'Prewalk reviewing');
    });
    await harness.command.handler('exit', harness.ctx);
    resolveReview(undefined);

    const stale = await pendingReview;
    expect(stale).toMatchObject({
      details: { phase: 'idle', decision: 'stale' },
      terminate: true,
    });
    expect(harness.ui.setStatus).toHaveBeenLastCalledWith('prewalk', undefined);
    expect(harness.setModel).not.toHaveBeenCalled();
  });

  it('does not hand off for a mutation before plan approval', async () => {
    const harness = createHarness({ prewalkOptions: { planReview: 'ask' } });
    await startPlanning(harness);
    await harness.emit('turn_start', { type: 'turn_start', turnIndex: 0, timestamp: Date.now() });
    await recordTaskGraph(harness, 'premature-task');
    await harness.emit('tool_call', {
      type: 'tool_call', toolCallId: 'premature-mutation', toolName: 'edit', input: {},
    });
    await harness.emit('turn_end', {
      type: 'turn_end',
      turnIndex: 0,
      message: assistant('toolUse'),
      toolResults: [...taskGraphResults('premature-task'), toolResult('premature-mutation', 'edit')],
    });

    expect(harness.setModel).not.toHaveBeenCalled();
  });

  it('rejects exit_plan_mode outside an active planning run', async () => {
    const harness = createHarness({ prewalkOptions: { planReview: 'ask' } });

    await expect(exitPlanMode(harness)).rejects.toThrow(
      'exit_plan_mode requires an active Prewalk planning run; current phase is idle.',
    );
  });

  it('rejects an empty plan and presenting a plan before the task gate is ready', async () => {
    const harness = createHarness({ prewalkOptions: { planReview: 'ask' } });
    await startPlanning(harness);

    await expect(exitPlanMode(harness, '   ')).rejects.toThrow('requires a non-empty plan');
    await expect(exitPlanMode(harness, 'x'.repeat(32_001))).rejects.toThrow(
      'plan must not exceed 32000 characters',
    );
    await expect(exitPlanMode(harness)).rejects.toThrow(
      'Complete the required TaskCreate and in-progress TaskUpdate calls',
    );
  });

  it('rejects a second plan submission after approval', async () => {
    const harness = createHarness({ prewalkOptions: { planReview: 'ask' } });
    await startPlanning(harness);
    await preparePlanForReview(harness);
    await exitPlanMode(harness);

    await expect(exitPlanMode(harness, 'Another plan')).rejects.toThrow(
      'The Prewalk plan is already approved.',
    );
    expect((await contextMessages(harness, [])).at(-1)?.customType).toBe(PLAN_APPROVED_MESSAGE_TYPE);
  });

  it('skips inherited review when entry approval allows entry', async () => {
    const harness = createHarness({
      prewalkOptions: { entryApproval: 'allow', planReview: 'inherit' },
    });
    await startPlanning(harness);

    expect((await contextMessages(harness, [])).at(-1)?.customType).toBe(PLANNING_MESSAGE_TYPE);
    await expect(exitPlanMode(harness)).rejects.toThrow(
      'Plan review is disabled for the active Prewalk run.',
    );
  });

  it.each(['json', 'print'] as const)('auto-approves ask review with a trace in %s mode', async (mode) => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const harness = createHarness({ mode, prewalkOptions: { planReview: 'ask' } });
    await startPlanning(harness);
    await preparePlanForReview(harness);

    const approval = await exitPlanMode(harness);

    expect(log).toHaveBeenCalledWith(
      `Prewalk auto-approved plan review because interactive input is unavailable in ${mode} mode.`,
    );
    expect(approval).toMatchObject({ details: { phase: 'planning', decision: 'approved' } });
    expect((await contextMessages(harness, [])).at(-1)?.customType).toBe(PLAN_APPROVED_MESSAGE_TYPE);
    log.mockRestore();
  });

  it('keeps RPC plan review on the host select dialog', async () => {
    const harness = createHarness({ mode: 'rpc', prewalkOptions: { planReview: 'ask' } });
    await startPlanning(harness);
    await preparePlanForReview(harness);

    const approval = await exitPlanMode(harness, '# Preserve the API');

    expect(harness.ui.select).toHaveBeenCalledWith(
      'Review Prewalk plan\n\n# Preserve the API',
      ['Approve plan', 'Provide feedback', 'Cancel Prewalk'],
      undefined,
    );
    expect(harness.ui.custom).not.toHaveBeenCalled();
    expect(approval).toMatchObject({ details: { decision: 'approved' } });
  });

  it('keeps RPC feedback on the host input dialog', async () => {
    const harness = createHarness({
      mode: 'rpc',
      planDecision: 'feedback',
      planFeedback: 'Keep the API unchanged.',
      prewalkOptions: { planReview: 'ask' },
    });
    await startPlanning(harness);
    await preparePlanForReview(harness);

    const feedback = await exitPlanMode(harness);

    expect(harness.ui.input).toHaveBeenCalledWith(
      'Feedback on Prewalk plan',
      'Tell the planner what to change...',
      undefined,
    );
    expect(harness.ui.custom).not.toHaveBeenCalled();
    expect(feedback).toMatchObject({
      details: { phase: 'planning', decision: 'feedback', feedback: 'Keep the API unchanged.' },
    });
  });
});

describe('planning handoff and context', () => {
  it('arms with Codex apply_patch without checking Tasks tools', async () => {
    const harness = createHarness({ activeTools: ['read', 'exec_command', 'apply_patch'] });

    await harness.command.handler('Task', harness.ctx);

    expect(harness.sendUserMessage).toHaveBeenCalledWith('Task');
    expect(harness.ui.notify).toHaveBeenCalledWith(
      'Prewalk armed. The next task will plan, initialize Tasks when both task tools are active, make one mutation, then hand off to low at medium thinking.',
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

    expect(harness.setModel).toHaveBeenCalledWith(targetModel, { updateDefault: false });
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

    expect(harness.setModel).toHaveBeenCalledWith(targetModel, { updateDefault: false });
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

    expect(harness.setModel).toHaveBeenCalledWith(targetModel, { updateDefault: false });
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

    await resolveReviewer(harness);
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

    expect(harness.setModel).toHaveBeenCalledWith(anthropicTarget, { updateDefault: false });
  });

  it('resolves an explicitly configured xhigh implementation tier', async () => {
    const harness = createHarness({
      flags: { 'prewalk-target-model': 'xhigh' },
      models: [plannerModel, xhighTarget],
    });

    await qualifyHandoff(harness);

    expect(harness.setModel).toHaveBeenCalledWith(xhighTarget, { updateDefault: false });
  });

  it('does not leave the planner provider for a same-family gateway model', async () => {
    const harness = createHarness({
      currentModel: xaiPlanner,
      models: [xaiPlanner, vercelGrokTarget, targetModel],
    });

    await qualifyHandoff(harness);

    expect(harness.setModel).not.toHaveBeenCalled();
    expect(harness.currentModel).toBe(xaiPlanner);
    expect(harness.setThinkingLevel).toHaveBeenCalledWith('medium', { updateDefault: false });
    expect(harness.ui.notify).toHaveBeenCalledWith(
      `Prewalk handed implementation to ${xaiPlanner.provider}/${xaiPlanner.id} at medium thinking without changing models.`,
      'info',
    );
  });

  it('uses a same-provider target-tier model when one is authenticated', async () => {
    const harness = createHarness({
      currentModel: xaiPlanner,
      models: [xaiPlanner, xaiFastTarget, vercelGrokTarget, targetModel],
    });

    await qualifyHandoff(harness);

    expect(harness.setModel).toHaveBeenCalledWith(xaiFastTarget, { updateDefault: false });
  });

  it('still honors an exact target on another provider', async () => {
    const harness = createHarness({
      currentModel: xaiPlanner,
      models: [xaiPlanner, vercelGrokTarget],
      flags: { 'prewalk-target-model': `${vercelGrokTarget.provider}/${vercelGrokTarget.id}` },
    });

    await qualifyHandoff(harness);

    expect(harness.setModel).toHaveBeenCalledWith(vercelGrokTarget, { updateDefault: false });
  });

  it('resolves tiers only from the current session model scope', async () => {
    const harness = createHarness({
      currentModel: anthropicPlanner,
      models: [anthropicPlanner, targetModel, anthropicTarget],
      scopedModels: [anthropicTarget],
    });

    await qualifyHandoff(harness);

    expect(harness.setModel).toHaveBeenCalledWith(anthropicTarget, { updateDefault: false });
  });

  it('keeps the planner when session scope has no same-provider target-tier model', async () => {
    const harness = createHarness({
      currentModel: anthropicPlanner,
      models: [anthropicPlanner, targetModel, anthropicTarget],
      scopedModels: [targetModel],
    });

    await qualifyHandoff(harness);

    expect(harness.setModel).not.toHaveBeenCalled();
    expect(harness.currentModel).toBe(anthropicPlanner);
    expect(harness.setThinkingLevel).toHaveBeenCalledWith('medium', { updateDefault: false });
  });

  it('skips a tier handoff when the target and thinking level already match the planner', async () => {
    const harness = createHarness({
      currentModel: targetModel,
      models: [targetModel],
      thinkingLevel: 'medium',
    });

    await qualifyHandoff(harness);

    expect(harness.setModel).not.toHaveBeenCalled();
    expect(harness.ui.notify).toHaveBeenCalledWith(
      `Prewalk target ${targetModel.provider}/${targetModel.id} at medium thinking already matches the planner; continuing without a handoff.`,
      'info',
    );
    expect(await contextMessages(harness, [])).toEqual([]);
  });

  it('hands off effort on an exact same-model target when thinking differs', async () => {
    const harness = createHarness({
      currentModel: targetModel,
      flags: { 'prewalk-target-model': `${targetModel.provider}/${targetModel.id}` },
    });

    await qualifyHandoff(harness);

    expect(harness.setModel).not.toHaveBeenCalled();
    expect(harness.setThinkingLevel).toHaveBeenCalledWith('medium', { updateDefault: false });
    expect(harness.ui.notify).toHaveBeenCalledWith(
      `Prewalk handed implementation to ${targetModel.provider}/${targetModel.id} at medium thinking without changing models.`,
      'info',
    );

    harness.setThinking('low');
    await resolveReviewer(harness);
    await harness.emit('agent_settled', { type: 'agent_settled' });
    expect(harness.thinkingLevel).toBe('max');
  });

  it('switches once at turn_end and restores model before thinking at agent_settled', async () => {
    const harness = createHarness();

    await qualifyHandoff(harness);
    expect(harness.setModel).toHaveBeenCalledTimes(1);
    expect(harness.setModel).toHaveBeenNthCalledWith(1, targetModel, { updateDefault: false });
    expect(harness.currentModel).toBe(targetModel);
    expect(harness.setThinkingLevel).toHaveBeenNthCalledWith(1, 'medium', { updateDefault: false });
    expect((await contextMessages(harness, [])).at(-1)?.customType).toBe(IMPLEMENTATION_MESSAGE_TYPE);

    harness.setThinking('low');
    await resolveReviewer(harness);
    await harness.emit('agent_settled', { type: 'agent_settled' });

    expect(harness.setModel).toHaveBeenNthCalledWith(2, plannerModel, { updateDefault: false });
    expect(harness.setThinkingLevel).toHaveBeenNthCalledWith(2, 'max', { updateDefault: false });
    expect(harness.setModel.mock.invocationCallOrder[1]).toBeLessThan(
      harness.setThinkingLevel.mock.invocationCallOrder[1]!,
    );
    expect(harness.currentModel).toBe(plannerModel);
    expect(harness.thinkingLevel).toBe('max');
    expect(await contextMessages(harness, [])).toEqual([]);
  });

  it('restores the planner when turned off after handoff', async () => {
    const harness = createHarness();
    await qualifyHandoff(harness);

    await harness.command.handler('off', harness.ctx);

    expect(harness.setModel).toHaveBeenNthCalledWith(2, plannerModel, { updateDefault: false });
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

    expect(harness.setModel).toHaveBeenNthCalledWith(2, plannerModel, { updateDefault: false });
    expect(harness.currentModel).toBe(plannerModel);
  });

  it('deduplicates an exit command while planner restoration is in progress', async () => {
    const harness = createHarness();
    await qualifyHandoff(harness);
    await resolveReviewer(harness);
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
    expect(harness.setThinkingLevel).toHaveBeenCalledWith('max', { updateDefault: false });
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
    expect(harness.setThinkingLevel).toHaveBeenCalledWith('medium', { updateDefault: false });
  });

  it('clears after one failed restoration without retrying', async () => {
    const harness = createHarness();
    await qualifyHandoff(harness);
    await resolveReviewer(harness);
    harness.setModel.mockResolvedValueOnce(false);

    await harness.emit('agent_settled', { type: 'agent_settled' });
    await harness.emit('agent_settled', { type: 'agent_settled' });

    expect(harness.setModel).toHaveBeenCalledTimes(2);
    expect(harness.ui.notify).toHaveBeenCalledWith(expect.stringContaining('could not restore'), 'error');
  });
});

describe('model failures and manual control', () => {
  it('keeps the planner and reduces thinking when the provider has no target-tier model', async () => {
    const harness = createHarness({ models: [plannerModel] });
    await qualifyHandoff(harness);

    expect(harness.setModel).not.toHaveBeenCalled();
    expect(harness.currentModel).toBe(plannerModel);
    expect(harness.setThinkingLevel).toHaveBeenCalledWith('medium', { updateDefault: false });
    expect(harness.ui.notify).toHaveBeenCalledWith(
      `Prewalk handed implementation to ${plannerModel.provider}/${plannerModel.id} at medium thinking without changing models.`,
      'info',
    );
  });

  it('keeps the planner when other providers are unauthenticated', async () => {
    const harness = createHarness({ authenticated: false });
    await qualifyHandoff(harness);

    expect(harness.setModel).not.toHaveBeenCalled();
    expect(harness.currentModel).toBe(plannerModel);
    expect(harness.setThinkingLevel).toHaveBeenCalledWith('medium', { updateDefault: false });
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

    expect(harness.setModel).toHaveBeenCalledWith(alternateTarget, { updateDefault: false });
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

  it('cancels planning when the user changes thinking level', async () => {
    const harness = createHarness();
    await startPlanning(harness);

    harness.setThinking('low');
    await harness.emit('thinking_level_select', {
      type: 'thinking_level_select',
      level: 'low',
      previousLevel: 'max',
    });

    expect(await contextMessages(harness, [])).toEqual([]);
    expect(harness.ui.notify).toHaveBeenCalledWith(
      'Prewalk cancelled after the thinking level changed to low.',
      'warning',
    );
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

  it('does not restore over a manual thinking selection after handoff', async () => {
    const harness = createHarness();
    await qualifyHandoff(harness);
    harness.setThinking('low');
    await harness.emit('thinking_level_select', {
      type: 'thinking_level_select',
      level: 'low',
      previousLevel: 'medium',
    });

    await harness.emit('agent_settled', { type: 'agent_settled' });

    expect(harness.currentModel).toBe(targetModel);
    expect(harness.thinkingLevel).toBe('low');
    expect(harness.setModel).toHaveBeenCalledTimes(1);
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
    await vi.waitFor(() => expect(harness.setModel).toHaveBeenCalledWith(targetModel, { updateDefault: false }));
    harness.setCurrentModel(externalModel);
    harness.setThinking('medium');
    await harness.emit('model_select', {
      type: 'model_select', model: externalModel, previousModel: plannerModel, source: 'cycle',
    });
    finishHandoff();
    await turnEnd;

    expect(harness.setModel).toHaveBeenNthCalledWith(2, externalModel, { updateDefault: false });
    expect(harness.currentModel).toBe(externalModel);
    expect(harness.thinkingLevel).toBe('medium');
    expect(harness.setThinkingLevel).toHaveBeenLastCalledWith('medium', { updateDefault: false });
    expect(await contextMessages(harness, [])).toEqual([]);
  });

  it('reapplies a manual thinking selection that races an in-flight handoff', async () => {
    const harness = createHarness();
    await startPlanning(harness);
    await harness.emit('turn_start', { type: 'turn_start', turnIndex: 0, timestamp: Date.now() });
    await recordTaskGraph(harness, 'raced-thinking-task');
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
      toolResults: [...taskGraphResults('raced-thinking-task'), toolResult('mutation', 'edit')],
    });
    await vi.waitFor(() => expect(harness.setModel).toHaveBeenCalledWith(targetModel, { updateDefault: false }));
    harness.setThinking('low');
    await harness.emit('thinking_level_select', {
      type: 'thinking_level_select',
      level: 'low',
      previousLevel: 'max',
    });
    finishHandoff();
    await turnEnd;

    expect(harness.currentModel).toBe(targetModel);
    expect(harness.thinkingLevel).toBe('low');
    expect(harness.setThinkingLevel).toHaveBeenLastCalledWith('low', { updateDefault: false });
    expect(await contextMessages(harness, [])).toEqual([]);
  });

  it('ignores Pi thinking clamping emitted during an internal model switch', async () => {
    const harness = createHarness();
    await startPlanning(harness);
    harness.setModel.mockImplementationOnce(async (model: any) => {
      const previousModel = harness.currentModel;
      harness.setCurrentModel(model);
      harness.setThinking('high');
      await harness.emit('thinking_level_select', {
        type: 'thinking_level_select',
        level: 'high',
        previousLevel: 'max',
      });
      await harness.emit('model_select', {
        type: 'model_select', model, previousModel, source: 'set',
      });
      return true;
    });

    await handoffPlanningRun(harness);

    expect(harness.setThinkingLevel).toHaveBeenLastCalledWith('medium', { updateDefault: false });
    expect(harness.ui.notify).not.toHaveBeenCalledWith(
      'Prewalk cancelled after the thinking level changed to high.',
      'warning',
    );
    expect((await contextMessages(harness, [])).at(-1)?.customType).toBe(IMPLEMENTATION_MESSAGE_TYPE);
  });

  it('preserves a manual thinking change after the internal model selection event', async () => {
    const harness = createHarness();
    await startPlanning(harness);
    let finishModelSwitch!: () => void;
    const afterModelSelect = new Promise<void>((resolve) => {
      finishModelSwitch = resolve;
    });
    harness.setModel.mockImplementationOnce(async (model: any) => {
      const previousModel = harness.currentModel;
      harness.setCurrentModel(model);
      harness.setThinking('high');
      await harness.emit('thinking_level_select', {
        type: 'thinking_level_select',
        level: 'high',
        previousLevel: 'max',
      });
      await harness.emit('model_select', {
        type: 'model_select', model, previousModel, source: 'set',
      });
      await afterModelSelect;
      return true;
    });

    const turnEnd = handoffPlanningRun(harness);
    await vi.waitFor(() => expect(harness.currentModel).toBe(targetModel));
    harness.setThinking('low');
    await harness.emit('thinking_level_select', {
      type: 'thinking_level_select',
      level: 'low',
      previousLevel: 'high',
    });
    finishModelSwitch();
    await turnEnd;

    expect(harness.thinkingLevel).toBe('low');
    expect(harness.setThinkingLevel).toHaveBeenLastCalledWith('low', { updateDefault: false });
    expect(await contextMessages(harness, [])).toEqual([]);
  });

  it('preserves a manual thinking change after Pi clamping but before model selection completes', async () => {
    const harness = createHarness();
    await startPlanning(harness);
    harness.setModel.mockImplementationOnce(async (model: any) => {
      const previousModel = harness.currentModel;
      harness.setCurrentModel(model);
      harness.setThinking('high');
      await harness.emit('thinking_level_select', {
        type: 'thinking_level_select',
        level: 'high',
        previousLevel: 'max',
      });
      harness.setThinking('low');
      await harness.emit('thinking_level_select', {
        type: 'thinking_level_select',
        level: 'low',
        previousLevel: 'high',
      });
      await harness.emit('model_select', {
        type: 'model_select', model, previousModel, source: 'set',
      });
      return true;
    });

    await handoffPlanningRun(harness);

    expect(harness.thinkingLevel).toBe('low');
    expect(harness.setThinkingLevel).toHaveBeenLastCalledWith('low', { updateDefault: false });
    expect(await contextMessages(harness, [])).toEqual([]);
  });

  it('preserves a manual thinking change that wins before Pi emits its clamp', async () => {
    const harness = createHarness();
    await startPlanning(harness);
    harness.setModel.mockImplementationOnce(async (model: any) => {
      const previousModel = harness.currentModel;
      harness.setCurrentModel(model);
      harness.setThinking('low');
      await harness.emit('thinking_level_select', {
        type: 'thinking_level_select',
        level: 'low',
        previousLevel: 'max',
      });
      harness.setThinking('high');
      await harness.emit('thinking_level_select', {
        type: 'thinking_level_select',
        level: 'high',
        previousLevel: 'low',
      });
      await harness.emit('model_select', {
        type: 'model_select', model, previousModel, source: 'set',
      });
      return true;
    });

    await handoffPlanningRun(harness);

    expect(harness.thinkingLevel).toBe('low');
    expect(harness.setThinkingLevel).toHaveBeenLastCalledWith('low', { updateDefault: false });
    expect(await contextMessages(harness, [])).toEqual([]);
  });

  it('reapplies a manual selection that races planner restoration', async () => {
    const harness = createHarness();
    await qualifyHandoff(harness);
    await resolveReviewer(harness);
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

    expect(harness.setModel).toHaveBeenNthCalledWith(3, externalModel, { updateDefault: false });
    expect(harness.currentModel).toBe(externalModel);
    expect(harness.thinkingLevel).toBe('low');
    expect(harness.setThinkingLevel).toHaveBeenLastCalledWith('low', { updateDefault: false });
  });

  it('reapplies a manual thinking selection that races planner restoration', async () => {
    const harness = createHarness();
    await qualifyHandoff(harness);
    await resolveReviewer(harness);
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
    harness.setThinking('low');
    await harness.emit('thinking_level_select', {
      type: 'thinking_level_select',
      level: 'low',
      previousLevel: 'medium',
    });
    finishRestoration();
    await settling;

    expect(harness.currentModel).toBe(plannerModel);
    expect(harness.thinkingLevel).toBe('low');
    expect(harness.setThinkingLevel).toHaveBeenLastCalledWith('low', { updateDefault: false });
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
    await vi.waitFor(() => expect(harness.setModel).toHaveBeenCalledWith(targetModel, { updateDefault: false }));
    const shutdown = harness.emit('session_shutdown', { type: 'session_shutdown', reason: 'quit' });
    finishHandoff();
    await Promise.all([turnEnd, shutdown]);

    expect(harness.setModel).toHaveBeenNthCalledWith(2, plannerModel, { updateDefault: false });
    expect(harness.currentModel).toBe(plannerModel);
    expect(harness.thinkingLevel).toBe('max');
  });

  it('uses the target model selected by the namespaced flag', async () => {
    const harness = createHarness({
      flags: {
        'prewalk-target-model': 'anthropic/claude-opus',
        'prewalk-target-thinking': 'high',
      },
    });

    await qualifyHandoff(harness);

    expect(harness.setModel).toHaveBeenCalledWith(alternateTarget, { updateDefault: false });
    expect(harness.setThinkingLevel).toHaveBeenCalledWith('high', { updateDefault: false });
  });

  it('clamps target thinking to off for a non-reasoning implementation model', async () => {
    const harness = createHarness({
      models: [plannerModel, nonReasoningTarget],
      flags: {
        'prewalk-target-model': `${nonReasoningTarget.provider}/${nonReasoningTarget.id}`,
      },
    });

    await qualifyHandoff(harness);

    expect(harness.setModel).toHaveBeenCalledWith(nonReasoningTarget, { updateDefault: false });
    expect(harness.setThinkingLevel).toHaveBeenCalledWith('off', { updateDefault: false });
    expect(harness.thinkingLevel).toBe('off');
  });
});

function scriptedClassifier(choices: Record<string, Record<string, string> | Error>) {
  return {
    evaluate: vi.fn(async (_state: any, questions: Record<string, unknown>) => {
      const key = Object.keys(questions).join(',');
      const scripted = choices[key];
      if (scripted === undefined) throw new Error(`unexpected classifier questions: ${key}`);
      if (scripted instanceof Error) throw scripted;
      return {
        answers: Object.fromEntries(Object.entries(scripted).map(([id, choice]) => [id, { type: 'choice', choice }])),
      };
    }),
  };
}

const entryTools = ['read', 'TaskCreate', 'TaskUpdate', 'edit', 'write', 'enter_prewalk'];

function beforeStartEvent(prompt: string) {
  return {
    type: 'before_agent_start',
    prompt,
    systemPrompt: 'system',
    systemPromptOptions: { sections: {} as Record<string, string> },
  };
}

describe('classifier guidance', () => {
  it('recommends Prewalk entry from an input-started classification', async () => {
    const classifier = scriptedClassifier({ route: { route: 'prewalk' } });
    const harness = createHarness({ classifier, activeTools: entryTools });

    await harness.emit('input', { type: 'input', text: 'Build the billing feature', source: 'interactive' });
    const event = beforeStartEvent('Build the billing feature');
    const result = await harness.emit('before_agent_start', event);

    expect(classifier.evaluate).toHaveBeenCalledTimes(1);
    expect(classifier.evaluate.mock.calls[0]![0]).toMatchObject({ request: 'Build the billing feature' });
    expect(event.systemPromptOptions.sections).toEqual({});
    expect(result).toEqual({ message: { customType: ENTRY_MESSAGE_TYPE, content: ENTRY_GUIDANCE, display: false } });
    const entry = { role: 'custom', ...result.message, timestamp: 2 };
    const messages = await contextMessages(harness, [
      { role: 'custom', customType: ENTRY_MESSAGE_TYPE, content: ENTRY_GUIDANCE, display: false, timestamp: 0 },
      { role: 'user', content: 'Build the billing feature', timestamp: 1 },
      entry,
    ]);
    expect(messages.filter((message) => message.customType === ENTRY_MESSAGE_TYPE)).toEqual([entry]);
    await harness.emit('agent_settled');
    const later = await contextMessages(harness, messages);
    expect(later.some((message) => message.customType === ENTRY_MESSAGE_TYPE)).toBe(false);
    expect(harness.tools.has('enter_prewalk')).toBe(true);
  });

  it('adds no entry guidance for regular requests, denied entry, child sessions, or failures', async () => {
    const regular = createHarness({ classifier: scriptedClassifier({ route: { route: 'regular' } }), activeTools: entryTools });
    const regularEvent = beforeStartEvent('Fix a typo');
    expect(await regular.emit('before_agent_start', regularEvent)).toBeUndefined();
    expect(regularEvent.systemPromptOptions.sections).toEqual({});

    const deniedClassifier = scriptedClassifier({ route: { route: 'prewalk' } });
    const denied = createHarness({ classifier: deniedClassifier, prewalkOptions: { entryApproval: 'deny' }, activeTools: entryTools });
    await denied.emit('before_agent_start', beforeStartEvent('Build it'));
    expect(deniedClassifier.evaluate).not.toHaveBeenCalled();

    const childClassifier = scriptedClassifier({ route: { route: 'prewalk' } });
    const child = createHarness({ classifier: childClassifier, childSession: true, activeTools: entryTools });
    await child.emit('before_agent_start', beforeStartEvent('Build it'));
    expect(childClassifier.evaluate).not.toHaveBeenCalled();

    const failing = createHarness({ classifier: scriptedClassifier({ route: new Error('down') }), activeTools: entryTools });
    const failingEvent = beforeStartEvent('Build it');
    await expect(failing.emit('before_agent_start', failingEvent)).resolves.toBeUndefined();
    expect(failingEvent.systemPromptOptions.sections).toEqual({});
  });

  it('appends the classified exploration depth to planning guidance once', async () => {
    const classifier = scriptedClassifier({ route: { route: 'prewalk' }, depth: { depth: 'sufficient' } });
    const harness = createHarness({ classifier, prewalkOptions: { entryApproval: 'allow' }, activeTools: entryTools });
    const entry = await harness.emit('before_agent_start', beforeStartEvent('Implement the feature'));

    await enterPrewalk(harness);

    const messages = await contextMessages(harness, [
      { role: 'user', content: 'Implement the feature', timestamp: 1 },
      { role: 'custom', ...entry.message, timestamp: 2 },
    ]);
    expect(messages.some((message) => message.customType === ENTRY_MESSAGE_TYPE)).toBe(false);
    const planning = messages.filter((message) => message.customType === PLANNING_MESSAGE_TYPE);
    expect(planning).toHaveLength(1);
    expect(planning[0].content).toBe(`${PLANNING_INSTRUCTION}\n\n${EXPLORATION_DEPTH_GUIDANCE.sufficient}`);
    expect(classifier.evaluate.mock.calls[1]![0]).toMatchObject({ request: 'Implement the feature', tasks: [] });
  });

  it('preserves classified deep exploration without checking the Agent tool', async () => {
    const harness = createHarness({ classifier: scriptedClassifier({ depth: { depth: 'deep' } }) });

    await startPlanning(harness);

    const messages = await contextMessages(harness, [{ role: 'user', content: 'Implement the feature', timestamp: 1 }]);
    const planning = messages.find((message) => message.customType === PLANNING_MESSAGE_TYPE);
    expect(planning.content).toContain(EXPLORATION_DEPTH_GUIDANCE.deep);
  });

  it('keeps the base planning guidance and mandatory reviewer without a classifier', async () => {
    const harness = createHarness({ activeTools: [...entryTools, 'Agent'] });
    await qualifyHandoff(harness);

    const messages = await contextMessages(harness, [{ role: 'user', content: 'Implement the feature', timestamp: 1 }]);
    const implementation = messages.find((message) => message.customType === IMPLEMENTATION_MESSAGE_TYPE);
    expect(implementation.content).toBe(VERIFICATION_INSTRUCTION);
  });

  it('does not change verification guidance or completion gating based on Agent availability', async () => {
    for (const classifier of [undefined, scriptedClassifier({
      depth: { depth: 'targeted' },
      'tier,thinking': { tier: 'low', thinking: 'medium' },
    })]) {
      const harness = createHarness({ ...(classifier === undefined ? {} : { classifier }) });
      await qualifyHandoff(harness);

      const messages = await contextMessages(harness, [{ role: 'user', content: 'Implement the feature', timestamp: 1 }]);
      expect(messages.find((message) => message.customType === IMPLEMENTATION_MESSAGE_TYPE).content)
        .toBe(classifier === undefined ? VERIFICATION_INSTRUCTION : GATED_VERIFICATION_INSTRUCTION);
      const completion = await beforeSettle(harness);
      if (classifier !== undefined) {
        expect(completion).toEqual({
          entries: [{ type: 'custom_message', customType: COMPLETION_MESSAGE_TYPE, content: COMPLETION_REVIEW_INSTRUCTION, display: false }],
          continue: true,
        });
      }
      await harness.emit('agent_settled');
      expect(harness.currentModel).toBe(targetModel);
    }
  });

  it('escalates the implementation tier and thinking from the approved plan', async () => {
    const classifier = scriptedClassifier({
      depth: { depth: 'targeted' },
      'tier,thinking': { tier: 'high', thinking: 'high' },
    });
    const harness = createHarness({ classifier, activeTools: [...entryTools, 'Agent'] });

    await qualifyHandoff(harness);

    const profileState = classifier.evaluate.mock.calls[1]![0];
    expect(profileState).toMatchObject({ request: 'Implement the feature' });
    expect(profileState.tasks[0]).toContain('Implement the feature');
    expect(profileState).not.toHaveProperty('session');
    expect(harness.currentModel).not.toBe(targetModel);
    expect(harness.thinkingLevel).toBe('high');
    const messages = await contextMessages(harness, [{ role: 'user', content: 'Implement the feature', timestamp: 1 }]);
    expect(messages.find((message) => message.customType === IMPLEMENTATION_MESSAGE_TYPE).content)
      .toBe(GATED_VERIFICATION_INSTRUCTION);
  });

  it('never lowers the configured implementation target and falls back on failure', async () => {
    const lower = createHarness({
      classifier: scriptedClassifier({ depth: { depth: 'targeted' }, 'tier,thinking': { tier: 'low', thinking: 'low' } }),
    });
    await qualifyHandoff(lower);
    expect(lower.currentModel).toBe(targetModel);
    expect(lower.thinkingLevel).toBe('medium');

    const failing = createHarness({
      classifier: scriptedClassifier({ depth: { depth: 'targeted' }, 'tier,thinking': new Error('down') }),
    });
    await qualifyHandoff(failing);
    expect(failing.currentModel).toBe(targetModel);
    expect(failing.thinkingLevel).toBe('medium');
  });

  it('continues implementation when the completion check finds a gap', async () => {
    const harness = createHarness({
      activeTools: [...entryTools, 'Agent'],
      classifier: scriptedClassifier({
        depth: { depth: 'targeted' },
        'tier,thinking': { tier: 'low', thinking: 'medium' },
        verdict: { verdict: 'gap' },
      }),
    });
    await qualifyHandoff(harness);

    await harness.emit('turn_end', { type: 'turn_end', turnIndex: 1, message: assistant('stop', [{ type: 'text', text: 'Done' }]), toolResults: [] });
    expect(harness.sendMessage).not.toHaveBeenCalledWith(expect.objectContaining({ customType: COMPLETION_MESSAGE_TYPE }), expect.anything());
    const result = await beforeSettle(harness);

    expect(result).toEqual({
      entries: [{ type: 'custom_message', customType: COMPLETION_MESSAGE_TYPE, content: COMPLETION_GAP_INSTRUCTION, display: false }],
      continue: true,
    });
    const history = [
      { role: 'user', content: 'Implement the feature', timestamp: 1 },
      { role: 'custom', customType: COMPLETION_MESSAGE_TYPE, content: COMPLETION_GAP_INSTRUCTION, display: false, timestamp: 2 },
    ];
    expect((await contextMessages(harness, history)).some((message) => message.customType === COMPLETION_MESSAGE_TYPE)).toBe(true);
    await harness.emit('turn_end', { type: 'turn_end', turnIndex: 2, message: assistant('stop'), toolResults: [] });
    expect((await contextMessages(harness, history)).some((message) => message.customType === COMPLETION_MESSAGE_TYPE)).toBe(false);
    await harness.command.handler('off', harness.ctx);
    expect((await contextMessages(harness, history)).some((message) => message.customType === COMPLETION_MESSAGE_TYPE)).toBe(false);
  });

  it('checks only the final assistant response after the entire agent run', async () => {
    const classifier = scriptedClassifier({
      depth: { depth: 'targeted' },
      'tier,thinking': { tier: 'low', thinking: 'medium' },
      verdict: { verdict: 'done' },
    });
    const harness = createHarness({ classifier });
    await qualifyHandoff(harness);
    const first = assistant('stop', [{ type: 'text', text: 'I will verify this next.' }]);
    const final = assistant('stop', [{ type: 'text', text: 'Verified and done.' }]);
    await harness.emit('turn_end', { type: 'turn_end', turnIndex: 1, message: first, toolResults: [] });
    await harness.emit('turn_end', { type: 'turn_end', turnIndex: 2, message: assistant('toolUse'), toolResults: [] });
    await harness.emit('turn_end', { type: 'turn_end', turnIndex: 3, message: final, toolResults: [] });
    expect(classifier.evaluate).toHaveBeenCalledTimes(2);
    expect(await beforeSettle(harness, [first], 'completed', { continue: true })).toBeUndefined();
    expect(await beforeSettle(harness, [first], 'completed', { pendingMessages: [{ role: 'custom', content: 'Continue' }] })).toBeUndefined();
    expect(await beforeSettle(harness, [first, assistant('toolUse')])).toBeUndefined();
    expect(classifier.evaluate).toHaveBeenCalledTimes(2);
    expect(await beforeSettle(harness, [first, assistant('toolUse'), final])).toEqual({
      entries: [{ type: 'custom_message', customType: COMPLETION_MESSAGE_TYPE, content: COMPLETION_REVIEW_INSTRUCTION, display: false }],
      continue: true,
    });
    expect(classifier.evaluate).toHaveBeenCalledTimes(3);
    expect(classifier.evaluate.mock.calls[2]![0].final_message).toBe('Verified and done.');
  });

  it('requests one review when completion is uncertain and then stops checking', async () => {
    const classifier = scriptedClassifier({
      depth: { depth: 'targeted' },
      'tier,thinking': { tier: 'low', thinking: 'medium' },
      verdict: { verdict: 'unsure' },
    });
    const harness = createHarness({ classifier, activeTools: [...entryTools, 'Agent'] });
    await qualifyHandoff(harness);

    const review = await beforeSettle(harness);
    expect(review).toEqual({
      entries: [{ type: 'custom_message', customType: COMPLETION_MESSAGE_TYPE, content: COMPLETION_REVIEW_INSTRUCTION, display: false }],
      continue: true,
    });
    expect(await beforeSettle(harness)).toBeUndefined();
    expect(classifier.evaluate).toHaveBeenCalledTimes(3);
  });

  it('requests one independent review when the completion classifier fails', async () => {
    const classifier = scriptedClassifier({
      depth: { depth: 'targeted' },
      'tier,thinking': { tier: 'low', thinking: 'medium' },
      verdict: new Error('classifier unavailable'),
    });
    const harness = createHarness({ classifier, activeTools: [...entryTools, 'Agent'] });
    await qualifyHandoff(harness);

    expect(await beforeSettle(harness)).toEqual({
      entries: [{ type: 'custom_message', customType: COMPLETION_MESSAGE_TYPE, content: COMPLETION_REVIEW_INSTRUCTION, display: false }],
      continue: true,
    });
    expect(await beforeSettle(harness)).toBeUndefined();
    expect(classifier.evaluate).toHaveBeenCalledTimes(3);
  });

  it('does not continue after an exit request races the completion classifier', async () => {
    let finishVerdict!: () => void;
    const verdictReady = new Promise<void>((resolve) => { finishVerdict = resolve; });
    const classifier = {
      evaluate: vi.fn(async (_state: any, questions: Record<string, unknown>) => {
        if ('verdict' in questions) await verdictReady;
        const answer = 'verdict' in questions ? { verdict: 'gap' }
          : 'depth' in questions ? { depth: 'targeted' }
            : { tier: 'low', thinking: 'medium' };
        return { answers: Object.fromEntries(Object.entries(answer).map(([id, choice]) => [id, { type: 'choice', choice }])) };
      }),
    };
    const harness = createHarness({ classifier });
    await qualifyHandoff(harness);
    harness.setIdle(false);

    const checking = beforeSettle(harness);
    await vi.waitFor(() => expect(classifier.evaluate).toHaveBeenCalledTimes(3));
    await harness.command.handler('off', harness.ctx);
    finishVerdict();

    expect(await checking).toBeUndefined();
    expect(harness.sendMessage).not.toHaveBeenCalledWith(expect.objectContaining({ customType: COMPLETION_MESSAGE_TYPE }), expect.anything());
    harness.setIdle(true);
    await harness.emit('agent_settled');
    expect(harness.currentModel).toBe(plannerModel);
  });

  it('settles without follow-up when done, caps gap checks, and skips tool turns', async () => {
    const doneHarness = createHarness({
      activeTools: [...entryTools, 'Agent'],
      classifier: scriptedClassifier({
        depth: { depth: 'targeted' },
        'tier,thinking': { tier: 'low', thinking: 'medium' },
        verdict: { verdict: 'done' },
      }),
      sessionMessages: [
        { role: 'assistant', content: [{ type: 'toolCall', id: 'edit-1', name: 'edit', arguments: { path: 'src/feature.ts' } }] },
        { role: 'toolResult', toolCallId: 'edit-1', toolName: 'edit', isError: false, content: [{ type: 'text', text: 'ok' }] },
        { role: 'assistant', content: [{ type: 'toolCall', id: 'test-1', name: 'bash', arguments: { command: 'pnpm test' } }] },
        { role: 'toolResult', toolCallId: 'test-1', toolName: 'bash', isError: false, content: [{ type: 'text', text: 'Exit: 0' }] },
      ],
    });
    await qualifyHandoff(doneHarness);
    await doneHarness.emit('turn_end', { type: 'turn_end', turnIndex: 1, message: assistant('toolUse', [{ type: 'toolCall', id: 'x', name: 'bash', arguments: {} }]), toolResults: [] });
    await doneHarness.emit('turn_end', { type: 'turn_end', turnIndex: 2, message: assistant('stop', [{ type: 'text', text: 'Done' }]), toolResults: [] });
    expect(await beforeSettle(doneHarness)).toBeUndefined();

    const unverified = createHarness({
      activeTools: [...entryTools, 'Agent'],
      classifier: scriptedClassifier({
        depth: { depth: 'targeted' },
        'tier,thinking': { tier: 'low', thinking: 'medium' },
        verdict: { verdict: 'done' },
      }),
    });
    await qualifyHandoff(unverified);
    await unverified.emit('turn_end', { type: 'turn_end', turnIndex: 1, message: assistant('stop'), toolResults: [] });
    expect(await beforeSettle(unverified)).toEqual({
      entries: [{ type: 'custom_message', customType: COMPLETION_MESSAGE_TYPE, content: COMPLETION_REVIEW_INSTRUCTION, display: false }],
      continue: true,
    });

    const failedVerification = createHarness({
      activeTools: [...entryTools, 'Agent'],
      classifier: scriptedClassifier({
        depth: { depth: 'targeted' },
        'tier,thinking': { tier: 'low', thinking: 'medium' },
        verdict: { verdict: 'done' },
      }),
      sessionMessages: [
        { role: 'assistant', content: [{ type: 'toolCall', id: 'edit-2', name: 'edit', arguments: { path: 'src/feature.ts' } }] },
        { role: 'toolResult', toolCallId: 'edit-2', toolName: 'edit', isError: false, content: [{ type: 'text', text: 'ok' }] },
        { role: 'assistant', content: [{ type: 'toolCall', id: 'test-2', name: 'bash', arguments: { command: 'pnpm test' } }] },
        { role: 'toolResult', toolCallId: 'test-2', toolName: 'bash', isError: false, content: [{ type: 'text', text: 'Exit: 1' }] },
      ],
    });
    await qualifyHandoff(failedVerification);
    await failedVerification.emit('turn_end', { type: 'turn_end', turnIndex: 1, message: assistant('stop'), toolResults: [] });
    expect(await beforeSettle(failedVerification)).toEqual({
      entries: [{ type: 'custom_message', customType: COMPLETION_MESSAGE_TYPE, content: COMPLETION_REVIEW_INSTRUCTION, display: false }],
      continue: true,
    });

    const gapClassifier = scriptedClassifier({
      depth: { depth: 'targeted' },
      'tier,thinking': { tier: 'low', thinking: 'medium' },
      verdict: { verdict: 'gap' },
    });
    const gapHarness = createHarness({ classifier: gapClassifier, activeTools: [...entryTools, 'Agent'] });
    await qualifyHandoff(gapHarness);
    expect((await beforeSettle(gapHarness)).entries[0].content).toBe(COMPLETION_GAP_INSTRUCTION);
    expect((await beforeSettle(gapHarness)).entries[0].content).toBe(COMPLETION_REVIEW_INSTRUCTION);
    expect(await beforeSettle(gapHarness)).toBeUndefined();
    expect(gapClassifier.evaluate).toHaveBeenCalledTimes(4);
  });

  it('holds the implementation model through an asynchronous reviewer completion', async () => {
    const harness = createHarness({
      activeTools: [...entryTools, 'Agent'],
      classifier: scriptedClassifier({
        depth: { depth: 'targeted' },
        'tier,thinking': { tier: 'low', thinking: 'medium' },
        verdict: { verdict: 'unsure' },
      }),
    });
    await qualifyHandoff(harness);
    const implementationModel = harness.currentModel;

    await harness.emit('turn_end', {
      type: 'turn_end', turnIndex: 1, message: assistant('stop'), toolResults: [],
    });
    expect((await beforeSettle(harness)).entries[0].content).toBe(COMPLETION_REVIEW_INSTRUCTION);
    await harness.emit('agent_settled');
    expect(harness.currentModel).toBe(implementationModel);

    await harness.emit('tool_call', {
      type: 'tool_call', toolCallId: 'review-1', toolName: 'Agent', input: { subagent_type: 'reviewer' },
    });
    await harness.emit('turn_end', {
      type: 'turn_end', turnIndex: 2, message: assistant('toolUse'),
      toolResults: [{ ...toolResult('review-1', 'Agent'), details: { agentId: 'child-1' } }],
    });
    await harness.emit('agent_settled');
    expect(harness.currentModel).toBe(implementationModel);

    await harness.emit('message_end', {
      type: 'message_end',
      message: {
        role: 'custom', customType: 'felan-subagent-completion',
        details: { notice: { agentId: 'child-1', type: 'reviewer', status: 'completed' } },
      },
    });
    await harness.emit('agent_settled');
    expect(harness.currentModel).toBe(plannerModel);
  });

  it('keeps verification pending after an abnormal final turn', async () => {
    const harness = createHarness({
      activeTools: [...entryTools, 'Agent'],
      classifier: scriptedClassifier({
        depth: { depth: 'targeted' },
        'tier,thinking': { tier: 'low', thinking: 'medium' },
      }),
    });
    await qualifyHandoff(harness);
    const implementationModel = harness.currentModel;

    await harness.emit('turn_end', {
      type: 'turn_end', turnIndex: 1,
      message: { ...assistant('error'), stopReason: 'error' }, toolResults: [],
    });
    expect(await beforeSettle(harness, [assistant('error')], 'error')).toBeUndefined();
    await harness.emit('agent_settled');
    expect(harness.currentModel).toBe(implementationModel);
    const messages = await contextMessages(harness, [{ role: 'user', content: 'Resume verification', timestamp: 1 }]);
    expect(messages.find((message) => message.customType === IMPLEMENTATION_MESSAGE_TYPE).content)
      .toBe(GATED_VERIFICATION_INSTRUCTION);
  });

  it('waits for the mandatory reviewer when the classifier is unavailable', async () => {
    const harness = createHarness({ activeTools: [...entryTools, 'Agent'] });
    await qualifyHandoff(harness);
    const implementationModel = harness.currentModel;

    await harness.emit('agent_settled');
    expect(harness.currentModel).toBe(implementationModel);
    await harness.emit('tool_call', {
      type: 'tool_call', toolCallId: 'review-2', toolName: 'Agent', input: { subagent_type: 'reviewer' },
    });
    await harness.emit('turn_end', {
      type: 'turn_end', turnIndex: 2, message: assistant('toolUse'),
      toolResults: [{ ...toolResult('review-2', 'Agent'), details: { agentId: 'child-2' } }],
    });
    await harness.emit('agent_settled');
    expect(harness.currentModel).toBe(implementationModel);
    await harness.emit('message_end', {
      type: 'message_end',
      message: {
        role: 'custom', customType: 'felan-subagent-completion',
        details: { notice: { agentId: 'child-2', type: 'reviewer', status: 'completed' } },
      },
    });
    await harness.emit('agent_settled');
    expect(harness.currentModel).toBe(plannerModel);
  });
});
