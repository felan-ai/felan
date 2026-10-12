import { afterEach, describe, expect, it, vi } from 'vitest';
import { appendFileSync, constants, openSync, readFileSync, readSync, renameSync, writeFileSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, realpath, rename, rm, symlink, link, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { inspectInventoryHeader, inspectInventorySource, prepareExport, prepareImport, prepareTranscriptDeletion, publishExport, readOwnedOutputRange, stageImport } from '../src/daemon/session-files.js';
import type { DaemonOwnership } from '../src/daemon/ownership.js';
import { inspectLegacySession } from '../src/daemon/legacy-adoption.js';
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
  it('identifies headers without trusting oversized, linked or malformed transcript content', async () => {
    const f = await fixture(); const source = join(f.owned, 'header.jsonl');
    const header = JSON.stringify({ type: 'session', version: 3, id: 'header', cwd: f.owned }) + '\n';
    await writeFile(source, header + '{"unfinished":');
    expect(await inspectInventoryHeader(f.owner, source)).toMatchObject({ identity: { session: 'header' }, verifiable: true });
    await expect(inspectInventorySource(f.owner, source)).rejects.toThrow();
    await truncate(source, 64 * 1024 * 1024 + 1);
    expect(await inspectInventoryHeader(f.owner, source)).toMatchObject({ identity: { session: 'header' }, verifiable: false, diagnostic: 'oversize' });
    await writeFile(source, header); await link(source, join(f.owned, 'duplicate.jsonl'));
    expect(await inspectInventoryHeader(f.owner, source)).toMatchObject({ identity: { session: 'header' }, verifiable: false, diagnostic: 'unreadable' });
    await expect(inspectInventorySource(f.owner, source)).rejects.toThrow();
    await symlink(source, join(f.owned, 'alias.jsonl'));
    await expect(inspectInventoryHeader(f.owner, join(f.owned, 'alias.jsonl'))).rejects.toThrow();
    await writeFile(join(f.owned, 'invalid.jsonl'), 'not a session\n');
    await expect(inspectInventoryHeader(f.owner, join(f.owned, 'invalid.jsonl'))).rejects.toThrow();
  });

  it('reuses metadata-matched fingerprints and invalidates them when the source changes', async () => {
    const f = await fixture(); const source = join(f.owned, 'cached.jsonl');
    const bytes = JSON.stringify({ type: 'session', version: 3, id: 'cached', cwd: f.owned }) + '\n'; await writeFile(source, bytes, { mode: 0o600 });
    const first = await inspectInventorySource(f.owner, source);
    expect(await inspectInventorySource(f.owner, source, first)).toBe(first);
    expect(await inspectInventorySource(f.owner, source, first, 0)).toBe(first);
    await writeFile(source, bytes + '\n'); const second = await inspectInventorySource(f.owner, source, first);
    expect(second.key).not.toBe(first.key); expect(second.identity.fingerprint).not.toBe(first.identity.fingerprint);
    expect(second.identity.fingerprint).toBe(sha256(Buffer.from(bytes + '\n')));
    await expect(inspectInventorySource(f.owner, source, first, 0)).rejects.toMatchObject({ code: 'inventory_budget' });
  });

  it('revalidates a prepared import and export before staging or publication', async () => {
    const f = await fixture(); const source = join(f.external, 'import.jsonl');
    const text = JSON.stringify({ type: 'session', version: 3, id: 'staged', cwd: f.external }) + '\n'; await writeFile(source, text);
    const prepared = prepareImport(f.owner, source, []); await writeFile(source, text + '\n');
    expect(() => stageImport(f.owner, f.owned, source, [], prepared)).toThrowError(/changed/);
    const destination = join(f.external, 'export.html'); const output = prepareExport(f.owner, destination);
    await writeFile(destination, 'appeared');
    await expect(publishExport(f.owner, f.owned, destination, async () => {}, output)).rejects.toThrowError(/appeared/);
  });
  it('preserves exact normal bytes and fingerprints with nonblocking no-follow reads', async () => {
    const f = await fixture(); const source = join(f.owned, 'legacy.jsonl');
    const bytes = Buffer.from(JSON.stringify({ type: 'session', version: 3, id: 'legacy', cwd: f.owned }) + '\r\n' + JSON.stringify({ type: 'custom', data: '😀' }) + '\n\n');
    await writeFile(source, bytes, { mode: 0o600 });
    expect(inspectLegacySession(f.owner, source)).toEqual({ session: 'legacy', cwd: f.owned, source, fingerprint: sha256(bytes), bytes: bytes.length });
    expect(openSync).toHaveBeenCalledWith(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    expect(await readFile(source)).toEqual(bytes);
  });

  it('rejects non-regular and oversized files before attempting content reads', async () => {
    const f = await fixture();
    expect(() => inspectLegacySession(f.owner, f.owned)).toThrowError(/unsafe/);
    const source = join(f.owned, 'too-large.jsonl'); await writeFile(source, '', { mode: 0o600 }); await truncate(source, 64 * 1024 * 1024 + 1);
    expect(() => inspectLegacySession(f.owner, source)).toThrowError(/unsafe/);
    expect(readSync).not.toHaveBeenCalled();
  });

  it('detects growth at the maximum size after reading no more than max plus one bytes', async () => {
    const f = await fixture(); const source = join(f.owned, 'growing.jsonl'); const maximum = 64 * 1024 * 1024;
    await writeFile(source, '', { mode: 0o600 }); await truncate(source, maximum);
    vi.mocked(readSync).mockImplementationOnce(((...args: unknown[]) => {
      appendFileSync(source, 'x'); return Reflect.apply(actualFs.readSync, undefined, args);
    }) as typeof readSync);
    expect(() => inspectLegacySession(f.owner, source)).toThrowError(/unsafe/);
    const calls = vi.mocked(readSync).mock.calls as unknown as Array<[number, Buffer, number, number, number]>;
    expect(calls.length).toBeGreaterThan(0);
    expect(vi.mocked(readSync).mock.results.reduce((total, result) => total + (result.type === 'return' ? Number(result.value) : 0), 0)).toBe(maximum + 1);
    expect(calls.every(call => call[1].byteLength === maximum + 1 && call[3] <= 65536)).toBe(true);
  });

  it('revalidates path identity and in-place size changes after opening the source', async () => {
    for (const replace of [false, true]) {
      const f = await fixture(); const source = join(f.owned, 'changing.jsonl');
      const bytes = JSON.stringify({ type: 'session', version: 3, id: 'legacy', cwd: f.owned }) + '\n'; await writeFile(source, bytes, { mode: 0o600 });
      vi.mocked(readSync).mockImplementationOnce(((...args: unknown[]) => {
        const count = Reflect.apply(actualFs.readSync, undefined, args);
        if (replace) { renameSync(source, `${source}.original`); writeFileSync(source, bytes, { mode: 0o600 }); }
        else appendFileSync(source, '\n');
        return count;
      }) as typeof readSync);
      expect(() => inspectLegacySession(f.owner, source)).toThrowError(/unsafe/);
    }
  });
});
