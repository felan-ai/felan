import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { promisify } from 'node:util';
import { resolve } from 'node:path';

const execFileAsync = promisify(execFile);

export interface LocalMemoryProject {
  readonly canonicalRoot: string;
  readonly key: string;
}

export async function resolveLocalMemoryProject(cwd: string): Promise<LocalMemoryProject> {
  const canonicalCwd = await canonicalPath(cwd);
  const gitRoot = await discoverGitRoot(canonicalCwd);
  const canonicalRoot = await canonicalPath(gitRoot ?? canonicalCwd);
  return {
    canonicalRoot,
    key: createHash('sha256').update(canonicalRoot, 'utf8').digest('hex'),
  };
}

export function localMemoryProjectDirectory(agentDir: string, project: LocalMemoryProject): string {
  return resolve(agentDir, 'memory', 'v1', 'projects', project.key);
}

async function discoverGitRoot(cwd: string): Promise<string | undefined> {
  try {
    const result = await execFileAsync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      timeout: 5_000,
      windowsHide: true,
    });
    const root = result.stdout.trim();
    return root.length > 0 ? root : undefined;
  } catch {
    return undefined;
  }
}

async function canonicalPath(path: string): Promise<string> {
  try {
    return await realpath(resolve(path));
  } catch {
    return resolve(path);
  }
}
