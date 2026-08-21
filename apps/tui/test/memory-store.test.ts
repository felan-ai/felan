import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createMemorySnapshot, hydrateMemoryDirectory, type MemoryArtifact } from '@felan-ai/ext-memory';
import { acquireLocalMemoryLease } from '../src/memory/lease.js';
import { LocalMemoryStore } from '../src/memory/store.js';

const temporaryPaths: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('local memory store', () => {
  it('initializes canonical current memory and records idempotent checkpoints', async () => {
    const { store } = await createStore();
    await expect(store.readCurrent()).resolves.toMatchObject({ files: expect.any(Array), fingerprint: expect.any(String) });
    const checkpoint = checkpointFor('session-1', 'a'.repeat(64));
    await expect(store.recordCheckpoint(checkpoint)).resolves.toBe(true);
    await expect(store.recordCheckpoint(checkpoint)).resolves.toBe(false);
    await expect(store.status()).resolves.toMatchObject({ pending: { 'session-1': { checkpoint } } });
  });

  it('projects current memory into session storage without making the projection authoritative', async () => {
    const { store, root } = await createStore();
    const sessionStorage = join(root, 'session-storage');
    const projection = await store.projectTo(sessionStorage);
    await expect(readFile(join(projection.memoryPath, 'summary.md'), 'utf8')).resolves.toBe('');
    await expect(readFile(join(projection.memoryPath, 'index.md'), 'utf8')).resolves.toContain(
      `Follow its ${projection.memoryPath} links`,
    );
    await writeFile(join(projection.memoryPath, 'summary.md'), 'agent edit', 'utf8');
    await expect(store.readCurrent()).resolves.toMatchObject({ files: expect.arrayContaining([{ path: 'summary.md', content: '' }]) });
    expect(store.currentDirectory).not.toContain(join('workspace', '.memory'));
  });

  it('publishes a validated artifact and acknowledges only matching pending cursors', async () => {
    const { store } = await createStore();
    const checkpoint = checkpointFor('session-1', 'b'.repeat(64));
    await store.recordCheckpoint(checkpoint);
    const processing = await store.processingSnapshot();
    const lease = await acquireLocalMemoryLease(store.projectDirectory);
    expect(lease).toBeDefined();
    const artifact = memoryArtifact();
    const fingerprint = await store.commit(lease!, processing.fingerprint, artifact, processing.checkpoints);
    expect(fingerprint).toMatch(/^[a-f0-9]{64}$/u);
    await lease!.release();

    const state = await store.status();
    expect(state.pending).toEqual({});
    expect(state.processed['session-1']).toMatchObject({ checkpoint, memoryFingerprint: fingerprint });
    await expect(store.readCurrent()).resolves.toMatchObject({
      fingerprint,
      files: [...artifact.files].sort((left, right) => left.path.localeCompare(right.path)),
    });
    expect(await store.status()).toMatchObject({ memoryFingerprint: fingerprint });
  });

  it('rejects a compare-and-swap commit when canonical memory changed', async () => {
    const { store } = await createStore();
    const processing = await store.processingSnapshot();
    const lease = await acquireLocalMemoryLease(store.projectDirectory);
    expect(lease).toBeDefined();
    await hydrateMemoryDirectory(memoryArtifact(), store.currentDirectory, { replace: true });
    await expect(store.commit(lease!, processing.fingerprint, memoryArtifact(), [])).rejects.toThrow(/changed/);
    await lease!.release();
    expect((await store.readCurrent()).files).toEqual(
      [...memoryArtifact().files].sort((left, right) => left.path.localeCompare(right.path)),
    );
  });
});

async function createStore(): Promise<{ root: string; store: LocalMemoryStore }> {
  const root = await mkdtemp(join(tmpdir(), 'felan-memory-store-'));
  temporaryPaths.push(root);
  const project = { canonicalRoot: join(root, 'workspace'), key: '1'.repeat(64) };
  await mkdir(project.canonicalRoot, { recursive: true });
  const store = new LocalMemoryStore(join(root, 'agent'), project);
  await store.initialize();
  return { root, store };
}

function checkpointFor(sessionId: string, digest: string) {
  return {
    sessionId,
    sessionFile: `/sessions/${sessionId}.jsonl`,
    leafId: 'leaf-1',
    transcriptDigest: digest,
  } as const;
}

function memoryArtifact(): MemoryArtifact {
  return {
    version: 1,
    files: [
      { path: 'summary.md', content: 'Durable project preference.' },
      { path: 'index.md', content: '# Memory index\n\n## How to use this memory\n\n## Memory map\n- [Workflow](.memory/pages/workflows/index.md)\n' },
      { path: 'pages/workflows/index.md', content: '# workflows index\n- [Workflow](workflow.md) — Durable workflow.\n' },
      { path: 'pages/workflows/workflow.md', content: '# Workflow\n\n## Sources\n- session:session-1\n' },
    ],
  };
}
