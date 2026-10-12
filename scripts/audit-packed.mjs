import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--artifacts')) throw new Error('Usage: audit-packed.mjs [--artifacts <directory>]');
const artifacts = resolve(args[1] ?? fileURLToPath(new URL('../.artifacts', import.meta.url)));
const source = join(artifacts, 'packed-lock.json');
if (statSync(source).size > 16 * 1024 * 1024) throw new Error('Packed lockfile exceeds the audit bound');
const text = readFileSync(source, 'utf8');
const lock = JSON.parse(text);
const root = lock.packages?.[''];
if (lock.lockfileVersion !== 3 || !root || !root.dependencies || typeof root.dependencies !== 'object') {
  throw new Error('Run pnpm verify first to produce a packed-install dependency lockfile');
}
const directory = mkdtempSync(join(tmpdir(), 'felan-packed-audit-'));
try {
  writeFileSync(join(directory, 'package-lock.json'), text, { mode: 0o600 });
  writeFileSync(join(directory, 'package.json'), JSON.stringify({ private: true, dependencies: root.dependencies }), { mode: 0o600 });
  writeFileSync(join(directory, 'user.npmrc'), 'registry=https://registry.npmjs.org/\n', { mode: 0o600 });
  writeFileSync(join(directory, 'global.npmrc'), '', { mode: 0o600 });
  const environment = Object.fromEntries(['PATH', 'SystemRoot', 'LANG', 'LC_ALL', 'TZ'].flatMap(name => process.env[name] ? [[name, process.env[name]]] : []));
  Object.assign(environment, { HOME: directory, USERPROFILE: directory, NPM_CONFIG_CACHE: join(directory, 'cache'),
    NPM_CONFIG_USERCONFIG: join(directory, 'user.npmrc'), NPM_CONFIG_GLOBALCONFIG: join(directory, 'global.npmrc'),
    NPM_CONFIG_REGISTRY: 'https://registry.npmjs.org/', NPM_CONFIG_UPDATE_NOTIFIER: 'false', CI: '1' });
  const command = process.platform === 'win32' ? process.execPath : 'npm';
  const prefix = process.platform === 'win32' ? [join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')] : [];
  const result = spawnSync(command, [...prefix, 'audit', '--omit=dev', '--audit-level=high', '--json', '--prefix', directory], {
    cwd: directory, env: environment, encoding: 'utf8', timeout: 120_000, maxBuffer: 8 * 1024 * 1024,
  });
  process.stdout.write(result.stdout ?? ''); process.stderr.write(result.stderr ?? '');
  if (result.error) process.stderr.write(`${result.error.message}\n`);
  process.exitCode = result.status ?? 1;
} finally { rmSync(directory, { recursive: true, force: true }); }
