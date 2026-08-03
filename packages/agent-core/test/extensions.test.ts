import type { ExtensionAPI, InlineExtension } from '@earendil-works/pi-coding-agent';
import { describe, expect, it } from 'vitest';
import {
  bindFelanExtension,
  loadFelanExtensions,
  type FelanExtensionAPI,
} from '../src/index.js';
import { TestAgentRuntime } from '../src/test-agent-runtime.js';

describe('Felan extension bridge', () => {
  it('preserves Pi method receivers, exposes the runtime, and routes exec through it', async () => {
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
      getFlag(this: { marker: string }) {
        return this.marker;
      },
    } as unknown as ExtensionAPI;
    let receivedRuntime;
    let receiverValue;
    let execOutput;
    const inline = bindFelanExtension('@felan-ai/test-extension', async (felanPi) => {
      receivedRuntime = felanPi.runtime;
      const detachedGetFlag = felanPi.getFlag;
      receiverValue = detachedGetFlag('test');
      execOutput = await felanPi.exec('literal-command', ['two words', '$HOME', ';']);
    }, runtime);

    await inlineFactory(inline)(pi);

    expect(receivedRuntime).toBe(runtime);
    expect(receiverValue).toBe('pi receiver');
    expect(JSON.parse(execOutput!.stdout)).toEqual({
      command: 'literal-command',
      args: ['two words', '$HOME', ';'],
    });
    expect(runtime.execCalls[0]).toMatchObject({
      command: 'literal-command',
      args: ['two words', '$HOME', ';'],
    });
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
