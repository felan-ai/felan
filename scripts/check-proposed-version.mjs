import { appendFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { packagePaths } from './package-paths.mjs';

const root = resolve(import.meta.dirname, '..');
const selectUnpublished = process.argv.includes('--select-unpublished');
const runtimeDependencyFields = ['dependencies', 'optionalDependencies', 'peerDependencies'];
const unpublished = [];
let failed = false;

const manifests = await Promise.all(packagePaths.map(async (packagePath) => (
  JSON.parse(await readFile(resolve(root, packagePath, 'package.json'), 'utf8'))
)));
const localVersions = new Map(manifests.map((manifest) => [manifest.name, manifest.version]));

// pnpm publish rewrites workspace: specifiers from the local versions at publish time.
function publishedSpecifier(specifier, name) {
  const range = specifier.slice('workspace:'.length);
  const version = localVersions.get(name);
  if (range === '*') return version;
  if (range === '^' || range === '~') return `${range}${version}`;
  return range;
}

// A published version keeps the internal pins it was packed with, so a dependency release leaves it stale.
function stalePins(manifest, published) {
  const stale = [];
  for (const field of runtimeDependencyFields) {
    for (const [name, specifier] of Object.entries(manifest[field] ?? {})) {
      if (!specifier.startsWith('workspace:')) continue;
      const expected = publishedSpecifier(specifier, name);
      const actual = published[field]?.[name];
      if (actual !== expected) stale.push(`${name} ${actual ?? 'missing'} -> ${expected}`);
    }
  }
  return stale;
}

for (const [index, packagePath] of packagePaths.entries()) {
  const manifest = manifests[index];
  const url = `https://registry.npmjs.org/${encodeURIComponent(manifest.name)}/${encodeURIComponent(manifest.version)}`;
  const response = await fetch(url);
  if (response.status === 404) {
    console.log(`${manifest.name}@${manifest.version}: available`);
    unpublished.push({ packagePath, version: manifest.version });
    continue;
  }
  if (!response.ok) {
    console.error(`${manifest.name}@${manifest.version}: registry returned HTTP ${response.status}`);
    failed = true;
    continue;
  }
  const stale = stalePins(manifest, await response.json());
  if (stale.length > 0) {
    console.error(`${manifest.name}@${manifest.version}: published with stale workspace pins (${stale.join(', ')}); bump its version`);
    failed = true;
    continue;
  }
  console.log(`${manifest.name}@${manifest.version}: already published; skipping`);
}

if (failed) {
  process.exit(1);
}

if (selectUnpublished) {
  const output = [
    `has_packages=${unpublished.length > 0}`,
    `has_stable=${unpublished.some(({ version }) => !version.includes('-'))}`,
    `package_paths=${unpublished.map(({ packagePath }) => packagePath).join(' ')}`,
  ].join('\n');
  if (process.env.GITHUB_OUTPUT) {
    await appendFile(process.env.GITHUB_OUTPUT, `${output}\n`);
  } else {
    console.log(output);
  }
}
