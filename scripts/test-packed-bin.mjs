import {
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

const root = resolve(import.meta.dirname, '..');
const artifacts = resolve(root, '.artifacts');
const installDir = mkdtempSync(join(tmpdir(), 'felan-packed-bin-'));
const cleanHome = join(installDir, 'home');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const felan = join(installDir, 'node_modules', '.bin', process.platform === 'win32' ? 'felan.cmd' : 'felan');
const packageNames = [
  '@felan-ai/agent-core',
  '@felan-ai/ext-context',
  '@felan-ai/ext-prewalk',
  '@felan-ai/ext-powerline',
  '@felan-ai/felan',
];
const proposedVersion = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version;
const cleanEnvironment = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => !/(TOKEN|API_KEY|AUTH|PASSWORD|SECRET)/i.test(name)),
);
Object.assign(cleanEnvironment, {
  HOME: cleanHome,
  USERPROFILE: cleanHome,
  NPM_CONFIG_REGISTRY: 'https://registry.npmjs.org/',
  NPM_CONFIG_USERCONFIG: join(cleanHome, '.npmrc'),
  PATH: `${join(installDir, 'node_modules', '.bin')}${delimiter}${process.env.PATH ?? ''}`,
});

try {
  mkdirSync(cleanHome);
  writeFileSync(join(cleanHome, '.npmrc'), 'registry=https://registry.npmjs.org/\n');

  const tarballs = readdirSync(artifacts)
    .filter((entry) => entry.endsWith('.tgz'))
    .map((entry) => join(artifacts, entry));
  if (tarballs.length !== 5) {
    throw new Error(`Expected 5 packed artifacts, found ${tarballs.length}`);
  }

  run(npm, [
    'install',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    '--prefix',
    installDir,
    ...tarballs,
  ], cleanEnvironment);

  for (const packageName of packageNames) {
    const manifest = JSON.parse(readFileSync(
      join(installDir, 'node_modules', ...packageName.split('/'), 'package.json'),
      'utf8',
    ));
    if (manifest.version !== proposedVersion) {
      throw new Error(`${packageName} packed version is ${manifest.version}, expected ${proposedVersion}`);
    }
    for (const [dependency, version] of Object.entries(manifest.dependencies ?? {})) {
      if (dependency.startsWith('@felan-ai/') && version !== proposedVersion) {
        throw new Error(`${packageName} packed dependency ${dependency} is ${version}, expected ${proposedVersion}`);
      }
    }
  }

  run(process.execPath, [
    '--input-type=module',
    '--eval',
    `await Promise.all(${JSON.stringify([...packageNames, '@felan-ai/agent-core/runtime-test-kit'])}.map((name) => import(name)))`,
  ], cleanEnvironment);

  const result = run(felan, ['--diagnostics'], cleanEnvironment);
  for (const expected of [
    `Felan version: ${proposedVersion}`,
    `Agent Core version: ${proposedVersion}`,
    'Pi version:',
    'Runtime: host',
    'Credentials: local',
  ]) {
    if (!result.stdout.includes(expected)) {
      throw new Error(`Packed felan --diagnostics output is missing ${JSON.stringify(expected)}`);
    }
  }
  const versionResult = run(felan, ['--version'], cleanEnvironment);
  if (versionResult.stdout.trim() !== proposedVersion) {
    throw new Error(`Packed felan --version reported ${JSON.stringify(versionResult.stdout.trim())}`);
  }
} finally {
  rmSync(installDir, { recursive: true, force: true });
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
