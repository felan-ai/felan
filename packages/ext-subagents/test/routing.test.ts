import { describe, expect, it, vi } from 'vitest';
import {
  createLogger,
  type FelanExtensionAPI,
  type LogRecord,
} from '@felan-ai/agent-core';
import { createSubagentsExtension, type SubagentHost } from '../src/index.js';

describe('classifier-guided subagent routing', () => {
  it('keeps the static capability when probability judgments are unavailable', () => {
    const handlers = new Map<string, (event: any, ctx: any) => Promise<any> | any>();
    const registerCapability = vi.fn();
    const logs: LogRecord[] = [];
    const pi = {
      runtime: {
        classifier: { evaluate: vi.fn() },
        logger: recordingLogger(logs),
      },
      registerCapability,
      registerTool: vi.fn(),
      on: (event: string, handler: any) => { handlers.set(event, handler); },
      getThinkingLevel: () => 'medium',
    } as unknown as FelanExtensionAPI;

    createSubagentsExtension(createHost([
      { id: 'reader', description: 'Read-only investigation', allowNesting: false },
    ]))(pi);

    expect(registerCapability).toHaveBeenCalledWith(expect.objectContaining({
      id: 'subagents',
      instructions: expect.stringContaining('reader (Read-only investigation)'),
    }));
    expect(handlers.has('before_agent_start')).toBe(false);
    expect(logs.find(({ msg }) => msg === 'subagent routing configured')).toMatchObject({
      fields: {
        component: 'subagent-routing',
        event: 'configuration',
        mode: 'static',
        reason: 'probability-classifier-unavailable',
        catalog: ['reader'],
        guidance: expect.stringContaining('reader (Read-only investigation)'),
      },
    });
  });

  it('scores every catalog entry once and appends one authoritative system-prompt decision', async () => {
    const handlers = new Map<string, (event: any, ctx: any) => Promise<any> | any>();
    const logs: LogRecord[] = [];
    const evaluateProbabilities = vi.fn(async (_state: any, questions: Record<string, unknown>) => ({
      answers: Object.fromEntries(Object.keys(questions).map((id) => [id, {
        probability: id === 'agent:0' ? 0.9 : 0.7,
      }])),
      metadata: { provider: 'typesafe', model: 'jev-latest', elapsedMs: 12 },
    }));
    const host = createHost([
      { id: 'reader', description: 'Read-only investigation', allowNesting: false },
      { id: 'auditor', description: 'Independent review', allowNesting: false },
    ]);
    const pi = createPi(evaluateProbabilities, handlers, logs);
    createSubagentsExtension(host)(pi);

    const event = routingEvent({
      prompt: 'Understand and then verify the parser',
    });
    event.systemPromptOptions.sections.other_extension = 'Preserve this section';
    const result = await handlers.get('before_agent_start')!(event, context());

    expect(evaluateProbabilities).toHaveBeenCalledTimes(1);
    const questions = evaluateProbabilities.mock.calls[0]![1] as Record<string, unknown>;
    expect(Object.keys(questions)).toEqual(['agent:0', 'agent:1']);
    expect(JSON.stringify(questions['agent:0'])).toContain('available_agents[0]');
    expect(JSON.stringify(questions['agent:1'])).toMatch(/exploration.*parallelism.*review or verification/s);
    expect(evaluateProbabilities.mock.calls[0]![0]).toMatchObject({
      available_agents: [
        { id: 'reader', description: 'Read-only investigation' },
        { id: 'auditor', description: 'Independent review' },
      ],
    });
    expect(result).toBeUndefined();
    expect(event.systemPromptOptions.sections).toEqual({
      other_extension: 'Preserve this section',
      subagent_routing: expect.any(String),
    });
    const selectedGuidance = event.systemPromptOptions.sections.subagent_routing;
    expect(selectedGuidance).toContain('selected the following required agent types');
    expect(selectedGuidance).toContain('at least one concrete, non-overlapping task to every listed type');
    expect(selectedGuidance).toContain('decide when to launch each one and which subtask to assign');
    expect(selectedGuidance).toContain('matching the request and current state to its description');
    expect(selectedGuidance).toContain('repeated use of a listed type for genuinely distinct scopes');
    expect(selectedGuidance).toContain('reader (Read-only investigation)');
    expect(selectedGuidance).toContain('auditor (Independent review)');
    expect(pi.registerCapability).toHaveBeenCalledWith({
      id: 'subagents',
      instructions: expect.stringMatching(/Use child agents only for bounded work.*always run asynchronously/s),
    });
    const capabilityInstructions = (pi.registerCapability as ReturnType<typeof vi.fn>).mock.calls[0]![0].instructions;
    expect(capabilityInstructions).not.toContain('Read-only investigation');
    expect(capabilityInstructions).not.toContain('routing decision');
    const agentTool = (pi.registerTool as ReturnType<typeof vi.fn>).mock.calls
      .map(([tool]) => tool)
      .find((tool) => tool.name === 'Agent');
    expect(agentTool.description).toContain('current turn system prompt supplies the routing decision');
    expect(agentTool.description).not.toContain('Read-only investigation');
    const decisionLog = logs.find(({ msg }) => msg === 'subagent routing decision');
    expect(decisionLog).toMatchObject({
      level: 'debug',
      fields: {
        component: 'subagent-routing',
        event: 'decision',
        sessionId: 'root-session',
        attempt: 1,
        outcome: 'classified',
        guidanceVariant: 'selected',
        threshold: 0.65,
        scores: [
          { agentType: 'reader', probability: 0.9 },
          { agentType: 'auditor', probability: 0.7 },
        ],
        selectedAgents: ['reader', 'auditor'],
        classifier: { provider: 'typesafe', model: 'jev-latest', elapsedMs: 12 },
        guidancePlacement: 'system-prompt-section',
        guidanceSection: 'subagent_routing',
        guidance: expect.stringContaining('- reader (Read-only investigation)'),
      },
    });
    expect(JSON.stringify(decisionLog)).not.toContain('Understand and then verify the parser');
  });

  it('falls back to a full-catalog system-prompt decision when classification fails', async () => {
    const handlers = new Map<string, (event: any, ctx: any) => Promise<any> | any>();
    const logs: LogRecord[] = [];
    const evaluateProbabilities = vi.fn(async () => { throw new Error('classifier unavailable'); });
    const pi = createPi(evaluateProbabilities, handlers, logs);
    createSubagentsExtension(createHost([
      { id: 'custom-investigator', description: 'Investigate', allowNesting: false },
    ]))(pi);

    const event = routingEvent({ prompt: 'Inspect this' });
    await expect(handlers.get('before_agent_start')!(event, context())).resolves.toBeUndefined();
    expect(event.systemPromptOptions.sections).toEqual({
      subagent_routing: expect.stringMatching(/^## Subagent routing decision.*could not decide.*custom-investigator \(Investigate\).*`Agent` tool/s),
    });
    expect(logs.find(({ msg }) => msg === 'subagent routing fallback')).toMatchObject({
      level: 'warn',
      fields: {
        component: 'subagent-routing',
        event: 'decision',
        outcome: 'fallback',
        guidanceVariant: 'catalog-fallback',
        error: { name: 'Error', message: 'classifier unavailable' },
        guidancePlacement: 'system-prompt-section',
        guidanceSection: 'subagent_routing',
        guidance: expect.stringContaining('custom-investigator (Investigate)'),
      },
    });
  });

  it('falls back when the classifier omits a catalog judgment', async () => {
    const handlers = new Map<string, (event: any, ctx: any) => Promise<any> | any>();
    const evaluateProbabilities = vi.fn(async () => ({
      answers: {},
    }));
    const pi = createPi(evaluateProbabilities, handlers);
    createSubagentsExtension(createHost([
      { id: 'custom-investigator', description: 'Investigate', allowNesting: false },
    ]))(pi);

    const event = routingEvent({ prompt: 'Inspect this' });
    const result = await handlers.get('before_agent_start')!(event, context());

    expect(result).toBeUndefined();
    expect(event.systemPromptOptions.sections.subagent_routing).toContain('custom-investigator (Investigate)');
    expect(event.systemPromptOptions.sections.subagent_routing).toContain('could not decide routing');
  });

  it('uses the full active conversation, request, catalog descriptions, and child state', async () => {
    const handlers = new Map<string, (event: any, ctx: any) => Promise<any> | any>();
    const evaluateProbabilities = vi.fn(async (_state: any, questions: Record<string, unknown>) => ({
      answers: Object.fromEntries(Object.keys(questions).map((id) => [id, {
        probability: id === 'agent:0' ? 0.9 : 0,
      }])),
    }));
    const description = `Read-only investigation ${'detail '.repeat(100)}`.trim();
    const request = `Current request ${'requirement '.repeat(500)}`.trim();
    const earlier = `Earlier requirement ${'context '.repeat(100)}`.trim();
    const host = createHost([{ id: 'reader', description, allowNesting: false }]);
    const pi = createPi(evaluateProbabilities, handlers);
    createSubagentsExtension(host)(pi);
    const messages = [{ role: 'user', content: [{ type: 'text', text: earlier }] }];

    const event = routingEvent({
      prompt: request,
      images: [{ type: 'image' }, { type: 'image' }],
    });
    const result = await handlers.get('before_agent_start')!(event, context(messages, true, [{
      type: 'custom_message',
      id: 'routing-message',
      parentId: 'message-0',
      timestamp: '',
      customType: 'felan-subagent-routing',
      content: 'stale routing guidance',
      display: true,
    }, {
      type: 'custom_message',
      id: 'other-extension-message',
      parentId: 'routing-message',
      timestamp: '',
      customType: 'other-extension',
      content: 'private extension-generated context',
      display: true,
    }]));

    expect(evaluateProbabilities.mock.calls[0]![0]).toMatchObject({
      request,
      image_count: 2,
      session_kind: 'child',
      conversation: [{ role: 'user', text: earlier }],
      available_agents: [{ id: 'reader', description }],
      active_children: [{ type: 'reader', status: 'running' }],
    });
    expect(result).toBeUndefined();
    expect(event.systemPromptOptions.sections.subagent_routing).toContain(`reader (${description})`);
    expect(event.systemPromptOptions.sections.subagent_routing).toContain('every listed type before reporting completion');
    expect(event.systemPromptOptions.sections.subagent_routing).toContain('decide when to launch each one and which subtask to assign');
  });

  it('routes from projected context rather than superseded raw messages', async () => {
    const handlers = new Map<string, (event: any, ctx: any) => Promise<any> | any>();
    const evaluateProbabilities = vi.fn(async (_state: any, questions: Record<string, unknown>) => ({
      answers: Object.fromEntries(Object.keys(questions).map((id) => [id, { probability: 0 }])),
    }));
    const host = createHost([{ id: 'reader', description: 'Read-only investigation', allowNesting: false }]);
    const pi = createPi(evaluateProbabilities, handlers);
    createSubagentsExtension(host)(pi);
    const raw = { role: 'user', content: [{ type: 'text', text: 'superseded raw content' }] };
    const projected = { role: 'user', content: [{ type: 'text', text: 'projected content' }] };
    const ctx = context([raw]);
    ctx.sessionManager.buildSessionProjection = () => ({
      entries: [{ sourceEntry: ctx.sessionManager.buildContextEntries()[0], messages: [projected] }],
      messages: [projected],
      thinkingLevel: 'off',
      model: null,
    });

    await handlers.get('before_agent_start')!(routingEvent({ prompt: 'request' }), ctx);

    expect(evaluateProbabilities.mock.calls[0]![0].conversation).toEqual([
      { role: 'user', text: 'projected content' },
    ]);
  });

  it('scores catalogs larger than one classifier request instead of dropping routing', async () => {
    const handlers = new Map<string, (event: any, ctx: any) => Promise<any> | any>();
    const descriptors = Array.from({ length: 40 }, (_, index) => ({
      id: `specialist-${index}`,
      description: `Specialist ${index}`,
      allowNesting: false,
    }));
    const evaluateProbabilities = vi.fn(async (_state: any, questions: Record<string, unknown>) => ({
      answers: Object.fromEntries(Object.keys(questions).map((id) => [id, { probability: 0 }])),
    }));
    const pi = createPi(evaluateProbabilities, handlers);
    createSubagentsExtension(createHost(descriptors))(pi);

    const event = routingEvent({ prompt: 'Coordinate specialists' });
    const result = await handlers.get('before_agent_start')!(event, context());

    expect(Object.keys(evaluateProbabilities.mock.calls[0]![1])).toHaveLength(40);
    expect(result).toBeUndefined();
    expect(event.systemPromptOptions.sections.subagent_routing).toContain('Keep this request in the parent');
    expect(event.systemPromptOptions.sections.subagent_routing).toContain('Do not call the `Agent` tool');
    expect(event.systemPromptOptions.sections.subagent_routing).not.toContain('Specialist 0');
  });

  it('orders equal-probability recommendations by code point', async () => {
    const handlers = new Map<string, (event: any, ctx: any) => Promise<any> | any>();
    const evaluateProbabilities = vi.fn(async (_state: any, questions: Record<string, unknown>) => ({
      answers: Object.fromEntries(Object.keys(questions).map((id) => [id, { probability: 0.8 }])),
    }));
    const pi = createPi(evaluateProbabilities, handlers);
    createSubagentsExtension(createHost([
      { id: 'zeta', description: 'Zeta specialist', allowNesting: false },
      { id: 'alpha', description: 'Alpha specialist', allowNesting: false },
    ]))(pi);

    const event = routingEvent({ prompt: 'Use both specialists' });
    const result = await handlers.get('before_agent_start')!(
      event,
      context(),
    );

    expect(result).toBeUndefined();
    const guidance = event.systemPromptOptions.sections.subagent_routing;
    expect(guidance).toBeDefined();
    expect(guidance!.indexOf('- alpha (Alpha specialist)')).toBeLessThan(
      guidance!.indexOf('- zeta (Zeta specialist)'),
    );
  });

  it('cancels an in-flight classification when the session shuts down', async () => {
    const handlers = new Map<string, (event: any, ctx: any) => Promise<any> | any>();
    const logs: LogRecord[] = [];
    let aborted = false;
    const evaluateProbabilities = vi.fn(async (_state: any, _questions: any, signal: AbortSignal) => {
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => {
        aborted = true;
        resolve();
      }, { once: true }));
      return { answers: {} };
    });
    const pi = createPi(evaluateProbabilities, handlers, logs);
    createSubagentsExtension(createHost([{ id: 'reader', description: 'Read-only investigation', allowNesting: false }]))(pi);
    const pending = handlers.get('before_agent_start')!(routingEvent({ prompt: 'Inspect' }), context());
    await Promise.resolve();
    handlers.get('session_shutdown')!({}, context());
    await pending;
    expect(aborted).toBe(true);
    expect(logs.find(({ msg }) => msg === 'subagent routing cancelled')).toMatchObject({
      fields: {
        outcome: 'cancelled',
        reason: 'session-shutdown',
      },
    });
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
    list: vi.fn(async () => ({ ok: true, value: [{ agentId: 'child', type: 'reader', status: 'running', description: 'active' }] })),
    getResult: vi.fn(),
    steer: vi.fn(),
    cancel: vi.fn(),
  } as unknown as SubagentHost;
}

function context(messages: unknown[] = [], child = false, extraEntries: unknown[] = []): any {
  return {
    sessionManager: {
      getSessionId: () => 'root-session',
      getHeader: () => child ? { parentSession: '/parent/session.jsonl' } : { id: 'root' },
      buildContextEntries: () => [
        ...messages.map((message, index) => ({
          type: 'message',
          id: `message-${index}`,
          parentId: index === 0 ? null : `message-${index - 1}`,
          timestamp: '',
          message,
        })),
        ...extraEntries,
      ],
    },
  };
}
