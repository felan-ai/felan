import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { packagePaths } from './package-paths.mjs';

const root = resolve(import.meta.dirname, '..');
const rootManifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
const manifests = await Promise.all(
  packagePaths.map(async (packagePath) => ({
    packagePath,
    manifest: JSON.parse(await readFile(resolve(root, packagePath, 'package.json'), 'utf8')),
  })),
);

const errors = [];
const versions = new Set(manifests.map(({ manifest }) => manifest.version));

if (versions.size !== 1 || [...versions][0] !== rootManifest.version) {
  errors.push('Root and public packages must use one version');
}
if (!/^\d+\.\d+\.\d+-[0-9A-Za-z.-]+$/.test(rootManifest.version)) {
  errors.push('Root version must be a prerelease version');
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
if (!release.includes("- 'v*-*'") || !release.includes('--tag next')) {
  errors.push('Release workflow must publish only prerelease tags to the next dist-tag');
}

const expectedOrder = [
  'packages/agent-core',
  'packages/ext-context',
  'packages/ext-prewalk',
  'packages/ext-powerline',
  'apps/tui',
];
if (packagePaths.join('\n') !== expectedOrder.join('\n')) {
  errors.push('Package order must be Agent Core, extensions, then TUI');
}
const publishArtifacts = [
  'felan-ai-agent-core-${version}.tgz',
  'felan-ai-ext-context-${version}.tgz',
  'felan-ai-ext-prewalk-${version}.tgz',
  'felan-ai-ext-powerline-${version}.tgz',
  'felan-ai-felan-${version}.tgz',
];
let previousArtifact = -1;
for (const artifact of publishArtifacts) {
  const artifactIndex = release.indexOf(artifact);
  if (artifactIndex <= previousArtifact) {
    errors.push('Release workflow must publish Agent Core, extensions, then TUI');
    break;
  }
  previousArtifact = artifactIndex;
}

if (errors.length > 0) {
  for (const error of errors) {
    console.error(error);
  }
  process.exit(1);
}

console.log(`Release metadata valid for ${manifests.length} public packages at ${rootManifest.version}`);
