import { join } from 'node:path';
import {
  createUnavailableExtensionUi,
  type AgentRuntime,
  type AgentRuntimeProcess,
  type ExtensionContext,
  type FelanExtensionAPI,
  type ToolDefinition,
} from '@felan-ai/agent-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runForegroundCommand } from '../src/foreground.js';
import { createBackgroundBashExtension } from '../src/index.js';
import { getBackgroundBashRoot } from '../src/job-store.js';
import { BackgroundBashManager } from '../src/process-manager.js';

vi.mock('../src/foreground.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/foreground.js')>(),
  runForegroundCommand: vi.fn(),
}));

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
  vi.mocked(runForegroundCommand).mockReset();
});

describe('foreground bash routing', () => {
  it.each([
    { config: undefined, timeout: undefined, expected: 120_000 },
    { config: 4.5, timeout: undefined, expected: 4_500 },
    { config: 4.5, timeout: 0.25, expected: 250 },
  ])('passes the resolved timeout $expected and unchanged command to the foreground runner', async ({ config, timeout, expected }) => {
    const f = await fixture({ config });
    const command = "export RTK_DB_PATH='/tmp/rtk.db'; rtk git status";
    const controller = new AbortController();
    const result = await f.bash({ command, ...(timeout === undefined ? {} : { timeout }) }, controller.signal);
    expect(runForegroundCommand).toHaveBeenCalledExactlyOnceWith(f.runtime, command, {
      timeoutMs: expected, signal: controller.signal,
      spillDir: join(getBackgroundBashRoot('/storage', '/workspace'), 'output'),
      storage: expect.objectContaining({ root: '/storage' }),
    });
    expect(result.details).toEqual({ background: false, exitCode: 0, truncated: false });
    expect(f.start).not.toHaveBeenCalled();
  });

  it('formats a truncated foreground result without a spill path or exit code', async () => {
    const f = await fixture();
    vi.mocked(runForegroundCommand).mockResolvedValue({ kind: 'exited', output: '', signal: 'SIGTERM', truncated: true });
    const result = await f.bash({ command: 'command' });
    expect(result).toEqual({
      content: [{ type: 'text', text: 'Exit: SIGTERM\n\n(no output)\n\n[Output truncated to the last 2000 lines / 50 KB]' }],
      details: { background: false, signal: 'SIGTERM', truncated: true },
    });
  });

  it.each([false, true])('terminates and disposes the child if promotion fails, termination failure: %s', async terminationFails => {
    const f = await fixture();
    const failure = new Error('promotion failed');
    const terminate = vi.fn<AgentRuntimeProcess['terminate']>(async () => {
      if (terminationFails) throw new Error('termination failed');
    });
    const dispose = vi.fn<AgentRuntimeProcess['dispose']>(async () => {});
    const process = { terminate, dispose } as unknown as AgentRuntimeProcess;
    vi.mocked(runForegroundCommand).mockResolvedValue({ kind: 'timeout', process, startedAt: 42 });
    const promote = vi.spyOn(BackgroundBashManager.prototype, 'promote').mockRejectedValue(failure);
    await expect(f.bash({ command: 'command' })).rejects.toBe(failure);
    expect(promote).toHaveBeenCalledExactlyOnceWith('command', process, 42);
    expect(terminate).toHaveBeenCalledExactlyOnceWith('SIGTERM');
    expect(dispose).toHaveBeenCalledOnce();
    expect(f.start).not.toHaveBeenCalled();
  });

  it('rejects an already-cancelled call before starting a process', async () => {
    const f = await fixture();
    const controller = new AbortController();
    controller.abort();
    await expect(f.bash({ command: 'command' }, controller.signal)).rejects.toThrow('Command cancelled');
    expect(runForegroundCommand).not.toHaveBeenCalled();
    expect(f.start).not.toHaveBeenCalled();
  });

  it('leaves stock bash active when the runtime has no in-process shell service', async () => {
    const f = await fixture({ processes: false });
    expect(f.tools.size).toBe(0);
    expect(f.shell).not.toHaveBeenCalled();
  });
});

async function fixture(options: { config?: number | undefined; processes?: boolean } = {}) {
  const tools = new Map<string, ToolDefinition>();
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
  const start = vi.spyOn(BackgroundBashManager.prototype, 'start');
  const shell = vi.fn(async () => ({ code: 0, stdout: '', stderr: '', killed: false }));
  const runtime = {
    cwd: '/workspace', shell,
    storage: () => ({ root: '/storage' }),
    ...(options.processes === false ? {} : { processes: { startShell: vi.fn() } }),
  } as unknown as AgentRuntime;
  let activeTools = ['bash'];
  const pi = {
    runtime, ui: createUnavailableExtensionUi(),
    config: { foregroundTimeoutSeconds: options.config },
    registerShortcut() {}, registerCommand() {}, registerMessageRenderer() {}, sendMessage() {},
    registerTool(tool: ToolDefinition) { tools.set(tool.name, tool); },
    getActiveTools: () => activeTools,
    setActiveTools: (names: string[]) => { activeTools = names; },
    on(name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) { handlers.set(name, handler); },
  } as unknown as FelanExtensionAPI;
  const ctx = { mode: 'print', cwd: runtime.cwd } as unknown as ExtensionContext;
  await createBackgroundBashExtension()(pi);
  cleanups.push(async () => { await handlers.get('session_shutdown')?.({ reason: 'shutdown' }, ctx); });
  vi.mocked(runForegroundCommand).mockResolvedValue({ kind: 'exited', output: 'output', exitCode: 0, truncated: false });
  await handlers.get('session_start')?.({}, ctx);
  return {
    runtime, tools, start, shell,
    bash: (params: Record<string, unknown>, signal?: AbortSignal) => tools.get('bash')!.execute(
      'test-bash', params, signal, undefined, ctx as Parameters<ToolDefinition['execute']>[4],
    ),
  };
}
