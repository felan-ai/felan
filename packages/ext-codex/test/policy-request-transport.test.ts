import {
  type Api,
  type AssistantMessageEventStream,
  type Model,
  normalizeContext,
  type StreamFunction,
} from '@felan-ai/agent-core';
import { describe, expect, it, vi } from 'vitest';
import {
  applyCodexRequestOptions,
  DEFAULT_CODEX_CONFIG,
  type CodexPriority,
  createCodexStreamFunctionWrapper,
  resolveCodexTransport,
  resolveCodexStreamOptions,
  supportsCodexModel,
} from '../src/index.js';

describe('Codex service priority', () => {
  const choices = [
    [undefined, false, undefined, undefined],
    [undefined, true, 'priority', 'priority'],
    ['normal', true, 'default', 'default'],
    ['normal', false, 'default', 'default'],
    ['fast', false, 'priority', 'priority'],
    ['fast', true, 'priority', 'priority'],
    ['ultrafast', false, 'ultrafast', 'priority'],
    ['ultrafast', true, 'ultrafast', 'priority'],
  ] as const;
  for (const [provider, api] of [
    ['openai', 'openai-responses'],
    ['openai', 'openai-codex-responses'],
    ['openai-codex', 'openai-codex-responses'],
  ] as const) {
    it.each(choices)('resolves %s with legacy fast=%s consistently on ' + provider + '/' + api,
      (priority, fast, supportedTier, fallbackTier) => {
        const config = { ...DEFAULT_CODEX_CONFIG, fast, ...(priority === undefined ? {} : { priority }) };
        for (const [id, expectedTier] of [
          ['gpt-6-astra', supportedTier],
          ['gpt-6.1-sol', fallbackTier],
          ['gpt-5.6-sol', fallbackTier],
          ['gpt-unknown', fallbackTier],
        ] as const) {
          const model = responseModel(provider, id, api);
          const payload = Object.freeze({ model: id, reasoning: { effort: 'high' } });
          expect(applyCodexRequestOptions(payload, { model }, config)).toEqual({
            ...payload,
            ...(expectedTier === undefined ? {} : { service_tier: expectedTier }),
            text: { verbosity: 'low' },
          });
          for (const transport of ['sse', 'websocket'] as const) {
            const options = Object.freeze({ transport });
            const prepared = resolveCodexStreamOptions(model, options, config);
            if (expectedTier === undefined) expect(prepared).not.toHaveProperty('serviceTier');
            else expect(prepared).toMatchObject({ serviceTier: expectedTier });
            expect(options).toEqual({ transport });
          }
          expect(payload).not.toHaveProperty('service_tier');
        }
      });
  }

  it('explicit normal overrides existing premium routing while omitted priority preserves it', () => {
    const model = responseModel('openai-codex', 'gpt-6-astra', 'openai-codex-responses');
    const options = { serviceTier: 'ultrafast', transport: 'sse' as const };
    const payload = { service_tier: 'ultrafast' };
    expect(resolveCodexStreamOptions(model, options, { ...DEFAULT_CODEX_CONFIG, priority: 'normal' }))
      .toMatchObject({ serviceTier: 'default' });
    expect(applyCodexRequestOptions(payload, { model }, { ...DEFAULT_CODEX_CONFIG, priority: 'normal' }))
      .toMatchObject({ service_tier: 'default' });
    expect(resolveCodexStreamOptions(model, options, DEFAULT_CODEX_CONFIG))
      .toMatchObject({ serviceTier: 'ultrafast' });
    expect(applyCodexRequestOptions(payload, { model }, DEFAULT_CODEX_CONFIG))
      .toMatchObject({ service_tier: 'ultrafast' });
    expect(options.serviceTier).toBe('ultrafast');
    expect(payload.service_tier).toBe('ultrafast');
  });

  it.each(['normal', 'fast', 'ultrafast'] as const)('does not change ineligible requests for %s', (priority: CodexPriority) => {
    const config = { ...DEFAULT_CODEX_CONFIG, priority };
    for (const model of [
      responseModel('custom', 'gpt-6-astra', 'openai-responses'),
      responseModel('openai', 'o3', 'openai-responses'),
      responseModel('openai', 'gpt-6-astra', 'openai-completions'),
    ]) {
      const options = { transport: 'sse' as const };
      expect(resolveCodexStreamOptions(model, options, config)).toBe(options);
      expect(applyCodexRequestOptions({}, { model }, config)).toBeUndefined();
    }
  });
});

describe('Codex model policy', () => {
  it.each([
    ['openai', 'gpt-5.4', true],
    ['openai-codex', 'gpt-5.3-codex', true],
    ['openai-codex', 'gpt-6-astra', true],
    ['openai', 'o3', false],
    ['openai-codex', 'codex-mini', false],
    ['custom', 'gpt-5.4', false],
    ['OpenAI', 'gpt-5.4', false],
  ] as const)('handles %s/%s', (provider, id, expected) => {
    expect(supportsCodexModel({ provider, id } as Model<Api>)).toBe(expected);
  });

  it('requires a selected model', () => {
    expect(supportsCodexModel(undefined)).toBe(false);
  });
});

describe('OpenAI request options', () => {
  it('adds fast mode and merges verbosity into eligible Responses payloads', () => {
    const model = { provider: 'openai', id: 'gpt-5.4', api: 'openai-responses' } as Model<Api>;
    expect(applyCodexRequestOptions(
      { model: model.id, text: { format: { type: 'text' } } },
      { model },
      { fast: true, verbosity: 'medium', forceCachedWebSockets: true, postAgentRunCompaction: false },
    )).toEqual({
      model: model.id,
      service_tier: 'priority',
      text: { format: { type: 'text' }, verbosity: 'medium' },
    });
  });

  it('leaves non-GPT, other-provider, and non-Responses requests untouched', () => {
    const config = { fast: true, verbosity: 'high', forceCachedWebSockets: true, postAgentRunCompaction: false } as const;
    for (const model of [
      { provider: 'anthropic', id: 'gpt-5.4', api: 'openai-responses' },
      { provider: 'openai', id: 'o3', api: 'openai-responses' },
      { provider: 'openai', id: 'gpt-5.4', api: 'openai-completions' },
    ] as Model<Api>[]) {
      expect(applyCodexRequestOptions({ untouched: true }, { model }, config)).toBeUndefined();
    }
  });

  it.each([
    ['openai', 'openai-responses'],
    ['openai-codex', 'openai-codex-responses'],
  ] as const)('normalizes nullable strictness for %s/%s function tools', (provider, api) => {
    const model = { provider, id: 'gpt-6-astra', api } as Model<Api>;
    const payload = {
      model: model.id,
      tools: [
        { type: 'function', name: 'optional', strict: null, parameters: {} },
        { type: 'function', name: 'strict', strict: true, parameters: {} },
        { type: 'function', name: 'loose', strict: false, parameters: {} },
        { type: 'function', name: 'absent', parameters: {} },
        { type: 'custom', name: 'grammar', strict: null, format: { type: 'grammar' } },
        { type: 'web_search_preview', strict: null },
      ],
    };

    const result = applyCodexRequestOptions(payload, { model }, {
      fast: false,
      verbosity: 'high',
      forceCachedWebSockets: true,
      postAgentRunCompaction: false,
    }) as typeof payload & { text: { verbosity: string } };

    expect(result.tools).toEqual([
      { type: 'function', name: 'optional', strict: false, parameters: {} },
      { type: 'function', name: 'strict', strict: true, parameters: {} },
      { type: 'function', name: 'loose', strict: false, parameters: {} },
      { type: 'function', name: 'absent', parameters: {} },
      { type: 'custom', name: 'grammar', strict: null, format: { type: 'grammar' } },
      { type: 'web_search_preview', strict: null },
    ]);
    expect(result.text).toEqual({ verbosity: 'high' });
    expect(payload.tools[0]).toEqual({
      type: 'function', name: 'optional', strict: null, parameters: {},
    });
  });

  it('does not normalize malformed or already-compatible tool payloads', () => {
    const model = { provider: 'openai', id: 'gpt-5.4', api: 'openai-responses' } as Model<Api>;
    const noNull = { tools: [{ type: 'function', name: 'tool', strict: false }] };
    const malformed = { tools: 'not-an-array' };

    expect(applyCodexRequestOptions(noNull, { model }, {
      fast: false, verbosity: 'low', forceCachedWebSockets: true, postAgentRunCompaction: false,
    })).toMatchObject({ tools: noNull.tools });
    expect(applyCodexRequestOptions(malformed, { model }, {
      fast: false, verbosity: 'low', forceCachedWebSockets: true, postAgentRunCompaction: false,
    })).toMatchObject(malformed);
  });

  it('does not normalize tools for an ineligible model or non-object payload', () => {
    const payload = { tools: [{ type: 'function', strict: null }] };
    const config = {
      fast: false, verbosity: 'low', forceCachedWebSockets: true, postAgentRunCompaction: false,
    } as const;
    expect(applyCodexRequestOptions(payload, {
      model: { provider: 'anthropic', id: 'gpt-6-astra', api: 'openai-responses' } as Model<Api>,
    }, config)).toBeUndefined();
    expect(applyCodexRequestOptions(null, {
      model: { provider: 'openai', id: 'gpt-6-astra', api: 'openai-responses' } as Model<Api>,
    }, config)).toBeUndefined();
  });
});

describe('OpenAI Codex transport policy', () => {
  it.each([
    ['websocket', true, 'websocket-cached'],
    ['websocket', false, 'websocket'],
    ['websocket-cached', true, 'websocket-cached'],
    ['sse', true, 'sse'],
    ['auto', true, 'auto'],
    [undefined, true, undefined],
  ] as const)('maps %s with force=%s', (transport, force, expected) => {
    expect(resolveCodexTransport(transport, force)).toBe(expected);
  });

  it('sets native options only for eligible requests', () => {
    const config = { fast: true, verbosity: 'high', forceCachedWebSockets: true, postAgentRunCompaction: false } as const;
    expect(resolveCodexStreamOptions(
      responseModel('openai-codex', 'gpt-5.3-codex', 'openai-codex-responses'),
      { transport: 'websocket', sessionId: 'session-1' },
      config,
    )).toMatchObject({
      transport: 'websocket-cached',
      sessionId: 'session-1',
      serviceTier: 'priority',
      textVerbosity: 'high',
    });
    expect(resolveCodexStreamOptions(
      responseModel('openai', 'gpt-5.4', 'openai-responses'),
      { transport: 'websocket' },
      config,
    )).toEqual({ transport: 'websocket', serviceTier: 'priority' });
    const ineligible = { transport: 'websocket' as const };
    expect(resolveCodexStreamOptions(
      responseModel('custom', 'gpt-5.4', 'openai-responses'),
      ineligible,
      config,
    )).toBe(ineligible);
    expect(resolveCodexStreamOptions(
      responseModel('openai-codex', 'gpt-5.3-codex', 'openai-completions'),
      { transport: 'websocket' },
      config,
    )).toEqual({ transport: 'websocket' });
    expect(resolveCodexStreamOptions(
      responseModel('openai-codex', 'gpt-6-astra', 'openai-codex-responses'),
      { transport: 'websocket' },
      config,
    )).toMatchObject({
      transport: 'websocket-cached', serviceTier: 'priority', textVerbosity: 'high',
    });
  });

  it('wraps each session independently without extra provider calls', () => {
    const first = vi.fn<StreamFunction>(() => endedStream());
    const second = vi.fn<StreamFunction>(() => endedStream());
    const firstWrapped = createCodexStreamFunctionWrapper({
      fast: true,
      verbosity: 'high',
      forceCachedWebSockets: true,
      postAgentRunCompaction: false,
    })(first);
    const secondWrapped = createCodexStreamFunctionWrapper({
      fast: false,
      verbosity: 'low',
      forceCachedWebSockets: false,
      postAgentRunCompaction: false,
    })(second);
    const model = responseModel('openai-codex', 'gpt-5.3-codex', 'openai-codex-responses');

    const context = normalizeContext({ messages: [] });
    firstWrapped(model, context, { transport: 'websocket' });
    secondWrapped(model, context, { transport: 'websocket' });
    firstWrapped(model, context, { transport: 'sse' });

    expect(first).toHaveBeenCalledTimes(2);
    expect(first.mock.calls[0]?.[2]).toMatchObject({
      transport: 'websocket-cached', serviceTier: 'priority', textVerbosity: 'high',
    });
    expect(first.mock.calls[1]?.[2]).toMatchObject({ transport: 'sse' });
    expect(second).toHaveBeenCalledTimes(1);
    expect(second.mock.calls[0]?.[2]).toMatchObject({
      transport: 'websocket', textVerbosity: 'low',
    });
  });
});

function responseModel(provider: string, id: string, api: string): Model<Api> {
  return { provider, id, api } as Model<Api>;
}

function endedStream(): AssistantMessageEventStream {
  return { async *[Symbol.asyncIterator]() {} } as unknown as AssistantMessageEventStream;
}
