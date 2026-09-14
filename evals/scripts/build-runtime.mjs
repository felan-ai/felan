import { existsSync, mkdirSync, copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const evalsRoot = resolve(import.meta.dirname, '..');
const context = mkdtempSync(join(tmpdir(), 'felan-evals-runtime-'));
try {
  const dockerfile = resolve(evalsRoot, 'runtimes/felan/Dockerfile');
  const requirements = resolve(evalsRoot, 'runtimes/felan/markitdown-requirements.txt');
  if (!existsSync(dockerfile) || !existsSync(requirements)) throw new Error('Felan runtime assets are missing');
  mkdirSync(join(context, 'evals', 'runtimes', 'felan'), { recursive: true });
  copyFileSync(dockerfile, join(context, 'Dockerfile'));
  copyFileSync(requirements, join(context, 'evals', 'runtimes', 'felan', 'markitdown-requirements.txt'));
  const result = spawnSync('docker', ['build', '-f', 'Dockerfile', '-t', 'felan-evals-runtime:v1', '.'], { cwd: context, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
} finally {
  rmSync(context, { recursive: true, force: true });
}
