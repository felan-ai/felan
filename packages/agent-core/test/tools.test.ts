import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExtensionContext, ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { AgentRuntime } from '../src/runtime.js';
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

  it('requests bounded output and reports runtime truncation', async () => {
    const runtime = new TestAgentRuntime('/virtual-felan-workspace', {
      shell: ({ options }) => ({
        stdout: 'x'.repeat(60_000),
        stderr: '',
        code: 0,
        killed: false,
        ...(options?.maxOutputBytes === 50 * 1024 ? { truncated: true } : {}),
      }),
      exec: ({ command, options }) => command === 'rg'
        ? {
            stdout: 'one\ntwo\nthree\n',
            stderr: '',
            code: 0,
            killed: false,
            ...(options?.maxOutputBytes === 50 * 1024 ? { truncated: true } : {}),
          }
        : { stdout: '', stderr: '', code: 0, killed: false },
    });
    const tools = toolsByName(createRuntimeCodingTools(runtime));

    const bashResult = await tools.bash!.execute(
      'bash-bounded',
      { command: 'printf output' },
      undefined,
      undefined,
      context,
    );
    const grepResult = await tools.grep!.execute(
      'grep-bounded',
      { pattern: 'needle', path: '.', limit: 2 },
      undefined,
      undefined,
      context,
    );

    expect(runtime.shellCalls[0]?.options).toMatchObject({ maxOutputBytes: 50 * 1024 });
    expect(runtime.execCalls.at(-1)?.options).toMatchObject({ maxOutputBytes: 50 * 1024 });
    expect(bashResult).toMatchObject({
      details: { outputTruncated: true, maxOutputBytes: 50 * 1024 },
    });
    expect(bashResult.content[0]).toMatchObject({
      text: expect.stringContaining('[Output truncated at 51200 bytes]'),
    });
    expect(grepResult).toMatchObject({
      details: {
        matchLimitReached: 2,
        outputTruncated: true,
        maxOutputBytes: 50 * 1024,
      },
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

  it('passes bounded search options to the runtime file listing', async () => {
    const runtime = new RecordingListRuntime('/virtual-felan-workspace');
    await runtime.mkdir('src');
    await runtime.mkdir('.git');
    await runtime.mkdir('node_modules');
    await runtime.writeFile('src/app.ts', new TextEncoder().encode('app'));
    await runtime.writeFile('src/readme.md', new TextEncoder().encode('readme'));
    await runtime.writeFile('.git/ignored.ts', new TextEncoder().encode('ignored'));
    await runtime.writeFile('node_modules/ignored.ts', new TextEncoder().encode('ignored'));
    const tools = toolsByName(createRuntimeCodingTools(runtime));

    const result = await tools.find!.execute(
      'find-1',
      { pattern: '**/*.ts', path: 'src', limit: 7 },
      undefined,
      undefined,
      context,
    );

    expect(result.content[0]).toMatchObject({ type: 'text', text: 'app.ts' });
    expect(result.content[0]).not.toMatchObject({ type: 'text', text: expect.stringContaining('readme.md') });
    expect(runtime.listFilesCalls.at(-1)).toMatchObject({
      path: expect.stringContaining('src'),
      options: {
        recursive: true,
        ignore: ['**/node_modules/**', '**/.git/**'],
        limit: 7,
        pattern: '**/*.ts',
      },
    });

    const rootResult = await tools.find!.execute(
      'find-2',
      { pattern: '**/*.ts', path: '.', limit: 7 },
      undefined,
      undefined,
      context,
    );
    expect(rootResult.content[0]).not.toMatchObject({ type: 'text', text: expect.stringContaining('.git') });
    expect(rootResult.content[0]).not.toMatchObject({ type: 'text', text: expect.stringContaining('node_modules') });

    const findSignal = new AbortController();
    await tools.find!.execute(
      'find-signal',
      { pattern: '**/*.ts', path: 'src', limit: 1 },
      findSignal.signal,
      undefined,
      context,
    );
    expect(runtime.listFilesCalls).toContainEqual(expect.objectContaining({
      options: expect.objectContaining({
        recursive: true,
        signal: findSignal.signal,
      }),
    }));

    await tools.ls!.execute(
      'ls-1',
      { path: 'src' },
      undefined,
      undefined,
      context,
    );
    expect(runtime.listFilesCalls).toContainEqual(expect.objectContaining({
      path: expect.stringContaining('src'),
      options: expect.objectContaining({ recursive: false, includeDirectories: true }),
    }));
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

class RecordingListRuntime extends TestAgentRuntime {
  readonly listFilesCalls: Array<{
    readonly path: string;
    readonly options?: Parameters<AgentRuntime['listFiles']>[1];
  }> = [];

  override async listFiles(
    path: string,
    options?: Parameters<AgentRuntime['listFiles']>[1],
  ): Promise<string[]> {
    this.listFilesCalls.push({ path, options });
    return super.listFiles(path, options);
  }
}

function toolsByName(tools: ToolDefinition<any, any, any>[]) {
  return Object.fromEntries(tools.map((tool) => [tool.name, tool])) as Record<
    string,
    ToolDefinition<any, any, any>
  >;
}
