import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
const installDir = mkdtempSync(join(tmpdir(), 'felan-product-coinstall-'));
const cleanHome = join(installDir, 'home');
const binDirectory = join(installDir, 'node_modules', '.bin');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const cliSpec = option('--cli') ?? process.env.FELAN_CLI_PACKAGE;
const tuiSpec = option('--tui') ?? process.env.FELAN_TUI_PACKAGE;

if (!cliSpec) {
  console.error('Pass --cli <tarball-or-package-spec> or set FELAN_CLI_PACKAGE');
  process.exit(2);
}

const cleanEnvironment = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => (
    !/(TOKEN|API_KEY|AUTH|PASSWORD|SECRET|CREDENTIAL|COOKIE|SESSION|(^|_)KEY$)/i.test(name)
  )),
);
Object.assign(cleanEnvironment, {
  HOME: cleanHome,
  USERPROFILE: cleanHome,
  NPM_CONFIG_CACHE: join(installDir, 'npm-cache'),
  NPM_CONFIG_REGISTRY: 'https://registry.npmjs.org/',
  NPM_CONFIG_USERCONFIG: join(cleanHome, '.npmrc'),
  PATH: `${binDirectory}${delimiter}${process.env.PATH ?? ''}`,
  FELAN_AGENT_DIR: join(cleanHome, '.felan', 'agent'),
});

try {
  mkdirSync(cleanHome);
  writeFileSync(join(cleanHome, '.npmrc'), 'registry=https://registry.npmjs.org/\n');
  const tuiPackages = tuiSpec ? [normalizeSpec(tuiSpec)] : packedTuiSet();
  run(npm, [
    'install',
    '--ignore-scripts',
    '--no-fund',
    '--prefix',
    installDir,
    normalizeSpec(cliSpec),
    ...tuiPackages,
  ]);

  const cliManifest = installedManifest('@felan-ai/cli');
  const tuiManifest = installedManifest('@felan-ai/felan');
  if (JSON.stringify(cliManifest.bin) !== JSON.stringify({ 'felan-cli': 'dist/cli.js' })) {
    throw new Error(`@felan-ai/cli must expose only felan-cli; received ${JSON.stringify(cliManifest.bin)}`);
  }
  if (JSON.stringify(tuiManifest.bin) !== JSON.stringify({ felan: './dist/cli.js' })) {
    throw new Error(`@felan-ai/felan must expose only felan; received ${JSON.stringify(tuiManifest.bin)}`);
  }

  const felan = binary('felan');
  const felanCli = binary('felan-cli');
  if (!existsSync(felan) || !existsSync(felanCli) || felan === felanCli) {
    throw new Error('felan and felan-cli must coexist as distinct binaries');
  }
  const tuiHelp = run(felan, ['--help']);
  if (!tuiHelp.stdout.includes('Usage: felan ')) throw new Error('felan TUI help smoke failed');
  const cliHelp = run(felanCli, ['--help']);
  if (!/felan-cli|Usage:/i.test(cliHelp.stdout + cliHelp.stderr)) {
    throw new Error('felan-cli help smoke failed');
  }
} finally {
  rmSync(installDir, { recursive: true, force: true });
}

function option(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
  return value;
}

function packedTuiSet() {
  const artifacts = resolve(root, '.artifacts');
  if (!existsSync(artifacts)) throw new Error('Run pnpm pack:all before the packed co-install smoke');
  const tarballs = readdirSync(artifacts)
    .filter((entry) => entry.endsWith('.tgz'))
    .map((entry) => join(artifacts, entry));
  if (tarballs.length === 0) throw new Error('No packed TUI package set found in .artifacts');
  return tarballs;
}

function normalizeSpec(spec) {
  if (spec.startsWith('-')) throw new Error(`Package spec cannot start with '-': ${spec}`);
  if (/^https?:\/\//.test(spec)) return spec;
  if (spec.startsWith('.') || spec.startsWith('/') || spec.endsWith('.tgz')) {
    return isAbsolute(spec) ? spec : resolve(process.cwd(), spec);
  }
  return spec;
}

function installedManifest(packageName) {
  const path = join(installDir, 'node_modules', ...packageName.split('/'), 'package.json');
  if (!existsSync(path)) throw new Error(`${packageName} was not installed`);
  const manifest = JSON.parse(readFileSync(path, 'utf8'));
  if (manifest.name !== packageName) throw new Error(`${path} contains ${manifest.name}`);
  return manifest;
}

function binary(name) {
  return join(binDirectory, process.platform === 'win32' ? `${name}.cmd` : name);
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: installDir,
    encoding: 'utf8',
    env: cleanEnvironment,
  });
  if (result.status !== 0) {
    process.stderr.write(result.stdout);
    process.stderr.write(result.stderr);
    throw new Error(`${command} exited with status ${result.status ?? 'unknown'}`);
  }
  return result;
}
