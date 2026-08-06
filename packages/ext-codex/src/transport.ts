import {
  lazyStream,
  type Api,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type Provider,
  type SimpleStreamOptions,
  type Transport,
} from '@felan-ai/agent-core';
import type { CodexConfig } from './config.js';

export function resolveCodexTransport(
  transport: Transport | undefined,
  forceCachedWebSockets: boolean,
): Transport | undefined {
  return forceCachedWebSockets && transport === 'websocket'
    ? 'websocket-cached'
    : transport;
}

export function wrapOpenAICodexProvider(
  provider: Provider,
  config: CodexConfig,
): Provider {
  const prewarms = new Map<string, Promise<void>>();

  const prewarm = async (
    model: Model<Api>,
    context: Context,
    options: Parameters<Provider['stream']>[2],
    simple: boolean,
  ): Promise<void> => {
    if (!config.forceCachedWebSockets || !options?.sessionId) return;
    const transport = resolveCodexTransport(options.transport ?? 'auto', true)!;
    if (transport === 'sse' || transport === 'websocket') return;
    const key = `${options.sessionId}:${model.id}:${simple ? 'simple' : 'full'}`;
    let pending = prewarms.get(key);
    if (!pending) {
      const prewarmOptions = {
        ...options,
        transport,
        onPayload: async (payload: unknown, currentModel: Model<Api>) => {
          const prepared = await options.onPayload?.(payload, currentModel) ?? payload;
          return isRecord(prepared) ? { ...prepared, generate: false } : prepared;
        },
      };
      pending = consumePrewarm(() => simple
        ? provider.streamSimple(model, context, prewarmOptions as SimpleStreamOptions)
        : provider.stream(model, context, prewarmOptions as never)).catch((error: unknown) => {
        prewarms.delete(key);
        if (options.signal?.aborted) throw error;
      });
      prewarms.set(key, pending);
    }
    await pending;
  };

  return {
    ...provider,
    stream<T extends Api>(
      model: Model<T>,
      context: Context,
      options?: Parameters<Provider['stream']>[2],
    ): AssistantMessageEventStream {
      const transport = resolveCodexTransport(options?.transport, config.forceCachedWebSockets);
      const wrappedOptions = transport === undefined ? options : { ...options, transport };
      if (!wrappedOptions) return provider.stream(model, context, wrappedOptions as never);
      return lazyStream(model, async () => {
        await prewarm(model, context, wrappedOptions as never, false);
        return provider.stream(model, context, wrappedOptions as never);
      });
    },
    streamSimple(
      model: Model<Api>,
      context: Context,
      options?: SimpleStreamOptions,
    ): AssistantMessageEventStream {
      const transport = resolveCodexTransport(options?.transport, config.forceCachedWebSockets);
      const wrappedOptions = transport === undefined ? options : { ...options, transport };
      if (!wrappedOptions) return provider.streamSimple(model, context, wrappedOptions);
      return lazyStream(model, async () => {
        await prewarm(model, context, wrappedOptions as never, true);
        return provider.streamSimple(model, context, wrappedOptions);
      });
    },
  };
}

async function consumePrewarm(
  createStream: () => AssistantMessageEventStream,
): Promise<void> {
  for await (const event of createStream()) {
    if (event.type === 'error') throw new Error(event.error.errorMessage ?? 'OpenAI Codex prewarm failed');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
