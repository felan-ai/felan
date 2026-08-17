import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExtensionContext, ToolDefinition } from '@earendil-works/pi-coding-agent';
import { describe, expect, it } from 'vitest';
import { createRuntimeCodingTools } from '../src/index.js';
import { TestAgentRuntime } from './test-agent-runtime.js';

const context = {} as ExtensionContext;

describe('runtime-backed coding tools', () => {
  it('routes file reads and writes through AgentRuntime instead of the host filesystem', async () => {
    const hostDirectory = await mkdtemp(join(tmpdir(), 'felan-runtime-tools-'));
    const runtime = new TestAgentRuntime(hostDirectory);
    const tools = toolsByName(createRuntimeCodingTools(runtime));

    try {
      await tools.write!.execute(
        'write-1',
        { path: 'nested/file.txt', content: 'runtime content' },
        undefined,
        undefined,
        context,
      );
      const result = await tools.read!.execute(
        'read-1',
        { path: 'nested/file.txt' },
        undefined,
        undefined,
        context,
      );

      await expect(runtime.readFile('nested/file.txt')).resolves.toEqual(
        new TextEncoder().encode('runtime content'),
      );
      expect(result.content).toEqual([{ type: 'text', text: 'runtime content' }]);
      await expect(access(join(hostDirectory, 'nested', 'file.txt'))).rejects.toThrow();
    } finally {
      await rm(hostDirectory, { recursive: true });
    }
  });

  it('routes shell and grep execution through runtime operations with safe argv boundaries', async () => {
    const runtime = new TestAgentRuntime('/virtual-felan-workspace', {
      shell: ({ command }) => ({ stdout: command, stderr: '', code: 0, killed: false }),
      exec: ({ command, args }) => ({
        stdout: `${command}:${JSON.stringify(args)}`,
        stderr: '',
        code: 0,
        killed: false,
      }),
    });
    const tools = toolsByName(createRuntimeCodingTools(runtime));

    await tools.bash!.execute(
      'bash-1',
      { command: 'printf "%s" "$HOME"' },
      undefined,
      undefined,
      context,
    );
    await tools.grep!.execute(
      'grep-1',
      { pattern: 'two words; $HOME', path: '.', literal: true },
      undefined,
      undefined,
      context,
    );

    expect(runtime.shellCalls[0]?.command).toBe('printf "%s" "$HOME"');
    expect(runtime.execCalls[0]).toMatchObject({
      command: 'rg',
      args: [
        '--line-number',
        '--color=never',
        '--hidden',
        '--fixed-strings',
        '--',
        'two words; $HOME',
        '.',
      ],
    });
  });

  it('accepts file grep targets and normalizes empty paths', async () => {
    const runtime = new TestAgentRuntime('/virtual-felan-workspace');
    await runtime.mkdir('nested');
    await runtime.writeFile('nested/target.ts', new TextEncoder().encode('const needle = true;'));
    const tools = toolsByName(createRuntimeCodingTools(runtime));

    await tools.grep!.execute(
      'grep-file',
      { pattern: 'needle', path: 'nested/target.ts' },
      undefined,
      undefined,
      context,
    );
    await tools.grep!.execute(
      'grep-empty-path',
      { pattern: 'needle', path: '' },
      undefined,
      undefined,
      context,
    );

    expect(runtime.execCalls.map(({ args }) => args.slice(-2))).toEqual([
      ['needle', 'nested/target.ts'],
      ['needle', '.'],
    ]);
  });

  it('validates grep targets through the runtime before execution', async () => {
    const runtime = new TestAgentRuntime('/virtual-felan-workspace');
    const tools = toolsByName(createRuntimeCodingTools(runtime));

    await expect(tools.grep!.execute(
      'grep-escape',
      { pattern: 'secret', path: '../outside.txt' },
      undefined,
      undefined,
      context,
    )).rejects.toThrow('escapes runtime cwd');
    expect(runtime.execCalls).toHaveLength(0);
  });

  it('does not infer file access from a parent directory listing', async () => {
    const runtime = new FilePolicyRuntime('/virtual-felan-workspace');
    const tools = toolsByName(createRuntimeCodingTools(runtime));

    await expect(tools.grep!.execute(
      'grep-denied-file',
      { pattern: 'secret', path: 'secret.txt' },
      undefined,
      undefined,
      context,
    )).rejects.toThrow('File access denied');
    expect(runtime.execCalls).toHaveLength(0);
  });
});

class FilePolicyRuntime extends TestAgentRuntime {
  override async readFile(path: string): Promise<Uint8Array> {
    if (path === 'secret.txt') throw new Error('File access denied');
    return super.readFile(path);
  }

  override async listFiles(
    path: string,
    options?: { recursive?: boolean },
  ): Promise<string[]> {
    if (path === 'secret.txt') throw new Error('File listing denied');
    if (path === '.') return ['secret.txt'];
    return super.listFiles(path, options);
  }
}

function toolsByName(tools: ToolDefinition<any, any, any>[]) {
  return Object.fromEntries(tools.map((tool) => [tool.name, tool])) as Record<
    string,
    ToolDefinition<any, any, any>
  >;
}
