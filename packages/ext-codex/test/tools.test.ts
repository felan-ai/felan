import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  HostAgentRuntime,
  type AgentRuntime,
  type AgentRuntimeProcess,
  type AgentRuntimeProcessReadOptions,
  type AgentRuntimeProcessSnapshot,
  type Api,
  type ExtensionContext,
  type Model,
  type ToolDefinition,
} from '@felan-ai/agent-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createCodexTools,
} from '../src/index.js';
import { ApplyPatchError, applyPatch } from '../src/patch.js';

const temporaryPaths: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('Codex patch tool', () => {
  it('applies add, update, and delete sections through AgentRuntime', async () => {
    const runtime = await createRuntime();
    const patch = tool(createCodexTools(runtime), 'apply_patch');
    await runtime.writeFile('old.txt', new TextEncoder().encode('before\nkeep\n'));
    await runtime.writeFile('delete.txt', new TextEncoder().encode('remove\n'));

    const result = await patch.execute('patch', { input: `*** Begin Patch
*** Add File: nested/new.txt
+created
*** Update File: old.txt
@@
-before
+after
 keep
*** Delete File: delete.txt
*** End Patch` }, undefined, undefined, textContext()) as ToolResult;

    expect(result.details).toMatchObject({
      status: 'success',
      result: { createdFiles: ['nested/new.txt'], deletedFiles: ['delete.txt'] },
    });
    await expect(text(runtime, 'nested/new.txt')).resolves.toBe('created\n');
    await expect(text(runtime, 'old.txt')).resolves.toBe('after\nkeep\n');
    await expect(runtime.readFile('delete.txt')).rejects.toThrow();
  });

  it('treats an adjacent Delete File and Add File for the same path as one replacement', async () => {
    const runtime = await createRuntime();
    const patch = tool(createCodexTools(runtime), 'apply_patch');
    await runtime.writeFile('replace.txt', new TextEncoder().encode('before\n'));

    const result = await patch.execute('patch', { input: `*** Begin Patch
*** Delete File: replace.txt
*** Add File: replace.txt
+after
*** End Patch` }, undefined, undefined, textContext()) as ToolResult;

    expect(result.details).toEqual({
      status: 'success',
      result: {
        changedFiles: ['replace.txt'],
        createdFiles: [],
        deletedFiles: [],
        movedFiles: [],
        fuzz: 0,
      },
    });
    await expect(text(runtime, 'replace.txt')).resolves.toBe('after\n');
  });

  it('leaves the original file in place when an adjacent replacement write fails', async () => {
    const host = await createRuntime();
    await host.writeFile('replace.txt', new TextEncoder().encode('before\n'));
    const runtime = runtimeWithWriteFailure(host, 'replace.txt');

    await expect(applyPatch(runtime, `*** Begin Patch
*** Delete File: replace.txt
*** Add File: replace.txt
+after
*** End Patch`)).rejects.toMatchObject({
      result: { changedFiles: [], createdFiles: [], deletedFiles: [] },
    });
    await expect(text(host, 'replace.txt')).resolves.toBe('before\n');
  });

  it('rejects a repeated path when Delete File and Add File are not adjacent', async () => {
    const runtime = await createRuntime();
    await runtime.writeFile('replace.txt', new TextEncoder().encode('before\n'));

    await expect(applyPatch(runtime, `*** Begin Patch
*** Delete File: replace.txt
*** Add File: other.txt
+other
*** Add File: replace.txt
+after
*** End Patch`)).rejects.toThrow('Duplicate patch path: replace.txt');
    await expect(text(runtime, 'replace.txt')).resolves.toBe('before\n');
    await expect(runtime.readFile('other.txt')).rejects.toThrow();
  });

  it('uses exclusive creation for concurrent Add File patches', async () => {
    const runtime = await createRuntime();
    const patch = `*** Begin Patch
*** Add File: race.txt
+winner
*** End Patch`;

    const results = await Promise.allSettled([
      applyPatch(runtime, patch),
      applyPatch(runtime, patch),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    await expect(text(runtime, 'race.txt')).resolves.toBe('winner\n');
  });

  it('rolls back a move destination when source removal fails', async () => {
    const host = await createRuntime();
    await host.writeFile('source.txt', new TextEncoder().encode('before\n'));
    const runtime = runtimeWithRemoveFailures(host, false);

    await expect(applyPatch(runtime, movePatch())).rejects.toMatchObject({
      result: { changedFiles: [], createdFiles: [], deletedFiles: [] },
    });
    await expect(text(host, 'source.txt')).resolves.toBe('before\n');
    await expect(host.readFile('destination.txt')).rejects.toThrow();
  });

  it('reports the destination when move rollback also fails', async () => {
    const host = await createRuntime();
    await host.writeFile('source.txt', new TextEncoder().encode('before\n'));
    const runtime = runtimeWithRemoveFailures(host, true);

    let failure: unknown;
    try {
      await applyPatch(runtime, movePatch());
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(ApplyPatchError);
    expect((failure as ApplyPatchError).result).toMatchObject({
      changedFiles: ['destination.txt'],
      createdFiles: ['destination.txt'],
      deletedFiles: [],
    });
    await expect(text(host, 'source.txt')).resolves.toBe('before\n');
    await expect(text(host, 'destination.txt')).resolves.toBe('after\n');
  });

});

interface ToolResult {
  content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
  details: unknown;
}

function tool(tools: ToolDefinition<any, any, any>[], name: string): ToolDefinition<any, any, any> {
  const found = tools.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`Tool not found: ${name}`);
  return found;
}

function renderedCall(
  definition: ToolDefinition<any, any, any>,
  args: Record<string, unknown>,
  isPartial: boolean,
  isError = false,
): string {
  const renderCall = definition.renderCall;
  if (!renderCall) throw new Error(`Tool has no call renderer: ${definition.name}`);
  const theme = {
    fg: (_role: string, text: string) => text,
    bold: (text: string) => text,
  } as Parameters<typeof renderCall>[1];
  const context = { isPartial, isError } as Parameters<typeof renderCall>[2];
  return renderCall(args, theme, context).render(200).map((line) => line.trimEnd()).join('\n');
}

class FakeProcess implements AgentRuntimeProcess {
  readonly pid: number;
  readonly waits: number[] = [];
  readonly writes: string[] = [];
  disposed = false;
  disposeCalls = 0;
  maxConcurrentWrites = 0;
  #activeWrites = 0;
  #running = true;

  constructor(pid: number, private readonly writeDelayMs: number) {
    this.pid = pid;
  }

  async read(
    afterOffset: number,
    options?: AgentRuntimeProcessReadOptions,
  ): Promise<AgentRuntimeProcessSnapshot> {
    this.waits.push(options?.waitMs ?? 0);
    return { output: new Uint8Array(), nextOffset: afterOffset, running: this.#running };
  }

  async write(content: Uint8Array): Promise<void> {
    this.#activeWrites += 1;
    this.maxConcurrentWrites = Math.max(this.maxConcurrentWrites, this.#activeWrites);
    try {
      this.writes.push(new TextDecoder().decode(content));
      if (this.writeDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.writeDelayMs));
    } finally {
      this.#activeWrites -= 1;
    }
  }

  async interrupt(): Promise<void> {}

  async terminate(): Promise<void> {
    this.#running = false;
  }

  async dispose(): Promise<void> {
    this.disposeCalls += 1;
    this.disposed = true;
    await this.terminate();
  }
}

class FakeTerminal extends FakeProcess {}

class FailingDisposeProcess extends FakeProcess {
  override async dispose(): Promise<void> {
    await super.dispose();
    throw new Error('injected dispose failure');
  }
}

function fakeRuntime(writeDelayMs = 0): {
  runtime: AgentRuntime;
  processes: FakeProcess[];
  terminals: FakeTerminal[];
} {
  const processes: FakeProcess[] = [];
  const terminals: FakeTerminal[] = [];
  let nextPid = 10_000;
  const unavailable = async (): Promise<never> => { throw new Error('unavailable'); };
  const runtime: AgentRuntime = {
    kind: 'host',
    cwd: '/workspace',
    processes: {
      async startShell() {
        const handle = new FakeProcess(nextPid++, writeDelayMs);
        processes.push(handle);
        return handle;
      },
    },
    terminals: {
      async startShell() {
        const handle = new FakeTerminal(nextPid++, writeDelayMs);
        terminals.push(handle);
        return handle;
      },
    },
    storage: () => ({
      root: '/storage',
      readFile: unavailable,
      writeFile: unavailable,
      listFiles: unavailable,
      mkdir: unavailable,
      remove: unavailable,
    }),
    exec: unavailable,
    shell: unavailable,
    readFile: unavailable,
    writeFile: unavailable,
    listFiles: unavailable,
    mkdir: unavailable,
    remove: unavailable,
  };
  return { runtime, processes, terminals };
}

async function createRuntime(): Promise<HostAgentRuntime> {
  const root = await mkdtemp(join(tmpdir(), 'felan-codex-tools-'));
  temporaryPaths.push(root);
  const cwd = join(root, 'workspace');
  const sessionStorageRoot = join(root, 'session');
  const agentStorageRoot = join(root, 'agent-storage');
  const agentDir = join(root, 'agent-dir');
  await Promise.all([cwd, sessionStorageRoot, agentStorageRoot, agentDir]
    .map((path) => mkdir(path, { recursive: true })));
  return new HostAgentRuntime(cwd, { sessionStorageRoot, agentStorageRoot, agentDir });
}

function runtimeWithoutTerminals(host: HostAgentRuntime): AgentRuntime {
  return {
    kind: host.kind,
    cwd: host.cwd,
    processes: host.processes,
    storage: (scope) => host.storage(scope),
    exec: (command, args, options) => host.exec(command, args, options),
    shell: (command, options) => host.shell(command, options),
    readFile: (path, options) => host.readFile(path, options),
    writeFile: (path, content, options) => host.writeFile(path, content, options),
    listFiles: (path, options) => host.listFiles(path, options),
    mkdir: (path, options) => host.mkdir(path, options),
    remove: (path, options) => host.remove(path, options),
    readAgentFile: (path) => host.readAgentFile(path),
  };
}

function imageContext(): ExtensionContext {
  return { model: {
    provider: 'openai-codex',
    id: 'gpt-5.3-codex',
    api: 'openai-codex-responses',
    input: ['text', 'image'],
  } as Model<Api> } as ExtensionContext;
}

function textContext(): ExtensionContext {
  return { model: {
    provider: 'openai',
    id: 'gpt-5.4',
    api: 'openai-responses',
    input: ['text'],
  } as Model<Api> } as ExtensionContext;
}

async function text(runtime: HostAgentRuntime, path: string): Promise<string> {
  return new TextDecoder().decode(await runtime.readFile(path));
}

function movePatch(): string {
  return `*** Begin Patch
*** Update File: source.txt
*** Move to: destination.txt
@@
-before
+after
*** End Patch`;
}

function runtimeWithRemoveFailures(host: HostAgentRuntime, failRollback: boolean): AgentRuntime {
  return {
    kind: host.kind,
    cwd: host.cwd,
    processes: host.processes,
    storage: (scope) => host.storage(scope),
    exec: (command, args, options) => host.exec(command, args, options),
    shell: (command, options) => host.shell(command, options),
    readFile: (path, options) => host.readFile(path, options),
    writeFile: (path, content, options) => host.writeFile(path, content, options),
    listFiles: (path, options) => host.listFiles(path, options),
    mkdir: (path, options) => host.mkdir(path, options),
    remove: async (path, options) => {
      if (path === 'source.txt' || (failRollback && path === 'destination.txt')) {
        throw new Error(`injected remove failure: ${path}`);
      }
      await host.remove(path, options);
    },
    readAgentFile: (path) => host.readAgentFile(path),
  };
}

function runtimeWithWriteFailure(host: HostAgentRuntime, failedPath: string): AgentRuntime {
  return {
    kind: host.kind,
    cwd: host.cwd,
    processes: host.processes,
    storage: (scope) => host.storage(scope),
    exec: (command, args, options) => host.exec(command, args, options),
    shell: (command, options) => host.shell(command, options),
    readFile: (path, options) => host.readFile(path, options),
    writeFile: async (path, content, options) => {
      if (path === failedPath) throw new Error(`injected write failure: ${path}`);
      await host.writeFile(path, content, options);
    },
    listFiles: (path, options) => host.listFiles(path, options),
    mkdir: (path, options) => host.mkdir(path, options),
    remove: (path, options) => host.remove(path, options),
    readAgentFile: (path) => host.readAgentFile(path),
  };
}
