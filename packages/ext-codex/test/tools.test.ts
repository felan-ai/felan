import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  HostAgentRuntime,
  type AgentRuntime,
  type Api,
  type ExtensionContext,
  type Model,
  type ToolDefinition,
} from '@felan-ai/agent-core';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ExecSessionManager,
  MAX_VIEW_IMAGE_INPUT_BYTES,
  createCodexTools,
} from '../src/index.js';
import { ApplyPatchError, applyPatch } from '../src/patch.js';

const temporaryPaths: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('Codex runtime-backed tools', () => {
  it('executes foreground commands and bounds returned output', async () => {
    const runtime = await createRuntime();
    const sessions = new ExecSessionManager(runtime);
    const exec = tool(createCodexTools(runtime, sessions), 'exec_command');

    const result = await exec.execute(
      'exec',
      { cmd: `${JSON.stringify(process.execPath)} -e "process.stdout.write('x'.repeat(2000))"`, yield_time_ms: 1000, max_output_tokens: 64 },
      undefined,
      undefined,
      imageContext(),
    ) as ToolResult;

    expect(result.details).toMatchObject({ exit_code: 0, original_token_count: 500 });
    expect((result.details as { output: string }).output).toHaveLength(256);
    await sessions.shutdown();
  });

  it('returns persistent sessions and polls them through write_stdin', async () => {
    const runtime = await createRuntime();
    const sessions = new ExecSessionManager(runtime);
    const tools = createCodexTools(runtime, sessions);
    const exec = tool(tools, 'exec_command');
    const writeStdin = tool(tools, 'write_stdin');
    const command = `${JSON.stringify(process.execPath)} -e "setTimeout(() => console.log('finished'), 350)"`;

    const started = await exec.execute(
      'exec', { cmd: command, yield_time_ms: 250 }, undefined, undefined, imageContext(),
    ) as ToolResult;
    const sessionId = (started.details as { session_id: number }).session_id;
    expect(sessionId).toBeTypeOf('number');

    const completed = await writeStdin.execute(
      'poll', { session_id: sessionId, yield_time_ms: 1000 }, undefined, undefined, imageContext(),
    ) as ToolResult;
    expect(completed.details).toMatchObject({ exit_code: 0, output: expect.stringContaining('finished') });
    await sessions.shutdown();
  });

  it('writes input to tty-enabled sessions', async () => {
    const runtime = await createRuntime();
    const sessions = new ExecSessionManager(runtime);
    const tools = createCodexTools(runtime, sessions);
    const exec = tool(tools, 'exec_command');
    const writeStdin = tool(tools, 'write_stdin');
    const script = "process.stdin.once('data', value => { process.stdout.write('got:' + value); process.exit(0) })";
    const started = await exec.execute(
      'exec',
      { cmd: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`, tty: true, yield_time_ms: 250 },
      undefined,
      undefined,
      imageContext(),
    ) as ToolResult;
    const sessionId = (started.details as { session_id: number }).session_id;

    const completed = await writeStdin.execute(
      'input', { session_id: sessionId, chars: 'hello\n', yield_time_ms: 1000 }, undefined, undefined, imageContext(),
    ) as ToolResult;
    expect(completed.details).toMatchObject({ exit_code: 0, output: expect.stringContaining('got:hello') });
    await sessions.shutdown();
  });

  it('decodes UTF-8 incrementally across polls', async () => {
    const runtime = await createRuntime();
    const sessions = new ExecSessionManager(runtime);
    const script = "process.stdout.write(Buffer.from([0xe2,0x82])); setTimeout(() => process.stdout.write(Buffer.from([0xac,0x0a])), 400)";
    const started = await sessions.exec({
      cmd: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`,
      yield_time_ms: 250,
    });

    expect(started.output).toBe('');
    const completed = await sessions.write({ session_id: started.session_id!, yield_time_ms: 1_000 });
    expect(completed).toMatchObject({ output: '€\n', exit_code: 0 });
    await sessions.shutdown();
  });

  it('strips split terminal control sequences while preserving tabs and newlines', async () => {
    const runtime = await createRuntime();
    const sessions = new ExecSessionManager(runtime);
    const first = JSON.stringify('safe\t\n\u001b]0;injected');
    const second = JSON.stringify('\u0007\u001b[31mred\u001b[0m\u001bPsecret\u001b\\\u0000done\n');
    const script = `process.stdout.write(${first}); setTimeout(() => process.stdout.write(${second}), 400)`;
    const started = await sessions.exec({
      cmd: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`,
      yield_time_ms: 250,
    });

    expect(started.output).toBe('safe\t\n');
    const completed = await sessions.write({ session_id: started.session_id!, yield_time_ms: 1_000 });
    expect(completed.output).toBe('reddone\n');
    await sessions.shutdown();
  });

  it('applies add, update, and delete sections through AgentRuntime', async () => {
    const runtime = await createRuntime();
    const sessions = new ExecSessionManager(runtime);
    const patch = tool(createCodexTools(runtime, sessions), 'apply_patch');
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
*** End Patch` }, undefined, undefined, imageContext()) as ToolResult;

    expect(result.details).toMatchObject({
      status: 'success',
      result: { createdFiles: ['nested/new.txt'], deletedFiles: ['delete.txt'] },
    });
    await expect(text(runtime, 'nested/new.txt')).resolves.toBe('created\n');
    await expect(text(runtime, 'old.txt')).resolves.toBe('after\nkeep\n');
    await expect(runtime.readFile('delete.txt')).rejects.toThrow();
    await sessions.shutdown();
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

  it('returns validated image content with dimensions and rejects unsupported models', async () => {
    const runtime = await createRuntime();
    const sessions = new ExecSessionManager(runtime);
    const view = tool(createCodexTools(runtime, sessions), 'view_image');
    await runtime.writeFile('pixel.png', VALID_PNG);
    await runtime.writeFile('plain.txt', new TextEncoder().encode('text'));

    const result = await view.execute('view', { path: '@pixel.png' }, undefined, undefined, imageContext()) as ToolResult;
    expect(result.content[0]).toMatchObject({ type: 'image', mimeType: 'image/png' });
    expect(result.details).toMatchObject({
      originalWidth: 1, originalHeight: 1, width: 1, height: 1, wasResized: false,
    });
    await expect(view.execute('view', { path: 'pixel.png' }, undefined, undefined, textContext()))
      .rejects.toThrow('does not support image input');
    await expect(view.execute('view', { path: 'plain.txt' }, undefined, undefined, imageContext()))
      .rejects.toThrow('expected a PNG, JPEG, GIF, or WebP image');
    await sessions.shutdown();
  });

  it('rejects malformed and valid oversized images', async () => {
    const runtime = await createRuntime();
    const sessions = new ExecSessionManager(runtime);
    const view = tool(createCodexTools(runtime, sessions), 'view_image');
    await runtime.writeFile('malformed.png', VALID_PNG.subarray(0, 40));
    await runtime.writeFile('oversized.png', oversizedValidPng());

    await expect(view.execute('view', { path: 'malformed.png' }, undefined, undefined, imageContext()))
      .rejects.toThrow('could not decode or resize');
    await expect(view.execute('view', { path: 'oversized.png' }, undefined, undefined, imageContext()))
      .rejects.toThrow(`exceeds maximum size of ${MAX_VIEW_IMAGE_INPUT_BYTES} bytes`);
    await sessions.shutdown();
  });

  it('terminates running sessions during shutdown', async () => {
    const runtime = await createRuntime();
    const sessions = new ExecSessionManager(runtime);
    const exec = tool(createCodexTools(runtime, sessions), 'exec_command');
    const started = await exec.execute(
      'exec',
      { cmd: `${JSON.stringify(process.execPath)} -e "setInterval(() => {}, 1000)"`, yield_time_ms: 250 },
      undefined,
      undefined,
      imageContext(),
    ) as ToolResult;
    expect(started.details).toHaveProperty('session_id');

    await sessions.shutdown();

    await expect(sessions.write({ session_id: (started.details as { session_id: number }).session_id }))
      .rejects.toThrow('Unknown process id');
  });

  it('aborts and terminates an executing command', async () => {
    const runtime = await createRuntime();
    const sessions = new ExecSessionManager(runtime);
    const exec = tool(createCodexTools(runtime, sessions), 'exec_command');
    const controller = new AbortController();
    const execution = exec.execute(
      'exec',
      { cmd: `${JSON.stringify(process.execPath)} -e "setInterval(() => {}, 1000)"`, yield_time_ms: 30_000 },
      controller.signal,
      undefined,
      imageContext(),
    );
    setTimeout(() => controller.abort(), 50);

    await expect(execution).rejects.toThrow('exec_command aborted');
    await sessions.shutdown();
  });

  it('disposes an active session when write_stdin is aborted', async () => {
    const runtime = await createRuntime();
    const sessions = new ExecSessionManager(runtime);
    const started = await sessions.exec({
      cmd: `${JSON.stringify(process.execPath)} -e "setInterval(() => {}, 1000)"`,
      tty: true,
      yield_time_ms: 250,
    });
    const controller = new AbortController();
    const writing = sessions.write(
      { session_id: started.session_id!, yield_time_ms: 30_000 },
      controller.signal,
    );
    setTimeout(() => controller.abort(), 50);

    await expect(writing).rejects.toThrow('write_stdin aborted');
    await expect(sessions.write({ session_id: started.session_id! }))
      .rejects.toThrow('Unknown process id');
    await sessions.shutdown();
  });
});

const VALID_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

interface ToolResult {
  content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
  details: unknown;
}

function tool(tools: ToolDefinition<any, any, any>[], name: string): ToolDefinition<any, any, any> {
  const found = tools.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`Tool not found: ${name}`);
  return found;
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

function oversizedValidPng(): Uint8Array {
  const iendOffset = VALID_PNG.length - 12;
  const text = Buffer.alloc(MAX_VIEW_IMAGE_INPUT_BYTES, 0x61);
  Buffer.from('Comment\0').copy(text);
  const type = Buffer.from('tEXt');
  const chunk = Buffer.alloc(12 + text.length);
  chunk.writeUInt32BE(text.length, 0);
  type.copy(chunk, 4);
  text.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([type, text])), 8 + text.length);
  return Buffer.concat([
    VALID_PNG.subarray(0, iendOffset),
    chunk,
    VALID_PNG.subarray(iendOffset),
  ]);
}

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
