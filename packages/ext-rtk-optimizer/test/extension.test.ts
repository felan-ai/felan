import type { ExtensionContext, FelanExtensionAPI } from '@felan-ai/agent-core';
import { describe, expect, it, vi } from 'vitest';
import { RTK_OPTIMIZER_CONFIG_FILE } from '../src/config.js';
import rtkOptimizerExtension from '../src/index.js';
import { DEFAULT_RTK_OPTIMIZER_CONFIG } from '../src/types.js';
import { MemoryRuntime, result } from './test-runtime.js';

type Handler = (event: any, ctx: ExtensionContext) => unknown;

describe('RTK optimizer extension', () => {
  it('rewrites both ordinary Bash and Codex exec_command calls', async () => {
    const runtime = rtkRuntime();
    const harness = await createHarness(runtime);
    await harness.emit('session_start', { reason: 'startup' });

    const bash = { toolName: 'bash', input: { command: 'git status' } };
    await harness.emit('tool_call', bash);
    expect(bash.input.command).toBe('rtk git status');

    const codex = { toolName: 'exec_command', input: { cmd: 'pnpm test' } };
    await harness.emit('tool_call', codex);
    expect(codex.input.cmd).toBe('rtk pnpm test');
    expect(runtime.execCalls.filter((call) => call.args[0] === 'rewrite').map((call) => call.args[1])).toEqual([
      'git status',
      'pnpm test',
    ]);
  });

  it('preserves Codex envelopes and carries commands across write_stdin sessions', async () => {
    const harness = await createHarness(rtkRuntime());
    await harness.emit('session_start', { reason: 'startup' });

    const execResults = await harness.emit('tool_result', {
      toolName: 'exec_command',
      input: { cmd: 'pnpm test' },
      content: [
        {
          type: 'text',
          text: 'Chunk ID: abc123\nWall time: 0.1 seconds\nProcess running with session ID 4242\nOutput:\n2 passed',
        },
      ],
      details: { session_id: 4242, output: '2 passed' },
      isError: false,
    });
    const execResult = execResults[0] as { content: Array<{ text: string }>; details: any };
    expect(execResult.content[0]?.text).toContain('Chunk ID: abc123');
    expect(execResult.content[0]?.text).toContain('PASS: 2 passed');
    expect(execResult.details.rtkCompaction).toMatchObject({ techniques: ['test'] });
    expect(execResult.details.output).toBe('2 passed');

    await harness.emit('agent_end', {});

    const writeResults = await harness.emit('tool_result', {
      toolName: 'write_stdin',
      input: { session_id: 4242 },
      content: [
        {
          type: 'text',
          text: 'Chunk ID: def456\nWall time: 0.2 seconds\nProcess exited with code 0\nOutput:\n3 passed',
        },
      ],
      details: { exit_code: 0, output: '3 passed' },
      isError: false,
    });
    const writeResult = writeResults[0] as { content: Array<{ text: string }> };
    expect(writeResult.content[0]?.text).toContain('Chunk ID: def456');
    expect(writeResult.content[0]?.text).toContain('PASS: 3 passed');

    const afterExit = await harness.emit('tool_result', {
      toolName: 'write_stdin',
      input: { session_id: 4242 },
      content: [
        {
          type: 'text',
          text: 'Chunk ID: end000\nWall time: 0.0 seconds\nProcess exited with code 0\nOutput:\n4 passed',
        },
      ],
      details: { exit_code: 0, output: '4 passed' },
      isError: false,
    });
    expect(afterExit[0]).toBeUndefined();
  });

  it('sanitizes streamed output from Codex command tools', async () => {
    const harness = await createHarness(rtkRuntime());
    await harness.emit('session_start', { reason: 'startup' });
    const event = {
      toolName: 'exec_command',
      partialResult: { content: [{ type: 'text', text: '\u001b[31merror\u001b[0m' }] },
    };

    await harness.emit('tool_execution_update', { ...event });

    expect(event.partialResult.content[0]?.text).toBe('error');
  });

  it('tracks an aborted Codex process from its partial session details', async () => {
    const harness = await createHarness(rtkRuntime());
    await harness.emit('session_start', { reason: 'startup' });
    await harness.emit('tool_execution_start', {
      toolCallId: 'aborted-exec',
      toolName: 'exec_command',
      args: { cmd: 'pnpm test' },
    });
    await harness.emit('tool_execution_update', {
      toolCallId: 'aborted-exec',
      toolName: 'exec_command',
      args: { cmd: 'pnpm test' },
      partialResult: { content: [], details: { session_id: 7070 } },
    });
    await harness.emit('tool_execution_end', {
      toolCallId: 'aborted-exec',
      toolName: 'exec_command',
      result: { content: [{ type: 'text', text: 'exec_command aborted' }], details: undefined },
      isError: true,
    });
    await harness.emit('agent_end', {});

    const [result] = await harness.emit('tool_result', {
      toolName: 'write_stdin',
      input: { session_id: 7070 },
      content: [{ type: 'text', text: 'Chunk ID: poll01\nOutput:\n5 passed' }],
      details: { exit_code: 0, output: '5 passed' },
      isError: false,
    });

    expect((result as { content: Array<{ text: string }> }).content[0]?.text).toContain('PASS: 5 passed');
  });

  it('guards both command tool families when RTK is unavailable', async () => {
    const runtime = new MemoryRuntime(async (_command, args) =>
      args[0] === '--version' ? result('', 127, 'not found') : result('should not run'),
    );
    const harness = await createHarness(runtime);
    await harness.emit('session_start', { reason: 'startup' });
    const event = { toolName: 'exec_command', input: { cmd: 'git status' } };

    await harness.emit('tool_call', event);

    expect(event.input.cmd).toBe('git status');
    expect(runtime.execCalls.map((call) => call.args[0])).toEqual(['--version']);
    expect(harness.notifications.some(([message]) => message.includes('rtk is unavailable'))).toBe(true);
  });

  it('suggests Codex rewrites without mutating the command', async () => {
    const runtime = rtkRuntime();
    const config = structuredClone(DEFAULT_RTK_OPTIMIZER_CONFIG);
    config.mode = 'suggest';
    runtime.files.set(RTK_OPTIMIZER_CONFIG_FILE, new TextEncoder().encode(JSON.stringify(config)));
    const harness = await createHarness(runtime);
    await harness.emit('session_start', { reason: 'startup' });
    const event = { toolName: 'exec_command', input: { cmd: 'git status' } };

    await harness.emit('tool_call', event);

    expect(event.input.cmd).toBe('git status');
    expect(harness.notifications.at(-1)).toEqual(['RTK suggestion: rtk git status', 'info']);
  });

  it('registers the /rtk command and reports runtime verification', async () => {
    const harness = await createHarness(rtkRuntime());
    const command = harness.commands.get('rtk');
    expect(command).toBeDefined();

    await command!.handler('verify', harness.ctx);

    expect(harness.notifications.at(-1)).toEqual(['RTK is available (rtk 1.0.0).', 'info']);
  });

  it('reports invalid shared configuration in headless sessions', async () => {
    const runtime = rtkRuntime();
    runtime.files.set(RTK_OPTIMIZER_CONFIG_FILE, new TextEncoder().encode('{ invalid'));
    const harness = await createHarness(runtime, false);

    await harness.emit('session_start', { reason: 'startup' });

    expect(harness.notifications).toContainEqual([
      expect.stringContaining('Invalid /agent-storage/rtk-optimizer/config.json'),
      'warning',
    ]);
  });
});

function rtkRuntime(): MemoryRuntime {
  return new MemoryRuntime(async (command, args) => {
    if (command !== 'rtk') return result('', 127, 'not found');
    if (args[0] === '--version') return result('rtk 1.0.0\n');
    if (args[0] === 'rewrite') return result(`rtk ${args[1]}\n`);
    return result('', 1, 'unsupported');
  });
}

async function createHarness(runtime: MemoryRuntime, hasUI = true) {
  const handlers = new Map<string, Handler[]>();
  const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
  const notifications: Array<[string, string | undefined]> = [];
  const ctx = {
    cwd: runtime.cwd,
    hasUI,
    ui: {
      notify: (message: string, level?: string) => notifications.push([message, level]),
      select: vi.fn(async () => undefined),
    },
  } as unknown as ExtensionContext;
  const pi = {
    runtime,
    agentDir: '/agent',
    registerCapability: vi.fn(),
    registerCommand: (name: string, command: { handler: (args: string, ctx: any) => Promise<void> }) => {
      commands.set(name, command);
    },
    on: (name: string, handler: Handler) => {
      const existing = handlers.get(name) ?? [];
      existing.push(handler);
      handlers.set(name, existing);
    },
  } as unknown as FelanExtensionAPI;
  await rtkOptimizerExtension(pi);

  return {
    ctx,
    commands,
    notifications,
    async emit(name: string, event: Record<string, unknown>): Promise<unknown[]> {
      const results: unknown[] = [];
      for (const handler of handlers.get(name) ?? []) results.push(await handler(event, ctx));
      return results;
    },
  };
}
