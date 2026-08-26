import type { ExtensionContext, FelanExtensionAPI } from '@felan-ai/agent-core';
import { describe, expect, it, vi } from 'vitest';
import rtkOptimizerExtension from '../src/index.js';
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

  it('stores a recovery copy before returning truncated output', async () => {
    const runtime = rtkRuntime();
    const harness = await createHarness(runtime, true, { truncateMaxChars: 120 });
    const original = `HEAD\n${'middle\n'.repeat(80)}TAIL`;
    const [result] = await harness.emit('tool_result', {
      toolName: 'bash',
      input: { command: 'echo output' },
      content: [{ type: 'text', text: original }],
      details: undefined,
      isError: false,
    });

    const output = result as { content: Array<{ text: string }>; details: { rtkCompaction: { recoveryPath: string } } };
    expect(output.content[0]?.text).toContain('HEAD');
    expect(output.content[0]?.text).toContain('TAIL');
    const recoveryPath = output.details.rtkCompaction.recoveryPath;
    expect(recoveryPath).toContain('/agent-storage/rtk-optimizer/recovery/');
    expect([...runtime.files.values()].some((value) => new TextDecoder().decode(value) === original)).toBe(true);
  });

  it('does not support the former metric subcommands', async () => {
    const harness = await createHarness(rtkRuntime());
    const command = harness.commands.get('rtk')!;
    const completions = command.getArgumentCompletions?.('') ?? [];
    expect(completions.map(({ value }) => value)).not.toContain('stats');
    expect(completions.map(({ value }) => value)).not.toContain('clear-stats');

    await command.handler('stats', harness.ctx);
    expect(harness.notifications.at(-1)).toEqual([
      'Usage: /rtk [show|verify|install|help]',
      'warning',
    ]);
  });

  it('reports final post-tool payloads through the Felan savings reporter', async () => {
    const reported: unknown[] = [];
    const harness = await createHarness(rtkRuntime(), true, { truncateMaxChars: 120 }, {
      report: async (measurement: unknown) => { reported.push(measurement); },
    });
    const original = `HEAD\n${'middle\n'.repeat(80)}TAIL`;
    await harness.emit('tool_result', {
      toolName: 'bash',
      input: { command: 'echo output' },
      content: [{ type: 'text', text: original }],
      isError: false,
    });
    await Promise.resolve();
    expect(reported).toHaveLength(1);
    expect(reported[0]).toMatchObject({
      category: 'output-optimization',
      operation: 'post-tool-compaction',
      basis: { method: 'utf8-bytes/4-ceil-v1' },
      dimensions: { tool: 'bash' },
    });
    const measurement = reported[0] as any;
    expect(measurement.baseline.tokens.input).toBeGreaterThan(measurement.actual.tokens.input);
  });

  it('reports session RTK command-output savings separately at shutdown', async () => {
    const reported: any[] = [];
    const runtime = new MemoryRuntime(async (command, args) => {
      if (command === 'rtk' && args[0] === '--version') return result('rtk 1.0.0\n');
      if (command === 'rtk' && args[0] === 'rewrite') return result('rtk git status\n');
      if (command === '/usr/bin/env' && args.includes('gain')) {
        return result(JSON.stringify({
          summary: {
            total_commands: 1,
            total_input: 100,
            total_output: 25,
            total_saved: 75,
          },
        }));
      }
      return result('', 1, 'unexpected');
    });
    const harness = await createHarness(runtime, true, {}, {
      report: async (measurement: unknown) => { reported.push(measurement); },
    });
    await harness.emit('session_start', { reason: 'startup' });
    const call = { toolName: 'bash', toolCallId: 'bash-1', input: { command: 'git status' } };
    await harness.emit('tool_call', call);
    expect(call.input.command).toContain('RTK_DB_PATH=');

    await harness.emit('tool_result', {
      toolName: 'bash',
      toolCallId: 'bash-1',
      input: call.input,
      content: [{ type: 'text', text: 'filtered status' }],
      details: undefined,
      isError: false,
    });
    await Promise.resolve();

    expect(reported.map((measurement) => measurement.operation)).toEqual(['post-tool-compaction']);
    await harness.emit('session_shutdown', { reason: 'quit' });
    expect(reported.map((measurement) => measurement.operation)).toEqual([
      'post-tool-compaction',
      'rtk-command-output',
    ]);
    expect(reported[1]).toMatchObject({
      category: 'output-optimization',
      basis: { kind: 'observed-comparison', method: 'rtk-tracking-byte4-v1' },
      calls: 1,
      baseline: { tokens: { input: 100, output: 0 } },
      actual: { tokens: { input: 25, output: 0 } },
    });
  });

  it('queries one aggregate for multiple rewritten commands in a session', async () => {
    const reported: any[] = [];
    const runtime = new MemoryRuntime(async (command, args) => {
      if (command === 'rtk' && args[0] === '--version') return result('rtk 1.0.0\n');
      if (command === 'rtk' && args[0] === 'rewrite') return result(`rtk ${args[1]}\n`);
      if (command === '/usr/bin/env' && args.includes('gain')) {
        return result(JSON.stringify({ summary: { total_commands: 2, total_input: 100, total_output: 40, total_saved: 60 } }));
      }
      return result('', 1, 'unexpected');
    });
    const harness = await createHarness(runtime, true, {}, {
      report: async (measurement: unknown) => { reported.push(measurement); },
    });
    await harness.emit('session_start', { reason: 'startup' });
    for (const [toolCallId, command] of [['one', 'git status'], ['two', 'git diff']] as const) {
      const call = { toolName: 'bash', toolCallId, input: { command } };
      await harness.emit('tool_call', call);
      await harness.emit('tool_result', {
        toolName: 'bash',
        toolCallId,
        input: call.input,
        content: [{ type: 'text', text: 'filtered' }],
        details: undefined,
        isError: false,
      });
    }
    await harness.emit('session_shutdown', { reason: 'quit' });
    expect(runtime.execCalls.filter((entry) => entry.args.includes('gain'))).toHaveLength(1);
    expect(reported.find(({ operation }) => operation === 'rtk-command-output')).toMatchObject({
      calls: 2,
      baseline: { tokens: { input: 100 } },
      actual: { tokens: { input: 40 } },
    });
  });

  it('keeps shutdown aggregates attributed to their model shards', async () => {
    const reported: any[] = [];
    const runtime = new MemoryRuntime(async (command, args) => {
      if (command === 'rtk' && args[0] === '--version') return result('rtk 1.0.0\n');
      if (command === 'rtk' && args[0] === 'rewrite') return result(`rtk ${args[1]}\n`);
      if (command === '/usr/bin/env' && args.includes('gain')) {
        return result(JSON.stringify({ summary: { total_commands: 1, total_input: 10, total_output: 5, total_saved: 5 } }));
      }
      return result('', 1, 'unexpected');
    });
    const harness = await createHarness(runtime, true, {}, {
      report: async (measurement: unknown) => { reported.push(measurement); },
    }, { provider: 'openai', id: 'cheap' });
    await harness.emit('session_start', { reason: 'startup' });
    const first = { toolName: 'bash', toolCallId: 'cheap', input: { command: 'git status' } };
    await harness.emit('tool_call', first);
    await harness.emit('tool_result', { ...first, content: [{ type: 'text', text: 'ok' }], isError: false });
    (harness.ctx as any).model = { provider: 'openai', id: 'expensive' };
    const second = { toolName: 'bash', toolCallId: 'expensive', input: { command: 'git diff' } };
    await harness.emit('tool_call', second);
    await harness.emit('tool_result', { ...second, content: [{ type: 'text', text: 'ok' }], isError: false });
    await harness.emit('session_shutdown', { reason: 'quit' });
    expect(runtime.execCalls.filter((entry) => entry.args.includes('gain'))).toHaveLength(2);
    expect(reported.filter(({ operation }) => operation === 'rtk-command-output').map(({ baseline }) => baseline.model.id))
      .toEqual(expect.arrayContaining(['cheap', 'expensive']));
  });

  it('waits for the final Codex write_stdin result and reports RTK savings once', async () => {
    const reported: any[] = [];
    const runtime = new MemoryRuntime(async (command, args) => {
      if (command === 'rtk' && args[0] === '--version') return result('rtk 1.0.0\n');
      if (command === 'rtk' && args[0] === 'rewrite') return result('rtk pnpm test\n');
      if (command === '/usr/bin/env' && args.includes('gain')) {
        return result(JSON.stringify({ summary: { total_commands: 1, total_input: 80, total_output: 20, total_saved: 60 } }));
      }
      return result('', 1, 'unexpected');
    });
    const harness = await createHarness(runtime, true, {}, {
      report: async (measurement: unknown) => { reported.push(measurement); },
    });
    await harness.emit('session_start', { reason: 'startup' });
    const call = { toolName: 'exec_command', toolCallId: 'exec-1', input: { cmd: 'pnpm test' } };
    await harness.emit('tool_call', call);
    await harness.emit('tool_execution_start', {
      toolName: 'exec_command',
      toolCallId: 'exec-1',
      args: { cmd: 'pnpm test' },
    });
    await harness.emit('tool_execution_update', {
      toolName: 'exec_command',
      toolCallId: 'exec-1',
      partialResult: { details: { session_id: 4242 } },
    });
    await harness.emit('tool_result', {
      toolName: 'exec_command',
      toolCallId: 'exec-1',
      input: call.input,
      content: [{ type: 'text', text: 'Process running with session ID 4242\nOutput:\nprogress' }],
      details: { session_id: 4242, output: 'progress' },
      isError: false,
    });
    expect(runtime.execCalls.filter((entry) => entry.args.includes('gain'))).toHaveLength(0);

    await harness.emit('tool_result', {
      toolName: 'write_stdin',
      input: { session_id: 4242 },
      content: [{ type: 'text', text: 'Process exited with code 0\nOutput:\ncomplete' }],
      details: { exit_code: 0, output: 'complete' },
      isError: false,
    });
    await Promise.resolve();
    expect(reported.filter(({ operation }) => operation === 'rtk-command-output')).toHaveLength(0);

    await harness.emit('tool_result', {
      toolName: 'write_stdin',
      input: { session_id: 4242 },
      content: [{ type: 'text', text: 'complete again' }],
      details: { exit_code: 0, output: 'complete again' },
      isError: false,
    });
    await harness.emit('session_shutdown', { reason: 'quit' });
    expect(runtime.execCalls.filter((entry) => entry.args.includes('gain'))).toHaveLength(1);
    expect(reported.filter(({ operation }) => operation === 'rtk-command-output')).toHaveLength(1);
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
    expect(runtime.execCalls.map((call) => call.args[0])).toEqual(['--version', '--version']);
    expect(harness.notifications.some(([message]) => message.includes('rtk is unavailable'))).toBe(true);
  });

  it('suggests Codex rewrites without mutating the command', async () => {
    const runtime = rtkRuntime();
    const harness = await createHarness(runtime, true, { mode: 'suggest' });
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

  it('exposes explicit managed installation without running it at startup', async () => {
    const runtime = rtkRuntime();
    const harness = await createHarness(runtime);
    expect(runtime.execCalls).toEqual([]);

    await harness.commands.get('rtk')!.handler('install', harness.ctx);

    expect(runtime.execCalls.some((call) => call.command === 'curl')).toBe(true);
    expect(harness.notifications.at(-1)?.[0]).toContain('RTK installation failed');
    expect(harness.statuses.at(-1)).toEqual(['rtk-install', undefined]);
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

async function createHarness(runtime: MemoryRuntime, hasUI = true, config: Record<string, unknown> = {}, savings?: { report(measurement: unknown): Promise<void> }, model?: { provider: string; id: string }) {
  const handlers = new Map<string, Handler[]>();
  type Command = {
    handler: (args: string, ctx: any) => Promise<void>;
    getArgumentCompletions?: (prefix: string) => Array<{ value: string }> | null;
  };
  const commands = new Map<string, Command>();
  const notifications: Array<[string, string | undefined]> = [];
  const statuses: Array<[string, string | undefined]> = [];
  const ctx = {
    cwd: runtime.cwd,
    hasUI,
    model,
    ui: {
      notify: (message: string, level?: string) => notifications.push([message, level]),
      select: vi.fn(async () => undefined),
      setStatus: (key: string, value: string | undefined) => statuses.push([key, value]),
    },
  } as unknown as ExtensionContext;
  const pi = {
    runtime,
    agentDir: '/agent',
    config,
    ...(savings === undefined ? {} : { savings }),
    registerCapability: vi.fn(),
    registerCommand: (name: string, command: Command) => {
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
    statuses,
    async emit(name: string, event: Record<string, unknown>): Promise<unknown[]> {
      const results: unknown[] = [];
      for (const handler of handlers.get(name) ?? []) results.push(await handler(event, ctx));
      return results;
    },
  };
}
