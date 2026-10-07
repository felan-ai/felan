import { describe, expect, it, vi } from 'vitest';
import {
  collectClassifierSessionEvidence,
  createLogger,
  sanitizeClassifierText,
  type Classifier,
  type ExtensionContext,
  type TurnClassificationContribution,
  type TurnClassificationInput,
  type TurnClassificationRequest,
  type TurnClassificationResult,
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

describe('shared discovery routing', () => {
  it('uses static guidance without a registry, even with a direct classifier', () => {
    const harness = createHarness();
    delete (harness.pi as any).turnClassification;
    createSubagentsExtension(harness.host)(harness.pi);

    expect(harness.handlers.size).toBe(0);
    expect(harness.classify).not.toHaveBeenCalled();
    expect(harness.pi.registerCapability).toHaveBeenCalled();
    expect(harness.logs.find(({ msg }) => msg === 'subagent routing configured')?.fields).toMatchObject({
      mode: 'static', reason: 'turn-classification-unavailable',
    });
  });

  it('registers no contribution without an explore agent', () => {
    const harness = createHarness();
    createSubagentsExtension(createHost([catalog[1]]))(harness.pi);

    expect(harness.registry.register).not.toHaveBeenCalled();
    expect(harness.handlers.size).toBe(0);
    expect(harness.logs.find(({ msg }) => msg === 'subagent routing configured')?.fields).toMatchObject({
      reason: 'discovery-agent-unavailable',
    });
  });

  it('registers discovery at init and consumes a shared namespaced decision once', async () => {
    const harness = createHarness();
    createSubagentsExtension(harness.host)(harness.pi);
    expect(harness.registry.register).toHaveBeenCalledTimes(1);
    expect(harness.contribution().id).toBe('subagents');
    expect([...harness.handlers.keys()]).toEqual(['before_agent_start']);
    harness.registry.register({
      id: 'other',
      prepare: () => ({ questions: { broad_discovery: {
        type: 'bool', instructions: 'Another contribution', criteria: { true: 'Yes', false: 'No' },
      } } }),
    });
    const ctx = context([
      { role: 'user', content: 'earlier question' },
      { role: 'assistant', content: [{ type: 'text', text: 'earlier answer' }] },
    ]);
    const event = routingEvent({ prompt: 'Map how authentication flows through every service', images: [{}] });
    event.systemPromptOptions.sections.other_extension = 'Preserve this section';
    harness.registry.start({ prompt: event.prompt, imageCount: 1 }, ctx);
    await harness.consume(event, ctx);

    expect(harness.classify).toHaveBeenCalledTimes(1);
    expect(harness.host.list).toHaveBeenCalledTimes(1);
    expect(harness.host.list).toHaveBeenCalledWith({ includeDescendants: false });
    const [state, questions] = harness.classify.mock.calls[0]!;
    expect(Object.keys(questions)).toEqual(['subagents:broad_discovery', 'other:broad_discovery']);
    expect(questions['subagents:broad_discovery']).toMatchObject({
      type: 'bool', criteria: { true: 'Broad discovery is required', false: 'Broad discovery is not required' },
    });
    expect(questions['subagents:broad_discovery']!.instructions).toContain('`session.conversation`');
    expect(questions['subagents:broad_discovery']!.instructions).toContain('`extensions.subagents.active_children`');
    expect(state).toMatchObject({
      request: event.prompt, image_count: 1,
      session: { conversation: [
        { role: 'user', text: 'earlier question' },
        { role: 'assistant', text: 'earlier answer' },
      ] },
      extensions: { subagents: {
        discovery_agent: { id: 'explore' },
        active_children: [{ id: 'child', type: 'explore', status: 'running', description: 'active' }],
      } },
    });
    expect(Object.keys((state as any).extensions.subagents)).toEqual(['discovery_agent', 'active_children']);
    expect(event.systemPromptOptions.sections).toEqual({
      other_extension: 'Preserve this section', subagent_routing: DISCOVERY_GUIDANCE,
    });
    expect(DISCOVERY_GUIDANCE).toContain('do not read the delegated scopes yourself');
    const decision = harness.logs.find(({ msg }) => msg === 'subagent routing decision');
    expect(decision).toMatchObject({
      level: 'debug', fields: {
        component: 'subagent-routing', outcome: 'classified', threshold: 0.65,
        probability: 0.8, discovery: true, guidanceSection: 'subagent_routing',
        classifier: { provider: 'typesafe', model: 'jev-latest', elapsedMs: 12 },
      },
    });
    expect(JSON.stringify(decision)).not.toContain('authentication');
  });

  it.each([0, 0.64, 0.65, 1])('uses the inclusive threshold for probability %s', async (probability) => {
    const harness = createHarness(async () => ({
      answers: { 'subagents:broad_discovery': { type: 'bool', probability } },
    }));
    createSubagentsExtension(harness.host)(harness.pi);
    const event = routingEvent({ prompt: 'Inspect this' });
    await harness.turn(event, context());

    expect(event.systemPromptOptions.sections.subagent_routing).toBe(probability >= 0.65 ? DISCOVERY_GUIDANCE : undefined);
  });

  it('uses bounded sanitized shared evidence without scanning context during preparation or consumption', async () => {
    const harness = createHarness();
    createSubagentsExtension(harness.host)(harness.pi);
    const ctx = context(Array.from({ length: 30 }, (_, index) => ({
      role: 'user', content: `finding-${index}-${'x'.repeat(1_300)}`,
    })));
    const event = routingEvent({ prompt: 'Survey sk-exampletoken' });
    await harness.turn(event, ctx);

    const [state] = harness.classify.mock.calls[0]! as [any, unknown, unknown];
    expect(state.request).toBe('Survey [REDACTED_TOKEN]');
    expect(state.session.conversation.length).toBeLessThanOrEqual(24);
    expect(state.session.conversation.at(-1).text).toContain('finding-29-');
    expect(state.session.conversation.every(({ text }: { text: string }) => Buffer.byteLength(text) <= 1_200)).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(state.session))).toBeLessThanOrEqual(16_384);
    expect(ctx.sessionManager.buildContextEntries).toHaveBeenCalledTimes(1);

    ctx.sessionManager.buildContextEntries.mockImplementation(() => { throw new Error('Extension must use shared evidence'); });
    ctx.sessionManager.buildSessionProjection = () => { throw new Error('Extension must not scan projection'); };
    const preparation = await harness.contribution().prepare(sharedInput(), ctx, new AbortController().signal);
    expect(preparation?.state).not.toHaveProperty('conversation');
    await harness.consume(event, ctx);
    expect(ctx.sessionManager.buildContextEntries).toHaveBeenCalledTimes(1);
  });

  it('does not require a direct runtime classifier when the registry is provided', async () => {
    const harness = createHarness();
    delete (harness.pi.runtime as any).classifier;
    createSubagentsExtension(harness.host)(harness.pi);
    const event = routingEvent({ prompt: 'Survey' });
    await harness.turn(event, context());
    expect(event.systemPromptOptions.sections.subagent_routing).toBe(DISCOVERY_GUIDANCE);
  });

  it('adds no section when the registry reports no decision or classification fails', async () => {
    const harness = createHarness(async () => { throw new Error('classifier unavailable'); });
    createSubagentsExtension(harness.host)(harness.pi);
    const event = routingEvent({ prompt: 'Inspect this' });
    await harness.turn(event, context());
    expect(event.systemPromptOptions.sections).toEqual({});
    expect(harness.classify).toHaveBeenCalledTimes(1);
  });

  it('warns without injecting when result consumption fails', async () => {
    const harness = createHarness();
    createSubagentsExtension(harness.host)(harness.pi);
    harness.registry.result.mockRejectedValueOnce(new Error('registry unavailable'));
    const event = routingEvent({ prompt: 'Survey' });
    await expect(harness.consume(event, context())).resolves.toBeUndefined();
    expect(event.systemPromptOptions.sections).toEqual({});
    expect(harness.logs.find(({ msg }) => msg === 'subagent routing failed')).toMatchObject({
      level: 'warn', fields: { outcome: 'failed', error: { message: 'registry unavailable' } },
    });
  });

  it.each([
    undefined, { type: 'choice', choice: 'yes' },
    ...[-1, 2, NaN, Infinity, '0.9'].map(probability => ({ type: 'bool', probability })),
  ])('rejects incomplete or invalid discovery answers: %j', async (answer) => {
    const harness = createHarness();
    createSubagentsExtension(harness.host)(harness.pi);
    harness.registry.result.mockResolvedValueOnce({ answers: { broad_discovery: answer } } as any);
    const event = routingEvent({ prompt: 'Survey' });
    await harness.consume(event, context());
    expect(event.systemPromptOptions.sections).toEqual({});
    expect(harness.logs.find(({ msg }) => msg === 'subagent routing failed')?.fields).toMatchObject({
      outcome: 'failed', error: { message: 'Classifier returned an incomplete discovery answer' },
    });
  });

  it.each(['child', 'print', 'json'])('skips preparation and consumption for %s sessions', async (mode) => {
    const harness = createHarness();
    createSubagentsExtension(harness.host)(harness.pi);
    const ctx = { ...context([], mode === 'child'), mode: mode === 'child' ? 'interactive' : mode };
    const event = routingEvent({ prompt: 'Survey' });
    await harness.turn(event, ctx);
    expect(harness.host.list).not.toHaveBeenCalled();
    expect(harness.classify).not.toHaveBeenCalled();
    expect(harness.registry.result).not.toHaveBeenCalled();
    expect(event.systemPromptOptions.sections).toEqual({});
  });

  it('skips small repositories before listing children or classifying', async () => {
    const harness = createHarness();
    const listFiles = vi.fn(async () => ['package.json', 'src/main.ts', 'test/main.test.ts']);
    (harness.pi.runtime as any).listFiles = listFiles;
    createSubagentsExtension(harness.host)(harness.pi);
    const event = routingEvent({ prompt: 'Trace the entire repository' });
    await harness.turn(event, context());
    expect(listFiles).toHaveBeenCalledWith('.', expect.objectContaining({
      recursive: true, limit: 20, ignore: ['.git', 'node_modules', '.artifacts', 'dist'], signal: expect.any(AbortSignal),
    }));
    expect(harness.host.list).not.toHaveBeenCalled();
    expect(harness.classify).not.toHaveBeenCalled();
    expect(event.systemPromptOptions.sections).toEqual({});
    expect(harness.logs.find(({ msg }) => msg === 'subagent routing decision')?.fields).toMatchObject({
      outcome: 'skipped', reason: 'small-repository', discovery: false,
    });
  });

  it('prepares at the repository limit and tolerates unavailable file listing', async () => {
    const harness = createHarness();
    const listFiles = vi.fn(async () => Array.from({ length: 20 }, (_, index) => `file-${index}`));
    (harness.pi.runtime as any).listFiles = listFiles;
    createSubagentsExtension(harness.host)(harness.pi);
    await harness.turn(routingEvent({ prompt: 'Survey' }), context());
    listFiles.mockRejectedValueOnce(new Error('listing unavailable'));
    await harness.turn(routingEvent({ prompt: 'Survey again' }), context());
    expect(harness.classify).toHaveBeenCalledTimes(2);
  });

  it('does not classify when host listing fails', async () => {
    const harness = createHarness();
    vi.mocked(harness.host.list).mockResolvedValueOnce({ ok: false, error: { code: 'host_unavailable', message: 'host unavailable' } });
    createSubagentsExtension(harness.host)(harness.pi);
    const event = routingEvent({ prompt: 'Survey' });
    await harness.turn(event, context());
    expect(harness.classify).not.toHaveBeenCalled();
    expect(event.systemPromptOptions.sections).toEqual({});
  });

  it('awaits pending shared work and does not duplicate calls for a matching turn', async () => {
    let resolve!: (value: Awaited<ReturnType<Classifier['classify']>>) => void;
    const harness = createHarness(() => new Promise(done => { resolve = done; }));
    createSubagentsExtension(harness.host)(harness.pi);
    const ctx = context();
    const event = routingEvent({ prompt: 'Survey' });
    const request = { prompt: event.prompt, imageCount: 0 };
    harness.registry.start(request, ctx);
    harness.registry.start(request, ctx);
    const pending = harness.consume(event, ctx);
    await vi.waitFor(() => expect(harness.classify).toHaveBeenCalledTimes(1));
    expect(event.systemPromptOptions.sections).toEqual({});
    resolve({ answers: { 'subagents:broad_discovery': { type: 'bool', probability: 0.9 } } });
    await pending;
    await harness.consume(event, ctx);
    expect(harness.classify).toHaveBeenCalledTimes(1);
    expect(harness.host.list).toHaveBeenCalledTimes(1);
    expect(event.systemPromptOptions.sections.subagent_routing).toBe(DISCOVERY_GUIDANCE);
  });

  it('does not start fallback work for missing, mismatched, or finished turns', async () => {
    const harness = createHarness();
    createSubagentsExtension(harness.host)(harness.pi);
    const ctx = context();
    await harness.consume(routingEvent({ prompt: 'No started turn' }), ctx);
    expect(harness.classify).not.toHaveBeenCalled();
    harness.registry.start({ prompt: 'Survey', imageCount: 0 }, ctx);
    const changedPrompt = routingEvent({ prompt: 'expanded' });
    const changedImages = routingEvent({ prompt: 'Survey', images: [{}] });
    await harness.consume(changedPrompt, ctx);
    await harness.consume(changedImages, ctx);
    expect(changedPrompt.systemPromptOptions.sections).toEqual({});
    expect(changedImages.systemPromptOptions.sections).toEqual({});
    harness.registry.finish();
    await harness.consume(routingEvent({ prompt: 'Survey' }), ctx);
    expect(harness.classify.mock.calls.length).toBeLessThanOrEqual(1);
  });

  it.each(['before', 'files', 'children'])('respects cancellation during %s preparation', async (stage) => {
    const harness = createHarness();
    const controller = new AbortController();
    if (stage === 'before') controller.abort();
    if (stage === 'files') (harness.pi.runtime as any).listFiles = vi.fn(async () => {
      controller.abort();
      return Array.from({ length: 20 }, () => 'file');
    });
    if (stage === 'children') vi.mocked(harness.host.list).mockImplementationOnce(async () => {
      controller.abort();
      return { ok: true, value: [] };
    });
    createSubagentsExtension(harness.host)(harness.pi);
    expect(await harness.contribution().prepare(sharedInput(), context(), controller.signal)).toBeUndefined();
    if (stage !== 'children') expect(harness.host.list).not.toHaveBeenCalled();
    expect(harness.classify).not.toHaveBeenCalled();
  });

  it('leaves shutdown cancellation to the registry and does not inject stale guidance', async () => {
    let resolve!: (value: Awaited<ReturnType<Classifier['classify']>>) => void;
    const harness = createHarness(() => new Promise(done => { resolve = done; }));
    createSubagentsExtension(harness.host)(harness.pi);
    const ctx = context();
    const event = routingEvent({ prompt: 'Survey' });
    harness.registry.start({ prompt: event.prompt, imageCount: 0 }, ctx);
    const pending = harness.consume(event, ctx);
    await vi.waitFor(() => expect(harness.classify).toHaveBeenCalledTimes(1));
    const signal = harness.classify.mock.calls[0]![2]!;
    harness.registry.finish();
    expect(signal.aborted).toBe(true);
    resolve({ answers: { 'subagents:broad_discovery': { type: 'bool', probability: 0.9 } } });
    await pending;
    expect(event.systemPromptOptions.sections).toEqual({});
    expect(harness.handlers.has('session_shutdown')).toBe(false);
  });
});

function createHarness(classifier: Classifier['classify'] = async () => ({
  answers: { 'subagents:broad_discovery': { type: 'bool', probability: 0.8 }, 'other:broad_discovery': { type: 'bool', probability: 0.1 } },
  metadata: { provider: 'typesafe', model: 'jev-latest', elapsedMs: 12 },
})) {
  const handlers = new Map<string, (event: any, ctx: any) => Promise<any> | any>();
  const logs: LogRecord[] = [];
  const classify = vi.fn(classifier);
  const registry = registryStub(classify);
  const pi = createPi(classify, handlers, logs);
  (pi as any).turnClassification = registry;
  const host = createHost(catalog);
  const consume = (event: ReturnType<typeof routingEvent>, ctx: any) => handlers.get('before_agent_start')!(event, ctx);
  return {
    handlers, logs, classify, registry, pi, host, consume,
    contribution: () => registry.register.mock.calls[0]![0],
    async turn(event: ReturnType<typeof routingEvent>, ctx: any) {
      registry.start({ prompt: event.prompt, imageCount: event.images?.length ?? 0 }, ctx);
      await consume(event, ctx);
      registry.finish();
    },
  };
}

function registryStub(classify: Classifier['classify']) {
  const contributions: TurnClassificationContribution[] = [];
  let current: {
    request: TurnClassificationRequest;
    sessionId: string;
    controller: AbortController;
    results: Promise<Map<string, TurnClassificationResult>>;
  } | undefined;
  const matches = (request: TurnClassificationRequest, ctx: ExtensionContext) => current?.request.prompt === request.prompt
    && current.request.imageCount === request.imageCount && current.sessionId === ctx.sessionManager.getSessionId();
  const finish = () => { current?.controller.abort(); current = undefined; };
  return {
    register: vi.fn((contribution: TurnClassificationContribution) => { contributions.push(contribution); }),
    start(request: TurnClassificationRequest, ctx: ExtensionContext) {
      if (matches(request, ctx)) return;
      finish();
      const controller = new AbortController();
      const input = { ...request, prompt: sanitizeClassifierText(request.prompt, 4_096),
        session: collectClassifierSessionEvidence(ctx.sessionManager) };
      const results = (async () => {
        const prepared = await Promise.all(contributions.map(async contribution => {
          try { return { id: contribution.id, value: await contribution.prepare(input, ctx, controller.signal) }; }
          catch { return { id: contribution.id, value: undefined }; }
        }));
        const questions: Record<string, Parameters<Classifier['classify']>[1][string]> = {};
        const extensions: Record<string, unknown> = {};
        for (const { id, value } of prepared) {
          if (!value) continue;
          extensions[id] = value.state ?? {};
          for (const [key, question] of Object.entries(value.questions)) questions[`${id}:${key}`] = question;
        }
        const decisions = new Map<string, TurnClassificationResult>();
        if (!Object.keys(questions).length || controller.signal.aborted) return decisions;
        const response = await classify({ request: input.prompt, image_count: input.imageCount, session: input.session, extensions },
          questions, controller.signal);
        for (const { id, value } of prepared) {
          if (!value) continue;
          decisions.set(id, { ...response, answers: Object.fromEntries(Object.keys(value.questions)
            .map(key => [key, response.answers[`${id}:${key}`]!])) });
        }
        return decisions;
      })().catch(() => new Map<string, TurnClassificationResult>());
      current = { request, sessionId: ctx.sessionManager.getSessionId(), controller, results };
    },
    result: vi.fn(async (id: string, request: TurnClassificationRequest, ctx: ExtensionContext) => {
      if (!matches(request, ctx)) return undefined;
      const active = current!;
      const results = await active.results;
      return current === active && !active.controller.signal.aborted ? results.get(id) : undefined;
    }),
    finish,
  };
}

function sharedInput(): TurnClassificationInput {
  return { prompt: 'Survey', imageCount: 0, session: { conversation: [], tool_activity: [] } };
}

function createPi(
  classify: (...args: any[]) => Promise<any>,
  handlers: Map<string, (event: any, ctx: any) => Promise<any> | any>,
  logs: LogRecord[] = [],
): FelanExtensionAPI {
  return {
    runtime: {
      classifier: { classify },
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
      buildContextEntries: vi.fn(() => messages.map((message, index) => ({
        type: 'message',
        id: `message-${index}`,
        parentId: index === 0 ? null : `message-${index - 1}`,
        timestamp: '',
        message,
      }))),
    },
  };
}
