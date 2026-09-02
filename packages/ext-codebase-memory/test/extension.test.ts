import type { ExtensionContext, FelanExtensionAPI, ToolDefinition } from '@felan-ai/agent-core';
import { describe, expect, it, vi } from 'vitest';
import codebaseMemoryExtension, {
  CODEBASE_MEMORY_CAPABILITY_INSTRUCTIONS,
  createCodebaseMemoryExtension,
} from '../src/index.js';
import { codebaseMemoryRuntimeDirectory } from '../src/runtime-path.js';
import { envelope, MemoryRuntime, result } from './test-runtime.js';

type Handler = (event: any, ctx: ExtensionContext) => unknown;

describe('Codebase Memory extension', () => {
  it('gates all model-visible behavior on a compatible binary and gives one local hint', async () => {
    const runtime = new MemoryRuntime('host', false);
    const harness = await createHarness(runtime);

    expect(harness.tools).toEqual([]);
    expect(harness.capabilities).toEqual([]);
    expect(harness.commands).toEqual(['codebase-memory']);

    await harness.emit('session_start', { reason: 'startup' });
    await harness.emit('session_start', { reason: 'reload' });
    expect(harness.notifications).toEqual([[
      'Codebase Memory is unavailable. Run /codebase-memory install to install the reviewed binary.',
      'info',
    ]]);
  });

  it('logs a hard cloud error but remains a silent nonfatal no-op when the binary is missing', async () => {
    const log = vi.fn();
    const harness = await createHarness(
      new MemoryRuntime('daytona', false),
      createCodebaseMemoryExtension({ log }),
    );

    expect(harness.tools).toEqual([]);
    expect(harness.capabilities).toEqual([]);
    expect(harness.notifications).toEqual([]);
    expect(log).toHaveBeenCalledWith('error', expect.stringContaining('unavailable'), expect.any(Object));
  });

  it('emits cache telemetry through the cloud log by default', async () => {
    const log = vi.fn();
    const runtime = new MemoryRuntime('daytona', true, async (command) => {
      if (command.includes('index_repository')) return result(envelope({ status: 'indexed', project: 'fixture' }));
      if (command.includes('list_projects')) {
        return result(envelope({ projects: [{ name: 'fixture', root_path: '/work/repo', size_bytes: 123 }] }));
      }
      return result(envelope({}));
    });
    const harness = await createHarness(runtime, createCodebaseMemoryExtension({ log }));
    runtime.files.set('codebase-memory/cache/fixture/data', new Uint8Array(123));

    await harness.emit('session_start', { reason: 'startup' });

    await vi.waitFor(() => {
      expect(log).toHaveBeenCalledWith('info', 'telemetry.cache_size', expect.objectContaining({ bytes: 123 }));
    });
  });

  it('rejects an unreviewed binary version', async () => {
    const runtime = new MemoryRuntime('host', true);
    runtime.version = '0.10.2';
    const harness = await createHarness(runtime);

    expect(harness.tools).toEqual([]);
    expect(harness.capabilities).toEqual([]);
  });

  it('registers exactly four tools, background startup indexing, accurate freshness guidance, and explicit refresh paths', async () => {
    const telemetry = vi.fn();
    const runtime = new MemoryRuntime('host', true, async (command) => {
      if (command.includes('index_repository')) return result(envelope({ status: 'indexed', project: 'fixture' }));
      if (command.includes('list_projects')) return result(envelope({ projects: [{ name: 'fixture', root_path: '/work/repo', size_bytes: 123 }] }));
      if (command.includes('search_graph')) return result(envelope({ results: [{ qualified_name: 'fixture.src.answer' }] }));
      if (command.includes('get_code_snippet')) return result(envelope({ code: 'export const answer = 42;' }));
      return result(envelope({ results: [] }));
    });
    const harness = await createHarness(runtime, createCodebaseMemoryExtension({ telemetry }));
    runtime.files.set('codebase-memory/cache/fixture/data', new Uint8Array(123));

    expect(harness.tools.map((tool) => tool.name)).toEqual([
      'codebase_memory',
      'read_symbol',
      'search_and_read_symbols',
      'search_code',
    ]);
    expect(harness.capabilities).toEqual([{
      id: 'codebase-memory',
      instructions: CODEBASE_MEMORY_CAPABILITY_INSTRUCTIONS,
    }]);
    expect(CODEBASE_MEMORY_CAPABILITY_INSTRUCTIONS).toContain('may be stale');
    expect(CODEBASE_MEMORY_CAPABILITY_INSTRUCTIONS).toContain('background index');
    expect(CODEBASE_MEMORY_CAPABILITY_INSTRUCTIONS).not.toMatch(/watch|periodic/iu);

    await harness.emit('session_start', { reason: 'startup' });
    await vi.waitFor(() => {
      expect(runtime.shellCalls.some((call) => call.command.includes('index_repository'))).toBe(true);
      expect(telemetry).toHaveBeenCalledWith('cache_size', expect.objectContaining({ bytes: 123 }));
    });
    expect(harness.statuses.at(-1)).toEqual(['codebase-memory', undefined]);
    const runtimeDirectory = codebaseMemoryRuntimeDirectory('/agent-storage');
    expect(runtime.shellCalls[0]?.options?.env).toEqual(expect.objectContaining({
      CBM_CACHE_DIR: '/agent-storage/codebase-memory/cache',
      CBM_RUNTIME_DIR: runtimeDirectory.root,
    }));
    expect(runtime.shellCalls[0]?.command).toContain("cli --json 'index_repository'");

    await execute(harness.tools[0]!, { command: 'index_repository' });
    await harness.commandHandlers.get('codebase-memory')?.('', harness.context);
    expect(runtime.shellCalls.filter((call) => call.command.includes('index_repository'))).toHaveLength(3);
    expect(telemetry).toHaveBeenCalledWith('cache_size', expect.objectContaining({ bytes: 123 }));
  });

  it('renders concise search and symbol targets in tool call lines', async () => {
    const harness = await createHarness(new MemoryRuntime());

    expect(renderedCall(harness.tools[0]!, {
      command: 'search_graph',
      arguments: { query: 'authentication flow' },
    })).toBe('codebase_memory search_graph · authentication flow');
    expect(renderedCall(harness.tools[1]!, {
      name: 'authorizeRequest',
      file_path: 'src/auth.ts',
    })).toBe('read_symbol authorizeRequest · src/auth.ts');
    expect(renderedCall(harness.tools[2]!, {
      query: 'session validation',
      file_pattern: 'src/**/*.ts',
    })).toBe('search_and_read_symbols session validation · src/**/*.ts');
    expect(renderedCall(harness.tools[3]!, {
      pattern: 'SESSION_SECRET',
      path_filter: 'config',
    })).toBe('search_code SESSION_SECRET · config');

    const unsafeDetail = renderedCall(harness.tools[3]!, {
      pattern: `line one\n${'x'.repeat(150)}\u001b[31m`,
    }).slice('search_code '.length);
    expect(unsafeDetail).not.toMatch(/[\n\u001b]/u);
    expect([...unsafeDetail]).toHaveLength(120);
    expect(unsafeDetail.endsWith('…')).toBe(true);
  });

  it('does not await startup indexing and shows a compact status only while active', async () => {
    let finishIndexing!: (value: ReturnType<typeof result>) => void;
    const indexing = new Promise<ReturnType<typeof result>>((resolve) => { finishIndexing = resolve; });
    let markIndexingStarted!: () => void;
    const indexingStarted = new Promise<void>((resolve) => { markIndexingStarted = resolve; });
    const runtime = new MemoryRuntime('host', true, async (command) => {
      if (command.includes('index_repository')) {
        markIndexingStarted();
        return indexing;
      }
      if (command.includes('list_projects')) {
        return result(envelope({ projects: [{ name: 'fixture', root_path: '/work/repo' }] }));
      }
      return result(envelope({}));
    }, '/agent-storage/background-index');
    const harness = await createHarness(runtime);

    await expect(harness.emit('session_start', { reason: 'startup' })).resolves.toBeUndefined();
    await indexingStarted;
    expect(harness.statuses.at(-1)).toEqual(['codebase-memory', 'cbm: idx']);

    finishIndexing(result(envelope({ status: 'indexed', project: 'fixture' })));
    await vi.waitFor(() => {
      expect(harness.statuses).toEqual([
        ['codebase-memory', 'cbm: idx'],
        ['codebase-memory', undefined],
      ]);
    });
  });

  it('clears the compact status when background indexing fails', async () => {
    const runtime = new MemoryRuntime('host', true, async (command) => command.includes('index_repository')
      ? result('', 1, 'index failed')
      : result(envelope({})));
    const harness = await createHarness(runtime);

    await harness.emit('session_start', { reason: 'startup' });
    await vi.waitFor(() => {
      expect(harness.notifications.at(-1)?.[0]).toContain('Codebase Memory index failed');
    });
    expect(harness.statuses).toEqual([
      ['codebase-memory', 'cbm: idx'],
      ['codebase-memory', undefined],
    ]);
  });

  it('keeps scoped POSIX coordination below the Darwin Unix socket path limit', () => {
    const longStorageRoot = `/Users/test/${'deeply-nested/'.repeat(20)}agent`;
    const runtimeDirectory = codebaseMemoryRuntimeDirectory(longStorageRoot);
    const maximumDarwinSocketPath = `/private${runtimeDirectory.root}/cbm-daemon-4294967295/cbm-0123456789abcdef.sock`;

    expect(runtimeDirectory.storagePath).toBeUndefined();
    expect(runtimeDirectory.root).toMatch(/^\/tmp\/felan-cbm-[a-f0-9]{24}$/u);
    expect(new TextEncoder().encode(maximumDarwinSocketPath)).toHaveLength(95);
    expect(codebaseMemoryRuntimeDirectory(longStorageRoot)).toEqual(runtimeDirectory);
    expect(codebaseMemoryRuntimeDirectory(`${longStorageRoot}-other`).root).not.toBe(runtimeDirectory.root);
  });

  it('keeps Windows coordination in scoped agent storage', () => {
    expect(codebaseMemoryRuntimeDirectory('C:/Users/test/.felan/storage/agent')).toEqual({
      root: 'C:\\Users\\test\\.felan\\storage\\agent\\codebase-memory\\runtime',
      storagePath: 'codebase-memory/runtime',
    });
  });

  it('rejects mutating or unknown upstream commands from the generic proxy', async () => {
    const runtime = new MemoryRuntime();
    const harness = await createHarness(runtime);

    await expect(execute(harness.tools[0]!, {
      command: 'manage_adr',
      arguments: { mode: 'update', content: 'untrusted' },
    })).rejects.toThrow('Unsupported Codebase Memory command');
    expect(runtime.shellCalls).toEqual([]);
  });

  it('forces proxy and typed queries to the active workspace project', async () => {
    const runtime = new MemoryRuntime('host', true, async (command) => {
      if (command.includes('list_projects')) {
        return result(envelope({ projects: [{ name: 'fixture', root_path: '/work/repo' }] }));
      }
      return result(envelope({ results: [] }));
    });
    const harness = await createHarness(runtime);

    await execute(harness.tools[0]!, {
      command: 'search_graph',
      arguments: { project: 'external-project', query: 'answer' },
    });

    const query = runtime.shellCalls.find(({ command }) => command.includes('search_graph'))?.command ?? '';
    expect(query).toContain('fixture');
    expect(query).not.toContain('external-project');
    for (const tool of harness.tools.slice(1)) {
      expect(JSON.stringify(tool.parameters)).not.toContain('project');
    }
  });

  it('bounds symbol source to 220 lines', async () => {
    const source = Array.from({ length: 300 }, (_, index) => `line ${index + 1}`).join('\n');
    const runtime = new MemoryRuntime('host', true, async (command) => {
      if (command.includes('list_projects')) return result(envelope({ projects: [] }));
      if (command.includes('search_graph')) {
        return result(envelope({
          total: 1,
          cols: ['qn', 'label', 'file', 'lines', 'rank'],
          rows: [['fixture.answer', 'Function', 'src/answer.ts', '1-3', 1]],
        }));
      }
      if (command.includes('get_code_snippet')) return result(envelope({ code: source }));
      return result(envelope({}));
    });
    const harness = await createHarness(runtime);

    const response = await execute(harness.tools[1]!, { name: 'answer' });
    const content = response.content[0];
    expect(content?.type).toBe('text');
    const payload = JSON.parse(content?.type === 'text' ? content.text : '') as { snippet: { code: string; truncated: boolean } };

    expect(payload.snippet.code.split('\n')).toHaveLength(220);
    expect(payload.snippet.truncated).toBe(true);
  });

  it('reads symbols from real flat and grouped search_graph response shapes', async () => {
    const runtime = new MemoryRuntime('host', true, async (command) => {
      if (command.includes('list_projects')) return result(envelope({ projects: [{ name: 'fixture', root_path: '/work/repo' }] }));
      if (command.includes('search_graph') && command.includes('qn_pattern')) {
        return result(envelope({
          total: 1,
          count: 1,
          cols: ['name', 'label', 'lines', 'in', 'out'],
          groups: [{ qn_prefix: 'fixture.src.answer', file: 'src/answer.ts', rows: [['answer', 'Function', '1-3', 0, 1]] }],
        }));
      }
      if (command.includes('search_graph')) {
        return result(envelope({
          total: 1,
          cols: ['qn', 'label', 'file', 'lines', 'rank'],
          rows: [['fixture.src.answer.answer', 'Function', 'src/answer.ts', '1-3', 1]],
        }));
      }
      if (command.includes('get_code_snippet')) return result(envelope({ source: 'export function answer() { return 42; }' }));
      return result(envelope({}));
    });
    const harness = await createHarness(runtime);

    for (const params of [
      { qualified_name: 'fixture.src.answer.answer' },
      { name: 'answer', file_path: 'src/answer.ts' },
    ]) {
      const response = await execute(harness.tools[1]!, params);
      const content = response.content[0];
      const payload = JSON.parse(content?.type === 'text' ? content.text : '') as { snippet: { source: string } };
      expect(payload.snippet.source).toContain('return 42');
    }
  });

  it('fails closed when a symbol name is ambiguous', async () => {
    const runtime = new MemoryRuntime('host', true, async (command) => {
      if (command.includes('list_projects')) return result(envelope({ projects: [] }));
      if (command.includes('search_graph')) {
        return result(envelope({
          total: 2,
          cols: ['qn', 'label', 'file', 'lines', 'rank'],
          rows: [
            ['fixture.first.answer', 'Function', 'src/first.ts', '1-3', 1],
            ['fixture.second.answer', 'Function', 'src/second.ts', '1-3', 1],
          ],
        }));
      }
      if (command.includes('get_code_snippet')) throw new Error('ambiguous reads must not fetch source');
      return result(envelope({}));
    });
    const harness = await createHarness(runtime);

    const response = await execute(harness.tools[1]!, { name: 'answer' });
    const content = response.content[0];
    const payload = JSON.parse(content?.type === 'text' ? content.text : '') as {
      error: string;
      candidates: unknown[];
    };

    expect(payload.error).toContain('ambiguous');
    expect(payload.candidates).toHaveLength(2);
    expect(runtime.shellCalls.some(({ command }) => command.includes('get_code_snippet'))).toBe(false);
  });

  it.each([
    ['bash', { command: "grep -R 'Needle' src" }],
    ['exec_command', { cmd: "grep -R 'Needle' src" }],
    ['exec_command', { cmd: "rg --glob '*.ts' 'Needle' src" }],
  ])('augments %s grep results within the dedicated deadline and emits hit-rate telemetry', async (toolName, input) => {
    const telemetry = vi.fn();
    const runtime = new MemoryRuntime('host', true, async (command, options) => {
      expect(options?.timeout).toBeGreaterThan(0);
      expect(options?.timeout).toBeLessThanOrEqual(1_500);
      if (command.includes('list_projects')) return result(envelope({ projects: [] }));
      expect(command).toContain('search_code');
      expect(command).toContain('Needle');
      expect(command).not.toContain('*.ts');
      return result(envelope({ results: [{ file_path: 'src/a.ts', line: 3, text: 'Needle' }] }));
    });
    const harness = await createHarness(runtime, createCodebaseMemoryExtension({ telemetry }));

    await harness.emit('tool_call', { type: 'tool_call', toolName, toolCallId: 'grep-1', input });
    const augmented = await harness.emit('tool_result', {
      type: 'tool_result', toolName, toolCallId: 'grep-1', input,
      content: [{ type: 'text', text: 'src/a.ts:3:Needle' }], details: {}, isError: false,
    }) as { content: Array<{ type: string; text: string }> };

    expect(augmented.content.at(-1)?.text).toContain('Codebase Memory augmentation');
    expect(telemetry).toHaveBeenCalledWith('grep_augmentation', expect.objectContaining({
      tool: toolName,
      hit: true,
    }));
    const gitCall = runtime.execCalls.find(({ command }) => command === 'git');
    expect(gitCall?.options?.timeout).toBeLessThanOrEqual(1_500);
  });
});

async function execute(tool: ToolDefinition, params: Record<string, unknown>) {
  return tool.execute('call', params as never, new AbortController().signal, () => {}, {} as never);
}

function renderedCall(tool: ToolDefinition, params: Record<string, unknown>): string {
  if (!tool.renderCall) throw new Error(`Tool has no call renderer: ${tool.name}`);
  const theme = {
    fg: (_role: string, text: string) => text,
    bold: (text: string) => text,
  } as Parameters<NonNullable<ToolDefinition['renderCall']>>[1];
  const context = {} as Parameters<NonNullable<ToolDefinition['renderCall']>>[2];
  return tool.renderCall(params as never, theme, context).render(300).map((line) => line.trimEnd()).join('\n');
}

async function createHarness(
  runtime: MemoryRuntime,
  extension = codebaseMemoryExtension,
) {
  const handlers = new Map<string, Handler[]>();
  const tools: ToolDefinition[] = [];
  const capabilities: Array<{ id: string; instructions: string }> = [];
  const commands: string[] = [];
  const commandHandlers = new Map<string, (args: string, ctx: ExtensionContext) => Promise<void> | void>();
  const notifications: Array<[string, string | undefined]> = [];
  const statuses: Array<[string, string | undefined]> = [];
  const context = {
    cwd: runtime.cwd,
    hasUI: runtime.kind === 'host',
    mode: runtime.kind === 'host' ? 'tui' : 'print',
    signal: new AbortController().signal,
    ui: {
      notify: (message: string, level?: string) => notifications.push([message, level]),
      setStatus: vi.fn((key: string, text: string | undefined) => statuses.push([key, text])),
      confirm: vi.fn(async () => false),
    },
  } as unknown as ExtensionContext;
  const pi = {
    runtime,
    config: {},
    agentDir: '/agent',
    registerTool: (tool: ToolDefinition) => tools.push(tool),
    registerCapability: (capability: { id: string; instructions: string }) => capabilities.push(capability),
    registerCommand: (name: string, command: { handler: (args: string, ctx: ExtensionContext) => Promise<void> | void }) => {
      commands.push(name);
      commandHandlers.set(name, command.handler);
    },
    on: (name: string, handler: Handler) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
  } as unknown as FelanExtensionAPI;
  await extension(pi);
  return {
    capabilities, commands, commandHandlers, context, notifications, statuses, tools,
    async emit(name: string, event: Record<string, unknown>): Promise<unknown> {
      let result: unknown;
      for (const handler of handlers.get(name) ?? []) result = await handler(event, context) ?? result;
      return result;
    },
  };
}
