import { spawn } from 'node:child_process';
import { lstat, mkdir, mkdtemp, open, readFile, rename, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { HostAgentRuntime } from '../src/host-agent-runtime.js';

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, open: vi.fn(actual.open), rename: vi.fn(actual.rename) };
});
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});
const actualFiles = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
const actualProcesses = await vi.importActual<typeof import('node:child_process')>('node:child_process');
const directories: string[] = [];
beforeEach(() => {
  vi.mocked(open).mockReset().mockImplementation(actualFiles.open);
  vi.mocked(rename).mockReset().mockImplementation(actualFiles.rename);
  vi.mocked(spawn).mockReset().mockImplementation(actualProcesses.spawn);
});
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), 'windows-host-runtime-')); directories.push(cwd);
  await mkdir(join(cwd, 'storage'));
  return { cwd, runtime: new HostAgentRuntime(cwd, { sessionStorageRoot: join(cwd, 'storage'), agentStorageRoot: join(cwd, 'storage') }) };
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

it.runIf(process.platform === 'win32')('does not create a symlink target inserted during a Windows no-follow open', async () => {
  const { cwd, runtime } = await fixture();
  vi.mocked(open).mockImplementationOnce(async (path, flags, mode) => {
    await symlink('missing-target', join(cwd, 'file'));
    return actualFiles.open(path, flags, mode);
  });
  await expect(runtime.files.append('file', new Uint8Array([2]))).rejects.toMatchObject({ code: 'ELOOP' });
  await expect(lstat(join(cwd, 'missing-target'))).rejects.toMatchObject({ code: 'ENOENT' });
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

it.runIf(process.platform === 'win32').each(['shell', 'stdio'] as const)(
  'waits for taskkill to finish before timing out forced %s termination', async kind => {
    const { runtime } = await fixture();
    vi.mocked(spawn).mockImplementation((command, args, options) => {
      if (command !== 'taskkill') return actualProcesses.spawn(command, args!, options!);
      const script = `setTimeout(() => {
        const child = require('node:child_process').spawn('taskkill', ${JSON.stringify(args)}, { stdio: 'ignore', windowsHide: true });
        child.once('error', () => process.exit(1));
        child.once('close', code => process.exit(code ?? 1));
      }, 1300);`;
      return actualProcesses.spawn(process.execPath, ['-e', script], options!);
    });
    const handle = kind === 'shell'
      ? await runtime.processes.startShell(`${JSON.stringify(process.execPath)} -e "setInterval(() => {}, 1000)"`)
      : await runtime.processes.startStdio!(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
    try {
      await handle.terminate('SIGKILL');
      expect((await handle.read(0)).running).toBe(false);
    } finally { await handle.dispose(); }
  },
  10_000,
);
