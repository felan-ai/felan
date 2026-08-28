import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { promisify } from 'node:util';
import {
  HostAgentRuntime,
  type AgentRuntimeExecOptions,
  type ExecResult,
  type ExtensionContext,
  type FelanExtensionAPI,
} from '@felan-ai/agent-core';
import { describe, expect, it, vi } from 'vitest';
import codebaseMemoryExtension from '../dist/index.js';

const execFileAsync = promisify(execFile);
const CBM_BINARY = process.env.CODEBASE_MEMORY_MCP_TEST_BINARY
  ?? '/tmp/cbm-runtime/node_modules/.bin/codebase-memory-mcp';
const CBM_BIN_DIR = dirname(CBM_BINARY);
const EXPECTED_TOOLS = [
  'codebase_memory',
  'read_symbol',
  'search_and_read_symbols',
  'search_code',
];

type Handler = (event: any, ctx: ExtensionContext) => unknown;

describe.skipIf(!existsSync(CBM_BINARY))('Codebase Memory extension with the real binary', () => {
  it('indexes, searches, reads symbols, refreshes edits, and cleans isolated provider state', { timeout: 120_000 }, async () => {
    await expect(readFile(CBM_BINARY)).resolves.toBeInstanceOf(Buffer);
    const root = await mkdtemp(join(tmpdir(), 'bug374-cbm-integration-'));
    const repo = join(root, 'repo');
    const sessionStorageRoot = join(root, 'session-storage');
    const agentStorageRoot = join(root, 'agent-storage');
    let project: string | undefined;

    try {
      await Promise.all([
        mkdir(join(repo, 'src'), { recursive: true }),
        mkdir(sessionStorageRoot, { recursive: true }),
        mkdir(agentStorageRoot, { recursive: true }),
      ]);
      await writeFile(join(repo, 'src', 'portable-memory.ts'), [
        'export function bug374StartupSymbol(): string {',
        "  return 'BUG374_STARTUP_INDEX_TOKEN';",
        '}',
        '',
      ].join('\n'));
      await git(repo, ['init', '-q']);
      await git(repo, ['config', 'user.email', 'bug374-qa@example.invalid']);
      await git(repo, ['config', 'user.name', 'BUG-374 QA']);
      await git(repo, ['add', 'src/portable-memory.ts']);
      await git(repo, ['commit', '-qm', 'fixture']);

      const runtime = new PathHostRuntime(repo, {
        sessionStorageRoot,
        agentStorageRoot,
      }, `${CBM_BIN_DIR}${delimiter}${process.env.PATH ?? ''}`);
      const harness = createHarness(runtime);
      await codebaseMemoryExtension(harness.pi);

      expect([...harness.tools.keys()]).toEqual(EXPECTED_TOOLS);
      expect(harness.capabilities).toEqual([]);

      await harness.emit('session_start', { reason: 'startup' });
      await waitForStatus(harness.status, 'cbm: on');
      expect(harness.status.at(-1)).toBe('cbm: on');

      const projects = await providerCall(runtime, agentStorageRoot, 'list_projects', {});
      const indexed = providerProjects(projects).find((candidate) => candidate.root_path === repo);
      expect(indexed).toBeDefined();
      project = indexed!.name;

      const startupSearch = await executeTool(harness, 'search_code', {
        pattern: 'BUG374_STARTUP_INDEX_TOKEN',
      });
      expect(resultText(startupSearch)).toContain('bug374StartupSymbol');

      const symbolSearch = await executeTool(harness, 'search_and_read_symbols', {
        name_pattern: '.*bug374StartupSymbol.*',
        limit: 3,
      });
      expect(resultText(symbolSearch)).toContain('bug374StartupSymbol');
      expect(resultText(symbolSearch)).toContain('BUG374_STARTUP_INDEX_TOKEN');

      await writeFile(join(repo, 'src', 'portable-memory.ts'), [
        'export function bug374StartupSymbol(): string {',
        "  return 'BUG374_STARTUP_INDEX_TOKEN';",
        '}',
        '',
        'export function bug374RefreshedSymbol(): string {',
        "  return 'BUG374_EXPLICIT_REFRESH_TOKEN';",
        '}',
        '',
      ].join('\n'));

      const staleSearch = await executeTool(harness, 'search_and_read_symbols', {
        name_pattern: '.*bug374RefreshedSymbol.*',
      });
      expect(resultText(staleSearch)).not.toContain('bug374RefreshedSymbol');

      const refresh = await executeTool(harness, 'codebase_memory', {
        command: 'index_repository',
      });
      expect(resultText(refresh)).toContain('indexed');

      const refreshedSearch = await executeTool(harness, 'search_and_read_symbols', {
        name_pattern: '.*bug374RefreshedSymbol.*',
      });
      expect(resultText(refreshedSearch)).toContain('BUG374_EXPLICIT_REFRESH_TOKEN');

      const refreshedSymbol = await executeTool(harness, 'read_symbol', {
        name: 'bug374RefreshedSymbol',
      });
      expect(resultText(refreshedSymbol)).toContain('BUG374_EXPLICIT_REFRESH_TOKEN');

      const providerSearch = await providerCall(runtime, agentStorageRoot, 'search_code', {
        project,
        pattern: 'BUG374_EXPLICIT_REFRESH_TOKEN',
      });
      expect(JSON.stringify(providerSearch)).toContain('bug374RefreshedSymbol');
    } finally {
      if (project) {
        const cleanupRuntime = new PathHostRuntime(repo, {
          sessionStorageRoot,
          agentStorageRoot,
        }, `${CBM_BIN_DIR}${delimiter}${process.env.PATH ?? ''}`);
        await providerCall(cleanupRuntime, agentStorageRoot, 'delete_project', { project });
        const remaining = await providerCall(cleanupRuntime, agentStorageRoot, 'list_projects', {});
        expect(providerProjects(remaining).some((candidate) => candidate.name === project)).toBe(false);
      }
      await rm(root, { recursive: true, force: true });
      await expect(readdir(root)).rejects.toMatchObject({ code: 'ENOENT' });
    }
  });

  it('registers no tools or capabilities when the binary is missing', { timeout: 20_000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'bug374-cbm-missing-'));
    try {
      const repo = join(root, 'repo');
      const emptyBin = join(root, 'empty-bin');
      const sessionStorageRoot = join(root, 'session-storage');
      const agentStorageRoot = join(root, 'agent-storage');
      await Promise.all([
        mkdir(repo, { recursive: true }),
        mkdir(emptyBin, { recursive: true }),
        mkdir(sessionStorageRoot, { recursive: true }),
        mkdir(agentStorageRoot, { recursive: true }),
      ]);
      const runtime = new PathHostRuntime(repo, { sessionStorageRoot, agentStorageRoot }, emptyBin);
      const harness = createHarness(runtime);

      await codebaseMemoryExtension(harness.pi);

      expect(harness.tools.size).toBe(0);
      expect(harness.capabilities).toEqual([]);
      await harness.emit('session_start', { reason: 'startup' });
      expect(harness.status.at(-1)).toBe('cbm: off');
    } finally {
      await rm(root, { recursive: true, force: true });
      await expect(readdir(root)).rejects.toMatchObject({ code: 'ENOENT' });
    }
  });

  it('disabled configuration performs no initialization or registration', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bug374-cbm-disabled-'));
    try {
      const repo = join(root, 'repo');
      const sessionStorageRoot = join(root, 'session-storage');
      const agentStorageRoot = join(root, 'agent-storage');
      await Promise.all([
        mkdir(repo, { recursive: true }),
        mkdir(sessionStorageRoot, { recursive: true }),
        mkdir(agentStorageRoot, { recursive: true }),
      ]);
      const runtime = new PathHostRuntime(repo, {
        sessionStorageRoot,
        agentStorageRoot,
      }, `${CBM_BIN_DIR}${delimiter}${process.env.PATH ?? ''}`);
      const harness = createHarness(runtime, { disabled: true });

      await codebaseMemoryExtension(harness.pi);

      expect(runtime.execCalls).toBe(0);
      expect(harness.tools.size).toBe(0);
      expect(harness.commands.size).toBe(0);
      expect(harness.handlers.size).toBe(0);
      expect(harness.capabilities).toEqual([]);
      expect(await readdir(agentStorageRoot)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
      await expect(readdir(root)).rejects.toMatchObject({ code: 'ENOENT' });
    }
  });
});

class PathHostRuntime extends HostAgentRuntime {
  execCalls = 0;

  constructor(
    cwd: string,
    options: ConstructorParameters<typeof HostAgentRuntime>[1],
    private readonly testPath: string,
  ) {
    super(cwd, options);
  }

  override exec(
    command: string,
    args: readonly string[],
    options?: AgentRuntimeExecOptions,
  ): Promise<ExecResult> {
    this.execCalls += 1;
    return super.exec(command, args, {
      ...options,
      env: {
        PATH: this.testPath,
        ...options?.env,
      },
    });
  }
}

function createHarness(runtime: HostAgentRuntime, config: Record<string, unknown> = {}) {
  const handlers = new Map<string, Handler[]>();
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const capabilities: unknown[] = [];
  const status: string[] = [];
  const ctx = {
    cwd: runtime.cwd,
    signal: undefined,
    mode: 'tui',
    hasUI: true,
    ui: {
      notify: vi.fn(),
      setStatus: (_key: string, text?: string) => { if (text) status.push(text); },
    },
  } as unknown as ExtensionContext;
  const pi = {
    runtime,
    config,
    on: (name: string, handler: Handler) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
    registerTool: (tool: any) => tools.set(tool.name, tool),
    registerCommand: (name: string, command: any) => commands.set(name, command),
    registerCapability: (capability: unknown) => capabilities.push(capability),
    appendEntry: vi.fn(),
  } as unknown as FelanExtensionAPI;
  return {
    pi,
    handlers,
    tools,
    commands,
    capabilities,
    status,
    ctx,
    emit: async (name: string, event: any) => {
      let returned: unknown;
      for (const handler of handlers.get(name) ?? []) returned = await handler(event, ctx) ?? returned;
      return returned;
    },
  };
}

async function executeTool(
  harness: ReturnType<typeof createHarness>,
  name: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  const tool = harness.tools.get(name);
  expect(tool, `${name} must be registered`).toBeDefined();
  return tool.execute('bug374-call', params, undefined, undefined, { cwd: harness.ctx.cwd });
}

function resultText(result: unknown): string {
  if (typeof result !== 'object' || result === null) return String(result);
  const content = Reflect.get(result, 'content');
  if (!Array.isArray(content)) return JSON.stringify(result);
  return content.map((entry) => (
    typeof entry === 'object' && entry !== null && typeof Reflect.get(entry, 'text') === 'string'
      ? Reflect.get(entry, 'text')
      : JSON.stringify(entry)
  )).join('\n');
}

async function providerCall(
  runtime: HostAgentRuntime,
  agentStorageRoot: string,
  tool: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const result = await runtime.exec(CBM_BINARY, ['cli', '--json', tool, JSON.stringify(args)], {
    timeout: 60_000,
    maxOutputBytes: 5 * 1024 * 1024,
    env: {
      CBM_SQLITE_MMAP_SIZE: '0',
      HOME: join(agentStorageRoot, 'codebase-memory', 'home'),
      XDG_CACHE_HOME: join(agentStorageRoot, 'codebase-memory', 'cache'),
    },
  });
  expect(result.killed).toBe(false);
  expect(result.code, result.stderr).toBe(0);
  const envelope = JSON.parse(result.stdout) as { content?: Array<{ type?: string; text?: string }>; isError?: boolean };
  expect(envelope.isError, result.stdout).not.toBe(true);
  const text = envelope.content?.find((entry) => entry.type === 'text')?.text;
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function providerProjects(value: unknown): Array<{ name: string; root_path?: string }> {
  if (typeof value !== 'object' || value === null) return [];
  const projects = Reflect.get(value, 'projects');
  if (!Array.isArray(projects)) return [];
  return projects.filter((project): project is { name: string; root_path?: string } => (
    typeof project === 'object' && project !== null && typeof Reflect.get(project, 'name') === 'string'
  ));
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync('git', args, { cwd, timeout: 10_000 });
}

async function waitForStatus(status: readonly string[], expected: string): Promise<void> {
  for (let attempt = 0; attempt < 1_200; attempt += 1) {
    if (status.at(-1) === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Codebase Memory status did not reach ${expected}`);
}
