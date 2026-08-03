import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { packagePaths } from './package-paths.mjs';

const root = resolve(import.meta.dirname, '..');
const rootManifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
let failed = false;

for (const packagePath of packagePaths) {
  const manifest = JSON.parse(await readFile(resolve(root, packagePath, 'package.json'), 'utf8'));
  if (manifest.version !== rootManifest.version) {
    console.error(`${manifest.name}: version ${manifest.version} differs from proposed ${rootManifest.version}`);
    failed = true;
    continue;
  }

  const url = `https://registry.npmjs.org/${encodeURIComponent(manifest.name)}/${encodeURIComponent(manifest.version)}`;
  const response = await fetch(url);
  if (response.status === 404) {
    console.log(`${manifest.name}@${manifest.version}: available`);
    continue;
  }
  if (response.ok) {
    console.error(`${manifest.name}@${manifest.version}: already published`);
  } else {
    console.error(`${manifest.name}@${manifest.version}: registry returned HTTP ${response.status}`);
  }
  failed = true;
}

if (failed) {
  process.exit(1);
}
