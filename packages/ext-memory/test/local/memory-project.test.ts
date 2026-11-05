import { beforeEach as beforeMemoryTest } from "vitest";
import { createMemoryBackend } from './backend.js';
let { resolveLocalMemoryProject } = createMemoryBackend();
beforeMemoryTest(() => { ({ resolveLocalMemoryProject } = createMemoryBackend()); });
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { localMemoryProjectDirectory } from './backend.js';
import { discoverLocalMemoryProjects } from '../../src/local/project.js';


const temporaryPaths: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('local memory project identity', () => {
  it('uses a canonical path hash and never includes the path in the storage directory', async () => {
    const root = await temporaryDirectory();
    const workspace = join(root, 'workspace');
    await mkdir(workspace, { recursive: true });
    const project = await resolveLocalMemoryProject(workspace);
    const directory = localMemoryProjectDirectory(join(root, 'agent'), project);

    expect(project.canonicalRoot).toBe(await realpath(workspace));
    expect(project.key).toMatch(/^[a-f0-9]{64}$/u);
    expect(directory).toContain(join('memory', 'v1', 'projects', project.key));
    expect(directory).not.toContain(workspace);
  });

  it('falls back to a canonical cwd outside a repository', async () => {
    const root = await temporaryDirectory();
    const workspace = join(root, 'not-a-repository');
    await mkdir(workspace, { recursive: true });
    await expect(resolveLocalMemoryProject(workspace)).resolves.toMatchObject({ canonicalRoot: await realpath(workspace) });
  });
});

describe('local memory project discovery', () => {
  it('returns no projects when the storage directory does not exist', async () => {
    const { discover } = await discoveryFixture();
    await expect(discover()).resolves.toEqual([]);
  });

  it('discovers persisted projects without requiring the workspace to exist or rewriting metadata', async () => {
    const { root, store, discover } = await discoveryFixture();
    const canonicalRoot = join(root, 'removed-workspace');
    const project = projectFor(canonicalRoot);
    const directory = localMemoryProjectDirectory(store.agentDir, project);
    await mkdir(directory, { recursive: true });
    const path = join(directory, 'project.json');
    const content = JSON.stringify({ version: 1, canonicalRoot });
    await writeFile(path, content);
    const before = await stat(path);

    await expect(discover()).resolves.toEqual([project]);
    await expect(readFile(path, 'utf8')).resolves.toBe(content);
    expect((await stat(path)).ino).toBe(before.ino);
    expect((await stat(path)).mtimeMs).toBe(before.mtimeMs);
  });

  it('backfills private project metadata from a valid run while ignoring newer invalid manifests', async () => {
    const { store, discover } = await discoveryFixture();
    await writeManifest(store.projectDirectory, 'old', manifestFor(store.project, 'old', '2026-01-01T00:00:00Z'));
    await writeManifest(store.projectDirectory, 'new', manifestFor(store.project, 'new', '2026-02-01T00:00:00Z'));
    await writeManifest(store.projectDirectory, 'invalid', { ...manifestFor(store.project, 'invalid', '2026-03-01T00:00:00Z'), projectRoot: '/wrong-root' });
    await writeManifest(store.projectDirectory, 'broken', 'not JSON');

    await expect(discover()).resolves.toEqual([store.project]);
    const path = join(store.projectDirectory, 'project.json');
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ version: 1, canonicalRoot: store.project.canonicalRoot });
    if (process.platform !== 'win32') expect((await stat(path)).mode & 0o777).toBe(0o600);
    await rm(join(store.projectDirectory, 'runs'), { recursive: true });
    await expect(discover()).resolves.toEqual([store.project]);
  });

  it('can discover a legacy project while a writer owns its lease without writing metadata', async () => {
    const { store, discover } = await discoveryFixture();
    await writeManifest(store.projectDirectory, 'old', manifestFor(store.project, 'old', '2026-01-01T00:00:00Z'));
    const { acquireLocalMemoryLease } = createMemoryBackend();
    const lease = await acquireLocalMemoryLease(store.projectDirectory);
    expect(lease).toBeDefined();
    try {
      await expect(discover()).resolves.toEqual([store.project]);
      await expect(stat(join(store.projectDirectory, 'project.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { await lease!.release(); }
    await expect(discover()).resolves.toEqual([store.project]);
    await expect(stat(join(store.projectDirectory, 'project.json'))).resolves.toBeDefined();
  });

  it('skips invalid identities and metadata without falling back from a malformed project file', async () => {
    const { root, store, discover } = await discoveryFixture();
    for (const [name, metadata] of [
      ['version', { version: 2 }], ['root', { version: 1, canonicalRoot: 'relative' }],
      ['mismatch', { version: 1, canonicalRoot: '/different' }], ['broken', 'not JSON'],
    ] as const) {
      const project = projectFor(join(root, name));
      const directory = localMemoryProjectDirectory(store.agentDir, project);
      await writeManifest(directory, 'valid', manifestFor(project, 'valid', '2026-01-01T00:00:00Z'));
      await writeFile(join(directory, 'project.json'), typeof metadata === 'string' ? metadata : JSON.stringify(metadata));
    }
    const projectsDirectory = join(store.agentDir, 'memory', 'v1', 'projects');
    await mkdir(join(projectsDirectory, 'invalid-key'));
    await writeFile(join(projectsDirectory, 'invalid-key', 'project.json'), JSON.stringify({ version: 1, canonicalRoot: root }));
    await writeManifest(store.projectDirectory, 'wrong-key', { ...manifestFor(store.project, 'wrong-key', '2026-01-01T00:00:00Z'), projectKey: 'f'.repeat(64) });
    await writeManifest(store.projectDirectory, 'wrong-root', { ...manifestFor(store.project, 'wrong-root', '2026-01-01T00:00:00Z'), projectRoot: '/different' });
    await writeManifest(store.projectDirectory, 'bad-date', manifestFor(store.project, 'bad-date', 'yesterday'));

    await expect(discover()).resolves.toEqual([]);
  });

  it.skipIf(process.platform === 'win32')('skips symlinked projects, metadata and run directories', async () => {
    const { root, store, discover } = await discoveryFixture();
    const outside = join(root, 'outside');
    await mkdir(outside);
    const metadata = join(outside, 'project.json');
    await writeFile(metadata, JSON.stringify({ version: 1, canonicalRoot: store.project.canonicalRoot }));
    await mkdir(join(store.agentDir, 'memory', 'v1', 'projects'), { recursive: true });
    await symlink(outside, store.projectDirectory, 'dir');
    await expect(discover()).resolves.toEqual([]);
    await rm(store.projectDirectory);
    await mkdir(store.projectDirectory);
    await symlink(metadata, join(store.projectDirectory, 'project.json'));
    await expect(discover()).resolves.toEqual([]);
    await rm(join(store.projectDirectory, 'project.json'));
    await writeManifest(outside, 'run', manifestFor(store.project, 'run', '2026-01-01T00:00:00Z'));
    await symlink(join(outside, 'runs'), join(store.projectDirectory, 'runs'), 'dir');
    await expect(discover()).resolves.toEqual([]);
  });
});

async function discoveryFixture() {
  const root = await temporaryDirectory();
  const project = projectFor(join(root, 'workspace'));
  const store = new (createMemoryBackend().LocalMemoryStore)(join(root, 'agent'), project);
  return { root, store, discover: () => discoverLocalMemoryProjects(store.environment, store.agentDir) };
}

function projectFor(canonicalRoot: string) {
  return { canonicalRoot, key: createHash('sha256').update(canonicalRoot, 'utf8').digest('hex') };
}

function manifestFor(project: ReturnType<typeof projectFor>, sessionId: string, startedAt: string) {
  return { version: 1, kind: 'memory', sessionId, sessionFile: `${sessionId}.jsonl`, projectKey: project.key,
    projectRoot: project.canonicalRoot, startedAt, status: 'completed', phase: 'publish', checkpoints: [], baseFingerprint: 'a'.repeat(64) };
}

async function writeManifest(directory: string, runId: string, manifest: unknown) {
  const runDirectory = join(directory, 'runs', runId);
  await mkdir(runDirectory, { recursive: true });
  await writeFile(join(runDirectory, 'manifest.json'), typeof manifest === 'string' ? manifest : JSON.stringify(manifest));
}

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'felan-memory-project-'));
  temporaryPaths.push(path);
  return path;
}
