import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { localMemoryProjectDirectory, resolveLocalMemoryProject } from '../src/memory/project.js';

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

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'felan-memory-project-'));
  temporaryPaths.push(path);
  return path;
}
