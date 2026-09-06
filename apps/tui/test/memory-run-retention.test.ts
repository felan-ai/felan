import { randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { pruneMemoryRuns, type MemoryRunRetentionOptions } from '../src/memory/run-retention.js';

const temporaryPaths: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('pruneMemoryRuns', () => {
  it('does not create missing storage directories', async () => {
    const fixture = await createFixture();
    await rm(fixture.projectDirectory, { recursive: true });
    await rm(fixture.sessionDirectory, { recursive: true });
    await expect(pruneMemoryRuns(fixture)).resolves.toEqual({ terminalRuns: 0, overLimit: false });
    await expect(readdir(fixture.root)).resolves.toEqual([]);
  });

  it('retains the newest 50 terminal records and removes only older records', async () => {
    const fixture = await createFixture();
    const runs = [];
    for (let index = 0; index < 51; index += 1) runs.push(await createRun(fixture, { finishedAt: iso(index) }));

    await expect(pruneMemoryRuns(fixture)).resolves.toEqual({ terminalRuns: 50, overLimit: false });
    await expectRecordDeleted(runs[0]!);
    for (const run of runs.slice(1)) await expectRecordRetained(run);
  });

  it('counts terminal statuses while preserving active and protected records', async () => {
    const fixture = await createFixture();
    const terminal = await createRun(fixture);
    const active = await createRun(fixture, { status: 'started', finishedAt: undefined });
    const protectedRun = await createRun(fixture, { finishedAt: iso(2), status: 'failed' });
    const result = await pruneMemoryRuns({ ...fixture, maxCompletedRuns: 1, protectedRunIds: [protectedRun.id] });

    expect(result).toEqual({ terminalRuns: 1, overLimit: false });
    await expectRecordDeleted(terminal);
    await expectRecordRetained(active);
    await expectRecordRetained(protectedRun);
  });

  it('preserves malformed and foreign records without blocking valid pruning', async () => {
    const fixture = await createFixture();
    const valid = await createRun(fixture);
    const malformed = await createRun(fixture, { sessionId: randomUUID(), projectKey: 'foreign' });
    await writeFile(malformed.manifestPath, '{malformed');

    await expect(pruneMemoryRuns({ ...fixture, maxCompletedRuns: 0 })).resolves.toEqual({ terminalRuns: 0, overLimit: false });
    await expectRecordDeleted(valid);
    await expect(readFile(malformed.manifestPath, 'utf8')).resolves.toBe('{malformed');
  });

  it('tolerates a terminal workspace that was already removed', async () => {
    const fixture = await createFixture();
    const run = await createRun(fixture);
    await rm(run.workspace, { recursive: true });
    await expect(pruneMemoryRuns({ ...fixture, maxCompletedRuns: 0 })).resolves.toEqual({ terminalRuns: 0, overLimit: false });
    await expectRecordDeleted(run);
  });
});

interface Fixture extends MemoryRunRetentionOptions { readonly root: string }
interface RunFixture {
  readonly id: string;
  readonly directory: string;
  readonly workspace: string;
  readonly manifestPath: string;
  readonly sessionPath: string;
}

async function createFixture(): Promise<Fixture> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'felan-memory-retention-')));
  temporaryPaths.push(root);
  const projectDirectory = join(root, 'project');
  const sessionDirectory = join(root, 'sessions');
  await mkdir(join(projectDirectory, 'runs'), { recursive: true });
  await mkdir(sessionDirectory);
  return { root, projectDirectory, sessionDirectory, projectKey: 'a'.repeat(64) };
}

async function createRun(fixture: Fixture, overrides: Record<string, unknown> = {}): Promise<RunFixture> {
  const id = String(overrides.sessionId ?? randomUUID());
  const directory = join(fixture.projectDirectory, 'runs', id);
  const workspace = join(directory, 'workspace');
  const sessionFile = `${id}.jsonl`;
  const manifestPath = join(directory, 'manifest.json');
  const sessionPath = join(fixture.sessionDirectory, sessionFile);
  const metadata = {
    version: 1, kind: 'memory', sessionId: id, projectKey: fixture.projectKey, sessionFile,
    startedAt: iso(0), finishedAt: iso(1), status: 'completed', ...overrides,
  };
  await mkdir(join(workspace, '.memory'), { recursive: true });
  await writeFile(join(workspace, '.memory', 'summary.md'), 'output');
  await writeFile(manifestPath, `${JSON.stringify(metadata)}\n`);
  await writeFile(sessionPath, `${JSON.stringify({ type: 'session', version: 3, id, timestamp: metadata.startedAt, cwd: '/workspace' })}\n${JSON.stringify({
    type: 'custom', id: 'marker', parentId: null, timestamp: metadata.startedAt,
    customType: 'felan-memory-run', data: metadata,
  })}\n`);
  return { id, directory, workspace, manifestPath, sessionPath };
}

async function expectRecordDeleted(run: RunFixture): Promise<void> {
  await expect(lstat(run.directory)).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(lstat(run.sessionPath)).rejects.toMatchObject({ code: 'ENOENT' });
}

async function expectRecordRetained(run: RunFixture): Promise<void> {
  await expect(readFile(run.manifestPath, 'utf8')).resolves.toBeTypeOf('string');
  await expect(readFile(run.sessionPath, 'utf8')).resolves.toBeTypeOf('string');
}

function iso(timestamp: number): string { return new Date(timestamp).toISOString(); }
