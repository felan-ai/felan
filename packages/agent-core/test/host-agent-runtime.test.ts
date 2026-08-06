import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HostAgentRuntime } from '../src/index.js';

const temporaryPaths: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

describe('HostAgentRuntime', () => {
  it('keeps cwd immutable and rejects escaping execution paths', async () => {
    const workspace = await createTemporaryDirectory('workspace');
    const runtime = await createHostRuntime(workspace);

    expect(Reflect.set(runtime, 'cwd', join(workspace, 'other'))).toBe(false);
    expect(runtime.cwd).toBe(workspace);
    await expect(runtime.exec(process.execPath, ['--version'], { cwd: '..' })).rejects.toThrow(
      'escapes runtime root',
    );
  });

  it('preserves literal argv boundaries and nonzero results', async () => {
    const runtime = await createHostRuntime(await createTemporaryDirectory('workspace'));
    const args = ['plain', 'two words', '"quoted"', "'single'", '$HOME', 'semi;colon', '', '--flag=value'];
    const literal = await runtime.exec(process.execPath, [
      '-e',
      'process.stdout.write(JSON.stringify(process.argv.slice(1)))',
      '--',
      ...args,
    ]);
    expect(literal).toMatchObject({ stdout: JSON.stringify(args), code: 0, killed: false });

    const failure = await runtime.exec(process.execPath, [
      '-e',
      "process.stderr.write('expected failure'); process.exit(17)",
    ]);
    expect(failure).toMatchObject({ stderr: 'expected failure', code: 17, killed: false });
  });

  it('kills execution on timeout', async () => {
    const runtime = await createHostRuntime(await createTemporaryDirectory('workspace'));
    const result = await runtime.exec(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1000)'],
      { timeout: 20 },
    );

    expect(result.killed).toBe(true);
    expect(result.code).not.toBe(0);
  });

  it('rejects lexical and symlink escapes across operations', async () => {
    const workspace = await createTemporaryDirectory('workspace');
    const outside = await createTemporaryDirectory('outside');
    const runtime = await createHostRuntime(workspace);
    await writeFile(join(outside, 'secret'), 'outside');
    await symlink(outside, join(workspace, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');

    await expect(runtime.readFile('../outside')).rejects.toThrow('escapes runtime root');
    await expect(runtime.readFile(resolve(outside, 'secret'))).rejects.toThrow('escapes runtime root');
    await expect(runtime.readFile('bad\0path')).rejects.toThrow('NUL');
    await expect(runtime.readFile('escape/secret')).rejects.toThrow('escapes runtime root');
    await expect(runtime.writeFile('escape/new', new Uint8Array([1]))).rejects.toThrow('escapes runtime root');
    await expect(runtime.listFiles('escape')).rejects.toThrow('escapes runtime root');
    await expect(runtime.mkdir('escape/new')).rejects.toThrow('escapes runtime root');
    await expect(runtime.remove('escape', { recursive: true })).rejects.toThrow('escapes runtime root');
    await expect(runtime.exec(process.execPath, ['--version'], { cwd: 'escape' })).rejects.toThrow(
      'escapes runtime root',
    );
    await expect(runtime.remove(workspace, { recursive: true })).rejects.toThrow(
      'runtime root cannot be removed',
    );
  });

  it('provides stable session and agent storage handles with session as the default', async () => {
    const workspace = await createTemporaryDirectory('workspace');
    const sessionStorageRoot = await createTemporaryDirectory('session-storage');
    const agentStorageRoot = await createTemporaryDirectory('agent-storage');
    const outside = await createTemporaryDirectory('outside-storage');
    const runtime = new HostAgentRuntime(workspace, { sessionStorageRoot, agentStorageRoot });
    const content = new Uint8Array([1, 2, 3]);
    const sessionStorage = runtime.storage();
    const agentStorage = runtime.storage('agent');

    expect(sessionStorage).toBe(runtime.storage('session'));
    expect(sessionStorage.root).toBe(sessionStorageRoot);
    expect(agentStorage.root).toBe(agentStorageRoot);
    expect(() => runtime.storage('other' as never)).toThrow(
      'Unsupported runtime storage scope: other',
    );
    await sessionStorage.mkdir('background-bash', { recursive: true });
    await sessionStorage.writeFile('background-bash/state.bin', content);
    await agentStorage.writeFile('state.bin', content);
    await writeFile(join(outside, 'secret.bin'), content);
    await symlink(
      outside,
      join(sessionStorageRoot, 'escape'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    await expect(sessionStorage.readFile('background-bash/state.bin')).resolves.toEqual(content);
    await expect(runtime.readFile(resolve(sessionStorageRoot, 'background-bash/state.bin')))
      .resolves.toEqual(content);
    await expect(runtime.listFiles(sessionStorageRoot, { recursive: true }))
      .resolves.toEqual([join('background-bash', 'state.bin')]);
    await expect(runtime.readFile(resolve(agentStorageRoot, 'state.bin')))
      .rejects.toThrow('agent storage');
    await expect(runtime.listFiles(agentStorageRoot)).rejects.toThrow('agent storage');
    await expect(runtime.writeFile(resolve(sessionStorageRoot, 'ordinary.bin'), content))
      .rejects.toThrow('escapes runtime root');
    await expect(sessionStorage.readFile(resolve(workspace, 'workspace.bin')))
      .rejects.toThrow('escapes runtime root');
    await expect(sessionStorage.readFile('escape/secret.bin'))
      .rejects.toThrow('escapes runtime root');
    await expect(sessionStorage.remove(sessionStorageRoot, { recursive: true }))
      .rejects.toThrow('runtime root cannot be removed');
    await expect(agentStorage.remove(agentStorageRoot, { recursive: true }))
      .rejects.toThrow('runtime root cannot be removed');
  });

  it('supports binary file IO, listing, mkdir, and removal', async () => {
    const runtime = await createHostRuntime(await createTemporaryDirectory('workspace'));
    const binary = new Uint8Array([0, 255, 128, 13, 10]);
    await runtime.mkdir('nested/deep', { recursive: true });
    await runtime.writeFile('nested/top.bin', binary);
    await runtime.writeFile('nested/deep/data.bin', binary);

    await expect(runtime.readFile('nested/top.bin')).resolves.toEqual(binary);
    await expect(runtime.listFiles('nested')).resolves.toEqual(['top.bin']);
    await expect(runtime.listFiles('nested', { recursive: true })).resolves.toEqual([
      join('deep', 'data.bin'),
      'top.bin',
    ]);
    await expect(runtime.remove('nested')).rejects.toThrow();
    await runtime.remove('nested', { recursive: true });
    await expect(runtime.readFile('nested/top.bin')).rejects.toThrow();
  });

  it('uses a shell only through the explicit shell method', async () => {
    const runtime = await createHostRuntime(await createTemporaryDirectory('workspace'));
    const variable = 'literal value; $HOME';
    const command = process.platform === 'win32'
      ? 'echo %HOST_RUNTIME_LITERAL%'
      : 'printf %s "$HOST_RUNTIME_LITERAL"';
    const result = await runtime.shell(command, { env: { HOST_RUNTIME_LITERAL: variable } });

    expect(result.stdout.trim()).toBe(variable);
    expect(result.code).toBe(0);
    expect(result.killed).toBe(false);
  });

  it('reads only files inside its configured agent directory', async () => {
    const workspace = await createTemporaryDirectory('workspace');
    const storageRoot = await createTemporaryDirectory('storage');
    const agentDir = await createTemporaryDirectory('agent-dir');
    const runtime = new HostAgentRuntime(workspace, {
      sessionStorageRoot: storageRoot,
      agentStorageRoot: join(storageRoot, 'agent'),
      agentDir,
    });
    await mkdir(join(storageRoot, 'agent'), { recursive: true });
    await writeFile(join(agentDir, 'codex.json'), '{"fast":true}');

    await expect(runtime.readAgentFile('codex.json'))
      .resolves.toEqual(new TextEncoder().encode('{"fast":true}'));
    await expect(runtime.readAgentFile('../secret')).rejects.toThrow('escapes runtime root');
  });

  it('supports persistent shell polling, input, and cleanup', async () => {
    const runtime = await createHostRuntime(await createTemporaryDirectory('workspace'));
    const script = "process.stdin.once('data', value => { process.stdout.write('got:' + value); process.exit(0) })";
    const processHandle = await runtime.processes.startShell(
      `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`,
      { stdin: true },
    );
    const pid = processHandle.pid!;
    await processHandle.write(new TextEncoder().encode('input\n'));
    const snapshot = await processHandle.read(0, { waitMs: 1_000 });

    expect(new TextDecoder().decode(snapshot.output)).toContain('got:input');
    await processHandle.dispose();
    await expect(waitForProcessExit(pid)).resolves.toBeUndefined();
  });

  it.skipIf(process.platform === 'win32')('kills the spawned process group on cancellation', async () => {
    const runtime = await createHostRuntime(await createTemporaryDirectory('workspace'));
    const controller = new AbortController();
    const script = [
      "const { spawn } = require('node:child_process');",
      "const { writeFileSync } = require('node:fs');",
      "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
      "writeFileSync('child.pid', String(child.pid));",
      'setInterval(() => {}, 1000);',
    ].join(' ');
    const execution = runtime.exec(process.execPath, ['-e', script], { signal: controller.signal });
    const childPid = Number(new TextDecoder().decode(await waitForFile(runtime, 'child.pid')));

    controller.abort();

    await expect(execution).resolves.toMatchObject({ code: 143, killed: true });
    await expect(waitForProcessExit(childPid)).resolves.toBeUndefined();
  });
});

async function createTemporaryDirectory(name: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), `felan-${name}-`));
  temporaryPaths.push(path);
  return realpath(path);
}

async function createHostRuntime(cwd: string): Promise<HostAgentRuntime> {
  const storageRoot = await createTemporaryDirectory('storage');
  const sessionStorageRoot = join(storageRoot, 'session');
  const agentStorageRoot = join(storageRoot, 'agent');
  await Promise.all([
    mkdir(sessionStorageRoot, { recursive: true }),
    mkdir(agentStorageRoot, { recursive: true }),
  ]);
  return new HostAgentRuntime(cwd, { sessionStorageRoot, agentStorageRoot });
}

async function waitForFile(runtime: HostAgentRuntime, path: string): Promise<Uint8Array> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      return await runtime.readFile(path);
    } catch {
      await delay(10);
    }
  }
  throw new Error(`Timed out waiting for ${path}`);
}

async function waitForProcessExit(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return;
      throw error;
    }
    await delay(10);
  }
  throw new Error(`Process ${pid} remained alive after cancellation`);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
