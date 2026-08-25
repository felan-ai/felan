import type { ExtensionAPI, InlineExtension } from '@earendil-works/pi-coding-agent';
import { describe, expect, it, vi } from 'vitest';
import {
  bindFelanExtension,
  loadFelanExtensions,
  type FelanExtensionAPI,
} from '../src/index.js';
import { loadFelanSessionExtensions } from '../src/extensions.js';
import type { ModelSelectionPersistenceScope } from '../src/model-selection.js';
import { TestAgentRuntime } from './test-agent-runtime.js';

describe('Felan extension bridge', () => {
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
