import type { ExtensionAPI, InlineExtension } from '@earendil-works/pi-coding-agent';
import { describe, expect, it, vi } from 'vitest';
import {
  associateExtensionConfig,
  bindFelanExtension,
  configField,
  createFelanServiceRegistry,
  defineExtensionConfig,
  defineServiceContract,
  loadFelanExtensions,
  type ConfiguredFelanExtension,
  type FelanExtensionAPI,
  type FelanExecutionContext,
  type StreamFunction,
} from '../src/index.js';
import { getExecutionContribution, loadFelanSessionExtensions } from '../src/extensions.js';
import type { ModelSelectionPersistenceScope } from '../src/model-selection.js';
import { TestAgentRuntime } from './test-agent-runtime.js';

describe('Felan extension bridge', () => {
  it('resolves execution once from validated configuration and restricted declared services', async () => {
    const declared = defineServiceContract<{ value: string }>('example.execution', 1);
    const undeclared = defineServiceContract<{}>('example.private', 1);
    const optional = defineServiceContract<{}>('example.optional', 1);
    const services = createFelanServiceRegistry();
    services.set(declared, { value: 'scoped' });
    services.set(undeclared, {});
    const wrapStreamFunction = vi.fn((stream: StreamFunction) => stream);
    const execution = vi.fn(({ config, services: access }: FelanExecutionContext) => {
      expect(config).toEqual({ enabled: false, mode: 'safe' });
      expect(Object.isFrozen(config)).toBe(true);
      expect(access.get(declared)).toEqual({ value: 'scoped' });
      expect(access.get(optional)).toBeUndefined();
      expect(() => access.get(undeclared)).toThrow('did not declare service');
      return { wrapStreamFunction };
    });
    const extension: ConfiguredFelanExtension = Object.assign(() => {}, {
      execution,
      serviceRequirements: { required: [declared], optional: [optional] },
    });
    associateExtensionConfig(extension, defineExtensionConfig({
      id: 'execution', title: 'Execution', fields: {
        enabled: configField.boolean({ default: true, description: 'Enabled' }),
        mode: configField.enum(['safe', 'fast'], { default: 'safe', description: 'Mode' }),
      },
    }));
    const load = (values: Record<string, unknown>) => loadFelanExtensions(
      ['example'], async () => ({ default: extension }), new TestAgentRuntime(), '/agent',
      [{ extensionId: 'execution', values, source: 'test' }], undefined, services,
    );
    await expect(load({ enabled: 'false' })).rejects.toThrow();
    expect(execution).not.toHaveBeenCalled();
    const [inline] = await load({ enabled: false });
    expect(execution).toHaveBeenCalledOnce();
    expect(getExecutionContribution(inline!)).toBeUndefined();
    await inlineFactory(inline!)({} as ExtensionAPI);
    expect(getExecutionContribution(inline!)).toEqual({ wrapStreamFunction });
    await inlineFactory(inline!)({} as ExtensionAPI);
    expect(execution).toHaveBeenCalledOnce();
    expect(wrapStreamFunction).not.toHaveBeenCalled();
  });

  it('never resolves execution for disabled packages or missing required services', async () => {
    const required = defineServiceContract<{}>('example.required', 1);
    const execution = vi.fn(() => ({}));
    const extension = Object.assign(() => {}, { execution, serviceRequirements: { required: [required] } });
    const importer = vi.fn(async () => ({ default: extension }));
    const runtime = new TestAgentRuntime();
    expect(await loadFelanExtensions([], importer, runtime)).toEqual([]);
    expect(importer).not.toHaveBeenCalled();
    expect(await loadFelanExtensions(['example'], importer, runtime)).toEqual([]);
    expect(execution).not.toHaveBeenCalled();
  });

  it('does not expose execution from an extension that fails initialization', async () => {
    const extension = Object.assign(() => { throw new Error('initialization failed'); }, {
      execution: () => ({ supportsNativeThinkingUpdates: () => true }),
    });
    const [inline] = await loadFelanExtensions(['example'], async () => ({ default: extension }), new TestAgentRuntime());
    await expect(inlineFactory(inline!)({} as ExtensionAPI)).rejects.toThrow('initialization failed');
    expect(getExecutionContribution(inline!)).toBeUndefined();
  });

  it('preserves Pi method receivers, exposes Felan context, and routes exec through it', async () => {
    const runtime = new TestAgentRuntime('/workspace', {
      exec: ({ command, args }) => ({
        stdout: JSON.stringify({ command, args }),
        stderr: '',
        code: 0,
        killed: false,
      }),
    });
    const pi = {
      marker: 'pi receiver',
      getActiveTools(this: { marker: string }) {
        return [this.marker];
      },
    } as unknown as ExtensionAPI;
    let receivedRuntime;
    let receivedAgentDir;
    let receiverValue;
    let execOutput;
    let lateRegister: FelanExtensionAPI['registerCapability'] | undefined;
    const inline = bindFelanExtension('@felan-ai/test-extension', async (felanPi) => {
      receivedRuntime = felanPi.runtime;
      receivedAgentDir = felanPi.agentDir;
      lateRegister = felanPi.registerCapability;
      const detachedGetActiveTools = felanPi.getActiveTools;
      receiverValue = detachedGetActiveTools()[0];
      execOutput = await felanPi.exec('literal-command', ['two words', '$HOME', ';']);
    }, runtime, '/agent');

    await inlineFactory(inline)(pi);

    expect(receivedRuntime).toBe(runtime);
    expect(receivedAgentDir).toBe('/agent');
    expect(receiverValue).toBe('pi receiver');
    expect(JSON.parse(execOutput!.stdout)).toEqual({
      command: 'literal-command',
      args: ['two words', '$HOME', ';'],
    });
    expect(runtime.execCalls[0]).toMatchObject({
      command: 'literal-command',
      args: ['two words', '$HOME', ';'],
    });
    expect(() => lateRegister!({ id: 'late', instructions: 'Too late' })).toThrow(
      'Capability registration from @felan-ai/test-extension is only available during initialization',
    );
  });

  it('forwards session-only model selection options through the Felan bridge', async () => {
    const setModel = vi.fn(async () => true);
    const setThinkingLevel = vi.fn();
    const runSelection = vi.fn(<T>(_updateDefault: boolean, operation: () => T): T => operation());
    const pi = {
      setModel,
      setThinkingLevel,
    } as unknown as ExtensionAPI;
    const inline = (await loadFelanSessionExtensions(
      ['@felan-ai/test-selection-extension'],
      async () => ({
        default: async (felanPi: FelanExtensionAPI) => {
          await felanPi.setModel({} as Parameters<ExtensionAPI['setModel']>[0], { updateDefault: false });
          felanPi.setThinkingLevel('medium', { updateDefault: false });
        },
      }),
      new TestAgentRuntime(),
      '/agent',
      { run: runSelection } as unknown as ModelSelectionPersistenceScope,
    ))[0]!;

    await inlineFactory(inline)(pi);

    expect(runSelection).toHaveBeenNthCalledWith(1, false, expect.any(Function));
    expect(runSelection).toHaveBeenNthCalledWith(2, false, expect.any(Function));
    expect(setModel).toHaveBeenCalledWith({});
    expect(setThinkingLevel).toHaveBeenCalledWith('medium');
  });

  it('binds savings reporting to the loaded extension package', async () => {
    const report = vi.fn(async () => {});
    const provider = {
      createReporter: vi.fn(() => ({ report })),
    };
    const inline = (await loadFelanExtensions(
      ['@felan-ai/example-extension'],
      async () => ({
        default: async (felanPi: FelanExtensionAPI) => {
          await felanPi.savings?.report({
            category: 'other',
            baseline: { costUsd: 2 },
            actual: { costUsd: 1 },
            basis: { kind: 'observed-comparison', method: 'test' },
          });
        },
      }),
      new TestAgentRuntime(),
      '/agent',
      [],
      provider,
    ))[0]!;

    await inlineFactory(inline)({} as ExtensionAPI);

    expect(provider.createReporter).toHaveBeenCalledWith('@felan-ai/example-extension');
    expect(report).toHaveBeenCalledWith(expect.objectContaining({ category: 'other' }));
  });

  it('exposes only declared services and revokes the registry with its owner', async () => {
    const runtime = new TestAgentRuntime('/workspace');
    const wanted = defineServiceContract<{ read(): string }>('example.read', 1);
    const other = defineServiceContract<{ write(): void }>('example.write', 1);
    const services = createFelanServiceRegistry();
    const implementation = { read: () => 'scoped' };
    services.set(wanted, implementation);
    const extension = Object.assign((pi: FelanExtensionAPI) => {
      expect(pi.services.get(wanted)).toBe(implementation);
      expect(() => pi.services.get(other)).toThrow('did not declare service');
    }, { serviceRequirements: { required: [wanted] } }) as ConfiguredFelanExtension;
    const inline = bindFelanExtension('@felan-ai/test-services', extension, runtime, runtime.cwd, {}, undefined, services,
      extension.serviceRequirements);
    await inlineFactory(inline)({} as ExtensionAPI);
    services.revoke();
    expect(() => services.get(wanted)).toThrow('revoked');
  });

  it('creates revocable per-session service scopes over shared provider services', () => {
    const contract = defineServiceContract<{ value: string }>('example.scoped', 1);
    const root = createFelanServiceRegistry(); root.set(contract, { value: 'root' });
    const session = root.fork();
    expect(session.get(contract)).toEqual({ value: 'root' });
    session.set(contract, { value: 'session' });
    expect(session.get(contract)).toEqual({ value: 'session' });
    expect(root.get(contract)).toEqual({ value: 'root' });
    session.revoke();
    expect(() => session.get(contract)).toThrow('revoked');
    expect(root.get(contract)).toEqual({ value: 'root' });
    root.revoke();
  });

  it('skips an extension with a missing required service and reports the exact contract', async () => {
    const required = defineServiceContract<{ run(): void }>('example.required', 2);
    const optional = defineServiceContract<{ fallback(): string }>('example.optional', 1);
    let optionalValue: unknown = 'not-read';
    const extension = Object.assign((pi: FelanExtensionAPI) => { optionalValue = pi.services.get(optional); },
      { serviceRequirements: { required: [required], optional: [optional] } }) as ConfiguredFelanExtension;
    const skipped: Array<[string, string]> = [];
    const loaded = await loadFelanExtensions(['@felan-ai/requires-service'], async () => ({ default: extension }),
      new TestAgentRuntime(), '/agent', [], undefined, createFelanServiceRegistry(),
      (packageName, contract) => skipped.push([packageName, contract]));
    expect(loaded).toEqual([]);
    expect(skipped).toEqual([['@felan-ai/requires-service', 'example.required@2']]);

    const optionalOnly = Object.assign((pi: FelanExtensionAPI) => { optionalValue = pi.services.get(optional); },
      { serviceRequirements: { optional: [optional] } }) as ConfiguredFelanExtension;
    const withoutRequired = await loadFelanExtensions(['@felan-ai/optional-service'], async () => ({ default: optionalOnly }),
      new TestAgentRuntime(), '/agent', [], undefined, createFelanServiceRegistry());
    await inlineFactory(withoutRequired[0]!)({} as ExtensionAPI);
    expect(optionalValue).toBeUndefined();
  });

  it('imports packages sequentially and retains package names on inline factories', async () => {
    const calls: string[] = [];
    const extension = (_pi: FelanExtensionAPI): void => {};
    const loaded = await loadFelanExtensions(
      ['@felan-ai/one', '@felan-ai/two'],
      async (packageName) => {
        calls.push(`start:${packageName}`);
        await Promise.resolve();
        calls.push(`end:${packageName}`);
        return { default: extension };
      },
      new TestAgentRuntime(),
    );

    expect(calls).toEqual([
      'start:@felan-ai/one',
      'end:@felan-ai/one',
      'start:@felan-ai/two',
      'end:@felan-ai/two',
    ]);
    expect(loaded.map((entry) => typeof entry === 'function' ? undefined : entry.name)).toEqual([
      '@felan-ai/one',
      '@felan-ai/two',
    ]);
  });

  it('rejects duplicates and malformed defaults with package-named diagnostics', async () => {
    const imported: string[] = [];
    await expect(loadFelanExtensions(
      ['@felan-ai/one', '@felan-ai/two', '@felan-ai/one'],
      async (packageName) => {
        imported.push(packageName);
        return { default: () => {} };
      },
      new TestAgentRuntime(),
    )).rejects.toThrow('Duplicate Felan extension package: @felan-ai/one');
    expect(imported).toEqual(['@felan-ai/one', '@felan-ai/two']);

    await expect(loadFelanExtensions(
      ['@felan-ai/malformed'],
      async () => ({ default: 'not callable' }),
      new TestAgentRuntime(),
    )).rejects.toThrow('@felan-ai/malformed must default-export a Felan extension');

    await expect(loadFelanExtensions(
      ['@felan-ai/missing'],
      async () => {
        throw new Error('module unavailable');
      },
      new TestAgentRuntime(),
    )).rejects.toThrow('Failed to import Felan extension @felan-ai/missing: module unavailable');
  });
});

function inlineFactory(extension: InlineExtension) {
  return typeof extension === 'function' ? extension : extension.factory;
}
