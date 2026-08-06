import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  HostAgentRuntime,
  type Api,
  type ExtensionContext,
  type Model,
  type ToolDefinition,
} from '@felan-ai/agent-core';
import { afterEach, describe, expect, it } from 'vitest';
import { ExecSessionManager, createCodexTools } from '../src/index.js';

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

  it('returns image content and rejects unsupported models or non-images', async () => {
    const runtime = await createRuntime();
    const sessions = new ExecSessionManager(runtime);
    const view = tool(createCodexTools(runtime, sessions), 'view_image');
    await runtime.writeFile('pixel.png', new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    await runtime.writeFile('plain.txt', new TextEncoder().encode('text'));

    const result = await view.execute('view', { path: '@pixel.png' }, undefined, undefined, imageContext()) as ToolResult;
    expect(result.content[0]).toMatchObject({ type: 'image', mimeType: 'image/png' });
    await expect(view.execute('view', { path: 'pixel.png' }, undefined, undefined, textContext()))
      .rejects.toThrow('does not support image input');
    await expect(view.execute('view', { path: 'plain.txt' }, undefined, undefined, imageContext()))
      .rejects.toThrow('expected a PNG, JPEG, GIF, or WebP image');
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
