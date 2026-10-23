import { afterEach, describe, expect, it, vi } from 'vitest';
import { openSync, readSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, link, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { prepareExport, prepareTranscriptDeletion, publishExport, readOwnedOutputRange, stageImport } from '../src/daemon/session-files.js';
import type { DaemonOwnership } from '../src/daemon/ownership.js';

vi.mock('node:fs', async original => {
  const fs = await original<typeof import('node:fs')>();
  return { ...fs, openSync: vi.fn(fs.openSync), readSync: vi.fn(fs.readSync) };
});
const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs');

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.mocked(readSync).mockImplementation(actualFs.readSync); vi.mocked(openSync).mockImplementation(actualFs.openSync); vi.clearAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 's7-files-')));
  const owned = join(directory, 'owned'); const external = join(directory, 'external');
  await mkdir(owned, { mode: 0o700 }); await mkdir(external, { mode: 0o700 });
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  let current = true;
  const assertCurrent = () => { if (!current) throw new Error('Synthetic ownership loss'); };
  const owner = { target: { uid: process.getuid!(), rootSet: [owned] }, assertCurrent,
    assertOwnsPath(input: string) {
      assertCurrent(); const path = resolve(input); const child = relative(owned, path);
      if (child === '..' || child.startsWith('../') || isAbsolute(child)) throw new Error('Outside private owned root');
      return path;
    }, async ownRoot(input: string) { owner.assertOwnsPath(input); }, watchPath: () => () => {},
  } as unknown as DaemonOwnership;
  return { owner, owned, external, lose: () => { current = false; } };
}

describe('identity-checked daemon host file ports', () => {
  it('reads bounded arbitrary byte ranges and rejects a cursor beyond retained output', async () => {
    const f = await fixture(); const path = join(f.owned, 'output.log');
    await writeFile(path, new Uint8Array([0, 255, 195, 40, 10]), { mode: 0o600 });
    expect(readOwnedOutputRange(f.owner, path, 1, 3)).toEqual(new Uint8Array([255, 195, 40]));
    expect(readOwnedOutputRange(f.owner, path, 5, 1)).toEqual(new Uint8Array());
    expect(() => readOwnedOutputRange(f.owner, path, 6, 1)).toThrowError(/retained/);
    expect(() => readOwnedOutputRange(f.owner, path, 0, 65537)).toThrowError(/range/);
    const alias = join(f.owned, 'alias'); await symlink(path, alias);
    expect(() => readOwnedOutputRange(f.owner, alias, 0, 1)).toThrow();
    await link(path, join(f.owned, 'hardlink'));
    expect(() => readOwnedOutputRange(f.owner, path, 0, 1)).toThrow();
  });

  it('deletes a transcript once and tolerates repeated deletion', async () => {
    const f = await fixture(); const path = join(f.owned, 'session.jsonl');
    await writeFile(path, 'original', { mode: 0o600 });
    prepareTranscriptDeletion(f.owner, path)();
    await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' });
    prepareTranscriptDeletion(f.owner, path)();
  });

  it('never unlinks after ownership loss', async () => {
    const f = await fixture(); const path = join(f.owned, 'session.jsonl');
    await writeFile(path, 'original', { mode: 0o600 }); const remove = prepareTranscriptDeletion(f.owner, path);
    f.lose(); expect(remove).toThrow(); expect(await readFile(path, 'utf8')).toBe('original');
  });

  it('stages an external legacy copy without rewriting it', async () => {
    const f = await fixture(); const source = join(f.external, 'legacy.jsonl');
    const bytes = JSON.stringify({ type: 'session', version: 3, id: 'legacy', cwd: f.external }) + '\n';
    await writeFile(source, bytes);
    const staged = stageImport(f.owner, f.owned, source);
    expect(staged.path).toMatch(/\.felan-import-.*\.tmp$/);
    expect(await readFile(staged.path, 'utf8')).toBe(bytes); expect(await readFile(source, 'utf8')).toBe(bytes);
    staged.dispose(); await expect(readFile(staged.path)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('publishes through a staging file and protects only daemon-managed paths', async () => {
    const f = await fixture(); const destination = join(f.external, 'export.html');
    await writeFile(destination, 'old');
    expect(await publishExport(f.owner, async path => { await writeFile(path, 'rendered'); }, prepareExport(f.owner, destination, [f.owned]))).toBe(destination);
    expect(await readFile(destination, 'utf8')).toBe('rendered');
    expect(() => prepareExport(f.owner, join(f.owned, 'forbidden'), [f.owned])).toThrowError(expect.objectContaining({ code: 'forbidden' }));
    const managed = join(f.owned, 'target.jsonl'); await writeFile(managed, 'managed');
    const alias = join(f.external, 'alias'); await symlink(managed, alias);
    expect(() => prepareExport(f.owner, alias, [f.owned])).toThrowError(expect.objectContaining({ code: 'forbidden' }));
    await link(destination, join(f.external, 'hardlink'));
    await publishExport(f.owner, async path => { await writeFile(path, 'again'); }, prepareExport(f.owner, destination, [f.owned]));
    expect(await readFile(destination, 'utf8')).toBe('again');
  });

  it('removes the staging file when rendering fails', async () => {
    const f = await fixture(); const destination = join(f.external, 'export.jsonl'); await writeFile(destination, 'old');
    await expect(publishExport(f.owner, async path => { await writeFile(path, 'partial'); throw new Error('render failed'); }, prepareExport(f.owner, destination, [f.owned]))).rejects.toThrow('render failed');
    expect(await readFile(destination, 'utf8')).toBe('old');
  });
});
