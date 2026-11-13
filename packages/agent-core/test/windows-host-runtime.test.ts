import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { constants } from 'node:fs';
import { link, lstat, mkdir, mkdtemp, open, readFile, rename, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { HostAgentRuntime } from '../src/host-agent-runtime.js';
import type { AgentRuntimeProcess } from '../src/runtime.js';

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, link: vi.fn(actual.link), lstat: vi.fn(actual.lstat), open: vi.fn(actual.open), rename: vi.fn(actual.rename), rm: vi.fn(actual.rm) };
});
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});
const actualFiles = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
const actualProcesses = await vi.importActual<typeof import('node:child_process')>('node:child_process');
const directories: string[] = [];
const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
const windowsEnvironment = Object.entries(process.env).filter(([name]) => /^(?:systemroot|comspec)$/iu.test(name));
beforeEach(() => {
  vi.mocked(link).mockReset().mockImplementation(actualFiles.link);
  vi.mocked(lstat).mockReset().mockImplementation(actualFiles.lstat);
  vi.mocked(open).mockReset().mockImplementation(actualFiles.open);
  vi.mocked(rename).mockReset().mockImplementation(actualFiles.rename);
  vi.mocked(rm).mockReset().mockImplementation(actualFiles.rm);
  vi.mocked(spawn).mockReset().mockImplementation(actualProcesses.spawn);
});
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  if (process.platform === 'win32') {
    for (const name of ['SystemRoot', 'SYSTEMROOT', 'ComSpec', 'COMSPEC']) delete process.env[name];
    for (const [name, value] of windowsEnvironment) process.env[name] = value;
  }
  await Promise.all(directories.splice(0).map(path => actualFiles.rm(path, { recursive: true, force: true })));
});

async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), 'windows-host-runtime-')); directories.push(cwd);
  await mkdir(join(cwd, 'storage'));
  return { cwd, runtime: new HostAgentRuntime(cwd, { sessionStorageRoot: join(cwd, 'storage'), agentStorageRoot: join(cwd, 'storage') }) };
}

async function waitForProcess(handle: AgentRuntimeProcess, predicate: (output: string, running: boolean) => boolean) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const snapshot = await handle.read(0, { waitMs: 100 });
    if (predicate(Buffer.from(snapshot.output).toString(), snapshot.running)) return snapshot;
    if (!snapshot.running) throw new Error('Process exited before the expected output');
    await delay(10);
  }
  throw new Error('Timed out waiting for process output or completion');
}

it.runIf(process.platform === 'win32')('retries atomic replacement until a Windows snapshot reader closes', async () => {
  const { cwd, runtime } = await fixture();
  await runtime.writeFile('source', new Uint8Array([2]));
  await runtime.writeFile('target', new Uint8Array([1]));
  const reader = await open(join(cwd, 'target'), 'r');
  const moving = runtime.files.move('source', 'target');
  try {
    await delay(40);
    expect(await readFile(join(cwd, 'target'))).toEqual(Buffer.from([1]));
  } finally { await reader.close(); }
  await moving;
  expect(await readFile(join(cwd, 'target'))).toEqual(Buffer.from([2]));
  await expect(lstat(join(cwd, 'source'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it.runIf(process.platform === 'win32')('bounds Windows replacement retries without unlinking either file', async () => {
  const { cwd, runtime } = await fixture();
  await runtime.writeFile('source', new Uint8Array([2]));
  await runtime.writeFile('target', new Uint8Array([1]));
  vi.mocked(rename).mockRejectedValue(Object.assign(new Error('locked'), { code: 'EPERM' }));
  await expect(runtime.files.move('source', 'target')).rejects.toMatchObject({ code: 'EPERM' });
  expect(rename).toHaveBeenCalledTimes(7);
  expect(await readFile(join(cwd, 'source'))).toEqual(Buffer.from([2]));
  expect(await readFile(join(cwd, 'target'))).toEqual(Buffer.from([1]));
});

it.runIf(process.platform === 'win32').each(['snapshot', 'append', 'write'] as const)(
  'rejects Windows file replacement during a no-follow %s before content I/O', async operation => {
    const { cwd, runtime } = await fixture();
    await runtime.writeFile('file', new Uint8Array([1]));
    await runtime.writeFile('other', new Uint8Array([9]));
    vi.mocked(open).mockImplementationOnce(async (path, flags, mode) => {
      await rename(join(cwd, 'file'), join(cwd, 'original'));
      await symlink('other', join(cwd, 'file'));
      const handle = await actualFiles.open(path, flags, mode);
      await rm(join(cwd, 'file'));
      await rename(join(cwd, 'original'), join(cwd, 'file'));
      return handle;
    });
    const result = operation === 'snapshot' ? runtime.files.snapshot('file', 4)
      : operation === 'append' ? runtime.files.append('file', new Uint8Array([2]))
        : runtime.writeFile('file', new Uint8Array([2]), { noFollow: true });
    await expect(result).rejects.toThrow('File changed while opening');
    expect(await readFile(join(cwd, 'file'))).toEqual(Buffer.from([1]));
    expect(await readFile(join(cwd, 'other'))).toEqual(Buffer.from([9]));
  },
);

it.runIf(process.platform === 'win32').each(['inspect', 'open'] as const)('does not create a symlink target inserted during a Windows no-follow %s', async phase => {
  const { cwd, runtime } = await fixture();
  const insert = () => symlink('missing-target', join(cwd, 'file'));
  if (phase === 'inspect') vi.mocked(lstat).mockImplementationOnce(async path => {
    await insert();
    return actualFiles.lstat(path);
  });
  else vi.mocked(open).mockImplementationOnce(async (path, flags, mode) => {
    expect(Number(flags) & constants.O_EXCL).toBe(constants.O_EXCL);
    await insert();
    return actualFiles.open(path, flags, mode);
  });
  await expect(runtime.files.append('file', new Uint8Array([2]))).rejects.toMatchObject({ code: 'ELOOP' });
  if (phase === 'inspect') expect(open).not.toHaveBeenCalled();
  await expect(lstat(join(cwd, 'missing-target'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await runtime.listFiles('.', { includeDirectories: true, includeOther: true })).toEqual(['file', 'storage']);
});

it.runIf(process.platform === 'win32').each(['append', 'write'] as const)('rechecks a concurrent Windows file creator before a no-follow %s', async operation => {
  const { cwd, runtime } = await fixture();
  vi.mocked(open).mockImplementationOnce(async (path, flags, mode) => {
    expect(Number(flags) & constants.O_EXCL).toBe(constants.O_EXCL);
    await actualFiles.writeFile(join(cwd, 'file'), new Uint8Array([1]));
    return actualFiles.open(path, flags, mode);
  });
  if (operation === 'append') await runtime.files.append('file', new Uint8Array([2]));
  else await runtime.writeFile('file', new Uint8Array([2]), { noFollow: true });
  expect(open).toHaveBeenCalledTimes(2);
  expect(Number(vi.mocked(open).mock.calls[1]![1]) & constants.O_CREAT).toBe(0);
  expect(await readFile(join(cwd, 'file'))).toEqual(Buffer.from(operation === 'append' ? [1, 2] : [2]));
});

it.runIf(process.platform === 'win32')('preserves exclusive creation during a Windows no-follow create race', async () => {
  const { cwd, runtime } = await fixture();
  vi.mocked(open).mockImplementationOnce(async (path, flags, mode) => {
    await actualFiles.writeFile(join(cwd, 'file'), new Uint8Array([1]));
    return actualFiles.open(path, flags, mode);
  });
  await expect(runtime.writeFile('file', new Uint8Array([2]), { noFollow: true, exclusive: true })).rejects.toMatchObject({ code: 'EEXIST' });
  expect(open).toHaveBeenCalledTimes(1);
  expect(await readFile(join(cwd, 'file'))).toEqual(Buffer.from([1]));
});

it.runIf(process.platform === 'win32')('bounds Windows no-follow create retries', async () => {
  const { runtime } = await fixture();
  vi.mocked(link).mockRejectedValue(Object.assign(new Error('exists'), { code: 'EEXIST' }));
  await expect(runtime.files.append('file', new Uint8Array([2]))).rejects.toMatchObject({ code: 'EEXIST' });
  expect(link).toHaveBeenCalledTimes(7);
  expect(await runtime.listFiles('.', { includeOther: true })).toEqual([]);
});

it.runIf(process.platform === 'win32')('preserves a read-only mode after staging a new Windows file', async () => {
  const { cwd, runtime } = await fixture();
  await runtime.writeFile('file', new Uint8Array([1]), { noFollow: true, readOnly: true, exclusive: true });
  expect(await readFile(join(cwd, 'file'))).toEqual(Buffer.from([1]));
  expect((await lstat(join(cwd, 'file'))).mode & 0o200).toBe(0);
  expect(await runtime.listFiles('.')).toEqual(['file']);
});

it.runIf(process.platform === 'win32').each(['EISDIR', 'ENOTSUP', 'EXDEV'])('falls back to exclusive Windows creation when hard links fail with %s', async code => {
  const { cwd, runtime } = await fixture();
  vi.mocked(link).mockRejectedValue(Object.assign(new Error('unsupported'), { code }));
  await runtime.files.append('append', new Uint8Array([1]));
  await runtime.writeFile('write', new Uint8Array([2]), { noFollow: true, exclusive: true });
  await runtime.writeFile('readonly', new Uint8Array([3]), { readOnly: true, exclusive: true });
  expect(await readFile(join(cwd, 'append'))).toEqual(Buffer.from([1]));
  expect(await readFile(join(cwd, 'write'))).toEqual(Buffer.from([2]));
  expect(await readFile(join(cwd, 'readonly'))).toEqual(Buffer.from([3]));
  expect((await lstat(join(cwd, 'readonly'))).mode & 0o200).toBe(0);
  expect(link).toHaveBeenCalledTimes(3);
  expect(open).toHaveBeenCalledTimes(9);
  for (let index = 0; index < 9; index += 3) {
    expect(Number(vi.mocked(open).mock.calls[index + 1]![1]) & (constants.O_CREAT | constants.O_EXCL)).toBe(constants.O_CREAT | constants.O_EXCL);
    expect(Number(vi.mocked(open).mock.calls[index + 2]![1]) & (constants.O_CREAT | constants.O_EXCL)).toBe(0);
  }
  expect(await runtime.listFiles('.')).toEqual(['append', 'readonly', 'write']);
});

it.runIf(process.platform === 'win32').each(['EEXIST', 'EACCES', 'EPERM', 'EBUSY', 'ENOENT', 'EIO'])('does not fall back after another Windows hard-link error %s', async code => {
  const { runtime } = await fixture();
  const error = Object.assign(new Error('link failed'), { code });
  vi.mocked(link).mockRejectedValue(error);
  await expect(runtime.writeFile('file', new Uint8Array([2]), { noFollow: true, exclusive: true })).rejects.toBe(error);
  expect(open).toHaveBeenCalledTimes(1);
  expect(link).toHaveBeenCalledTimes(1);
  expect(await runtime.listFiles('.')).toEqual([]);
});

it.runIf(process.platform === 'win32').each(['append', 'write', 'exclusive'] as const)('preserves a concurrent file during a Windows fallback %s', async operation => {
  const { cwd, runtime } = await fixture();
  vi.mocked(link).mockRejectedValue(Object.assign(new Error('unsupported'), { code: 'ENOTSUP' }));
  vi.mocked(open).mockImplementation(async (path, flags, mode) => {
    if (path === join(cwd, 'file') && Number(flags) & constants.O_CREAT) await actualFiles.writeFile(path, new Uint8Array([1]));
    return actualFiles.open(path, flags, mode);
  });
  if (operation === 'append') await runtime.files.append('file', new Uint8Array([2]));
  else if (operation === 'write') await runtime.writeFile('file', new Uint8Array([2]), { noFollow: true });
  else await expect(runtime.writeFile('file', new Uint8Array([2]), { noFollow: true, exclusive: true })).rejects.toMatchObject({ code: 'EEXIST' });
  expect(await readFile(join(cwd, 'file'))).toEqual(Buffer.from(operation === 'append' ? [1, 2] : operation === 'write' ? [2] : [1]));
  expect(link).toHaveBeenCalledTimes(1);
  expect(await runtime.listFiles('.')).toEqual(['file']);
});

it.runIf(process.platform === 'win32').each(['append', 'write'] as const)('checks the created identity before a Windows fallback %s', async operation => {
  const { cwd, runtime } = await fixture();
  vi.mocked(link).mockRejectedValue(Object.assign(new Error('unsupported'), { code: 'ENOTSUP' }));
  vi.mocked(open).mockImplementation(async (path, flags, mode) => {
    if (path === join(cwd, 'file') && !(Number(flags) & constants.O_CREAT)) {
      await actualFiles.rename(path, join(cwd, 'original'));
      await actualFiles.writeFile(path, new Uint8Array([9]));
    }
    return actualFiles.open(path, flags, mode);
  });
  const result = operation === 'append' ? runtime.files.append('file', new Uint8Array([2]))
    : runtime.writeFile('file', new Uint8Array([2]), { noFollow: true });
  await expect(result).rejects.toThrow('File changed while opening');
  expect(await readFile(join(cwd, 'file'))).toEqual(Buffer.from([9]));
  expect(await readFile(join(cwd, 'original'))).toEqual(Buffer.from([]));
  expect(await runtime.listFiles('.')).toEqual(['file', 'original']);
});

it.runIf(process.platform === 'win32').each(['EPERM', 'EACCES', 'EBUSY'])('retries a Windows staging removal that fails with %s after publishing', async code => {
  const { cwd, runtime } = await fixture();
  vi.mocked(rm).mockRejectedValueOnce(Object.assign(new Error('locked'), { code }));
  await runtime.writeFile('file', new Uint8Array([2]), { noFollow: true, exclusive: true });
  expect(await readFile(join(cwd, 'file'))).toEqual(Buffer.from([2]));
  expect(link).toHaveBeenCalledTimes(1);
  expect(rm).toHaveBeenCalledTimes(2);
  expect(await runtime.listFiles('.')).toEqual(['file']);
});

it.runIf(process.platform === 'win32').each(['EPERM', 'EACCES', 'EBUSY', 'EIO'])('does not fail a published Windows create when staging removal keeps failing with %s', async code => {
  const { cwd, runtime } = await fixture();
  vi.mocked(rm).mockRejectedValue(Object.assign(new Error('removal failed'), { code }));
  await runtime.writeFile('file', new Uint8Array([2]), { noFollow: true, exclusive: true });
  expect(await readFile(join(cwd, 'file'))).toEqual(Buffer.from([2]));
  expect(await readFile(vi.mocked(link).mock.calls[0]![0])).toEqual(Buffer.from([2]));
  expect(link).toHaveBeenCalledTimes(1);
  expect(rm).toHaveBeenCalledTimes(code === 'EIO' ? 1 : 4);
});

it.runIf(process.platform === 'win32')('does not fail a Windows fallback create when staging removal keeps failing', async () => {
  const { cwd, runtime } = await fixture();
  vi.mocked(link).mockRejectedValue(Object.assign(new Error('unsupported'), { code: 'EXDEV' }));
  vi.mocked(rm).mockRejectedValue(Object.assign(new Error('locked'), { code: 'EBUSY' }));
  await runtime.writeFile('file', new Uint8Array([2]), { noFollow: true, exclusive: true });
  expect(await readFile(join(cwd, 'file'))).toEqual(Buffer.from([2]));
  expect(await readFile(vi.mocked(link).mock.calls[0]![0])).toEqual(Buffer.from([]));
  expect(rm).toHaveBeenCalledTimes(4);
});

it.runIf(process.platform === 'win32')('preserves the Windows link error when staging removal also fails', async () => {
  const { runtime } = await fixture();
  const error = Object.assign(new Error('link denied'), { code: 'EACCES' });
  vi.mocked(link).mockRejectedValue(error);
  vi.mocked(rm).mockRejectedValue(Object.assign(new Error('locked'), { code: 'EPERM' }));
  await expect(runtime.files.append('file', new Uint8Array([2]))).rejects.toBe(error);
  expect(open).toHaveBeenCalledTimes(1);
  expect(rm).toHaveBeenCalledTimes(4);
});

it.runIf(process.platform === 'win32')('rechecks a symlink after a Windows no-follow create collision', async () => {
  const { cwd, runtime } = await fixture();
  vi.mocked(link).mockImplementationOnce(async () => {
    await symlink('missing-target', join(cwd, 'file'));
    throw Object.assign(new Error('exists'), { code: 'EEXIST' });
  });
  await expect(runtime.files.append('file', new Uint8Array([2]))).rejects.toMatchObject({ code: 'ELOOP' });
  expect(link).toHaveBeenCalledTimes(1);
  await expect(lstat(join(cwd, 'missing-target'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it.runIf(process.platform === 'win32').each(['append', 'write'] as const)('checks staged identity after publishing a Windows no-follow %s', async operation => {
  const { cwd, runtime } = await fixture();
  vi.mocked(link).mockImplementationOnce(async (source, target) => {
    await actualFiles.link(source, target);
    await actualFiles.rename(target, join(cwd, 'original'));
    await actualFiles.writeFile(target, new Uint8Array([9]));
  });
  const result = operation === 'append' ? runtime.files.append('file', new Uint8Array([2]))
    : runtime.writeFile('file', new Uint8Array([2]), { noFollow: true });
  await expect(result).rejects.toThrow('File changed while opening');
  expect(await readFile(join(cwd, 'file'))).toEqual(Buffer.from([9]));
  expect(await readFile(join(cwd, 'original'))).toEqual(Buffer.from([]));
  expect(Number(vi.mocked(open).mock.calls[1]![1]) & constants.O_CREAT).toBe(0);
  expect(await runtime.listFiles('.')).toEqual(['file', 'original']);
});

it.runIf(process.platform === 'win32')('does not follow a dangling symlink inserted after publishing a Windows staged file', async () => {
  const { cwd, runtime } = await fixture();
  vi.mocked(open).mockImplementation(async (path, flags, mode) => {
    if (path === join(cwd, 'file')) {
      expect(Number(flags) & constants.O_CREAT).toBe(0);
      await actualFiles.rm(path);
      await actualFiles.symlink('missing-target', path);
    }
    return actualFiles.open(path, flags, mode);
  });
  await expect(runtime.files.append('file', new Uint8Array([2]))).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(lstat(join(cwd, 'missing-target'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await runtime.listFiles('.', { includeOther: true })).toEqual(['file']);
});

it.runIf(process.platform === 'win32').each(['append', 'write'] as const)(
  'does not create a dangling target replacing an existing Windows file during %s', async operation => {
    const { cwd, runtime } = await fixture();
    await runtime.writeFile('file', new Uint8Array([1]));
    vi.mocked(open).mockImplementationOnce(async (path, flags, mode) => {
      await rename(join(cwd, 'file'), join(cwd, 'original'));
      await symlink('missing-target', join(cwd, 'file'));
      try { return await actualFiles.open(path, flags, mode); }
      finally {
        await rm(join(cwd, 'file'));
        await rename(join(cwd, 'original'), join(cwd, 'file'));
      }
    });
    const result = operation === 'append' ? runtime.files.append('file', new Uint8Array([2]))
      : runtime.writeFile('file', new Uint8Array([2]), { noFollow: true });
    await expect(result).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(cwd, 'file'))).toEqual(Buffer.from([1]));
    await expect(lstat(join(cwd, 'missing-target'))).rejects.toMatchObject({ code: 'ENOENT' });
  },
);

it.runIf(process.platform === 'win32').each([true, false])('requires pipe closure after Windows taskkill completes, close=%s', async closes => {
  const { runtime } = await fixture();
  const stdout = new PassThrough(), stderr = new PassThrough();
  const child = Object.assign(new EventEmitter(), { pid: 424242, stdout, stderr, stdin: null, exitCode: null, signalCode: null }) as unknown as ChildProcess;
  const killer = new EventEmitter() as ChildProcess;
  vi.mocked(spawn).mockReturnValueOnce(child).mockReturnValue(killer);
  vi.useFakeTimers();
  let handle: AgentRuntimeProcess | undefined;
  try {
    handle = await runtime.processes.startShell('command');
    const termination = handle.terminate('SIGKILL');
    let settled = false;
    const result = termination.then(() => { settled = true; }, error => { settled = true; return error as Error; });
    child.emit('exit', 1, null);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(settled).toBe(false);
    expect((await handle.read(0)).running).toBe(true);
    killer.emit('close', 0);
    await vi.advanceTimersByTimeAsync(100);
    expect(settled).toBe(false);
    expect((await handle.read(0)).running).toBe(true);
    if (closes) child.emit('close', 1, null);
    else await vi.advanceTimersByTimeAsync(1_000);
    if (closes) expect(await result).toBeUndefined();
    else expect(await result).toEqual(new Error('Process remained running after SIGKILL'));
  } finally {
    child.emit('close', 1, null);
    await handle?.dispose().catch(() => {});
    stdout.destroy(); stderr.destroy();
    vi.useRealTimers();
  }
});

it.runIf(process.platform === 'win32').each(['shell', 'stdio'] as const)(
  'waits for taskkill to finish before timing out forced %s termination', async kind => {
    const { runtime } = await fixture();
    const taskkill = join(systemRoot!, 'System32', 'taskkill.exe');
    const stdout = new PassThrough(), stderr = new PassThrough();
    const child = Object.assign(new EventEmitter(), { pid: 424242, stdout, stderr, stdin: null, exitCode: null, signalCode: null }) as unknown as ChildProcess;
    const killer = new EventEmitter() as ChildProcess;
    vi.mocked(spawn).mockReturnValueOnce(child).mockReturnValue(killer);
    vi.useFakeTimers();
    let handle: AgentRuntimeProcess | undefined;
    try {
      handle = kind === 'shell' ? await runtime.processes.startShell('command') : await runtime.processes.startStdio!('command', []);
      let settled = false;
      const termination = handle.terminate('SIGKILL').then(() => { settled = true; });
      expect(spawn).toHaveBeenLastCalledWith(taskkill, ['/pid', '424242', '/T', '/F'], expect.objectContaining({ timeout: 5_000 }));
      await vi.advanceTimersByTimeAsync(1_300);
      expect(settled).toBe(false);
      expect((await handle.read(0)).running).toBe(true);
      child.emit('close', 1, null);
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(false);
      killer.emit('close', 0, null);
      await termination;
      expect(settled).toBe(true);
      expect((await handle.read(0)).running).toBe(false);
    } finally {
      child.emit('close', 1, null); killer.emit('close', 0, null);
      try { await handle?.dispose(); }
      finally {
        stdout.destroy(); stderr.destroy();
        vi.useRealTimers();
      }
    }
  },
);

it.runIf(process.platform === 'win32').each([
  ['shell', false], ['shell', true], ['stdio', false], ['stdio', true],
] as const)('handles a signalled taskkill for %s with target exited=%s', async (kind, exited) => {
  const { runtime } = await fixture();
  const stdout = new PassThrough(), stderr = new PassThrough();
  const child = Object.assign(new EventEmitter(), { pid: 424242, stdout, stderr, stdin: null, exitCode: null, signalCode: null }) as unknown as ChildProcess;
  const killer = new EventEmitter() as ChildProcess;
  vi.mocked(spawn).mockReturnValueOnce(child).mockReturnValue(killer);
  vi.useFakeTimers();
  let handle: AgentRuntimeProcess | undefined;
  try {
    handle = kind === 'shell' ? await runtime.processes.startShell('command') : await runtime.processes.startStdio!('command', []);
    const result = handle.terminate('SIGKILL').then(() => undefined, error => error as Error);
    await vi.advanceTimersByTimeAsync(5_000);
    if (exited) { Object.assign(child, { exitCode: 1 }); child.emit('exit', 1, null); child.emit('close', 1, null); }
    killer.emit('close', null, 'SIGTERM');
    if (exited) expect(await result).toBeUndefined();
    else {
      expect(await result).toEqual(new Error('taskkill exited with code null'));
      expect((await handle.read(0)).running).toBe(true);
    }
  } finally {
    child.emit('close', 1, null);
    await handle?.dispose().catch(() => {});
    stdout.destroy(); stderr.destroy();
    vi.useRealTimers();
  }
});

it.runIf(process.platform === 'win32').each(['taskkill', 'CMD.EXE', 'explorer.exe', 'curl', 'tar.exe'])('pins Windows %s to the system directory instead of searching the project cwd', async command => {
  const { runtime } = await fixture();
  vi.mocked(spawn).mockImplementation((_command, _args, options) => actualProcesses.spawn(process.execPath, ['-e', ''], { ...options, shell: false }));
  await runtime.exec(command, []);
  const name = command.toLowerCase().replace(/\.exe$/u, '');
  const expected = name === 'explorer' ? join(systemRoot!, 'explorer.exe') : join(systemRoot!, 'System32', `${name}.exe`);
  expect(spawn).toHaveBeenCalledWith(expected, [], expect.objectContaining({ cwd: runtime.cwd, windowsHide: true, shell: false }));
});

it.runIf(process.platform === 'win32').each([undefined, '', 'Windows', '\\Windows', 'C:Windows', '\\\\server\\share\\Windows'])('refuses a non-absolute SystemRoot %s before spawning a Windows system command', async root => {
  const { runtime } = await fixture();
  vi.stubEnv('SYSTEMROOT', undefined);
  vi.stubEnv('SystemRoot', root);
  await expect(runtime.exec('curl', [])).rejects.toThrow('SystemRoot must be an absolute Windows path');
  expect(spawn).not.toHaveBeenCalled();
});

it.runIf(process.platform === 'win32')('refuses a NUL-containing SystemRoot before spawning a Windows system command', async () => {
  const { runtime } = await fixture();
  // Windows truncates NUL-containing values assigned to the real environment.
  vi.stubGlobal('process', { ...process, env: { ...process.env, SystemRoot: 'C:\\Windows\0invalid' } });
  await expect(runtime.exec('curl', [])).rejects.toThrow('SystemRoot must be an absolute Windows path');
  expect(spawn).not.toHaveBeenCalled();
});

it.runIf(process.platform === 'win32')('validates taskkill before launching any Windows child', async () => {
  const { runtime } = await fixture();
  vi.stubEnv('SystemRoot', 'relative');
  await expect(runtime.exec(process.execPath, [], { timeout: 10 })).rejects.toThrow('SystemRoot must be an absolute Windows path');
  await expect(runtime.shell('echo test')).rejects.toThrow('SystemRoot must be an absolute Windows path');
  await expect(runtime.processes.startShell('echo test')).rejects.toThrow('SystemRoot must be an absolute Windows path');
  await expect(runtime.processes.startStdio!(process.execPath, [])).rejects.toThrow('SystemRoot must be an absolute Windows path');
  expect(spawn).not.toHaveBeenCalled();
});

it.runIf(process.platform === 'win32')('captures taskkill before a Windows timeout callback can observe changed environment', async () => {
  const { runtime } = await fixture();
  const taskkill = join(systemRoot!, 'System32', 'taskkill.exe');
  let started: ChildProcess | undefined;
  vi.mocked(spawn).mockImplementation((command, args, options) => {
    const child = actualProcesses.spawn(command, args!, options!);
    if (command === process.execPath) { started = child; vi.stubEnv('SystemRoot', 'relative'); }
    return child;
  });
  const execution = runtime.exec(process.execPath, ['-e', "setTimeout(() => { process.stdout.write('not killed'); process.exit(99); }, 2500)"], { timeout: 50 });
  try {
    await expect(execution).resolves.toMatchObject({ killed: true, stdout: '' });
    const options = vi.mocked(spawn).mock.calls.find(([command]) => command === taskkill)![2]!;
    expect(options.windowsHide).toBe(true);
    expect(options.env?.SystemRoot ?? options.env?.SYSTEMROOT).toBe(systemRoot);
  } finally {
    started?.kill();
    await execution;
  }
});

it.runIf(process.platform === 'win32').each(['shell', 'stdio'] as const)('captures taskkill before Windows %s termination can observe changed environment', async kind => {
  const { runtime } = await fixture();
  const taskkill = join(systemRoot!, 'System32', 'taskkill.exe');
  const script = 'console.log(process.pid); setTimeout(() => process.exit(99), 5000)';
  const handle = kind === 'shell'
    ? await runtime.processes.startShell(`${JSON.stringify(process.execPath)} -e "${script}"`)
    : await runtime.processes.startStdio!(process.execPath, ['-e', script]);
  let pid: number | undefined;
  try {
    const ready = await waitForProcess(handle, output => /^\d+\s*$/u.test(output));
    pid = Number(Buffer.from(ready.output).toString().trim());
    vi.stubEnv('SystemRoot', 'relative');
    await handle.terminate('SIGKILL');
    const options = vi.mocked(spawn).mock.calls.find(([command]) => command === taskkill)![2]!;
    expect(options.windowsHide).toBe(true);
    expect(options.env?.SystemRoot ?? options.env?.SYSTEMROOT).toBe(systemRoot);
    expect((await handle.read(0)).running).toBe(false);
    expect((await handle.read(0)).exitCode).not.toBe(99);
    expect(() => process.kill(pid!, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
  } finally {
    if (pid !== undefined) {
      try { process.kill(pid, 'SIGKILL'); }
      catch (error) { if (!(error instanceof Error) || !('code' in error) || error.code !== 'ESRCH') throw error; }
    }
    await waitForProcess(handle, (_output, running) => !running);
    await handle.dispose();
  }
}, 15_000);

it.runIf(process.platform === 'win32')('uses an absolute Windows shell when ComSpec is missing', async () => {
  const { runtime } = await fixture();
  vi.stubEnv('COMSPEC', undefined);
  vi.stubEnv('ComSpec', undefined);
  vi.mocked(spawn).mockImplementation((_command, _args, options) => actualProcesses.spawn(process.execPath, ['-e', ''], { ...options, shell: false }));
  await runtime.shell('echo test');
  expect(spawn).toHaveBeenCalledWith('echo test', [], expect.objectContaining({ shell: join(systemRoot!, 'System32', 'cmd.exe') }));
  const handle = await runtime.processes.startShell('echo test');
  try {
    expect(spawn).toHaveBeenLastCalledWith('echo test', [], expect.objectContaining({ shell: join(systemRoot!, 'System32', 'cmd.exe') }));
  } finally { await handle.dispose(); }
});

it.runIf(process.platform === 'win32').each(['', 'cmd.exe', '\\Windows\\System32\\cmd.exe', 'C:cmd.exe'])('refuses relative ComSpec %s before starting a Windows shell', async shell => {
  const { runtime } = await fixture();
  vi.stubEnv('ComSpec', shell);
  await expect(runtime.shell('echo test')).rejects.toThrow('ComSpec must be an absolute Windows path');
  await expect(runtime.processes.startShell('echo test')).rejects.toThrow('ComSpec must be an absolute Windows path');
  await expect(runtime.terminals.startShell('echo test')).rejects.toThrow('ComSpec must be an absolute Windows path');
  expect(spawn).not.toHaveBeenCalled();
});

it.runIf(process.platform === 'win32')('uses uppercase Windows environment names in worker threads', async () => {
  const { runtime } = await fixture();
  vi.stubEnv('SystemRoot', undefined);
  vi.stubEnv('ComSpec', undefined);
  vi.stubEnv('SYSTEMROOT', systemRoot);
  const shell = join(systemRoot!, 'custom', 'cmd.exe');
  vi.stubEnv('COMSPEC', shell);
  vi.mocked(spawn).mockImplementation((_command, _args, options) => actualProcesses.spawn(process.execPath, ['-e', ''], { ...options, shell: false }));
  await runtime.exec('explorer.exe', []);
  expect(spawn).toHaveBeenCalledWith(join(systemRoot!, 'explorer.exe'), [], expect.objectContaining({ windowsHide: true }));
  await runtime.shell('echo test');
  expect(spawn).toHaveBeenLastCalledWith('echo test', [], expect.objectContaining({ shell }));
});
