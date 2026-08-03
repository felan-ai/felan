import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExtensionContext, ToolDefinition } from '@earendil-works/pi-coding-agent';
import { describe, expect, it } from 'vitest';
import { createRuntimeCodingTools } from '../src/index.js';
import { TestAgentRuntime } from '../src/test-agent-runtime.js';

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
});

function toolsByName(tools: ToolDefinition<any, any, any>[]) {
  return Object.fromEntries(tools.map((tool) => [tool.name, tool])) as Record<
    string,
    ToolDefinition<any, any, any>
  >;
}
