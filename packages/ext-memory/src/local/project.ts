import type { MemoryContext } from './context.js';
import { removeIfPresent } from './context.js';
import { acquireLocalMemoryLease } from './lease.js';
import { createHash, randomUUID } from 'node:crypto';

import { isAbsolute, join, resolve } from 'node:path';


export interface LocalMemoryProject {
  readonly canonicalRoot: string;
  readonly key: string;
}


export async function resolveLocalMemoryProject(environment: MemoryContext, cwd: string): Promise<LocalMemoryProject> {
  const canonicalCwd = await canonicalPath(environment, cwd);
  const gitRoot = await discoverGitRoot(environment, canonicalCwd);
  const canonicalRoot = await canonicalPath(environment, gitRoot ?? canonicalCwd);
  return {
    canonicalRoot,
    key: createHash('sha256').update(canonicalRoot, 'utf8').digest('hex'),
  };
}


export function localMemoryProjectDirectory(agentDir: string, project: LocalMemoryProject): string {
  return resolve(agentDir, 'memory', 'v1', 'projects', project.key);
}


export async function discoverLocalMemoryProjects(environment: MemoryContext, agentDir: string): Promise<LocalMemoryProject[]> {
  const directory = resolve(agentDir, 'memory', 'v1', 'projects');
  const projects: LocalMemoryProject[] = [];
  for (const key of await listDirectories(environment, directory)) {
    if (!/^[a-f0-9]{64}$/u.test(key)) continue;
    try {
      const projectDirectory = join(directory, key);
      const project = await readProject(environment, projectDirectory, key) ?? await backfillProject(environment, projectDirectory, key);
      if (project) projects.push(project);
    } catch {
      continue;
    }
  }
  return projects;
}


async function readProject(environment: MemoryContext, directory: string, key: string): Promise<LocalMemoryProject | undefined> {
  const value = await readJson(environment, join(directory, 'project.json'), 64 * 1_024);
  if (value === undefined) return undefined;
  const project = projectFromRoot(key, value.canonicalRoot);
  if (value.version !== 1 || !project) throw new Error('Invalid local memory project metadata');
  return project;
}


async function backfillProject(environment: MemoryContext, directory: string, key: string): Promise<LocalMemoryProject | undefined> {
  const runsDirectory = join(directory, 'runs');
  let newest: { project: LocalMemoryProject; startedAt: number } | undefined;
  for (const runId of await listDirectories(environment, runsDirectory)) {
    if (!/^[a-zA-Z0-9_-]{1,128}$/u.test(runId)) continue;
    try {
      const value = await readJson(environment, join(runsDirectory, runId, 'manifest.json'), 1_024 * 1_024);
      if (!value || value.version !== 1 || value.kind !== 'memory' || value.sessionId !== runId || value.projectKey !== key
        || typeof value.startedAt !== 'string') continue;
      const project = projectFromRoot(key, value.projectRoot);
      const startedAt = Date.parse(value.startedAt);
      if (project && Number.isFinite(startedAt) && (!newest || startedAt > newest.startedAt)) newest = { project, startedAt };
    } catch {
      continue;
    }
  }
  if (!newest) return undefined;
  const lease = await acquireLocalMemoryLease(environment, directory);
  if (!lease) return newest.project;
  const path = join(directory, 'project.json');
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const existing = await readProject(environment, directory, key);
    if (existing) return existing;
    await environment.runtime.writeFile(temporary,
      new TextEncoder().encode(`${JSON.stringify({ version: 1, canonicalRoot: newest.project.canonicalRoot }, null, 2)}\n`),
      { noFollow: true, exclusive: true });
    if (!(await lease.verify())) throw new Error('Memory writer lease was lost');
    await environment.runtime.files!.move(temporary, path);
    return newest.project;
  } finally {
    try { await removeIfPresent(environment, temporary); }
    finally { await lease.release(); }
  }
}


function projectFromRoot(key: string, canonicalRoot: unknown): LocalMemoryProject | undefined {
  if (typeof canonicalRoot !== 'string' || !isAbsolute(canonicalRoot) || canonicalRoot.includes('\0')
    || resolve(canonicalRoot) !== canonicalRoot || createHash('sha256').update(canonicalRoot, 'utf8').digest('hex') !== key) return undefined;
  return { canonicalRoot, key };
}


async function readJson(environment: MemoryContext, path: string, maxBytes: number): Promise<Record<string, unknown> | undefined> {
  try {
    const snapshot = await environment.runtime.files!.snapshot(path, maxBytes);
    if (snapshot.truncated) throw new Error('Local memory metadata is too large');
    const value: unknown = JSON.parse(new TextDecoder().decode(snapshot.content));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid local memory metadata');
    return value as Record<string, unknown>;
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  }
}


async function listDirectories(environment: MemoryContext, directory: string): Promise<string[]> {
  try {
    if ((await environment.runtime.files!.inspect(directory)).kind !== 'directory') return [];
    const entries = await environment.runtime.listFiles(directory, { includeDirectories: true, includeOther: true });
    const directories: string[] = [];
    for (const entry of entries.sort()) {
      if (!entry || entry === '.' || entry === '..' || /[/\\]/u.test(entry)) continue;
      try {
        if ((await environment.runtime.files!.inspect(join(directory, entry))).kind === 'directory') directories.push(entry);
      } catch { continue; }
    }
    return directories;
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return [];
    throw error;
  }
}


async function discoverGitRoot(environment: MemoryContext, cwd: string): Promise<string | undefined> {
  try {
    const result = await environment.runtime.exec('git', ['rev-parse', '--show-toplevel'], { cwd, timeout: 5_000 });
    const root = result.stdout.trim();
    return root.length > 0 ? root : undefined;
  } catch {
    return undefined;
  }
}


async function canonicalPath(environment: MemoryContext, path: string): Promise<string> {
  try {
    return await environment.runtime.files!.canonicalPath(resolve(path));
  } catch {
    return resolve(path);
  }
}

