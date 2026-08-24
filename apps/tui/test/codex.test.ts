import type {
  AgentRuntime,
  Api,
  AssistantMessageEventStream,
  Model,
  StreamFunction,
} from '@felan-ai/agent-core';
import { describe, expect, it, vi } from 'vitest';
import { builtinExtensionPackages } from '../src/extensions.js';
import { createLocalCodexStreamFunctionWrapper } from '../src/codex.js';

describe('local Codex stream composition', () => {
  it('loads the same agent config for root and nested session wrappers', async () => {
    const agentDir = '/agent';
    const config = { fast: true, verbosity: 'high', forceCachedWebSockets: true };
    const rootRuntime = runtimeWithConfig(config);
    const childRuntime = runtimeWithConfig(config);
    const rootOriginal = vi.fn<StreamFunction>(() => endedStream());
    const childOriginal = vi.fn<StreamFunction>(() => endedStream());
    const packages = [builtinExtensionPackages.codex];

    const rootWrapper = await createLocalCodexStreamFunctionWrapper(packages, rootRuntime, agentDir, config);
    const childWrapper = await createLocalCodexStreamFunctionWrapper(packages, childRuntime, agentDir, config);
    const model = {
      provider: 'openai-codex',
      id: 'gpt-5.3-codex',
      api: 'openai-codex-responses',
    } as Model<Api>;
    rootWrapper!(rootOriginal)(model, { systemPrompt: '', messages: [] }, { transport: 'websocket' });
    childWrapper!(childOriginal)(model, { systemPrompt: '', messages: [] }, { transport: 'websocket' });

    expect(rootOriginal.mock.calls[0]?.[2]).toMatchObject({
      transport: 'websocket-cached', serviceTier: 'priority', textVerbosity: 'high',
    });
    expect(childOriginal.mock.calls[0]?.[2]).toEqual(rootOriginal.mock.calls[0]?.[2]);
  });

  it('does not wrap sessions when ext-codex is disabled', async () => {
    await expect(createLocalCodexStreamFunctionWrapper([], runtimeWithConfig({}), '/agent'))
      .resolves.toBeUndefined();
  });
});

function runtimeWithConfig(config: unknown): AgentRuntime {
  const unused = async (): Promise<never> => { throw new Error('unused'); };
  return {
    kind: 'host',
    cwd: '/workspace',
    storage: () => ({ root: '/storage', readFile: unused, writeFile: unused, listFiles: unused, mkdir: unused, remove: unused }),
    exec: unused,
    shell: unused,
    readFile: unused,
    writeFile: unused,
    listFiles: unused,
    mkdir: unused,
    remove: unused,
    readAgentFile: async () => new TextEncoder().encode(JSON.stringify(config)),
  };
}

function endedStream(): AssistantMessageEventStream {
  return { async *[Symbol.asyncIterator]() {} } as unknown as AssistantMessageEventStream;
}
