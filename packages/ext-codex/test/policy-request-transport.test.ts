import {
  type Api,
  type AssistantMessageEventStream,
  type Model,
  type Provider,
} from '@felan-ai/agent-core';
import { describe, expect, it, vi } from 'vitest';
import {
  applyCodexRequestOptions,
  resolveCodexTransport,
  supportsCodexModel,
  wrapOpenAICodexProvider,
} from '../src/index.js';

describe('Codex model policy', () => {
  it.each([
    ['openai', 'gpt-5.4', true],
    ['openai-codex', 'gpt-5.3-codex', true],
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
      { fast: true, verbosity: 'medium', forceCachedWebSockets: true },
    )).toEqual({
      model: model.id,
      service_tier: 'priority',
      text: { format: { type: 'text' }, verbosity: 'medium' },
    });
  });

  it('leaves non-GPT, other-provider, and non-Responses requests untouched', () => {
    const config = { fast: true, verbosity: 'high', forceCachedWebSockets: true } as const;
    for (const model of [
      { provider: 'anthropic', id: 'gpt-5.4', api: 'openai-responses' },
      { provider: 'openai', id: 'o3', api: 'openai-responses' },
      { provider: 'openai', id: 'gpt-5.4', api: 'openai-completions' },
    ] as Model<Api>[]) {
      expect(applyCodexRequestOptions({ untouched: true }, { model }, config)).toBeUndefined();
    }
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

  it('prewarms and delegates to Pi native streams with upgraded options', async () => {
    const endedStream = () => {
      return {
        async *[Symbol.asyncIterator]() {},
      } as unknown as AssistantMessageEventStream;
    };
    const nativeStream = vi.fn((..._args: unknown[]) => endedStream());
    const nativeSimple = vi.fn((..._args: unknown[]) => endedStream());
    const native = {
      id: 'openai-codex',
      name: 'OpenAI Codex',
      auth: {} as Provider['auth'],
      getModels: () => [],
      stream: nativeStream,
      streamSimple: nativeSimple,
    } as unknown as Provider;
    const wrapped = wrapOpenAICodexProvider(native, {
      fast: false,
      verbosity: 'low',
      forceCachedWebSockets: true,
    });

    for await (const _event of wrapped.stream(
      { id: 'gpt-5.3-codex' } as Model<Api>,
      { messages: [] },
      { transport: 'websocket', sessionId: 'session-1' } as never,
    )) {}
    for await (const _event of wrapped.streamSimple(
      { id: 'gpt-5.3-codex' } as Model<Api>,
      { messages: [] },
      { transport: 'auto', sessionId: 'session-1' },
    )) {}

    expect(nativeStream.mock.calls[0]?.[2]).toMatchObject({ transport: 'websocket-cached' });
    const prewarmPayload = await (nativeStream.mock.calls[0]?.[2] as {
      onPayload: (payload: unknown, model: Model<Api>) => Promise<unknown>;
    }).onPayload({ input: [] }, {} as Model<Api>);
    expect(prewarmPayload).toEqual({ input: [], generate: false });
    expect(nativeStream.mock.calls[1]?.[2]).toMatchObject({ transport: 'websocket-cached' });
    expect(nativeSimple.mock.calls[0]?.[2]).toMatchObject({ transport: 'auto' });

    for await (const _event of wrapped.stream(
      { id: 'gpt-5.3-codex' } as Model<Api>,
      { messages: [] },
      { transport: 'sse', sessionId: 'session-2' } as never,
    )) {}
    expect(nativeStream).toHaveBeenCalledTimes(3);
    expect(nativeStream.mock.calls[2]?.[2]).toMatchObject({ transport: 'sse' });
  });
});
