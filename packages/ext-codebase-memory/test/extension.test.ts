import type { ExtensionContext, FelanExtensionAPI } from '@felan-ai/agent-core';
import { describe, expect, it, vi } from 'vitest';
import codebaseMemoryExtension from '../src/index.js';
import { MemoryRuntime, result } from './test-runtime.js';

type Handler = (event: any, ctx: ExtensionContext) => unknown;

describe('Codebase Memory extension', () => {
  it('registers exactly four tools and indexes on startup when the binary exists', async () => {
    const runtime = availableRuntime();
    const harness = createHarness(runtime);
    await codebaseMemoryExtension(harness.pi);
    expect([...harness.tools.keys()]).toEqual([
      'codebase_memory', 'read_symbol', 'search_and_read_symbols', 'search_code',
    ]);
    await harness.emit('session_start', { reason: 'startup' });
    await waitFor(() => harness.status.at(-1) === 'cbm: on');
    expect(runtime.execCalls.some((call) => call.args[2] === 'index_repository')).toBe(true);
    expect(harness.status.at(-1)).toBe('cbm: on');
    const prompt = await harness.emit('before_agent_start', { systemPrompt: 'base' }) as { systemPrompt: string };
    expect(prompt.systemPrompt).toContain("index_repository");
    expect(prompt.systemPrompt).not.toContain('periodically');
  });

  it('returns from session_start promptly while startup indexing finishes asynchronously', async () => {
    let releaseIndex!: () => void;
    let startedIndex!: () => void;
    const indexStarted = new Promise<void>((resolve) => { startedIndex = resolve; });
    const runtime = availableRuntime(async () => {
      startedIndex();
      await new Promise<void>((resolve) => { releaseIndex = resolve; });
    });
    const harness = createHarness(runtime);
    await codebaseMemoryExtension(harness.pi);

    await expect(Promise.race([
      harness.emit('session_start', { reason: 'startup' }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('session_start blocked')), 50)),
    ])).resolves.toBeUndefined();
    expect(harness.status.at(-1)).toBe('cbm: idx');
    await indexStarted;

    releaseIndex();
    await waitFor(() => harness.status.at(-1) === 'cbm: on');
  });

  it('caps startup indexing at the locked twenty-minute kill budget', async () => {
    const runtime = availableRuntime();
    const harness = createHarness(runtime, { indexTimeoutMs: 9_999_999 });
    await codebaseMemoryExtension(harness.pi);

    await harness.emit('session_start', { reason: 'startup' });
    await waitFor(() => harness.status.at(-1) === 'cbm: on');

    const index = runtime.execCalls.find((call) => call.args[2] === 'index_repository');
    expect(index?.options?.timeout).toBe(20 * 60_000);
  });

  it('has zero tools when missing and shows a one-time local hint', async () => {
    const harness = createHarness(new MemoryRuntime());
    await codebaseMemoryExtension(harness.pi);
    expect(harness.tools.size).toBe(0);
    expect([...harness.commands.keys()]).toEqual(['codebase-memory']);
    await harness.emit('session_start', { reason: 'startup' });
    await harness.emit('session_start', { reason: 'reload' });
    expect(harness.notifications).toHaveLength(1);
    expect(harness.notifications[0]![0]).toContain('/codebase-memory install');
  });

  it('disabled kill switch performs no I/O or registration', async () => {
    const runtime = availableRuntime();
    const harness = createHarness(runtime, { disabled: true });
    await codebaseMemoryExtension(harness.pi);
    expect(runtime.execCalls).toHaveLength(0);
    expect(harness.tools.size).toBe(0);
    expect(harness.commands.size).toBe(0);
    expect(harness.handlers.size).toBe(0);
  });

  it('fault-isolates storage setup failure without partially registering tools or prompt hooks', async () => {
    const runtime = availableRuntime();
    runtime.mkdirError = new Error('storage unavailable');
    const harness = createHarness(runtime);

    await expect(codebaseMemoryExtension(harness.pi)).resolves.toBeUndefined();

    expect(harness.tools.size).toBe(0);
    expect([...harness.commands.keys()]).toEqual(['codebase-memory']);
    expect(harness.handlers.get('before_agent_start')).toBeUndefined();
    await harness.emit('session_start', { reason: 'startup' });
    await harness.emit('session_start', { reason: 'reload' });
    expect(harness.status.at(-1)).toBe('cbm: off');
    expect(harness.notifications).toHaveLength(1);
    expect(harness.notifications[0]![0]).toContain('/codebase-memory install');
  });

  it('logs one cloud error on session_start after storage setup failure', async () => {
    const runtime = availableRuntime();
    Object.defineProperty(runtime, 'kind', { value: 'daytona' });
    runtime.mkdirError = new Error('storage unavailable');
    const harness = createHarness(runtime);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await codebaseMemoryExtension(harness.pi);
      await harness.emit('session_start', { reason: 'startup' });
      await harness.emit('session_start', { reason: 'reload' });
      expect(error).toHaveBeenCalledOnce();
      expect(error).toHaveBeenCalledWith(expect.stringContaining('[codebase-memory] ERROR: storage unavailable'));
    } finally {
      error.mockRestore();
    }
  });

  it('fails all registered tools closed after startup indexing disables the session', async () => {
    const runtime = availableRuntime(undefined, true);
    const harness = createHarness(runtime);
    await codebaseMemoryExtension(harness.pi);
    await harness.emit('session_start', { reason: 'startup' });
    await waitFor(() => harness.status.at(-1) === 'cbm: off');
    const callsAfterFailure = runtime.execCalls.length;

    for (const [name, tool] of harness.tools) {
      await expect(tool.execute('call', toolParams(name), undefined, undefined, { cwd: runtime.cwd }))
        .rejects.toThrow('Codebase Memory is disabled for this session');
    }

    expect(runtime.execCalls).toHaveLength(callsAfterFailure);
    await expect(harness.emit('before_agent_start', { systemPrompt: 'base' })).resolves.toBeUndefined();
  });

  it('refresh command explicitly reindexes the current repository', async () => {
    const runtime = availableRuntime();
    const harness = createHarness(runtime);
    await codebaseMemoryExtension(harness.pi);
    await harness.commands.get('codebase-memory')!.handler('refresh', harness.ctx);
    expect(runtime.execCalls.filter((call) => call.args[2] === 'index_repository')).toHaveLength(1);
  });

  it('enforces the cache cap at the shared project seam for startup, proxy, and slash refresh', async () => {
    const runtime = availableRuntime();
    const harness = createHarness(runtime);
    await codebaseMemoryExtension(harness.pi);

    await harness.emit('session_start', { reason: 'startup' });
    await waitFor(() => harness.status.at(-1) === 'cbm: on');
    await harness.tools.get('codebase_memory')!.execute(
      'proxy-refresh', { command: 'index_repository' }, undefined, undefined, { cwd: runtime.cwd },
    );
    await harness.commands.get('codebase-memory')!.handler('refresh', harness.ctx);

    const relevant = runtime.execCalls.filter((call) => (
      call.command === 'du' || call.args[2] === 'index_repository'
    )).map((call) => call.command === 'du' ? 'measure' : 'index');
    expect(relevant).toEqual([
      'measure', 'index',
      'measure', 'index',
      'measure', 'index',
    ]);
  });
});

function availableRuntime(beforeIndex?: () => Promise<void>, failIndex = false): MemoryRuntime {
  return new MemoryRuntime(async (command, args) => {
    if (command === 'codebase-memory-mcp' && args[0] === '--version') return result('codebase-memory-mcp 0.10.8');
    if (command === 'git') return result('/workspace/repository');
    if (command === 'du') return result('0\t/agent-storage/codebase-memory\n');
    if (command === 'codebase-memory-mcp' && args[0] === 'cli') {
      const tool = args[2];
      if (tool === 'index_repository') {
        await beforeIndex?.();
        if (failIndex) return result('', 2, 'index failed');
      }
      const data = tool === 'list_projects' ? { projects: [] } : tool === 'index_repository' ? { project: 'repository' } : { results: [] };
      return result(JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(data) }], isError: false }));
    }
    return result('', 127);
  });
}

function toolParams(name: string): Record<string, unknown> {
  if (name === 'codebase_memory') return { command: 'search_graph' };
  if (name === 'read_symbol') return { name: 'Widget' };
  if (name === 'search_code') return { pattern: 'Widget' };
  return { name_pattern: 'Widget' };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('condition not met');
}

function createHarness(runtime: MemoryRuntime, config: Record<string, unknown> = {}) {
  const handlers = new Map<string, Handler[]>();
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const notifications: Array<[string, string | undefined]> = [];
  const status: string[] = [];
  const ctx = {
    cwd: runtime.cwd,
    signal: undefined,
    mode: 'tui',
    hasUI: true,
    ui: {
      notify: (message: string, type?: string) => notifications.push([message, type]),
      setStatus: (_key: string, text?: string) => { if (text) status.push(text); },
    },
  } as unknown as ExtensionContext;
  const pi = {
    runtime,
    config,
    on: (name: string, handler: Handler) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
    registerTool: (tool: any) => tools.set(tool.name, tool),
    registerCommand: (name: string, command: any) => commands.set(name, command),
    appendEntry: vi.fn(),
  } as unknown as FelanExtensionAPI;
  return {
    pi, handlers, tools, commands, notifications, status, ctx,
    emit: async (name: string, event: any) => {
      let returned: unknown;
      for (const handler of handlers.get(name) ?? []) returned = await handler(event, ctx) ?? returned;
      return returned;
    },
  };
}
