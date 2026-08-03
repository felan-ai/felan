import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
const artifacts = resolve(root, '.artifacts');
const installDir = mkdtempSync(join(tmpdir(), 'felan-packed-bin-'));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const felan = join(installDir, 'node_modules', '.bin', process.platform === 'win32' ? 'felan.cmd' : 'felan');

try {
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
  ]);

  const result = run(felan, ['--diagnostics'], {
    ...process.env,
    PATH: `${join(installDir, 'node_modules', '.bin')}${delimiter}${process.env.PATH ?? ''}`,
  });
  for (const expected of ['Felan version:', 'Agent Core version:', 'Pi version:', 'Runtime: host']) {
    if (!result.stdout.includes(expected)) {
      throw new Error(`Packed felan --diagnostics output is missing ${JSON.stringify(expected)}`);
    }
  }
} finally {
  rmSync(installDir, { recursive: true, force: true });
}

function run(command, args, env = process.env) {
  const result = spawnSync(command, args, {
    cwd: root,
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
