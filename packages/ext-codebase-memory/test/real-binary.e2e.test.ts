import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  HostAgentRuntime,
  type ExtensionContext,
  type FelanExtensionAPI,
  type ToolDefinition,
} from '@felan-ai/agent-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import codebaseMemoryExtension from '../src/index.js';
import { codebaseMemoryRuntimeDirectory } from '../src/runtime-path.js';

const binary = process.env.CBM_E2E_BINARY;
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('Codebase Memory real binary', () => {
  (binary ? it : it.skip)('indexes, reads, explicitly refreshes, and safely gates a missing binary', async () => {
    const root = await mkdtemp(join(tmpdir(), 'felan-cbm-e2e-'));
    temporaryDirectories.push(root);
    const workspace = join(root, 'workspace');
    const sessionStorageRoot = join(root, 'session');
    const agentStorageRoot = join(root, 'agent');
    const runtimeDirectory = codebaseMemoryRuntimeDirectory(agentStorageRoot);
    if (!runtimeDirectory.storagePath) temporaryDirectories.push(runtimeDirectory.root);
    const managedDirectory = join(agentStorageRoot, 'codebase-memory', 'bin');
    await Promise.all([
      mkdir(workspace, { recursive: true }),
      mkdir(sessionStorageRoot, { recursive: true }),
      mkdir(managedDirectory, { recursive: true }),
    ]);
    await writeFile(join(workspace, 'answer.ts'), 'export function answer() { return 42; }\n');
    await runGit(workspace, ['init', '-q']);
    await runGit(workspace, ['add', 'answer.ts']);
    await runGit(workspace, ['-c', 'user.name=Felan', '-c', 'user.email=felan@example.test', 'commit', '-qm', 'fixture']);

    const managedBinary = join(managedDirectory, 'codebase-memory-mcp');
    await symlink(binary!, managedBinary);
    const runtime = new HostAgentRuntime(workspace, { sessionStorageRoot, agentStorageRoot });
    const harness = await createHarness(runtime);

    expect(harness.tools.map(({ name }) => name)).toEqual([
      'codebase_memory',
      'read_symbol',
      'search_and_read_symbols',
      'search_code',
    ]);
    await harness.emit('session_start', { reason: 'startup' });
    await vi.waitFor(() => {
      expect(harness.statuses).toEqual([
        ['codebase-memory', 'cbm: idx'],
        ['codebase-memory', undefined],
      ]);
    }, { timeout: 120_000 });
    expect(await readSymbol(harness.tools[1]!, 'answer')).toContain('return 42');

    await writeFile(join(workspace, 'answer.ts'), 'export function changedAnswer() { return 84; }\n');
    expect(await readSymbol(harness.tools[1]!, 'changedAnswer')).toContain('No matching symbol found');
    await executeTool(harness.tools[0]!, { command: 'index_repository' });
    expect(await readSymbol(harness.tools[1]!, 'changedAnswer')).toContain('return 84');

    await writeFile(join(workspace, 'answer.ts'), 'export function slashAnswer() { return 126; }\n');
    await harness.commandHandlers.get('codebase-memory')?.('refresh', harness.context);
    expect(await readSymbol(harness.tools[1]!, 'slashAnswer')).toContain('return 126');

    const missingRuntime = new HostAgentRuntime(workspace, {
      sessionStorageRoot: join(root, 'missing-session'),
      agentStorageRoot: join(root, 'missing-agent'),
    });
    const missingHarness = await createHarness(missingRuntime);
    expect(missingHarness.tools).toEqual([]);
    expect(missingHarness.capabilities).toEqual([]);
  }, 120_000);
});

async function createHarness(runtime: HostAgentRuntime) {
  const handlers = new Map<string, Array<(event: any, ctx: ExtensionContext) => unknown>>();
  const tools: ToolDefinition[] = [];
  const capabilities: string[] = [];
  const statuses: Array<[string, string | undefined]> = [];
  const commandHandlers = new Map<string, (args: string, ctx: ExtensionContext) => Promise<void> | void>();
  const context = {
    cwd: runtime.cwd,
    hasUI: true,
    mode: 'tui',
    signal: new AbortController().signal,
    ui: {
      notify: () => {},
      setStatus: (key: string, text: string | undefined) => statuses.push([key, text]),
      confirm: async () => false,
    },
  } as unknown as ExtensionContext;
  const api = {
    runtime,
    config: { maxCacheBytes: 0 },
    registerTool: (tool: ToolDefinition) => tools.push(tool),
    registerCapability: (capability: { id: string }) => capabilities.push(capability.id),
    registerCommand: (name: string, command: { handler: (args: string, ctx: ExtensionContext) => Promise<void> | void }) => {
      commandHandlers.set(name, command.handler);
    },
    on: (event: string, handler: (event: any, ctx: ExtensionContext) => unknown) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
  } as unknown as FelanExtensionAPI;
  await codebaseMemoryExtension(api);
  return {
    capabilities,
    commandHandlers,
    context,
    statuses,
    tools,
    async emit(event: string, payload: Record<string, unknown>): Promise<void> {
      for (const handler of handlers.get(event) ?? []) await handler(payload, context);
    },
  };
}

async function readSymbol(tool: ToolDefinition, name: string): Promise<string> {
  const result = await executeTool(tool, { name });
  const content = result.content[0];
  return content?.type === 'text' ? content.text : '';
}

function executeTool(tool: ToolDefinition, params: Record<string, unknown>) {
  return tool.execute('e2e', params as never, new AbortController().signal, () => {}, {} as never);
}

async function runGit(cwd: string, args: readonly string[]): Promise<void> {
  const runtime = new HostAgentRuntime(cwd, {
    sessionStorageRoot: join(cwd, '.session'),
    agentStorageRoot: join(cwd, '.agent'),
  });
  const result = await runtime.exec('git', args, { cwd });
  if (result.code !== 0) throw new Error(result.stderr || result.stdout);
}
