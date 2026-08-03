import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { packagePaths } from './package-paths.mjs';

const root = resolve(import.meta.dirname, '..');
const manifests = await Promise.all(
  packagePaths.map(async (packagePath) => ({
    packagePath,
    manifest: JSON.parse(await readFile(resolve(root, packagePath, 'package.json'), 'utf8')),
  })),
);

const errors = [];
const versions = new Set(manifests.map(({ manifest }) => manifest.version));

if (versions.size !== 1) {
  errors.push('Public packages must use one version');
}

for (const { packagePath, manifest } of manifests) {
  if (!manifest.name?.startsWith('@felan-ai/')) {
    errors.push(`${packagePath}: package name must use the @felan-ai scope`);
  }
  if (manifest.license !== 'MIT') {
    errors.push(`${packagePath}: license must be MIT`);
  }
  if (manifest.engines?.node !== '>=22.19.0') {
    errors.push(`${packagePath}: Node engine must be >=22.19.0`);
  }
  if (manifest.repository !== 'github:felan-ai/felan') {
    errors.push(`${packagePath}: repository metadata is missing`);
  }
  if (manifest.publishConfig?.access !== 'public' || manifest.publishConfig?.provenance !== true) {
    errors.push(`${packagePath}: public provenance publishing is required`);
  }
}

const agentCore = manifests.find(({ manifest }) => manifest.name === '@felan-ai/agent-core')?.manifest;
if (agentCore?.dependencies?.['@earendil-works/pi-coding-agent'] !== '0.82.1') {
  errors.push('@felan-ai/agent-core must pin Pi coding agent 0.82.1 exactly');
}

const nodeVersion = (await readFile(resolve(root, '.node-version'), 'utf8')).trim();
if (nodeVersion !== '22.20.0') {
  errors.push('.node-version must be 22.20.0');
}

const ci = await readFile(resolve(root, '.github/workflows/ci.yml'), 'utf8');
if (!ci.includes('node-version: 22.20.0')) {
  errors.push('CI must pin Node.js 22.20.0');
}

const release = await readFile(resolve(root, '.github/workflows/release.yml'), 'utf8');
if (!release.includes('id-token: write') || !release.includes('--provenance')) {
  errors.push('Release workflow must use npm provenance through OIDC');
}
if (/NODE_AUTH_TOKEN|NPM_TOKEN|npmrc.*_authToken/i.test(release)) {
  errors.push('Release workflow must not use registry credentials');
}

if (errors.length > 0) {
  for (const error of errors) {
    console.error(error);
  }
  process.exit(1);
}

console.log(`Release metadata valid for ${manifests.length} public packages at ${[...versions][0]}`);
