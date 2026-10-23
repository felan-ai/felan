import type {
  AgentRuntime,
  Api,
  AssistantMessageEventStream,
  ConfiguredFelanExtension,
  ExtensionConfigOverride,
  FelanExecutionContribution,
  Model,
  StreamFunction,
} from '@felan-ai/agent-core';
import { createExtensionServiceAccess, createFelanServiceRegistry, createSilentLogger, getExtensionConfigDefinition, loadFelanExtensions, resolveExtensionConfigs } from '@felan-ai/agent-core';
import { describe, expect, it, vi } from 'vitest';
import { builtinExtensionPackages, importLocalExtension } from '../../src/providers/extensions.js';
import type { ExtensionPackageImporter } from '@felan-ai/agent-core';

describe('Codex package execution contribution', () => {
  it('applies ultrafast and model fallback equally to root and child sessions', async () => {
    const config = { priority: 'ultrafast', fast: false };
    const originals = [vi.fn<StreamFunction>(() => endedStream()), vi.fn<StreamFunction>(() => endedStream())];
    const importers = sessionImporters();
    for (const [index, original] of originals.entries()) {
      const { wrapStreamFunction: wrapper } = await executionContribution(importers[index]!, config);
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
    const config = { fast: true, verbosity: 'high', forceCachedWebSockets: true, postAgentRunCompaction: false };
    const rootOriginal = vi.fn<StreamFunction>(() => endedStream());
    const childOriginal = vi.fn<StreamFunction>(() => endedStream());
    const [root, child] = sessionImporters();
    const { wrapStreamFunction: rootWrapper } = await executionContribution(root!, config);
    const { wrapStreamFunction: childWrapper } = await executionContribution(child!, config);
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
    const importers = sessionImporters();
    const wrappers = await Promise.all(configs.map(async (config, index) => (
      await executionContribution(importers[index]!, config)
    ).wrapStreamFunction));
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
    for (const importer of sessionImporters()) {
      const importExtension = vi.fn(importer);
      await expect(loadFelanExtensions([], importExtension, runtimeWithConfig(config), '/agent', [
        { extensionId: 'codex', values: config, source: 'test' },
      ], undefined, createFelanServiceRegistry())).resolves.toEqual([]);
      expect(importExtension).not.toHaveBeenCalled();
    }
  });

  it('rejects invalid config and declares native thinking support without a daemon-specific wrapper', async () => {
    const [importer] = sessionImporters();
    await expect(executionContribution(importer!, { priority: 'invalid' })).rejects.toThrow();
    const contribution = await executionContribution(importer!, {});
    expect(contribution.supportsNativeThinkingUpdates?.({
      provider: 'openai-codex', id: 'gpt-6-astra', api: 'openai-codex-responses',
    } as Model<Api>)).toBe(true);
    expect(contribution.supportsNativeThinkingUpdates?.({
      provider: 'other', id: 'gpt-6-astra', api: 'openai-completions',
    } as Model<Api>)).toBe(false);
  });
});

function sessionImporters(): readonly ExtensionPackageImporter[] {
  return [
    importLocalExtension,
    importLocalExtension,
  ];
}

async function executionContribution(
  importer: ExtensionPackageImporter,
  values: ExtensionConfigOverride['values'],
): Promise<FelanExecutionContribution> {
  const imported = await importer(builtinExtensionPackages.codex) as { default: ConfiguredFelanExtension };
  const definition = getExtensionConfigDefinition(imported.default);
  expect(definition?.id).toBe('codex');
  const config = resolveExtensionConfigs([definition!], [{ extensionId: 'codex', values, source: 'test' }]).get('codex')!;
  expect(imported.default.execution).toBeTypeOf('function');
  return imported.default.execution!({
    config,
    services: createExtensionServiceAccess(createFelanServiceRegistry(), imported.default.serviceRequirements ?? {}),
  });
}

function runtimeWithConfig(config: unknown): AgentRuntime {
  const unused = async (): Promise<never> => { throw new Error('unused'); };
  return {
    kind: 'host',
    cwd: '/workspace',
    logger: createSilentLogger(),
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
