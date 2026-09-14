import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { sourceImageTag } from './source-image.mjs';
import { packagePaths } from '../../scripts/package-paths.mjs';

const evalsRoot = resolve(import.meta.dirname, '..');
const projectRoot = resolve(evalsRoot, '..');
const artifacts = resolve(projectRoot, '.artifacts');
const provenancePath = resolve(evalsRoot, 'source-image.json');
const runtimeImage = 'felan-evals-runtime:v1';

if (process.argv[2] !== '--allow-current-source') {
  console.error('Refusing to build a source image without --allow-current-source');
  process.exit(2);
}

run('pnpm', ['pack:all']);
const tarballs = readdirSync(artifacts).filter((name) => name.endsWith('.tgz')).sort();
if (tarballs.length === 0) throw new Error('No Felan package tarballs were produced');
const expectedPackages = packagePaths.map((path) => JSON.parse(readFileSync(resolve(projectRoot, path, 'package.json'), 'utf8')));
const expectedFiles = expectedPackages.map(({ name, version }) => `${name.slice(1).replace('/', '-')}-${version}.tgz`);
if (tarballs.length !== expectedFiles.length || expectedFiles.some((file) => !tarballs.includes(file))) {
  throw new Error(`Expected one tarball for each of ${packagePaths.length} Felan packages, found ${tarballs.length}`);
}
const packages = expectedPackages.map(({ name, version }, index) => {
  const file = expectedFiles[index];
  if (!file) throw new Error(`Missing packed artifact metadata for ${name}`);
  return { name, version, file, sha256: hash(join(artifacts, file)) };
});
const runtimeImageId = output('docker', ['image', 'inspect', runtimeImage, '--format', '{{.Id}}']);
const digest = createHash('sha256').update(JSON.stringify({ runtimeImageId, packages })).digest('hex');
const tag = sourceImageTag(digest);
const context = mkdtempSync(join(tmpdir(), 'felan-evals-source-'));
try {
  mkdirSync(join(context, 'artifacts'));
  for (const { file } of packages) writeFileSync(join(context, 'artifacts', file), readFileSync(join(artifacts, file)));
  writeFileSync(join(context, 'Dockerfile'), [
    'ARG FELAN_RUNTIME_IMAGE=felan-evals-runtime:v1',
    'FROM ${FELAN_RUNTIME_IMAGE}',
    'ARG SOURCE_DIGEST',
    'LABEL org.felan.evals.source-digest="${SOURCE_DIGEST}"',
    'COPY artifacts/ /tmp/felan-artifacts/',
    'RUN npm install --global --ignore-scripts /tmp/felan-artifacts/*.tgz && felan --version && rm -rf /tmp/felan-artifacts',
    'WORKDIR /workspace',
    '',
  ].join('\n'));
  run('docker', [
    'build',
    '--build-arg', `FELAN_RUNTIME_IMAGE=${runtimeImage}`,
    '--build-arg', `SOURCE_DIGEST=${digest}`,
    '-f', 'Dockerfile',
    '-t', tag,
    '.',
  ], { cwd: context });
} finally {
  rmSync(context, { recursive: true, force: true });
}

const packageVersion = JSON.parse(readFileSync(resolve(projectRoot, 'apps/tui/package.json'), 'utf8')).version;
const felanProbe = output('docker', ['run', '--rm', tag, 'felan', '--version']);
const installedPackages = output('docker', ['run', '--rm', tag, 'npm', 'ls', '--global', '--parseable', '--all']);
const agentCoreInstallations = installedPackages
  .split('\n')
  .filter((path) => path.endsWith('/@felan-ai/agent-core'));
if (agentCoreInstallations.length !== 1) {
  throw new Error(`Expected exactly one Agent Core installation, found ${agentCoreInstallations.length}`);
}
const markitdownProbe = output('docker', [
  'run', '--rm',
  '--workdir', '/usr/local/lib/node_modules/@felan-ai/felan',
  tag,
  'node', '--input-type=module', '--eval', [
    "import { mkdir } from 'node:fs/promises';",
    "import { HostAgentRuntime } from '@felan-ai/agent-core';",
    "import { detectMarkitdown } from '@felan-ai/ext-markitdown';",
    "await Promise.all(['/tmp/felan-probe/workspace', '/tmp/felan-probe/session', '/tmp/felan-probe/agent'].map((path) => mkdir(path, { recursive: true })));",
    "const runtime = new HostAgentRuntime('/tmp/felan-probe/workspace', { sessionStorageRoot: '/tmp/felan-probe/session', agentStorageRoot: '/tmp/felan-probe/agent', agentDir: '/tmp/felan-probe/agent' });",
    'const detection = await detectMarkitdown(runtime);',
    "if (!detection.available) throw new Error(detection.reason);",
    'process.stdout.write(detection.invocation.version);',
  ].join('\n'),
]);
const provenance = {
  schemaVersion: 1,
  image: tag,
  imageId: output('docker', ['image', 'inspect', tag, '--format', '{{.Id}}']),
  source: { commit: output('git', ['rev-parse', 'HEAD']), dirty: output('git', ['status', '--porcelain']).length > 0 },
  felanVersion: packageVersion,
  packages,
  runtime: { image: runtimeImage, imageId: runtimeImageId },
  digest,
  probes: { felan: felanProbe, markitdown: markitdownProbe, agentCoreInstallations: agentCoreInstallations.length },
};
writeFileSync(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`);
console.log(`Built ${tag} for Felan source ${provenance.source.commit}${provenance.source.dirty ? ' (dirty)' : ''}`);

function hash(path) { return createHash('sha256').update(readFileSync(path)).digest('hex'); }
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: projectRoot, stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
function output(command, args) {
  const result = spawnSync(command, args, { cwd: projectRoot, encoding: 'utf8' });
  if (result.error || result.status !== 0) throw result.error ?? new Error(`${command} failed`);
  return result.stdout.trim();
}
