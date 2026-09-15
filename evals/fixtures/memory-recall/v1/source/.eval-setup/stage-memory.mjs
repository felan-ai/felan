import { createHash } from 'node:crypto';
import { cp, mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const workspaceRoot = '/workspace';
const felanAgentDir = '/agent-config/felan';
const setupRoot = dirname(fileURLToPath(import.meta.url));
const projectKey = createHash('sha256').update(workspaceRoot, 'utf8').digest('hex');
const target = join(felanAgentDir, 'memory', 'v1', 'projects', projectKey, 'current');

await mkdir(dirname(target), { recursive: true, mode: 0o700 });
await cp(join(setupRoot, 'memory'), target, { recursive: true, errorOnExist: true, force: false });
await rm(setupRoot, { recursive: true, force: true });
