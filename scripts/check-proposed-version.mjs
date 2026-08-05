import { appendFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { packagePaths } from './package-paths.mjs';

const root = resolve(import.meta.dirname, '..');
const selectUnpublished = process.argv.includes('--select-unpublished');
const unpublished = [];
let failed = false;

for (const packagePath of packagePaths) {
  const manifest = JSON.parse(await readFile(resolve(root, packagePath, 'package.json'), 'utf8'));
  const url = `https://registry.npmjs.org/${encodeURIComponent(manifest.name)}/${encodeURIComponent(manifest.version)}`;
  const response = await fetch(url);
  if (response.status === 404) {
    console.log(`${manifest.name}@${manifest.version}: available`);
    unpublished.push({ packagePath, version: manifest.version });
    continue;
  }
  if (response.ok) {
    console.log(`${manifest.name}@${manifest.version}: already published; skipping`);
    continue;
  } else {
    console.error(`${manifest.name}@${manifest.version}: registry returned HTTP ${response.status}`);
  }
  failed = true;
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
