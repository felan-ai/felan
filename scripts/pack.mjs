import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createFelanShrinkwrap } from './felan-shrinkwrap.mjs';
import { packagePaths } from './package-paths.mjs';

const root = resolve(import.meta.dirname, '..');
const destination = resolve(root, '.artifacts');
const appPath = 'apps/felan';
rmSync(destination, { recursive: true, force: true });

for (const packagePath of packagePaths) {
  const tarball = pack(packagePath);
  if (packagePath !== appPath) continue;

  // The app installs globally from npm, so it ships the dependency tree the workspace verified.
  const shrinkwrapPath = resolve(root, appPath, 'npm-shrinkwrap.json');
  const tarballs = new Map(readdirSync(destination)
    .filter((entry) => entry.endsWith('.tgz'))
    .map((entry) => join(destination, entry))
    .filter((path) => path !== tarball)
    .map((path) => [packedManifest(path).name, path]));
  const shrinkwrap = createFelanShrinkwrap({
    manifest: packedManifest(tarball),
    tarballs,
    pnpmLockfile: readFileSync(resolve(root, 'pnpm-lock.yaml'), 'utf8'),
  });
  try {
    writeFileSync(shrinkwrapPath, `${JSON.stringify(shrinkwrap, null, 2)}\n`);
    if (pack(packagePath) !== tarball) throw new Error(`${appPath} repacked to a different artifact`);
  } finally {
    rmSync(shrinkwrapPath, { force: true });
  }
  if (!packedEntries(tarball).includes('package/npm-shrinkwrap.json')) {
    throw new Error(`${appPath} artifact is missing npm-shrinkwrap.json`);
  }
}

function pack(packagePath) {
  const pnpm = process.env.npm_execpath;
  if (!pnpm) {
    throw new Error('Run this script through pnpm');
  }

  const result = spawnSync(
    process.execPath,
    [pnpm, '--dir', resolve(root, packagePath), 'pack', '--pack-destination', destination],
    { stdio: ['inherit', 'pipe', 'inherit'], encoding: 'utf8' },
  );
  process.stdout.write(result.stdout ?? '');

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
  const tarball = result.stdout.trim().split('\n').at(-1);
  if (!tarball?.endsWith('.tgz')) throw new Error(`pnpm pack did not report an artifact for ${packagePath}`);
  return resolve(destination, tarball);
}

function packedManifest(tarball) {
  return JSON.parse(tar(['-xOzf', tarball, 'package/package.json']));
}

function packedEntries(tarball) {
  return tar(['-tzf', tarball]).split('\n');
}

function tar(args) {
  const result = spawnSync('tar', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`tar ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout;
}
