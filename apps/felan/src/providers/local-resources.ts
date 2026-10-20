import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

export function getLocalSkillPaths(cwd: string, homeDir: string = homedir()): readonly string[] {
  return getLocalSkillSources(cwd, homeDir).map(source => source.path);
}

export function getLocalSkillSources(cwd: string, homeDir: string = homedir()): Array<{ path: string; scope: 'project' | 'user' }> {
  const project = resolve(cwd, '.agents', 'skills');
  const user = resolve(homeDir, '.agents', 'skills');
  return [{ path: project, scope: 'project' as const }, ...(user === project ? [] : [{ path: user, scope: 'user' as const }])]
    .filter(source => existsSync(source.path));
}
