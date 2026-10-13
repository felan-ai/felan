import { afterEach, describe, expect, it, vi } from 'vitest';
import { appendFileSync, constants, openSync, readFileSync, readSync, renameSync, writeFileSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, realpath, rename, rm, symlink, link, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { inspectInventoryHeader, inspectInventorySource, prepareExport, prepareImport, prepareTranscriptDeletion, publishExport, readOwnedOutputRange, stageImport } from '../src/daemon/session-files.js';
import type { DaemonOwnership } from '../src/daemon/ownership.js';
import { sha256 } from '../src/daemon/persistence.js';

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
    }, watchPath: () => () => {},
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

  it('prepares only an exact transcript unlink and refuses an identity replacement', async () => {
    const f = await fixture(); const path = join(f.owned, 'session.jsonl');
    await writeFile(path, 'original', { mode: 0o600 }); const remove = prepareTranscriptDeletion(f.owner, path);
    await rename(path, join(f.owned, 'original')); await writeFile(path, 'replacement', { mode: 0o600 });
    expect(remove).toThrow(); expect(await readFile(path, 'utf8')).toBe('replacement');
    expect(await readFile(join(f.owned, 'original'), 'utf8')).toBe('original');
    prepareTranscriptDeletion(f.owner, path)();
    await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' });
    prepareTranscriptDeletion(f.owner, path)();
  });

  it('never unlinks after ownership loss or treats a directory as a transcript', async () => {
    const f = await fixture(); const path = join(f.owned, 'session.jsonl');
    await writeFile(path, 'original', { mode: 0o600 }); const remove = prepareTranscriptDeletion(f.owner, path);
    expect(() => prepareTranscriptDeletion(f.owner, f.owned)).toThrow();
    f.lose(); expect(remove).toThrow(); expect(await readFile(path, 'utf8')).toBe('original');
  });

  it('stages a validated external legacy copy without rewriting it and excludes managed sources', async () => {
    const f = await fixture(); const source = join(f.external, 'legacy.jsonl');
    const bytes = JSON.stringify({ type: 'session', version: 3, id: 'legacy', cwd: f.external }) + '\n';
    await writeFile(source, bytes);
    const staged = stageImport(f.owner, f.owned, source, []);
    expect(staged.path).toMatch(/\.felan-import-.*\.tmp$/);
    expect(await readFile(staged.path, 'utf8')).toBe(bytes); expect(await readFile(source, 'utf8')).toBe(bytes);
    expect(() => stageImport(f.owner, f.owned, source, [source])).toThrowError(/Managed/);
    staged.dispose(); await expect(readFile(staged.path)).rejects.toMatchObject({ code: 'ENOENT' });
    await writeFile(source, bytes + '[]\n'); expect(() => stageImport(f.owner, f.owned, source, [])).toThrowError(/row/);
  });

  it('publishes through a private renderer staging file to explicit output-only paths', async () => {
    const f = await fixture(); const destination = join(f.external, 'export.html');
    await writeFile(destination, 'old');
    expect(await publishExport(f.owner, f.owned, destination, async path => { await writeFile(path, 'rendered'); })).toBe(destination);
    expect(await readFile(destination, 'utf8')).toBe('rendered');
    await expect(publishExport(f.owner, f.owned, join(f.owned, 'forbidden'), async () => {})).rejects.toMatchObject({ code: 'forbidden' });
    const alias = join(f.external, 'alias'); await symlink(destination, alias);
    await expect(publishExport(f.owner, f.owned, alias, async () => {})).rejects.toThrow();
    await link(destination, join(f.external, 'hardlink'));
    await expect(publishExport(f.owner, f.owned, destination, async () => {})).rejects.toThrow();
  });

  it('reports indeterminate rather than no write after publication loses its owner', async () => {
    const f = await fixture(); const destination = join(f.external, 'export.jsonl'); await writeFile(destination, 'old');
    f.owner.assertCurrent = () => { if (readFileSync(destination, 'utf8') === 'new') throw new Error('Synthetic post-rename ownership loss'); };
    await expect(publishExport(f.owner, f.owned, destination, async path => { await writeFile(path, 'new'); })).rejects.toMatchObject({ code: 'indeterminate' });
    expect(await readFile(destination, 'utf8')).toBe('new');
  });
});

describe('bounded legacy source reader', () => {

  it('revalidates a prepared import and export before staging or publication', async () => {
    const f = await fixture(); const source = join(f.external, 'import.jsonl');
    const text = JSON.stringify({ type: 'session', version: 3, id: 'staged', cwd: f.external }) + '\n'; await writeFile(source, text);
    const prepared = prepareImport(f.owner, source, []); await writeFile(source, text + '\n');
    expect(() => stageImport(f.owner, f.owned, source, [], prepared)).toThrowError(/changed/);
    const destination = join(f.external, 'export.html'); const output = prepareExport(f.owner, destination);
    await writeFile(destination, 'appeared');
    await expect(publishExport(f.owner, f.owned, destination, async () => {}, output)).rejects.toThrowError(/appeared/);
  });
});
