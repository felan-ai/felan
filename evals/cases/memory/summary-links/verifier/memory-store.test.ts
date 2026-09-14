import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { MemoryArtifact } from '@felan-ai/ext-memory';
import { acquireLocalMemoryLease } from '../src/memory/lease.js';
import { LocalMemoryStore } from '../src/memory/store.js';

const temporaryPaths: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('local memory linked-summary behavior', () => {
  it('reads and projects incomplete linked memory without changing canonical memory', async () => {
    const { root, store } = await createStore();
    const summary = [
      '[relative](pages/workflows/release.md#checks)',
      '[rooted](.memory/pages/workflows/release.md#checks)',
      '[[pages/workflows/index.md#overview|workflow]]',
      '[external](https://example.com/docs#intro)',
    ].join(' ');
    const index = [
      '# Incomplete index',
      '[relative](pages/workflows/index.md#overview)',
      '[[.memory/pages/workflows/release.md#checks|release]]',
    ].join('\n');
    await writeFile(join(store.currentDirectory, 'summary.md'), summary, 'utf8');
    await writeFile(join(store.currentDirectory, 'index.md'), index, 'utf8');
    await mkdir(join(store.currentDirectory, 'pages', 'workflows'), { recursive: true });
    await writeFile(join(store.currentDirectory, 'pages', 'workflows', 'index.md'), '# Workflows', 'utf8');
    await writeFile(join(store.currentDirectory, 'pages', 'workflows', 'release.md'), '# Release without provenance', 'utf8');

    const canonical = await store.readCurrent();
    expect(canonical.files).toEqual(expect.arrayContaining([
      { path: 'summary.md', content: summary },
      { path: 'index.md', content: index },
      { path: 'pages/workflows/release.md', content: '# Release without provenance' },
    ]));

    const projection = await store.projectTo(join(root, 'session'));
    const projectedSummary = await readFile(join(projection.memoryPath, 'summary.md'), 'utf8');
    const projectedIndex = await readFile(join(projection.memoryPath, 'index.md'), 'utf8');
    expect(projectedSummary).toContain(`[relative](${projection.memoryPath}/pages/workflows/release.md#checks)`);
    expect(projectedSummary).toContain(`[rooted](${projection.memoryPath}/pages/workflows/release.md#checks)`);
    expect(projectedSummary).toContain(`[[${projection.memoryPath}/pages/workflows/index.md#overview|workflow]]`);
    expect(projectedSummary).toContain('[external](https://example.com/docs#intro)');
    expect(projectedIndex).toContain(`[relative](${projection.memoryPath}/pages/workflows/index.md#overview)`);
    expect(projectedIndex).toContain(`[[${projection.memoryPath}/pages/workflows/release.md#checks|release]]`);
    expect(projection.fingerprint).toBe(canonical.fingerprint);
    await expect(store.readCurrent()).resolves.toEqual(canonical);
  });

  it('never follows unsafe files or unsafely rebases malformed and traversal links', async () => {
    const { root, store } = await createStore();
    const outside = join(root, 'outside.md');
    const sessionRoot = join(root, 'session');
    await writeFile(outside, 'sentinel', 'utf8');
    await writeFile(
      join(store.currentDirectory, 'summary.md'),
      [
        '[escape](../outside.md#token)',
        '[encoded](..%2Foutside.md)',
        '[encoded-dots](%2e%2e/outside.md)',
        '[absolute](/outside.md)',
        '[backslash](..\\outside.md)',
        '[protocol-relative](//example.com/outside.md)',
        '[file](file:///outside.md)',
        '[missing](pages/workflows/missing.md#later)',
        '[[%ZZ|malformed]]',
        '[external](https://example.com)',
      ].join(' '),
      'utf8',
    );

    let projectedContent: string | undefined;
    let projectionMemoryPath: string | undefined;
    let projectionError: unknown;
    try {
      const canonical = await store.readCurrent();
      const projection = await store.projectTo(sessionRoot, canonical);
      projectionMemoryPath = projection.memoryPath;
      projectedContent = await readFile(join(projection.memoryPath, 'summary.md'), 'utf8');
    } catch (error) {
      projectionError = error;
    }
    if (projectedContent !== undefined && projectionMemoryPath !== undefined) {
      expect(projectedContent).not.toContain(`${projectionMemoryPath}/../outside.md`);
      expect(projectedContent).not.toContain(`${projectionMemoryPath}/..%2Foutside.md`);
      expect(projectedContent).not.toContain(`${projectionMemoryPath}/%2e%2e/outside.md`);
      expect(projectedContent).not.toContain(`[absolute](${projectionMemoryPath}/outside.md)`);
      expect(projectedContent).not.toContain(`${projectionMemoryPath}/..\\outside.md`);
      expect(projectedContent).not.toContain(`${projectionMemoryPath}//example.com/outside.md`);
      expect(projectedContent).not.toContain(`${projectionMemoryPath}/file:///outside.md`);
      expect(projectedContent).not.toContain(`${projectionMemoryPath}/%ZZ`);
      expect(projectedContent).toContain('[external](https://example.com)');
    }
    expect(await readFile(outside, 'utf8')).toBe('sentinel');
    expect(projectionError !== undefined || projectedContent !== undefined).toBe(true);
    await expect(pathMissing(join(sessionRoot, 'outside.md'))).resolves.toBe(true);
    await expect(pathMissing(join(sessionRoot, '.memory', 'pages', 'workflows', 'missing.md'))).resolves.toBe(true);

    const linkedFile = join(root, 'linked.md');
    await writeFile(linkedFile, 'outside', 'utf8');
    await symlink(linkedFile, join(store.currentDirectory, 'pages-link.md'));
    await expect(store.readCurrent()).rejects.toThrow();

    await rm(join(store.currentDirectory, 'pages-link.md'));
    const linkedDirectory = join(root, 'linked-directory');
    await mkdir(linkedDirectory);
    await writeFile(join(linkedDirectory, 'outside.md'), 'outside', 'utf8');
    await symlink(linkedDirectory, join(store.currentDirectory, 'pages-link'), 'dir');
    await expect(store.readCurrent()).rejects.toThrow();
  });

  it('rejects incomplete publication, recovers staging, and preserves CAS state', async () => {
    const { root, store } = await createStore();
    const checkpoint = checkpointFor('session-1', 'b'.repeat(64));
    await store.recordCheckpoint(checkpoint);
    const processing = await store.processingSnapshot();
    const canonical = await store.readCurrent();
    const state = await store.status();
    const lease = await acquireLocalMemoryLease(store.projectDirectory);
    expect(lease).toBeDefined();

    await expect(store.commit(lease!, processing.fingerprint, incompleteArtifact(), processing.checkpoints)).rejects.toThrow();
    await expect(store.readCurrent()).resolves.toEqual(canonical);
    await expect(store.status()).resolves.toEqual(state);
    await lease!.release();

    const recovered = new LocalMemoryStore(join(root, 'agent'), store.project);
    await recovered.initialize();
    await expect(recovered.readCurrent()).resolves.toEqual(canonical);
    await expect(recovered.status()).resolves.toEqual(state);
    await expect(readdir(recovered.stagingDirectory)).resolves.toEqual([]);

    const recoveryLease = await acquireLocalMemoryLease(recovered.projectDirectory);
    expect(recoveryLease).toBeDefined();
    const fingerprint = await recovered.commit(
      recoveryLease!,
      processing.fingerprint,
      completeArtifact(),
      processing.checkpoints,
    );
    await recoveryLease!.release();
    expect(fingerprint).toMatch(/^[a-f0-9]{64}$/u);
    await expect(recovered.status()).resolves.toMatchObject({
      memoryFingerprint: fingerprint,
      pending: {},
      processed: { 'session-1': { checkpoint, memoryFingerprint: fingerprint } },
    });
  });

  it('processes and replaces an incomplete canonical artifact through CAS', async () => {
    const { root, store } = await createStore();
    await writeFile(join(store.currentDirectory, 'summary.md'), '[Release](pages/workflows/release.md)', 'utf8');
    await writeFile(join(store.currentDirectory, 'index.md'), '# Incomplete index', 'utf8');
    await mkdir(join(store.currentDirectory, 'pages', 'workflows'), { recursive: true });
    await writeFile(join(store.currentDirectory, 'pages', 'workflows', 'release.md'), '# Release without provenance', 'utf8');

    await store.initialize();
    const canonical = await store.readCurrent();
    const processing = await store.processingSnapshot();
    expect(processing.fingerprint).toBe(canonical.fingerprint);
    expect(processing.artifact.files).toEqual(canonical.files);

    const lease = await acquireLocalMemoryLease(store.projectDirectory);
    expect(lease).toBeDefined();
    const fingerprint = await store.commit(lease!, processing.fingerprint, completeArtifact(), []);
    await lease!.release();
    expect(fingerprint).not.toBe(canonical.fingerprint);
    await expect(store.readCurrent()).resolves.toMatchObject({ fingerprint });
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

function incompleteArtifact(): MemoryArtifact {
  return {
    version: 1,
    files: [
      { path: 'summary.md', content: 'Incomplete publication.' },
      { path: 'pages/workflows/release.md', content: '# Release without provenance' },
    ],
  };
}

function completeArtifact(): MemoryArtifact {
  return {
    version: 1,
    files: [
      { path: 'summary.md', content: 'Release workflow orientation.' },
      {
        path: 'index.md',
        content: '# Memory index\n\n## How to use this memory\n\n## Memory map\n- [Workflow](.memory/pages/workflows/index.md)\n',
      },
      { path: 'pages/workflows/index.md', content: '# Workflows\n\n- [Release](release.md)\n' },
      { path: 'pages/workflows/release.md', content: '# Release\n\n## Sources\n- session:session-1\n' },
    ],
  };
}

async function pathMissing(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return false;
  } catch (error) {
    if (typeof error === 'object' && error !== null && Reflect.get(error, 'code') === 'ENOENT') return true;
    throw error;
  }
}
