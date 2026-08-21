import { execFile } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { basename, delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FELAN_VERSION } from './version.js';

const PACKAGE_NAME = '@felan-ai/felan';
const PACKAGE_DIRECTORY = ['@felan-ai', 'felan'] as const;
const LATEST_RELEASE_URL = 'https://registry.npmjs.org/@felan-ai%2Ffelan/latest';
const DEFAULT_VERSION_CHECK_TIMEOUT_MS = 10_000;

export interface NpmResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface RunFelanUpdateOptions {
  readonly packageDirectory?: string;
  readonly currentVersion?: string;
  readonly runNpm?: (args: readonly string[], cwd: string) => Promise<NpmResult>;
  readonly writeOutput?: (line: string) => void;
  readonly writeError?: (line: string) => void;
}

export interface CheckForFelanUpdateOptions {
  readonly currentVersion?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export async function checkForFelanUpdate(
  options: CheckForFelanUpdateOptions = {},
): Promise<string | undefined> {
  if (process.env.FELAN_SKIP_VERSION_CHECK || process.env.PI_OFFLINE) return undefined;

  const currentVersion = options.currentVersion ?? FELAN_VERSION;
  if (!isStableVersion(currentVersion)) return undefined;

  try {
    const timeoutSignal = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_VERSION_CHECK_TIMEOUT_MS);
    const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;
    const response = await (options.fetch ?? globalThis.fetch)(LATEST_RELEASE_URL, {
      headers: {
        accept: 'application/json',
        'User-Agent': `felan/${currentVersion} (${process.platform}; node/${process.versions.node}; ${process.arch})`,
      },
      signal,
    });
    if (!response.ok) return undefined;

    const data: unknown = await response.json();
    if (!isRecord(data) || typeof data.version !== 'string') return undefined;
    const latestVersion = data.version.trim();
    if (!isStableVersion(latestVersion) || compareVersions(latestVersion, currentVersion) <= 0) {
      return undefined;
    }
    return latestVersion;
  } catch {
    return undefined;
  }
}

export async function runFelanUpdate(options: RunFelanUpdateOptions = {}): Promise<number> {
  const writeOutput = options.writeOutput ?? ((line) => console.log(line));
  const writeError = options.writeError ?? ((line) => console.error(line));
  const packageDirectory = options.packageDirectory ?? dirname(dirname(fileURLToPath(import.meta.url)));
  const currentVersion = options.currentVersion ?? FELAN_VERSION;
  const runNpm = options.runNpm ?? runNpmCommand;

  const globalRootResult = await runNpm(['root', '--global'], packageDirectory);
  if (globalRootResult.status !== 0) {
    writeError(`Could not find npm's global installation: ${commandError(globalRootResult)}`);
    return 1;
  }

  const globalRoot = globalRootResult.stdout.trim();
  const expectedPackageDirectory = join(globalRoot, ...PACKAGE_DIRECTORY);
  if (!globalRoot || !samePath(packageDirectory, expectedPackageDirectory) || isSymbolicLink(expectedPackageDirectory)) {
    writeError(
      'Felan update only supports a verified global npm installation. '
        + 'Run `npm install --global @felan-ai/felan` to update this installation manually.',
    );
    return 1;
  }

  const packageManifest = readPackageManifest(packageDirectory);
  if (!packageManifest || packageManifest.name !== PACKAGE_NAME || packageManifest.version !== currentVersion) {
    writeError('The running Felan package could not be verified. Update it manually with npm.');
    return 1;
  }

  const latestResult = await runNpm(['view', `${PACKAGE_NAME}@latest`, 'version'], packageDirectory);
  if (latestResult.status !== 0) {
    writeError(`Could not check for a newer Felan release: ${commandError(latestResult)}`);
    return 1;
  }

  const latestVersion = latestResult.stdout.trim();
  if (!isStableVersion(latestVersion) || !isStableVersion(currentVersion)) {
    writeError('npm returned an invalid stable Felan version. Update Felan manually.');
    return 1;
  }

  const comparison = compareVersions(latestVersion, currentVersion);
  if (comparison <= 0) {
    writeOutput(`Felan ${currentVersion} is already up to date.`);
    return 0;
  }

  const installResult = await runNpm(
    ['install', '--global', `${PACKAGE_NAME}@${latestVersion}`],
    packageDirectory,
  );
  if (installResult.status !== 0) {
    writeError(`Felan update failed: ${commandError(installResult)}`);
    return 1;
  }

  const installedManifest = readPackageManifest(packageDirectory);
  if (installedManifest?.name !== PACKAGE_NAME || installedManifest.version !== latestVersion) {
    writeError(`Felan update could not verify version ${latestVersion}. Update Felan manually.`);
    return 1;
  }

  writeOutput(`Updated Felan from ${currentVersion} to ${latestVersion}. Restart Felan to use the new version.`);
  return 0;
}

async function runNpmCommand(args: readonly string[], cwd: string): Promise<NpmResult> {
  const npmCommand = resolveNpmCommand();
  if (!npmCommand) {
    return { status: 1, stdout: '', stderr: 'npm was not found' };
  }

  return new Promise((resolveResult) => {
    execFile(npmCommand.command, [...npmCommand.arguments, ...args], {
      cwd,
      encoding: 'utf8',
      windowsHide: true,
    }, (error, stdout, stderr) => {
      resolveResult({
        status: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
        stdout,
        stderr,
      });
    });
  });
}

interface NpmCommand {
  readonly command: string;
  readonly arguments: readonly string[];
}

function resolveNpmCommand(): NpmCommand | undefined {
  const npmCliCandidates = [
    join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(dirname(process.execPath), '..', 'share', 'nodejs', 'npm', 'bin', 'npm-cli.js'),
  ];
  for (const candidate of npmCliCandidates) {
    if (candidate && basename(candidate).toLowerCase() === 'npm-cli.js' && existsSync(candidate)) {
      return { command: process.execPath, arguments: [candidate] };
    }
  }

  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    if (!directory || directory.toLowerCase().includes('node_modules')) continue;
    const executable = join(directory, process.platform === 'win32' ? 'npm.cmd' : 'npm');
    if (!existsSync(executable)) continue;
    if (process.platform === 'win32') {
      const adjacentCli = join(directory, 'node_modules', 'npm', 'bin', 'npm-cli.js');
      if (existsSync(adjacentCli)) return { command: process.execPath, arguments: [adjacentCli] };
      continue;
    }
    return { command: executable, arguments: [] };
  }
  return undefined;
}

function readPackageManifest(packageDirectory: string): { name?: unknown; version?: unknown } | undefined {
  try {
    return JSON.parse(readFileSync(join(packageDirectory, 'package.json'), 'utf8')) as {
      name?: unknown;
      version?: unknown;
    };
  } catch {
    return undefined;
  }
}

function isSymbolicLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

function samePath(left: string, right: string): boolean {
  const canonicalLeft = canonicalPath(left);
  const canonicalRight = canonicalPath(right);
  const normalizedLeft = process.platform === 'win32' ? canonicalLeft.toLowerCase() : canonicalLeft;
  const normalizedRight = process.platform === 'win32' ? canonicalRight.toLowerCase() : canonicalRight;
  return normalizedLeft === normalizedRight;
}

function canonicalPath(path: string): string {
  const resolved = resolve(path);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function isStableVersion(version: string): boolean {
  return /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u.test(version);
}

function compareVersions(left: string, right: string): number {
  const leftParts = left.split('.').map(Number);
  const rightParts = right.split('.').map(Number);
  for (let index = 0; index < leftParts.length; index += 1) {
    if (leftParts[index] !== rightParts[index]) return leftParts[index]! > rightParts[index]! ? 1 : -1;
  }
  return 0;
}

function commandError(result: NpmResult): string {
  return result.stderr.trim() || result.stdout.trim() || `npm exited with status ${result.status}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
