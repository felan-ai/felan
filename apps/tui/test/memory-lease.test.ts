import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { acquireLocalMemoryLease } from '../src/memory/lease.js';

const temporaryPaths: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('local memory writer lease', () => {
  it('allows one owner and fences a replaced owner token', async () => {
    const root = await temporaryDirectory();
    const first = await acquireLocalMemoryLease(root, { staleMs: 500, updateMs: 100 });
    expect(first).toBeDefined();
    await expect(acquireLocalMemoryLease(root, { staleMs: 500, updateMs: 100 })).resolves.toBeUndefined();
    expect(await first!.verify()).toBe(true);

    const ownerPath = join(root, `writer.owner.${first!.token}.json`);
    await writeFile(ownerPath, `${JSON.stringify({ token: 'new-owner' })}\n`);
    expect(await first!.verify()).toBe(false);
    await first!.release();
    expect(await readFile(ownerPath, 'utf8')).toContain('new-owner');
  });

  it('recovers a stale lock and rejects the old owner after takeover', async () => {
    const root = await temporaryDirectory();
    const first = await acquireLocalMemoryLease(root, { staleMs: 100, updateMs: 50 });
    expect(first).toBeDefined();
    await rm(join(root, 'writer.lock'), { recursive: true, force: true });
    await rm(join(root, 'writer.gate.lock'), { recursive: true, force: true });
    const second = await acquireLocalMemoryLease(root, { staleMs: 100, updateMs: 50 });
    expect(second).toBeDefined();
    expect(await first!.verify()).toBe(false);
    expect(await second!.verify()).toBe(true);
    await second!.release();
    await first!.release();
  });

  it('does not compromise its heartbeat when fencing metadata is written', async () => {
    const root = await temporaryDirectory();
    const lease = await acquireLocalMemoryLease(root, { staleMs: 2_000, updateMs: 1_000 });
    expect(lease).toBeDefined();
    await new Promise((resolve) => setTimeout(resolve, 1_250));
    expect(await lease!.verify()).toBe(true);
    await lease!.release();
  });

  it('migrates a stale legacy owner record without disturbing fresh legacy locks', async () => {
    const root = await temporaryDirectory();
    const target = join(root, 'writer');
    const legacyLock = join(root, 'writer.lock');
    await writeFile(target, '');
    await mkdir(legacyLock);
    await writeFile(join(legacyLock, 'owner.json'), JSON.stringify({ token: 'old-owner' }));
    const staleAt = new Date(Date.now() - 10_000);
    await utimes(legacyLock, staleAt, staleAt);

    const lease = await acquireLocalMemoryLease(root, { staleMs: 2_000, updateMs: 1_000 });
    expect(lease).toBeDefined();
    await expect(readFile(join(legacyLock, 'owner.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(join(root, `writer.owner.${lease!.token}.json`), 'utf8')).resolves.toContain(lease!.token);
    await lease!.release();

    const freshRoot = await temporaryDirectory();
    const freshTarget = join(freshRoot, 'writer');
    const freshLock = join(freshRoot, 'writer.lock');
    await writeFile(freshTarget, '');
    await mkdir(freshLock);
    await writeFile(join(freshLock, 'owner.json'), JSON.stringify({ token: 'fresh-owner' }));
    await expect(acquireLocalMemoryLease(freshRoot, { staleMs: 2_000, updateMs: 1_000 })).resolves.toBeUndefined();
    await expect(readFile(join(freshLock, 'owner.json'), 'utf8')).resolves.toContain('fresh-owner');
  });

  it('treats a populated stale legacy lock as still owned', async () => {
    const root = await temporaryDirectory();
    const target = join(root, 'writer');
    const legacyLock = join(root, 'writer.lock');
    const marker = join(legacyLock, 'other-process.marker');
    await writeFile(target, '');
    await mkdir(legacyLock);
    await writeFile(join(legacyLock, 'owner.json'), JSON.stringify({ token: 'old-owner' }));
    await writeFile(marker, 'owned elsewhere');
    const staleAt = new Date(Date.now() - 10_000);
    await utimes(legacyLock, staleAt, staleAt);

    await expect(acquireLocalMemoryLease(root, { staleMs: 2_000, updateMs: 1_000 })).resolves.toBeUndefined();
    await expect(readFile(marker, 'utf8')).resolves.toBe('owned elsewhere');
  });

  it('does not remove a successor lock when the old owner releases after takeover', async () => {
    const root = await temporaryDirectory();
    const first = await acquireLocalMemoryLease(root, { staleMs: 2_000, updateMs: 1_000 });
    expect(first).toBeDefined();
    const firstOwnerPath = join(root, `writer.owner.${first!.token}.json`);
    await rm(join(root, 'writer.lock'), { recursive: true, force: true });
    await rm(join(root, 'writer.gate.lock'), { recursive: true, force: true });

    const second = await acquireLocalMemoryLease(root, { staleMs: 2_000, updateMs: 1_000 });
    expect(second).toBeDefined();
    await first!.release();

    expect(await second!.verify()).toBe(true);
    await expect(readFile(firstOwnerPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(acquireLocalMemoryLease(root, { staleMs: 2_000, updateMs: 1_000 })).resolves.toBeUndefined();
    await second!.release();
  });
});

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'felan-memory-lease-'));
  await mkdir(path, { recursive: true });
  temporaryPaths.push(path);
  return path;
}
