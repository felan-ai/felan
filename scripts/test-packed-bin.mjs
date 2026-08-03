import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { packagePaths } from './package-paths.mjs';

const root = resolve(import.meta.dirname, '..');
const artifacts = resolve(root, '.artifacts');
const installDir = mkdtempSync(join(tmpdir(), 'felan-packed-bin-'));
const cleanHome = join(installDir, 'home');
const cacheDir = join(installDir, 'npm-cache');
const workspace = join(installDir, 'workspace');
const agentDir = join(cleanHome, '.felan', 'agent');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const binDirectory = join(installDir, 'node_modules', '.bin');
const felan = join(binDirectory, process.platform === 'win32' ? 'felan.cmd' : 'felan');
const proposedVersion = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version;
const sourcePackages = packagePaths.map((packagePath) => JSON.parse(
  readFileSync(resolve(root, packagePath, 'package.json'), 'utf8'),
));
const packageNames = sourcePackages.map(({ name }) => name);
const audit = process.argv.includes('--audit');
const cleanEnvironment = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => (
    !/(TOKEN|API_KEY|AUTH|PASSWORD|SECRET|CREDENTIAL|COOKIE|SESSION|(^|_)KEY$)/i.test(name)
  )),
);
Object.assign(cleanEnvironment, {
  HOME: cleanHome,
  USERPROFILE: cleanHome,
  NPM_CONFIG_CACHE: cacheDir,
  NPM_CONFIG_REGISTRY: 'https://registry.npmjs.org/',
  NPM_CONFIG_USERCONFIG: join(cleanHome, '.npmrc'),
  PATH: `${binDirectory}${delimiter}${process.env.PATH ?? ''}`,
  FELAN_AGENT_DIR: agentDir,
  PACKED_SMOKE_WORKSPACE: workspace,
});

try {
  mkdirSync(cleanHome);
  mkdirSync(workspace);
  writeFileSync(join(cleanHome, '.npmrc'), 'registry=https://registry.npmjs.org/\n');

  const tarballs = readdirSync(artifacts)
    .filter((entry) => entry.endsWith('.tgz'))
    .map((entry) => join(artifacts, entry));
  if (tarballs.length !== sourcePackages.length) {
    throw new Error(`Expected ${sourcePackages.length} packed artifacts, found ${tarballs.length}`);
  }

  run(npm, [
    'install',
    '--ignore-scripts',
    '--no-fund',
    '--prefix',
    installDir,
    ...tarballs,
  ], cleanEnvironment);

  for (const sourcePackage of sourcePackages) validateInstalledPackage(sourcePackage);

  run(process.execPath, [
    '--input-type=module',
    '--eval',
    `
      const packageNames = ${JSON.stringify([...packageNames, '@felan-ai/agent-core/runtime-test-kit'])};
      await Promise.all(packageNames.map((name) => import(name)));
      const app = await import('@felan-ai/felan');
      for (const packageName of app.localExtensionPackages) {
        const extension = await app.importLocalExtension(packageName);
        if (typeof extension.default !== 'function') throw new Error(packageName + ' has no extension factory');
      }
      for (const packageName of ['@felan-ai/agent-core', '@felan-ai/unlisted-extension']) {
        try {
          await app.importLocalExtension(packageName);
          throw new Error(packageName + ' loaded without a list entry');
        } catch (error) {
          if (!String(error).includes('Unknown local extension package')) throw error;
        }
      }
      const runtime = await app.createLocalFelanRuntime({
        cwd: process.env.PACKED_SMOKE_WORKSPACE,
        agentDir: process.env.FELAN_AGENT_DIR,
      });
      await runtime.dispose();
    `,
  ], cleanEnvironment);

  const diagnostics = run(felan, ['--diagnostics'], cleanEnvironment);
  for (const expected of [
    `Felan version: ${proposedVersion}`,
    `Agent Core version: ${proposedVersion}`,
    'Pi version: 0.82.1',
    'Runtime: host',
    'Credentials: local',
  ]) {
    if (!diagnostics.stdout.includes(expected)) {
      throw new Error(`Packed felan --diagnostics output is missing ${JSON.stringify(expected)}`);
    }
  }
  const help = run(felan, ['--help'], cleanEnvironment);
  if (!help.stdout.includes('Usage: felan [options] [message]')) {
    throw new Error('Packed felan --help did not start the local TUI CLI');
  }
  const versionResult = run(felan, ['--version'], cleanEnvironment);
  if (versionResult.stdout.trim() !== proposedVersion) {
    throw new Error(`Packed felan --version reported ${JSON.stringify(versionResult.stdout.trim())}`);
  }
  const authPath = join(agentDir, 'auth.json');
  if (existsSync(authPath) && Object.keys(JSON.parse(readFileSync(authPath, 'utf8'))).length > 0) {
    throw new Error('Credential-free packed smoke unexpectedly loaded model credentials');
  }

  if (audit) {
    run(npm, ['audit', '--audit-level=high', '--prefix', installDir], cleanEnvironment);
  }
} finally {
  rmSync(installDir, { recursive: true, force: true });
}

function validateInstalledPackage(sourcePackage) {
  const packageRoot = join(installDir, 'node_modules', ...sourcePackage.name.split('/'));
  const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
  if (manifest.version !== proposedVersion) {
    throw new Error(`${manifest.name} packed version is ${manifest.version}, expected ${proposedVersion}`);
  }
  if (
    manifest.repository?.url !== 'git+https://github.com/felan-ai/felan.git'
    || manifest.repository?.directory !== sourcePackage.repository.directory
  ) {
    throw new Error(`${manifest.name} packed manifest lost public source provenance`);
  }
  for (const requiredFile of ['LICENSE', 'NOTICE', 'README.md']) {
    if (!existsSync(join(packageRoot, requiredFile))) {
      throw new Error(`${manifest.name} packed artifact is missing ${requiredFile}`);
    }
  }
  if (!existsSync(join(packageRoot, 'dist'))) {
    throw new Error(`${manifest.name} packed artifact is missing dist`);
  }
  for (const entry of readdirSync(packageRoot)) {
    if (!['dist', 'LICENSE', 'NOTICE', 'README.md', 'package.json'].includes(entry)) {
      throw new Error(`${manifest.name} packed unexpected top-level entry ${entry}`);
    }
  }

  for (const [dependency, version] of Object.entries(manifest.dependencies ?? {})) {
    if (dependency.startsWith('@felan-ai/') && version !== proposedVersion) {
      throw new Error(`${manifest.name} packed dependency ${dependency} is ${version}, expected ${proposedVersion}`);
    }
    if (dependency.startsWith('@felan-cloud/')) {
      throw new Error(`${manifest.name} packed private dependency ${dependency}`);
    }
    if (/workspace:|^(?:file|link|portal|git|git\+|https?|github|bitbucket):|^\.{0,2}\//.test(version)) {
      throw new Error(`${manifest.name} packed non-registry dependency ${dependency}@${version}`);
    }
  }

  if (manifest.name === '@felan-ai/felan') {
    const extensionSource = readFileSync(join(packageRoot, 'dist', 'extensions.js'), 'utf8');
    if (!/import\(packageName\)/.test(extensionSource)) {
      throw new Error('Packed TUI did not preserve its app-anchored native dynamic importer');
    }
  }
}

function run(command, args, env = process.env) {
  const result = spawnSync(command, args, {
    cwd: installDir,
    encoding: 'utf8',
    env,
  });
  if (result.status !== 0) {
    process.stderr.write(result.stdout);
    process.stderr.write(result.stderr);
    throw new Error(`${command} exited with status ${result.status ?? 'unknown'}`);
  }
  return result;
}
