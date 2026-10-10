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
  it('applies ultrafast and model fallback equally to root and child sessions', async () => {
    const config = { priority: 'ultrafast', fast: false };
    const originals = [vi.fn<StreamFunction>(() => endedStream()), vi.fn<StreamFunction>(() => endedStream())];
    for (const original of originals) {
      const wrapper = await createLocalCodexStreamFunctionWrapper(
        [builtinExtensionPackages.codex], runtimeWithConfig(config), '/agent', config,
      );
      for (const id of ['gpt-6-astra', 'gpt-6.1-sol', 'gpt-6-sol', 'gpt-6-astra']) {
        const model = { provider: 'openai-codex', id, api: 'openai-codex-responses' } as Model<Api>;
        wrapper!(original)(model, { systemPrompt: '', messages: [] }, { transport: 'websocket' });
      }
      expect(original.mock.calls.map((call) => call[2])).toEqual([
        { transport: 'websocket-cached', serviceTier: 'ultrafast', textVerbosity: 'low' },
        { transport: 'websocket-cached', serviceTier: 'ultrafast', textVerbosity: 'low' },
        { transport: 'websocket-cached', serviceTier: 'priority', textVerbosity: 'low' },
        { transport: 'websocket-cached', serviceTier: 'ultrafast', textVerbosity: 'low' },
      ]);
    }
  });

  it('loads the same agent config for root and nested session wrappers', async () => {
    const agentDir = '/agent';
    const config = { fast: true, verbosity: 'high', forceCachedWebSockets: true, postAgentRunCompaction: false };
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

  it('keeps explicit priorities isolated between independently configured sessions', async () => {
    const configs = [{ priority: 'ultrafast', fast: false }, { priority: 'normal', fast: true }];
    const wrappers = await Promise.all(configs.map((config) => createLocalCodexStreamFunctionWrapper(
      [builtinExtensionPackages.codex], runtimeWithConfig(config), '/agent', config,
    )));
    const originals = [vi.fn<StreamFunction>(() => endedStream()), vi.fn<StreamFunction>(() => endedStream())];
    const model = {
      provider: 'openai-codex', id: 'gpt-6-astra', api: 'openai-codex-responses',
    } as Model<Api>;
    for (const index of [0, 1, 0]) {
      wrappers[index]!(originals[index]!)(model, { systemPrompt: '', messages: [] }, { transport: 'sse' });
    }
    expect(originals[0]!.mock.calls.map((call) => call[2])).toEqual([
      { transport: 'sse', serviceTier: 'ultrafast', textVerbosity: 'low' },
      { transport: 'sse', serviceTier: 'ultrafast', textVerbosity: 'low' },
    ]);
    expect(originals[1]!.mock.calls[0]?.[2]).toEqual({
      transport: 'sse', serviceTier: 'default', textVerbosity: 'low',
    });
  });

  it('does not wrap sessions when ext-codex is disabled even with ultrafast configured', async () => {
    const config = { priority: 'ultrafast', fast: true };
    await expect(createLocalCodexStreamFunctionWrapper([], runtimeWithConfig(config), '/agent', config))
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
