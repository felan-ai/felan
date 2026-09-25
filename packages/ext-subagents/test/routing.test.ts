import { describe, expect, it, vi } from 'vitest';
import {
  createLogger,
  type FelanExtensionAPI,
  type LogRecord,
} from '@felan-ai/agent-core';
import { createSubagentsExtension, type SubagentHost } from '../src/index.js';
import { DISCOVERY_GUIDANCE } from '../src/routing.js';

const catalog = [
  { id: 'explore', description: 'Read-only investigation', allowNesting: false },
  { id: 'reviewer', description: 'Independent review', allowNesting: false },
];

describe('capability guidance', () => {
  it('always lists the catalog and describes when delegation pays off', () => {
    const pi = createPi(vi.fn(), new Map());
    createSubagentsExtension(createHost(catalog))(pi);

    const instructions = (pi.registerCapability as ReturnType<typeof vi.fn>).mock.calls[0]![0].instructions as string;
    expect(instructions).toContain('explore (Read-only investigation)');
    expect(instructions).toContain('reviewer (Independent review)');
    expect(instructions).toContain('cheaper model');
    expect(instructions).toContain('fresh context');
    expect(instructions).toContain('disjoint file scopes');
    expect(instructions).toContain('Never re-read a scope you delegated');
    expect(instructions).not.toContain('explicitly request');
    const agentTool = (pi.registerTool as ReturnType<typeof vi.fn>).mock.calls
      .map(([tool]) => tool)
      .find((tool) => tool.name === 'Agent');
    expect(agentTool.description).toContain('subagents system capability supplies type descriptions');
  });
});

describe('classifier discovery routing', () => {
  it('registers no routing handlers without probability judgments', () => {
    const handlers = new Map<string, (event: any, ctx: any) => Promise<any> | any>();
    const logs: LogRecord[] = [];
    const pi = {
      runtime: { classifier: { evaluate: vi.fn() }, logger: recordingLogger(logs) },
      registerCapability: vi.fn(),
      registerTool: vi.fn(),
      on: (event: string, handler: any) => { handlers.set(event, handler); },
    } as unknown as FelanExtensionAPI;
    createSubagentsExtension(createHost(catalog))(pi);

    expect(handlers.has('before_agent_start')).toBe(false);
    expect(handlers.has('input')).toBe(false);
    expect(logs.find(({ msg }) => msg === 'subagent routing configured')?.fields).toMatchObject({
      mode: 'static',
      reason: 'probability-classifier-unavailable',
    });
  });

  it('registers no routing handlers without an explore agent', () => {
    const handlers = new Map<string, (event: any, ctx: any) => Promise<any> | any>();
    const logs: LogRecord[] = [];
    createSubagentsExtension(createHost([catalog[1]]))(createPi(vi.fn(), handlers, logs));

    expect(handlers.has('before_agent_start')).toBe(false);
    expect(logs.find(({ msg }) => msg === 'subagent routing configured')?.fields).toMatchObject({
      reason: 'discovery-agent-unavailable',
    });
  });

  it('adds the discovery section when broad discovery is likely', async () => {
    const handlers = new Map<string, (event: any, ctx: any) => Promise<any> | any>();
    const logs: LogRecord[] = [];
    const evaluateProbabilities = vi.fn(async () => ({
      answers: { broad_discovery: { probability: 0.8 } },
      metadata: { provider: 'typesafe', model: 'jev-latest', elapsedMs: 12 },
    }));
    createSubagentsExtension(createHost(catalog))(createPi(evaluateProbabilities, handlers, logs));

    const event = routingEvent({ prompt: 'Map how authentication flows through every service' });
    event.systemPromptOptions.sections.other_extension = 'Preserve this section';
    await handlers.get('before_agent_start')!(event, context([
      { role: 'user', content: 'earlier question' },
      { role: 'assistant', content: [{ type: 'text', text: 'earlier answer' }] },
    ]));

    expect(evaluateProbabilities).toHaveBeenCalledTimes(1);
    const [state, questions] = evaluateProbabilities.mock.calls[0]! as unknown as [any, Record<string, { instructions: string }>];
    expect(Object.keys(questions)).toEqual(['broad_discovery']);
    expect(questions.broad_discovery!.instructions).toContain('not already covered by `conversation`');
    expect(state).toMatchObject({
      request: 'Map how authentication flows through every service',
      conversation: [
        { role: 'user', text: 'earlier question' },
        { role: 'assistant', text: 'earlier answer' },
      ],
      discovery_agent: { id: 'explore' },
      active_children: [{ id: 'child', type: 'explore', status: 'running', description: 'active' }],
    });
    expect(event.systemPromptOptions.sections).toEqual({
      other_extension: 'Preserve this section',
      subagent_routing: DISCOVERY_GUIDANCE,
    });
    expect(DISCOVERY_GUIDANCE).toContain('do not read the delegated scopes yourself');
    const decision = logs.find(({ msg }) => msg === 'subagent routing decision');
    expect(decision).toMatchObject({
      level: 'debug',
      fields: {
        component: 'subagent-routing',
        outcome: 'classified',
        threshold: 0.65,
        probability: 0.8,
        discovery: true,
        guidanceSection: 'subagent_routing',
        classifier: { provider: 'typesafe', model: 'jev-latest', elapsedMs: 12 },
      },
    });
    expect(JSON.stringify(decision)).not.toContain('authentication');
  });

  it('adds no section below the threshold', async () => {
    const handlers = new Map<string, (event: any, ctx: any) => Promise<any> | any>();
    const evaluateProbabilities = vi.fn(async () => ({ answers: { broad_discovery: { probability: 0.4 } } }));
    createSubagentsExtension(createHost(catalog))(createPi(evaluateProbabilities, handlers));

    const event = routingEvent({ prompt: 'Read target.txt' });
    await handlers.get('before_agent_start')!(event, context());

    expect(event.systemPromptOptions.sections).toEqual({});
  });

  it('bounds projected conversation while preserving recent findings', async () => {
    const handlers = new Map<string, (event: any, ctx: any) => Promise<any> | any>();
    const evaluateProbabilities = vi.fn(async () => ({ answers: { broad_discovery: { probability: 0.2 } } }));
    createSubagentsExtension(createHost(catalog))(createPi(evaluateProbabilities, handlers));
    const messages = Array.from({ length: 30 }, (_, index) => ({
      role: 'user',
      content: `finding-${index}-${'x'.repeat(1_300)}`,
    }));

    await handlers.get('before_agent_start')!(routingEvent({ prompt: 'Use prior findings' }), context(messages));

    const [state] = evaluateProbabilities.mock.calls[0]! as unknown as [any];
    expect(state.conversation).toHaveLength(24);
    expect(state.conversation[0].text).toContain('finding-6-');
    expect(state.conversation.at(-1).text).toContain('finding-29-');
    expect(state.conversation.every(({ text }: { text: string }) => text.length <= 1_200)).toBe(true);
  });

  it('adds no section and warns when classification fails', async () => {
    const handlers = new Map<string, (event: any, ctx: any) => Promise<any> | any>();
    const logs: LogRecord[] = [];
    const evaluateProbabilities = vi.fn(async () => { throw new Error('classifier unavailable'); });
    createSubagentsExtension(createHost(catalog))(createPi(evaluateProbabilities, handlers, logs));

    const event = routingEvent({ prompt: 'Inspect this' });
    await expect(handlers.get('before_agent_start')!(event, context())).resolves.toBeUndefined();

    expect(event.systemPromptOptions.sections).toEqual({});
    expect(logs.find(({ msg }) => msg === 'subagent routing failed')).toMatchObject({
      level: 'warn',
      fields: { outcome: 'failed', error: { message: 'classifier unavailable' } },
    });
  });

  it('rejects out-of-range answers as failures', async () => {
    const handlers = new Map<string, (event: any, ctx: any) => Promise<any> | any>();
    const logs: LogRecord[] = [];
    const evaluateProbabilities = vi.fn(async () => ({ answers: { broad_discovery: { probability: 2 } } }));
    createSubagentsExtension(createHost(catalog))(createPi(evaluateProbabilities, handlers, logs));

    const event = routingEvent({ prompt: 'Inspect this' });
    await handlers.get('before_agent_start')!(event, context());

    expect(event.systemPromptOptions.sections).toEqual({});
    expect(logs.some(({ msg }) => msg === 'subagent routing failed')).toBe(true);
  });

  it('does not classify child sessions', async () => {
    const handlers = new Map<string, (event: any, ctx: any) => Promise<any> | any>();
    const evaluateProbabilities = vi.fn();
    createSubagentsExtension(createHost(catalog))(createPi(evaluateProbabilities, handlers));

    handlers.get('input')!({ type: 'input', text: 'Task', source: 'interactive' }, context([], true));
    const event = routingEvent({ prompt: 'Task' });
    await handlers.get('before_agent_start')!(event, context([], true));

    expect(evaluateProbabilities).not.toHaveBeenCalled();
    expect(event.systemPromptOptions.sections).toEqual({});
  });

  it('does not recommend asynchronous discovery in one-shot mode', async () => {
    const handlers = new Map<string, (event: any, ctx: any) => Promise<any> | any>();
    const evaluateProbabilities = vi.fn();
    createSubagentsExtension(createHost(catalog))(createPi(evaluateProbabilities, handlers));
    const ctx = { ...context(), mode: 'json' };

    handlers.get('input')!({ type: 'input', text: 'Survey', source: 'interactive' }, ctx);
    const event = routingEvent({ prompt: 'Survey' });
    await handlers.get('before_agent_start')!(event, ctx);

    expect(evaluateProbabilities).not.toHaveBeenCalled();
    expect(event.systemPromptOptions.sections).toEqual({});
  });

  it('skips discovery in a small repository before calling the classifier', async () => {
    const handlers = new Map<string, (event: any, ctx: any) => Promise<any> | any>();
    const logs: LogRecord[] = [];
    const evaluateProbabilities = vi.fn();
    const pi = createPi(evaluateProbabilities, handlers, logs);
    const listFiles = vi.fn(async () => ['package.json', 'src/main.ts', 'test/main.test.ts']);
    (pi.runtime as any).listFiles = listFiles;
    createSubagentsExtension(createHost(catalog))(pi);

    const event = routingEvent({ prompt: 'Trace the entire repository' });
    await handlers.get('before_agent_start')!(event, context());

    expect(listFiles).toHaveBeenCalledWith('.', expect.objectContaining({ recursive: true, limit: 20 }));
    expect(evaluateProbabilities).not.toHaveBeenCalled();
    expect(event.systemPromptOptions.sections).toEqual({});
    expect(logs.find(({ msg }) => msg === 'subagent routing decision')?.fields).toMatchObject({
      outcome: 'skipped', reason: 'small-repository', discovery: false,
    });
  });

  it('starts classification at input and reuses it for the matching prompt', async () => {
    const handlers = new Map<string, (event: any, ctx: any) => Promise<any> | any>();
    const evaluateProbabilities = vi.fn(async () => ({ answers: { broad_discovery: { probability: 0.9 } } }));
    createSubagentsExtension(createHost(catalog))(createPi(evaluateProbabilities, handlers));

    handlers.get('input')!({ type: 'input', text: 'Survey the repository', source: 'interactive' }, context());
    await Promise.resolve();
    expect(evaluateProbabilities).toHaveBeenCalledTimes(1);

    const event = routingEvent({ prompt: 'Survey the repository' });
    await handlers.get('before_agent_start')!(event, context());

    expect(evaluateProbabilities).toHaveBeenCalledTimes(1);
    expect(event.systemPromptOptions.sections.subagent_routing).toBe(DISCOVERY_GUIDANCE);
  });

  it('reclassifies when the started prompt was transformed and ignores steering input', async () => {
    const handlers = new Map<string, (event: any, ctx: any) => Promise<any> | any>();
    const evaluateProbabilities = vi.fn(async (state: any, _questions: unknown, signal: AbortSignal) => {
      expect(signal.aborted).toBe(false);
      return { answers: { broad_discovery: { probability: state.request === 'expanded' ? 0.9 : 0.1 } } };
    });
    createSubagentsExtension(createHost(catalog))(createPi(evaluateProbabilities, handlers));

    handlers.get('input')!({ type: 'input', text: 'steer', source: 'interactive', streamingBehavior: 'steer' }, context());
    await Promise.resolve();
    expect(evaluateProbabilities).not.toHaveBeenCalled();

    handlers.get('input')!({ type: 'input', text: '/skill:x', source: 'interactive' }, context());
    const event = routingEvent({ prompt: 'expanded' });
    await handlers.get('before_agent_start')!(event, context());

    expect(evaluateProbabilities).toHaveBeenCalledTimes(2);
    expect(event.systemPromptOptions.sections.subagent_routing).toBe(DISCOVERY_GUIDANCE);
  });

  it('aborts pending classification on shutdown', async () => {
    const handlers = new Map<string, (event: any, ctx: any) => Promise<any> | any>();
    let observed: AbortSignal | undefined;
    const evaluateProbabilities = vi.fn(async (_state: unknown, _questions: unknown, signal: AbortSignal) => {
      observed = signal;
      return new Promise<never>(() => {});
    });
    createSubagentsExtension(createHost(catalog))(createPi(evaluateProbabilities, handlers));

    handlers.get('input')!({ type: 'input', text: 'Survey', source: 'interactive' }, context());
    await vi.waitFor(() => expect(observed).toBeDefined());
    handlers.get('session_shutdown')!({}, context());

    expect(observed!.aborted).toBe(true);
  });
});

function createPi(
  evaluateProbabilities: (...args: any[]) => Promise<any>,
  handlers: Map<string, (event: any, ctx: any) => Promise<any> | any>,
  logs: LogRecord[] = [],
): FelanExtensionAPI {
  return {
    runtime: {
      classifier: { evaluateProbabilities },
      logger: recordingLogger(logs),
    },
    registerCapability: vi.fn(),
    registerTool: vi.fn(),
    on: (event: string, handler: any) => { handlers.set(event, handler); },
  } as unknown as FelanExtensionAPI;
}

function recordingLogger(logs: LogRecord[] = []) {
  return createLogger({
    level: 'debug',
    destination: { write: (record) => { logs.push(record); } },
  });
}

function routingEvent(overrides: { prompt: string; images?: unknown[] }) {
  return {
    type: 'before_agent_start',
    systemPrompt: 'base',
    systemPromptOptions: { sections: {} as Record<string, string> },
    ...overrides,
  };
}

function createHost(descriptors: any[]): SubagentHost {
  return {
    descriptors,
    policy: { maxPromptBytes: 10_000, maxDescriptionBytes: 1_000, maxSteerBytes: 1_000 },
    attachParent: vi.fn(() => () => {}),
    spawn: vi.fn(),
    list: vi.fn(async () => ({ ok: true, value: [{ agentId: 'child', type: 'explore', status: 'running', description: 'active' }] })),
    getResult: vi.fn(),
    steer: vi.fn(),
    cancel: vi.fn(),
  } as unknown as SubagentHost;
}

function context(messages: unknown[] = [], child = false): any {
  return {
    sessionManager: {
      getSessionId: () => 'root-session',
      getHeader: () => child ? { parentSession: '/parent/session.jsonl' } : { id: 'root' },
      buildContextEntries: () => messages.map((message, index) => ({
        type: 'message',
        id: `message-${index}`,
        parentId: index === 0 ? null : `message-${index - 1}`,
        timestamp: '',
        message,
      })),
    },
  };
}
