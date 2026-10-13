import type { MemoryContext } from './context.js';
import { createHash } from 'node:crypto';

import { resolve } from 'node:path';


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

