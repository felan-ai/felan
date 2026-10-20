import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { HostAgentRuntime } from '../src/index.js';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'runtime-files-')); directories.push(root);
  const cwd = join(root, 'workspace');
  await mkdir(cwd);
  await mkdir(join(root, 'storage'));
  return { cwd, runtime: new HostAgentRuntime(cwd, { sessionStorageRoot: join(root, 'storage'), agentStorageRoot: join(root, 'storage') }) };
}

it('supports exclusive private writes, bounded snapshots and atomic moves', async () => {
  const { runtime } = await fixture();
  await runtime.writeFile('temporary', new TextEncoder().encode('memory'), { exclusive: true, noFollow: true });
  await expect(runtime.writeFile('temporary', new Uint8Array(), { exclusive: true, noFollow: true })).rejects.toMatchObject({ code: 'EEXIST' });
  const before = await runtime.files.inspect('temporary');
  await runtime.files.move('temporary', 'current');
  const snapshot = await runtime.files.snapshot('current', 3);
  expect(new TextDecoder().decode(snapshot.content)).toBe('mem');
  expect(snapshot).toMatchObject({ truncated: true, info: { kind: 'file', identity: before.identity } });
  await runtime.files.ensurePrivateDirectory('empty');
  await runtime.files.removeEmptyDirectory('empty');
  expect(await runtime.listFiles('.')).toEqual(['current']);
});

it('retains symlink identity and refuses no-follow reads and writes', async () => {
  const { cwd, runtime } = await fixture();
  await runtime.writeFile('file', new Uint8Array([1]));
  await symlink('file', join(cwd, 'link'));
  expect((await runtime.files.inspect('link')).kind).toBe('symlink');
  await expect(runtime.files.snapshot('link', 4)).rejects.toMatchObject({ code: 'ELOOP' });
  await expect(runtime.files.append('link', new Uint8Array([2]))).rejects.toMatchObject({ code: 'ELOOP' });
  await expect(runtime.writeFile('link', new Uint8Array([2]), { noFollow: true })).rejects.toMatchObject({ code: 'ELOOP' });
  expect(new Uint8Array((await runtime.files.snapshot('file', 4)).content)).toEqual(new Uint8Array([1]));
});

it('rejects a conditional append when the original file changed', async () => {
  const { runtime } = await fixture();
  await runtime.files.append('journal', new TextEncoder().encode('first'));
  const snapshot = await runtime.files.snapshot('journal', 32);
  await runtime.files.append('journal', new TextEncoder().encode(' second'), snapshot.info);
  await expect(runtime.files.append('journal', new TextEncoder().encode(' lost'), snapshot.info)).rejects.toThrow('File changed before append');
});

it('does not grant metadata or mutation access outside the workspace', async () => {
  const { runtime } = await fixture();
  await expect(runtime.files.inspect('../outside')).rejects.toThrow();
  await expect(runtime.files.move('file', '../outside')).rejects.toThrow();
  await expect(runtime.writeFile('../outside', new Uint8Array(), { noFollow: true })).rejects.toThrow();
});
