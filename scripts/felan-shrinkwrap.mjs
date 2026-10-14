import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const REGISTRY = 'https://registry.npmjs.org/';

// npm ignores pnpm overrides and the workspace lockfile, so a published app would resolve its
// transitive dependencies afresh at install time. The app ships an npm-shrinkwrap.json instead,
// resolved with npm from the packed workspace tarballs and pinned to the versions pnpm tested.
export function createFelanShrinkwrap({ manifest, tarballs, pnpmLockfile }) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'felan-shrinkwrap-')));
  try {
    const dependencies = Object.fromEntries(Object.entries(manifest.dependencies ?? {}).map(([name, version]) => {
      if (!name.startsWith('@felan-ai/')) return [name, version];
      const tarball = tarballs.get(name);
      if (!tarball) throw new Error(`Missing packed artifact for ${name}`);
      return [name, `file:${tarball}`];
    }));
    writeFileSync(join(directory, 'package.json'), `${JSON.stringify({
      name: manifest.name,
      version: manifest.version,
      dependencies,
      overrides: Object.fromEntries(Object.entries(pnpmPinnedVersions(pnpmLockfile))
        .filter(([name]) => dependencies[name] === undefined)),
    }, null, 2)}\n`);
    writeFileSync(join(directory, '.npmrc'), `registry=${REGISTRY}\n`);
    runNpm(['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'], directory);

    const lockfile = JSON.parse(readFileSync(join(directory, 'package-lock.json'), 'utf8'));
    lockfile.name = manifest.name;
    lockfile.version = manifest.version;
    lockfile.packages[''] = rootEntry(manifest);
    for (const [path, entry] of Object.entries(lockfile.packages)) {
      if (path === '') continue;
      const name = path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length);
      if (name.startsWith('@felan-ai/')) {
        // Workspace packages publish alongside the app, so their registry integrity is unknown here.
        entry.resolved = `${REGISTRY}${name}/-/${name.split('/')[1]}-${entry.version}.tgz`;
        delete entry.integrity;
      }
      if (!entry.version || !entry.resolved?.startsWith(REGISTRY)) {
        throw new Error(`Shrinkwrap entry ${path} does not resolve from the public registry`);
      }
    }
    return lockfile;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function rootEntry(manifest) {
  const entry = { name: manifest.name, version: manifest.version };
  for (const field of ['license', 'dependencies', 'optionalDependencies', 'peerDependencies', 'bin', 'engines']) {
    if (manifest[field] !== undefined) entry[field] = manifest[field];
  }
  return entry;
}

// Every third-party package version pnpm resolved, keyed by package name.
export function pnpmPackageVersions(pnpmLockfile) {
  const section = /^packages:\n([\s\S]*?)(?:^\S|(?![\s\S]))/m.exec(pnpmLockfile)?.[1];
  if (!section) throw new Error('pnpm lockfile has no packages section');
  const versions = new Map();
  for (const [, name, version] of section.matchAll(/^ {2}'?(@?[^@'\s]+)@([^'(:\s]+)'?:/gm)) {
    if (name.startsWith('@felan-ai/')) continue;
    if (!versions.has(name)) versions.set(name, new Set());
    versions.get(name).add(version);
  }
  return versions;
}

// npm overrides for every third-party package that pnpm resolved to exactly one version. Packages
// resolved to several versions keep npm's choice within their declared ranges.
export function pnpmPinnedVersions(pnpmLockfile) {
  return Object.fromEntries([...pnpmPackageVersions(pnpmLockfile)]
    .filter(([, versions]) => versions.size === 1)
    .map(([name, versions]) => [name, [...versions][0]])
    .sort(([left], [right]) => left.localeCompare(right)));
}

function runNpm(args, cwd) {
  const command = process.platform === 'win32' ? process.execPath : 'npm';
  const prefix = process.platform === 'win32'
    ? [join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')]
    : [];
  const result = spawnSync(command, [...prefix, ...args], { cwd, encoding: 'utf8' });
  if (result.status !== 0) {
    process.stderr.write(result.stdout ?? '');
    process.stderr.write(result.stderr ?? '');
    throw new Error(`npm ${args.join(' ')} exited with status ${result.status ?? 'unknown'}`);
  }
}
