import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { packagePaths } from './package-paths.mjs';

const root = resolve(import.meta.dirname, '..');
const destination = resolve(root, '.artifacts');
rmSync(destination, { recursive: true, force: true });

for (const packagePath of packagePaths) {
  const pnpm = process.env.npm_execpath;
  if (!pnpm) {
    throw new Error('Run this script through pnpm');
  }

  const result = spawnSync(
    process.execPath,
    [pnpm, '--dir', resolve(root, packagePath), 'pack', '--pack-destination', destination],
    { stdio: 'inherit' },
  );

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
