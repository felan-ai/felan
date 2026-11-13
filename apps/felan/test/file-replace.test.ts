import { renameSync } from 'node:fs';
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as wait } from 'node:timers/promises';
import { afterEach, expect, it, vi } from 'vitest';
import { replaceFile, replaceFileSync } from '../src/file-replace.js';

vi.mock('node:fs', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs')>(); return { ...fs, renameSync: vi.fn(fs.renameSync) };
});
vi.mock('node:fs/promises', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs/promises')>(); return { ...fs, rename: vi.fn(fs.rename) };
});
vi.mock('node:timers/promises', () => ({ setTimeout: vi.fn(async () => {}) }));

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); vi.resetAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const failure = (code: string) => Object.assign(new Error(code), { code });

it.each(['EPERM', 'EACCES', 'EBUSY'])('retries asynchronous Windows replacements after %s and rechecks ownership', async code => {
  vi.mocked(rename).mockRejectedValueOnce(failure(code)).mockResolvedValueOnce(undefined);
  const beforeRename = vi.fn();
  await replaceFile('source', 'target', { platform: 'win32', beforeRename });
  expect(rename).toHaveBeenCalledTimes(2); expect(beforeRename).toHaveBeenCalledTimes(2);
  expect(wait).toHaveBeenCalledExactlyOnceWith(50);
});

it.each(['EPERM', 'EACCES', 'EBUSY'])('retries synchronous Windows replacements after %s without an asynchronous gap', code => {
  vi.mocked(renameSync).mockImplementationOnce(() => { throw failure(code); }).mockReturnValueOnce(undefined);
  const sleep = vi.spyOn(Atomics, 'wait').mockReturnValue('timed-out'); const beforeRename = vi.fn();
  replaceFileSync('source', 'target', { platform: 'win32', beforeRename });
  expect(renameSync).toHaveBeenCalledTimes(2); expect(beforeRename).toHaveBeenCalledTimes(2);
  expect(sleep).toHaveBeenCalledExactlyOnceWith(expect.any(Int32Array), 0, 0, 50);
});

it.each(['darwin', 'linux'] as const)('does not retry POSIX replacements on %s', async platform => {
  const error = failure('EPERM');
  vi.mocked(rename).mockRejectedValue(error); vi.mocked(renameSync).mockImplementation(() => { throw error; });
  await expect(replaceFile('source', 'target', { platform })).rejects.toBe(error);
  expect(() => replaceFileSync('source', 'target', { platform })).toThrow(error);
  expect(rename).toHaveBeenCalledTimes(1); expect(renameSync).toHaveBeenCalledTimes(1); expect(wait).not.toHaveBeenCalled();
});

it('does not retry unrelated Windows errors or a failed ownership check', async () => {
  const error = failure('ENOENT'); vi.mocked(rename).mockRejectedValue(error);
  await expect(replaceFile('source', 'target', { platform: 'win32' })).rejects.toBe(error);
  expect(rename).toHaveBeenCalledTimes(1); expect(wait).not.toHaveBeenCalled();
  vi.mocked(rename).mockReset().mockRejectedValue(failure('EPERM'));
  const beforeRename = vi.fn().mockImplementationOnce(() => {}).mockImplementationOnce(() => { throw new Error('ownership lost'); });
  await expect(replaceFile('source', 'target', { platform: 'win32', beforeRename })).rejects.toThrow('ownership lost');
  expect(rename).toHaveBeenCalledTimes(1);
});

it('limits persistent Windows sharing failures to two seconds of retry delays', async () => {
  const error = failure('EBUSY'); const sleep = vi.spyOn(Atomics, 'wait').mockReturnValue('timed-out');
  vi.mocked(rename).mockRejectedValue(error); vi.mocked(renameSync).mockImplementation(() => { throw error; });
  await expect(replaceFile('source', 'target', { platform: 'win32' })).rejects.toBe(error);
  expect(() => replaceFileSync('source', 'target', { platform: 'win32' })).toThrow(error);
  expect(rename).toHaveBeenCalledTimes(41); expect(renameSync).toHaveBeenCalledTimes(41);
  expect(wait).toHaveBeenCalledTimes(40); expect(sleep).toHaveBeenCalledTimes(40);
  expect(vi.mocked(wait).mock.calls.every(([delay]) => delay === 50)).toBe(true);
});

it.runIf(process.platform === 'win32').each(['async', 'sync'])('replaces a file after another Windows process releases its handle with %s I/O', async mode => {
  const timers = await vi.importActual<typeof import('node:timers/promises')>('node:timers/promises');
  vi.mocked(wait).mockImplementation(timers.setTimeout);
  const root = await mkdtemp(join(tmpdir(), 'replace-windows-')); roots.push(root);
  const source = join(root, 'source'); const target = join(root, 'target');
  await writeFile(source, 'new'); await writeFile(target, 'old');
  const child = spawn(process.execPath, ['-e', `const fs = require('node:fs'); const fd = fs.openSync(process.argv[1], 'r'); process.stdout.write('ready'); setTimeout(() => fs.closeSync(fd), 200);`, target], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = new Promise<void>((resolve, reject) => { child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error(`Holder exited with ${code}`))); });
  try {
    await new Promise<void>((resolve, reject) => { child.stdout.once('data', () => resolve()); child.once('error', reject); child.once('exit', () => reject(new Error('Holder exited before opening the file'))); });
    if (mode === 'sync') replaceFileSync(source, target); else await replaceFile(source, target);
    expect(await readFile(target, 'utf8')).toBe('new'); await exited;
  } finally { if (child.exitCode === null) { child.kill(); await exited.catch(() => {}); } }
});
