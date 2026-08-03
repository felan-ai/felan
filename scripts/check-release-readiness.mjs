import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { packagePaths } from './package-paths.mjs';

const NODE_ENGINE = '>=22.19.0';
const NODE_PIN = '22.20.0';
const PI_VERSION = '0.82.1';
const PI_PACKAGES = [
  '@earendil-works/pi-agent-core',
  '@earendil-works/pi-ai',
  '@earendil-works/pi-coding-agent',
  '@earendil-works/pi-tui',
];
const REQUIRED_PACKAGE_FILES = ['dist', 'LICENSE', 'NOTICE', 'README.md'];
const root = resolve(import.meta.dirname, '..');
const rootManifest = await manifestAt('.');
const packages = await Promise.all(packagePaths.map(async (packagePath) => ({
  packagePath,
  manifest: await manifestAt(packagePath),
})));
const errors = [];

checkPackageInventory();
checkPackageMetadata();
checkDependencies();
checkExtensionComposition();
checkExtensionBoundaries();
checkPinsAndWorkflows();
checkRepositoryBoundary();
checkLegalProvenance();

if (errors.length > 0) {
  for (const error of errors) console.error(error);
  process.exit(1);
}

console.log(`Release boundaries valid for ${packages.length} public packages at ${rootManifest.version}`);

function checkPackageInventory() {
  const discovered = ['apps', 'packages'].flatMap((parent) => (
    readdirSync(resolve(root, parent), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && existsSync(resolve(root, parent, entry.name, 'package.json')))
      .map((entry) => `${parent}/${entry.name}`)
  )).sort();
  const listed = [...packagePaths].sort();
  if (discovered.join('\n') !== listed.join('\n')) {
    errors.push(`Public package list differs from workspace manifests: ${discovered.join(', ')}`);
  }

  const names = packages.map(({ manifest }) => manifest.name);
  if (new Set(names).size !== names.length) errors.push('Public package names must be unique');
  if (packages.at(-1)?.manifest.name !== '@felan-ai/felan') {
    errors.push('@felan-ai/felan must pack after Agent Core and extensions');
  }
}

function checkPackageMetadata() {
  const versions = new Set(packages.map(({ manifest }) => manifest.version));
  if (versions.size !== 1 || [...versions][0] !== rootManifest.version) {
    errors.push('Root and public packages must use one version');
  }
  if (!/^\d+\.\d+\.\d+-[0-9A-Za-z.-]+$/.test(rootManifest.version)) {
    errors.push('Root version must be a prerelease version');
  }

  for (const { packagePath, manifest } of packages) {
    if (!manifest.name?.startsWith('@felan-ai/')) {
      errors.push(`${packagePath}: package name must use the @felan-ai scope`);
    }
    if (manifest.private === true) errors.push(`${packagePath}: public package cannot be private`);
    if (manifest.license !== 'MIT') errors.push(`${packagePath}: license must be MIT`);
    if (manifest.engines?.node !== NODE_ENGINE) {
      errors.push(`${packagePath}: Node engine must be ${NODE_ENGINE}`);
    }
    if (
      manifest.repository?.type !== 'git'
      || manifest.repository?.url !== 'git+https://github.com/felan-ai/felan.git'
      || manifest.repository?.directory !== packagePath
    ) {
      errors.push(`${packagePath}: repository metadata must identify its public source directory`);
    }
    if (manifest.publishConfig?.access !== 'public' || manifest.publishConfig?.provenance !== true) {
      errors.push(`${packagePath}: public provenance publishing is required`);
    }
    for (const requiredFile of REQUIRED_PACKAGE_FILES) {
      if (!manifest.files?.includes(requiredFile)) {
        errors.push(`${packagePath}: packed files must include ${requiredFile}`);
      }
    }
  }
}

function checkDependencies() {
  for (const { packagePath, manifest } of packages) {
    for (const section of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
      for (const [name, specifier] of Object.entries(manifest[section] ?? {})) {
        if (name.startsWith('@felan-cloud/')) {
          errors.push(`${packagePath}: public package depends on private package ${name}`);
        }
        if (/^(?:file|link|portal|git|git\+|https?|github|bitbucket):|^\.{0,2}\//.test(specifier)) {
          errors.push(`${packagePath}: ${name} uses non-registry dependency ${specifier}`);
        }
        if (name.startsWith('@felan-ai/')) {
          if (specifier !== 'workspace:*') {
            errors.push(`${packagePath}: internal source dependency ${name} must use workspace:*`);
          }
        } else if (specifier.startsWith('workspace:')) {
          errors.push(`${packagePath}: external dependency ${name} cannot use a workspace specifier`);
        } else if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(specifier)) {
          errors.push(`${packagePath}: production dependency ${name} must use an exact version`);
        }
        if (name.startsWith('@earendil-works/pi-') && specifier !== PI_VERSION) {
          errors.push(`${packagePath}: ${name} must pin ${PI_VERSION} exactly`);
        }
      }
    }
    if (manifest.bundledDependencies || manifest.bundleDependencies) {
      errors.push(`${packagePath}: bundled dependencies are not allowed`);
    }
  }
}

function checkExtensionComposition() {
  const tui = packages.find(({ manifest }) => manifest.name === '@felan-ai/felan');
  if (!tui) return;
  const source = readFileSync(resolve(root, 'apps/tui/src/extensions.ts'), 'utf8');
  const listBody = source.match(/localExtensionPackages\s*=\s*\[([\s\S]*?)\]\s*as const/)?.[1] ?? '';
  const listed = [...listBody.matchAll(/['"](@felan-ai\/ext-[^'"]+)['"]/g)].map((match) => match[1]);
  const dependencies = Object.keys(tui.manifest.dependencies ?? {})
    .filter((name) => name.startsWith('@felan-ai/ext-'));

  if ([...listed].sort().join('\n') !== [...dependencies].sort().join('\n')) {
    errors.push('apps/tui: extension list must equal direct extension dependencies');
  }
  if (new Set(listed).size !== listed.length) errors.push('apps/tui: extension list contains duplicates');
  if (!source.includes('return import(packageName);')) {
    errors.push('apps/tui: extension importer must preserve app-anchored native dynamic import');
  }
  if (/import\(\s*['"]@felan-ai\/ext-/.test(source)) {
    errors.push('apps/tui: extension importer cannot contain extension-specific imports');
  }

  const coreSources = sourceFiles(resolve(root, 'packages/agent-core/src'))
    .map((path) => readFileSync(path, 'utf8')).join('\n');
  if (/@felan-ai\/ext-/.test(coreSources)) {
    errors.push('@felan-ai/agent-core cannot import or name a concrete extension package');
  }
}

function checkExtensionBoundaries() {
  for (const { packagePath } of packages.filter(({ manifest }) => manifest.name.startsWith('@felan-ai/ext-'))) {
    for (const path of sourceFiles(resolve(root, packagePath, 'src'))) {
      const source = readFileSync(path, 'utf8');
      if (/['"]node:(?:fs|fs\/promises|child_process)['"]|from\s+['"](?:fs|fs\/promises|child_process)['"]/.test(source)) {
        errors.push(`${relativePath(path)}: extensions must use AgentRuntime instead of filesystem/process modules`);
      }
      if (/\b(?:exec|execFile|spawn|fork|writeFile|readFile|rm|unlink)Sync\s*\(|\b(?:Bun|Deno)\.(?:spawn|write|read|remove)\s*\(/.test(source)) {
        errors.push(`${relativePath(path)}: extensions cannot perform direct process or filesystem effects`);
      }
    }
  }
}

function checkPinsAndWorkflows() {
  if (rootManifest.packageManager !== 'pnpm@9.15.5') errors.push('pnpm must pin 9.15.5 exactly');
  if (rootManifest.engines?.node !== NODE_ENGINE) errors.push(`Root Node engine must be ${NODE_ENGINE}`);
  if (readFileSync(resolve(root, '.node-version'), 'utf8').trim() !== NODE_PIN) {
    errors.push(`.node-version must be ${NODE_PIN}`);
  }
  for (const packageName of PI_PACKAGES) {
    if (rootManifest.pnpm?.overrides?.[packageName] !== PI_VERSION) {
      errors.push(`Root override ${packageName} must pin ${PI_VERSION}`);
    }
  }

  const lockfile = readFileSync(resolve(root, 'pnpm-lock.yaml'), 'utf8');
  const lockPackages = lockfile.split('\npackages:\n')[1]?.split('\nsnapshots:\n')[0] ?? '';
  for (const packageName of PI_PACKAGES) {
    const resolved = [...lockPackages.matchAll(new RegExp(`^  ['"]?${escapeRegExp(packageName)}@([^:'"]+)['"]?:`, 'gm'))]
      .map((match) => match[1]);
    if (resolved.length !== 1 || resolved[0] !== PI_VERSION) {
      errors.push(`Lockfile must resolve exactly one ${packageName}@${PI_VERSION}`);
    }
  }

  const ci = readFileSync(resolve(root, '.github/workflows/ci.yml'), 'utf8');
  if (!ci.includes(`node-version: ${NODE_PIN}`) || !ci.includes('pnpm install --frozen-lockfile')) {
    errors.push(`CI must pin Node.js ${NODE_PIN} and use the frozen lockfile`);
  }
  const release = readFileSync(resolve(root, '.github/workflows/release.yml'), 'utf8');
  if (!release.includes(`node-version: ${NODE_PIN}`)) errors.push(`Release must pin Node.js ${NODE_PIN}`);
  if (!release.includes('id-token: write') || !release.includes('--provenance')) {
    errors.push('Release workflow must use npm provenance through OIDC');
  }
  if (/NODE_AUTH_TOKEN|NPM_TOKEN|npmrc.*_authToken/i.test(release)) {
    errors.push('Release workflow must not use registry credentials');
  }
  if (!release.includes("- 'v*-*'") || !release.includes('--tag next')) {
    errors.push('Release workflow must publish only prerelease tags to the next dist-tag');
  }

  let previousArtifact = -1;
  for (const { manifest } of packages) {
    const artifact = `${manifest.name.slice(1).replace('/', '-')}-\${version}.tgz`;
    const artifactIndex = release.indexOf(artifact);
    if (artifactIndex <= previousArtifact) {
      errors.push('Release workflow must publish every package in package-list order');
      break;
    }
    previousArtifact = artifactIndex;
  }

  const stable = readFileSync(resolve(root, '.github/workflows/stable-readiness.yml'), 'utf8');
  for (const requirement of [
    `node-version: ${NODE_PIN}`,
    'pnpm install --frozen-lockfile',
    'pnpm verify',
    'pnpm audit:packed',
    'pnpm test:co-install',
  ]) {
    if (!stable.includes(requirement)) errors.push(`Stable readiness workflow is missing ${requirement}`);
  }
  if (/npm publish|pnpm publish|git push/.test(stable)) {
    errors.push('Stable readiness workflow must be validation-only');
  }
}

function checkRepositoryBoundary() {
  const npmrc = readFileSync(resolve(root, '.npmrc'), 'utf8');
  if (!npmrc.includes('registry=https://registry.npmjs.org/')) {
    errors.push('.npmrc must default public packages to npmjs');
  }
  if (/^@[^:]+:registry=/m.test(npmrc) || /github\.com\/.*packages|npm\.pkg\.github\.com/i.test(npmrc)) {
    errors.push('.npmrc cannot map public packages to a private registry');
  }
  if (existsSync(resolve(root, '.gitmodules'))) errors.push('Git submodules are not allowed');
  const gitIndex = spawnSync('git', ['ls-files', '--stage'], { cwd: root, encoding: 'utf8' });
  if (gitIndex.status !== 0) errors.push('Unable to inspect Git index for submodules');
  if (/^160000 /m.test(gitIndex.stdout)) errors.push('Gitlink/submodule entries are not allowed');

  for (const { packagePath } of packages) {
    const manifestSource = readFileSync(resolve(root, packagePath, 'package.json'), 'utf8');
    if (/@felan-cloud\/|npm\.pkg\.github\.com|felan-platform\/apps\/agent/.test(manifestSource)) {
      errors.push(`${packagePath}: private package, registry, or copied-source reference is not allowed`);
    }
  }
}

function checkLegalProvenance() {
  const requiredNotices = new Map([
    ['packages/ext-context/NOTICE', '9571293d422db11de893fa80ed0fc3e39945c657'],
    ['packages/ext-prewalk/NOTICE', '7e72e509fe45a5a87c4c2e176cb711de994a8c1d'],
    ['packages/ext-powerline/NOTICE', '7e72e509fe45a5a87c4c2e176cb711de994a8c1d'],
  ]);
  for (const [path, sourceCommit] of requiredNotices) {
    const notice = readFileSync(resolve(root, path), 'utf8');
    if (!notice.includes('https://github.com/') || !notice.includes(sourceCommit)) {
      errors.push(`${path}: NOTICE must include public source URL and full source commit`);
    }
  }
  for (const { packagePath } of packages) {
    const license = readFileSync(resolve(root, packagePath, 'LICENSE'), 'utf8');
    if (!license.startsWith('MIT License')) errors.push(`${packagePath}: package LICENSE must contain MIT text`);
    const readme = readFileSync(resolve(root, packagePath, 'README.md'), 'utf8');
    if (!readme.includes('## Development')) errors.push(`${packagePath}: README must include source build instructions`);
  }
}

async function manifestAt(packagePath) {
  return JSON.parse(await readFile(resolve(root, packagePath, 'package.json'), 'utf8'));
}

function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : entry.isFile() && entry.name.endsWith('.ts') ? [path] : [];
  });
}

function relativePath(path) {
  return path.slice(root.length + 1);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
