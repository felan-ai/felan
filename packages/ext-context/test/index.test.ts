import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type {
  AgentRuntime,
  AgentRuntimeKind,
  ExtensionContext,
  FelanExtensionAPI,
} from '@felan-ai/agent-core';
import { HostAgentRuntime } from '@felan-ai/agent-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import contextExtension from '../src/index.js';

type EventHandler = (event: Record<string, unknown>, ctx: ExtensionContext) => unknown;
type CommandHandler = (args: string, ctx: ExtensionContext) => Promise<void>;

type ContextMessage = {
  readonly role?: string;
  readonly customType?: string;
  readonly content?: string;
  readonly display?: boolean;
  readonly timestamp?: number | string;
};

class RecordingRuntime implements AgentRuntime {
  readonly readPaths: string[] = [];

  constructor(
    private readonly runtime: HostAgentRuntime,
    readonly kind: AgentRuntimeKind = 'host',
  ) {}

  get cwd(): string {
    return this.runtime.cwd;
  }

  storage(...args: Parameters<AgentRuntime['storage']>): ReturnType<AgentRuntime['storage']> {
    return this.runtime.storage(...args);
  }

  exec(...args: Parameters<AgentRuntime['exec']>): ReturnType<AgentRuntime['exec']> {
    return this.runtime.exec(...args);
  }

  shell(...args: Parameters<AgentRuntime['shell']>): ReturnType<AgentRuntime['shell']> {
    return this.runtime.shell(...args);
  }

  async readFile(path: string): Promise<Uint8Array> {
    this.readPaths.push(path);
    return this.runtime.readFile(path);
  }

  writeFile(...args: Parameters<AgentRuntime['writeFile']>): ReturnType<AgentRuntime['writeFile']> {
    return this.runtime.writeFile(...args);
  }

  listFiles(...args: Parameters<AgentRuntime['listFiles']>): ReturnType<AgentRuntime['listFiles']> {
    return this.runtime.listFiles(...args);
  }

  mkdir(...args: Parameters<AgentRuntime['mkdir']>): ReturnType<AgentRuntime['mkdir']> {
    return this.runtime.mkdir(...args);
  }

  remove(...args: Parameters<AgentRuntime['remove']>): ReturnType<AgentRuntime['remove']> {
    return this.runtime.remove(...args);
  }
}

class ExtensionHarness {
  readonly capabilities: Array<{ id: string; instructions: string }> = [];
  readonly handlers = new Map<string, EventHandler[]>();
  readonly commands = new Map<string, CommandHandler>();
  readonly statuses: Array<[string, string | undefined]> = [];
  readonly notifications: Array<[string, string]> = [];
  readonly ctx: ExtensionContext;

  private constructor(readonly runtime: AgentRuntime, cwd: string) {
    const ui = {
      setStatus: (key: string, value: string | undefined) => this.statuses.push([key, value]),
      notify: (message: string, level: string) => this.notifications.push([message, level]),
    };
    this.ctx = {
      cwd,
      hasUI: true,
      ui,
    } as unknown as ExtensionContext;
  }

  static async create(
    runtime?: AgentRuntime,
  ): Promise<ExtensionHarness> {
    const selectedRuntime = runtime ?? await testRuntime();
    const harness = new ExtensionHarness(selectedRuntime, selectedRuntime.cwd);
    const pi = {
      runtime: selectedRuntime,
      registerCapability: (capability: { id: string; instructions: string }) => {
        harness.capabilities.push(capability);
      },
      on: (event: string, handler: EventHandler) => {
        const handlers = harness.handlers.get(event) ?? [];
        handlers.push(handler);
        harness.handlers.set(event, handlers);
      },
      registerCommand: (name: string, command: { handler: CommandHandler }) => {
        harness.commands.set(name, command.handler);
      },
    } as unknown as FelanExtensionAPI;
    await contextExtension(pi);
    return harness;
  }

  async emit(type: string, event: Record<string, unknown> = {}): Promise<unknown[]> {
    const results = [];
    for (const handler of this.handlers.get(type) ?? []) {
      results.push(await handler({ type, ...event }, this.ctx));
    }
    return results;
  }

  async successfulRead(path: string): Promise<void> {
    await this.emit('tool_result', {
      toolName: 'read',
      toolCallId: 'read-call',
      input: { path },
      content: [],
      details: undefined,
      isError: false,
    });
  }

  async input(text: string): Promise<void> {
    await this.emit('input', { text, source: 'interactive' });
  }

  async context(messages: ContextMessage[] = []): Promise<ContextMessage[]> {
    const [result] = await this.emit('context', { messages });
    return (result as { messages?: ContextMessage[] } | undefined)?.messages ?? messages;
  }

  async runCommand(): Promise<void> {
    const command = this.commands.get('progressive-context');
    if (!command) throw new Error('progressive-context command was not registered');
    await command('', this.ctx);
  }
}

const temporaryPaths: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('@felan-ai/ext-context', () => {
  it('registers progressive context guidance', async () => {
    const harness = await ExtensionHarness.create();

    expect(harness.capabilities).toEqual([
      expect.objectContaining({ id: 'progressive-context' }),
    ]);
  });

  it('injects newly discovered instructions only on the next context event and resets on session start', async () => {
    const runtime = await testRuntime();
    await put(runtime, 'nested/AGENTS.md', 'Nested instructions');
    await put(runtime, 'nested/file.ts', 'export {};');
    const harness = await ExtensionHarness.create(runtime);
    const original = [{ role: 'user', content: 'before read' }];

    expect(await harness.context(original)).toBe(original);
    await harness.successfulRead('nested/file.ts');

    const messages = await harness.context(original);
    expect(messages).toHaveLength(2);
    expect(messages[0]).toBe(original[0]);
    expect(messages[1]).toMatchObject({
      role: 'custom',
      customType: 'pi-progressive-context',
      display: false,
    });
    expect(messages[1]?.content).toContain('Nested instructions');
    expect(harness.statuses.at(-1)).toEqual(['progressive-context', '1 nested context file']);

    await harness.emit('session_start', { reason: 'new' });

    expect(await harness.context(messages)).toEqual(original);
    expect(harness.statuses.at(-1)).toEqual(['progressive-context', undefined]);

    await harness.successfulRead('nested/file.ts');
    expect((await harness.context(original)).at(-1)?.content).toContain('Nested instructions');
  });

  it('keeps unchanged instructions at a stable context prefix as history grows', async () => {
    const runtime = await testRuntime();
    await put(runtime, 'nested/AGENTS.md', 'Nested instructions');
    await put(runtime, 'nested/file.ts', 'export {};');
    const harness = await ExtensionHarness.create(runtime);
    await harness.successfulRead('nested/file.ts');
    const userMessage = { role: 'user', content: 'Task', timestamp: 1 };

    const first = await harness.context([userMessage]);
    const assistantMessage = { role: 'assistant', content: 'Read files', timestamp: 2 };
    const second = await harness.context([userMessage, assistantMessage]);

    expect(second.slice(0, first.length)).toEqual(first);
    expect(second.at(-1)).toEqual(assistantMessage);
  });

  it('stays append-only after an earlier stable transient context message', async () => {
    const runtime = await testRuntime();
    await put(runtime, 'nested/AGENTS.md', 'Nested instructions');
    await put(runtime, 'nested/file.ts', 'export {};');
    const harness = await ExtensionHarness.create(runtime);
    await harness.successfulRead('nested/file.ts');
    const userMessage = { role: 'user', content: 'Task', timestamp: 1 };
    const phaseGuidance = {
      role: 'custom',
      customType: 'pi-prewalk:planning',
      content: 'Planning guidance',
      display: false,
      timestamp: 2,
    };

    const first = await harness.context([userMessage, phaseGuidance]);
    const assistantMessage = { role: 'assistant', content: 'Inspect repository', timestamp: 3 };
    const second = await harness.context([userMessage, phaseGuidance, assistantMessage]);

    expect(second.slice(0, first.length)).toEqual(first);
    expect(second.at(-1)).toEqual(assistantMessage);
  });

  it('re-anchors once when newly discovered instructions change the context', async () => {
    const runtime = await testRuntime();
    await put(runtime, 'nested/AGENTS.md', 'Nested instructions');
    await put(runtime, 'nested/file.ts', 'export {};');
    await put(runtime, 'nested/deeper/AGENTS.md', 'Deeper instructions');
    await put(runtime, 'nested/deeper/file.ts', 'export {};');
    const harness = await ExtensionHarness.create(runtime);
    const userMessage = { role: 'user', content: 'Task', timestamp: 1 };
    await harness.successfulRead('nested/file.ts');
    await harness.context([userMessage]);

    await harness.successfulRead('nested/deeper/file.ts');
    const readTurn = { role: 'assistant', content: 'Read deeper file', timestamp: 2 };
    const changed = await harness.context([userMessage, readTurn]);
    expect(changed.at(-1)?.content).toContain('Nested instructions');
    expect(changed.at(-1)?.content).toContain('Deeper instructions');

    const nextTurn = { role: 'assistant', content: 'Continue', timestamp: 3 };
    const stable = await harness.context([userMessage, readTurn, nextTurn]);
    expect(stable.slice(0, changed.length)).toEqual(changed);
    expect(stable.at(-1)).toEqual(nextTurn);
  });

  it('ignores failed and non-read tool results', async () => {
    const runtime = await testRuntime();
    await put(runtime, 'nested/AGENTS.md', 'Nested instructions');
    await put(runtime, 'nested/file.ts', 'export {};');
    const harness = await ExtensionHarness.create(runtime);

    await harness.emit('tool_result', {
      toolName: 'read',
      input: { path: 'nested/file.ts' },
      isError: true,
    });
    await harness.emit('tool_result', {
      toolName: 'write',
      input: { path: 'nested/file.ts' },
      isError: false,
    });

    expect(await harness.context()).toEqual([]);
  });

  it('decodes CLI file block names and accepts the leading @ form', async () => {
    const runtime = await testRuntime();
    await put(runtime, 'nested/AGENTS.md', 'Ampersand path instructions');
    await put(runtime, 'nested/a&b.ts', 'export {};');
    const harness = await ExtensionHarness.create(runtime);

    await harness.input('<file source="cli" name="@nested/a&amp;b.ts">contents</file>');

    expect((await harness.context()).at(-1)?.content).toContain('Ampersand path instructions');
  });

  it('walks nested directories in cwd-to-file order while skipping cwd instructions', async () => {
    const runtime = await testRuntime();
    await put(runtime, 'AGENTS.md', 'Cwd instructions');
    await put(runtime, 'one/AGENTS.md', 'One instructions');
    await put(runtime, 'one/two/CLAUDE.md', 'Two instructions');
    await put(runtime, 'one/two/file.ts', 'export {};');
    const harness = await ExtensionHarness.create(runtime);

    await harness.successfulRead('one/two/file.ts');

    const content = (await harness.context()).at(-1)?.content ?? '';
    expect(content).not.toContain('Cwd instructions');
    expect(content.indexOf('One instructions')).toBeLessThan(content.indexOf('Two instructions'));
  });

  it('loads at most one file per directory with AGENTS.md precedence', async () => {
    const runtime = await testRuntime();
    await put(runtime, 'nested/AGENTS.md', 'Agents wins');
    await put(runtime, 'nested/CLAUDE.md', 'Claude fallback');
    await put(runtime, 'nested/file.ts', 'export {};');
    const harness = await ExtensionHarness.create(runtime);

    await harness.successfulRead('nested/file.ts');

    const content = (await harness.context()).at(-1)?.content ?? '';
    expect(content).toContain('Agents wins');
    expect(content).not.toContain('Claude fallback');
    expect(runtime.readPaths).not.toContain(resolve(runtime.cwd, 'nested/CLAUDE.md'));
  });

  it('uses CLAUDE.md as the fallback and decodes bytes with TextDecoder', async () => {
    const runtime = await testRuntime();
    await runtime.mkdir('nested', { recursive: true });
    await runtime.writeFile('nested/CLAUDE.md', new Uint8Array([0x66, 0x6f, 0x80]));
    await runtime.writeFile('nested/file.ts', new TextEncoder().encode('export {};'));
    const harness = await ExtensionHarness.create(runtime);

    await harness.successfulRead('nested/file.ts');

    expect((await harness.context()).at(-1)?.content).toContain('fo�');
  });

  it('deduplicates normalized observed paths and loaded files for the session', async () => {
    const runtime = await testRuntime();
    await put(runtime, 'nested/deep/AGENTS.md', 'Deep instructions');
    await put(runtime, 'nested/deep/file.ts', 'export {};');
    const harness = await ExtensionHarness.create(runtime);

    await harness.successfulRead('nested/./deep/../deep/file.ts');
    await harness.successfulRead(resolve(runtime.cwd, 'nested/deep/file.ts'));

    const content = (await harness.context()).at(-1)?.content ?? '';
    expect(content.match(/Deep instructions/g)).toHaveLength(1);
    expect(runtime.readPaths.filter((path) => path === resolve(runtime.cwd, 'nested/deep/AGENTS.md'))).toHaveLength(1);
  });

  it('rejects lexical traversal and absolute paths outside the session cwd', async () => {
    const runtime = await testRuntime();
    const harness = await ExtensionHarness.create(runtime);

    await harness.input('<file name="../outside/file.ts">outside</file>');
    await harness.successfulRead('/outside/file.ts');

    expect(await harness.context()).toEqual([]);
    expect(runtime.readPaths).toEqual([]);
  });

  it('rejects symlink escapes before loading instructions from an apparent parent', async () => {
    const runtime = await testRuntime();
    await put(runtime, 'scope/AGENTS.md', 'Must not escape');
    const outside = await temporaryDirectory();
    await writeFile(join(outside, 'file.ts'), 'outside');
    await symlink(outside, join(runtime.cwd, 'scope', 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    const harness = await ExtensionHarness.create(runtime);

    await harness.input('<file name="scope/escape/file.ts">outside</file>');

    expect(await harness.context()).toEqual([]);
  });

  it('treats read failures as nonfatal and never retries processed directories', async () => {
    const runtime = await testRuntime();
    await put(runtime, 'nested/first.ts', 'first');
    await put(runtime, 'nested/second.ts', 'second');
    const harness = await ExtensionHarness.create(runtime);

    await expect(harness.successfulRead('nested/first.ts')).resolves.toBeUndefined();
    await put(runtime, 'nested/AGENTS.md', 'Added after first check');
    await harness.successfulRead('nested/second.ts');

    expect(await harness.context()).toEqual([]);
    expect(runtime.readPaths.filter((path) => path === resolve(runtime.cwd, 'nested/AGENTS.md'))).toHaveLength(1);
    expect(runtime.readPaths.filter((path) => path === resolve(runtime.cwd, 'nested/CLAUDE.md'))).toHaveLength(1);
  });

  it('retains discovered state across compaction', async () => {
    const runtime = await testRuntime();
    await put(runtime, 'nested/AGENTS.md', 'Persistent instructions');
    await put(runtime, 'nested/file.ts', 'export {};');
    const harness = await ExtensionHarness.create(runtime);
    await harness.successfulRead('nested/file.ts');
    await harness.context([{ role: 'user', content: 'before compaction', timestamp: 1 }]);

    await harness.emit('session_compact', { summary: 'compacted state' });
    const summary = { role: 'user', content: 'compaction summary', timestamp: 2 };
    const messages = await harness.context([summary]);

    expect(messages.at(-1)).toMatchObject({
      customType: 'pi-progressive-context',
      content: expect.stringContaining('Persistent instructions'),
    });

    const nextTurn = { role: 'assistant', content: 'after compaction', timestamp: 3 };
    const stable = await harness.context([summary, nextTurn]);
    expect(stable.slice(0, messages.length)).toEqual(messages);
    expect(stable.at(-1)).toEqual(nextTurn);
  });

  it('reports empty and loaded state through /progressive-context', async () => {
    const runtime = await testRuntime();
    await put(runtime, 'nested/AGENTS.md', 'Nested instructions');
    await put(runtime, 'nested/file.ts', 'export {};');
    const harness = await ExtensionHarness.create(runtime);

    await harness.runCommand();
    expect(harness.notifications.at(-1)).toEqual(['No progressive context files loaded.', 'info']);

    await harness.successfulRead('nested/file.ts');
    await harness.runCommand();
    expect(harness.notifications.at(-1)?.[0]).toContain(resolve(runtime.cwd, 'nested/AGENTS.md'));
  });

  it.each(['host', 'daytona'] as const)('has identical behavior for %s runtime kind', async (kind) => {
    const runtime = await testRuntime(kind);
    await put(runtime, 'nested/AGENTS.md', 'Portable instructions');
    await put(runtime, 'nested/file.ts', 'export {};');
    const harness = await ExtensionHarness.create(runtime);

    await harness.successfulRead('nested/file.ts');

    expect((await harness.context()).at(-1)).toMatchObject({
      customType: 'pi-progressive-context',
      content: expect.stringContaining('Portable instructions'),
    });
  });

  it('relies on HostAgentRuntime containment for real filesystem symlink escapes', async () => {
    const root = await temporaryDirectory();
    const workspace = join(root, 'workspace');
    const outside = join(root, 'outside');
    await mkdir(join(workspace, 'scope'), { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(join(workspace, 'scope', 'AGENTS.md'), 'Must remain unloaded');
    await writeFile(join(outside, 'file.ts'), 'outside');
    await symlink(outside, join(workspace, 'scope', 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    const harness = await ExtensionHarness.create(await hostRuntime(workspace));

    await harness.successfulRead('scope/escape/file.ts');

    expect(await harness.context()).toEqual([]);
  });
});

async function put(runtime: AgentRuntime, path: string, content: string): Promise<void> {
  await runtime.mkdir(dirname(path), { recursive: true });
  await runtime.writeFile(path, new TextEncoder().encode(content));
}

async function testRuntime(kind: AgentRuntimeKind = 'host'): Promise<RecordingRuntime> {
  return new RecordingRuntime(await hostRuntime(await temporaryDirectory()), kind);
}

async function hostRuntime(cwd: string): Promise<HostAgentRuntime> {
  const sessionStorageRoot = join(cwd, '.runtime-storage', 'session');
  const agentStorageRoot = join(cwd, '.runtime-storage', 'agent');
  await Promise.all([
    mkdir(sessionStorageRoot, { recursive: true }),
    mkdir(agentStorageRoot, { recursive: true }),
  ]);
  return new HostAgentRuntime(cwd, { sessionStorageRoot, agentStorageRoot });
}

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'felan-context-'));
  temporaryPaths.push(path);
  return path;
}
