import type {
  ExtensionContext,
  FelanExtensionAPI,
  ToolDefinition,
} from '@felan-ai/agent-core';
import { Check } from 'typebox/value';
import { describe, expect, it, vi } from 'vitest';
import {
  createAskUserExtension,
  normalizeAskUserRequest,
  type AskUserHost,
} from '../src/index.js';

describe('@felan-ai/ext-ask-user core', () => {
  it('registers the capability, schema, sequential tool, and prompt guidance', () => {
    const harness = createHarness(answeringHost());
    const tool = harness.tool;

    expect(tool.name).toBe('ask_user');
    expect(tool.executionMode).toBe('sequential');
    expect(tool.promptGuidelines).toEqual(expect.arrayContaining([expect.stringContaining('questions[]')]));
    expect(harness.capabilities).toEqual([
      expect.objectContaining({ id: 'ask-user', instructions: expect.stringContaining('ambiguous') }),
    ]);
    const schema = tool.parameters as any;
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties.questions.maxItems).toBe(4);
    expect(schema.properties.displayMode).toMatchObject({
      type: 'string',
      enum: ['overlay', 'inline'],
    });
    expect(schema.properties.singleSelectLayout).toMatchObject({
      type: 'string',
      enum: ['auto', 'list'],
    });
    for (const optionsSchema of [
      schema.properties.options,
      schema.properties.questions.items.properties.options,
    ]) {
      expect(optionsSchema.items).toMatchObject({
        type: 'object',
        required: ['title'],
        additionalProperties: false,
      });
      expect(optionsSchema.items.anyOf).toBeUndefined();
    }
    expect(schema.properties.overlayToggleKey.anyOf).toBeUndefined();
  });

  it('normalizes defaults, inherited wizard values, and stable ids', () => {
    const normalized = normalizeAskUserRequest({
      context: ' Shared context ',
      options: [' Alpha ', { title: 'Beta', description: ' Second ' }],
      allowComment: true,
      singleSelectLayout: 'list',
      questions: [
        { question: ' First? ', header: ' Scope ' },
        { question: 'Second?', allowMultiple: true, allowFreeform: false },
      ],
    });

    expect(normalized).toEqual({
      ok: true,
      value: {
        singleSelectLayout: 'list',
        questions: [
          {
            id: 'q1',
            question: 'First?',
            header: 'Scope',
            context: 'Shared context',
            options: [{ title: 'Alpha' }, { title: 'Beta', description: 'Second' }],
            allowMultiple: false,
            allowFreeform: true,
            allowComment: true,
          },
          {
            id: 'q2',
            question: 'Second?',
            header: 'Q2',
            context: 'Shared context',
            options: [{ title: 'Alpha' }, { title: 'Beta', description: 'Second' }],
            allowMultiple: true,
            allowFreeform: false,
            allowComment: true,
          },
        ],
      },
    });
  });

  it('coerces legacy primitives and common proxy aliases', () => {
    const normalized = normalizeAskUserRequest({
      question: 'Pick?',
      options: [
        ' Legacy string ',
        7,
        false,
        { label: 'Label alias', description: ' Detail ' },
        { text: 'Text alias' },
        { value: 'Value alias' },
        { name: 'Name alias' },
        { option: 'Option alias' },
      ],
    });

    expect(normalized).toMatchObject({
      ok: true,
      value: {
        questions: [{
          options: [
            { title: 'Legacy string' },
            { title: '7' },
            { title: 'false' },
            { title: 'Label alias', description: 'Detail' },
            { title: 'Text alias' },
            { title: 'Value alias' },
            { title: 'Name alias' },
            { title: 'Option alias' },
          ],
        }],
      },
    });
  });

  it('prepares legacy and proxy option shapes before tool-schema validation', () => {
    const tool = createHarness(answeringHost()).tool;
    const prepared = tool.prepareArguments?.({
      question: 'Pick?',
      options: ['Legacy', { label: 'Alias' }, false],
      questions: [{ question: 'Nested?', options: [{ text: 'Nested alias' }] }],
    });

    expect(prepared).toMatchObject({
      options: [{ title: 'Legacy' }, { title: 'Alias' }, { title: 'false' }],
      questions: [{ options: [{ title: 'Nested alias' }] }],
    });
    expect(Check(tool.parameters, prepared)).toBe(true);
  });

  it('returns a clear validation error for an unusable option', () => {
    expect(normalizeAskUserRequest({
      question: 'Pick?',
      options: [{ label: 'Valid' }, {}],
    })).toEqual({
      ok: false,
      error: 'Option 2 is unusable: expected a string, number, boolean, or an object with a non-empty title, label, text, value, name, or option',
    });
  });

  it('delegates normalized requests and returns answered details', async () => {
    const ask = vi.fn<AskUserHost['ask']>(async (request, context) => {
      context.reportProgress([{ questionId: 'q1', response: { kind: 'selection', selections: ['Beta'] } }]);
      return {
        status: 'answered',
        answers: [{ questionId: 'q1', response: { kind: 'selection', selections: ['beta'], comment: ' because ' } }],
      };
    });
    const harness = createHarness({ ask });
    const updates: unknown[] = [];
    const result = await harness.execute({ question: 'Pick?', options: ['Alpha', 'Beta'], allowComment: true }, undefined, (update) => updates.push(update));

    expect(ask).toHaveBeenCalledOnce();
    expect(ask.mock.calls[0]![0].questions[0]).toMatchObject({ id: 'q1', allowFreeform: true });
    expect(ask.mock.calls[0]![1]).toMatchObject({ requestId: 'call', sessionId: 'session-1' });
    expect(result.content[0]).toMatchObject({ text: 'User answered: Beta — because' });
    expect(result.details).toMatchObject({
      kind: 'single',
      status: 'answered',
      response: { kind: 'selection', selections: ['Beta'], comment: 'because' },
    });
    expect(updates).toHaveLength(2);
    expect((updates[1] as any).content[0].text).toContain('1/1 answered');
  });

  it.each([
    [{ status: 'cancelled', reason: 'user' }, 'User cancelled the question', false],
    [{ status: 'cancelled', reason: 'unavailable', message: 'No UI' }, 'No UI', true],
    [
      { status: 'deferred', message: 'Output <no_response/>.', interactionId: 'ask-12' },
      "Question sent to the user (interaction: ask-12). Output <no_response/>. End this turn without taking further action and wait for the user's response in a new turn.",
      false,
    ],
  ] as const)('renders %s outcomes', async (outcome, text, isError) => {
    const harness = createHarness({ ask: async () => outcome });
    const result = await harness.execute({ question: 'Continue?' });
    expect(result.content[0]).toMatchObject({ text });
    expect(Boolean((result as any).isError)).toBe(isError);
  });

  it('rejects invalid and incomplete host answers', async () => {
    const harness = createHarness({
      ask: async () => ({
        status: 'answered',
        answers: [{ questionId: 'q1', response: { kind: 'selection', selections: ['Unknown'] } }],
      }),
    });
    const result = await harness.execute({ question: 'Pick?', options: ['Known'] });
    expect((result as any).isError).toBe(true);
    expect(result.content[0]).toMatchObject({ text: expect.stringContaining('unknown option') });
  });

  it('requires a correlation id for deferred delivery', async () => {
    const harness = createHarness({
      ask: async () => ({ status: 'deferred' } as any),
    });
    const result = await harness.execute({ question: 'Continue?' });
    expect((result as any).isError).toBe(true);
    expect(result.content[0]).toMatchObject({ text: expect.stringContaining('interaction id') });
  });

  it('aborts while the host is pending', async () => {
    const controller = new AbortController();
    const started = vi.fn();
    const harness = createHarness({
      ask: async () => {
        started();
        return new Promise(() => {});
      },
    });
    const pending = harness.execute({ question: 'Continue?' }, controller.signal);
    await vi.waitFor(() => expect(started).toHaveBeenCalled());
    controller.abort();
    const result = await pending;
    expect(result.content[0]).toMatchObject({ text: 'Ask-user prompt was aborted' });
    expect(result.details).toMatchObject({ status: 'cancelled', reason: 'abort' });
  });
});

function answeringHost(): AskUserHost {
  return {
    ask: async (request) => ({
      status: 'answered',
      answers: request.questions.map((question) => ({
        questionId: question.id,
        response: { kind: 'freeform', text: 'answer' },
      })),
    }),
  };
}

function createHarness(host: AskUserHost) {
  let tool!: ToolDefinition<any, any, any>;
  const capabilities: Array<{ id: string; instructions: string }> = [];
  const pi = {
    registerCapability: (capability: { id: string; instructions: string }) => capabilities.push(capability),
    registerTool: (definition: ToolDefinition<any, any, any>) => {
      tool = definition;
    },
  } as unknown as FelanExtensionAPI;
  createAskUserExtension(host)(pi);
  const context = {
    mode: 'print',
    hasUI: false,
    ui: {},
    sessionManager: { getSessionId: () => 'session-1' },
  } as unknown as ExtensionContext;
  return {
    capabilities,
    get tool() {
      return tool;
    },
    execute(
      params: Record<string, unknown>,
      signal?: AbortSignal,
      update?: (value: unknown) => void,
    ) {
      return tool.execute('call', params, signal, update as any, context);
    },
  };
}
