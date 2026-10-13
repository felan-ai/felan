import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

export function getLocalSkillPaths(cwd: string, homeDir: string = homedir()): readonly string[] {
  return [...new Set([resolve(cwd, '.agents', 'skills'), resolve(homeDir, '.agents', 'skills')])]
    .filter(path => existsSync(path));
}

