import type {
  Api,
  Model,
  SimpleStreamOptions,
  StreamFunction,
  Transport,
} from '@felan-ai/agent-core';
import type { CodexConfig } from './config.js';
import { supportsCodexModel, supportsCodexResponsesRequest } from './model-policy.js';

interface CodexNativeStreamOptions extends SimpleStreamOptions {
  readonly serviceTier?: 'priority';
  readonly textVerbosity?: CodexConfig['verbosity'];
}

export function resolveCodexTransport(
  transport: Transport | undefined,
  forceCachedWebSockets: boolean,
): Transport | undefined {
  return forceCachedWebSockets && transport === 'websocket'
    ? 'websocket-cached'
    : transport;
}

export function resolveCodexStreamOptions(
  model: Model<Api>,
  options: SimpleStreamOptions | undefined,
  config: CodexConfig,
): SimpleStreamOptions | undefined {
  if (!supportsCodexModel(model)) return options;

  const transport = model.provider === 'openai-codex' && model.api === 'openai-codex-responses'
    ? resolveCodexTransport(options?.transport, config.forceCachedWebSockets)
    : options?.transport;
  const responses = supportsCodexResponsesRequest(model);
  if (!responses && transport === options?.transport) return options;

  const prepared: CodexNativeStreamOptions = {
    ...options,
    ...(transport === undefined ? {} : { transport }),
    ...(responses && config.fast ? { serviceTier: 'priority' } : {}),
    ...(responses && model.api === 'openai-codex-responses'
      ? { textVerbosity: config.verbosity }
      : {}),
  };
  return prepared;
}

export function createCodexStreamFunctionWrapper(
  config: CodexConfig,
): (original: StreamFunction) => StreamFunction {
  return (original) => ((model, context, options) => original(
    model,
    context,
    resolveCodexStreamOptions(model, options, config),
  ));
}
