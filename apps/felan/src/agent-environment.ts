import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnv } from 'node:util';

// The daemon outlives the client that spawned it, so the agent directory's .env overrides the inherited
// environment to keep configuration independent of which terminal started the daemon. It must run before
// daemon-scoped providers read the environment.
export function loadAgentEnvironment(agentDir: string, environment: NodeJS.ProcessEnv = process.env): boolean {
  let contents: string;
  try { contents = readFileSync(join(agentDir, '.env'), 'utf8'); }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT'; }
  Object.assign(environment, parseEnv(contents));
  return true;
}

// Mirrors the daemon's launch target layout; the daemon validates the target itself afterwards.
export function daemonTargetAgentDir(targetArgument: string | undefined): string | undefined {
  try {
    const target: unknown = JSON.parse(targetArgument ?? '');
    if (!target || typeof target !== 'object') return undefined;
    const kind = Reflect.get(target, 'kind');
    const agentDir = Reflect.get(target, 'agentDir');
    const directory = Reflect.get(target, 'directory');
    if (kind === 'production' && typeof agentDir === 'string') return agentDir;
    if (kind === 'isolated' && typeof directory === 'string') return join(directory, 'agent');
  } catch {}
  return undefined;
}
