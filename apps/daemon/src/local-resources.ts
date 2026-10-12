import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { ModelRuntime } from '@felan-ai/agent-core';
import { installPiAsyncFileLockGuard } from './pi-lock.js';

export function getLocalSkillPaths(cwd: string, homeDir: string = homedir()): readonly string[] {
  return [...new Set([resolve(cwd, '.agents', 'skills'), resolve(homeDir, '.agents', 'skills')])]
    .filter(path => existsSync(path));
}

export async function createLocalModelRuntime(agentDir: string, signal?: AbortSignal): Promise<ModelRuntime> {
  installPiAsyncFileLockGuard();
  return ModelRuntime.create({ authPath: join(agentDir, 'auth.json'), modelsPath: join(agentDir, 'models.json'),
    ...(signal === undefined ? {} : { signal }) });
}

