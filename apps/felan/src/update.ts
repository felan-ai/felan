import { execFile } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { basename, delimiter, dirname, join, posix, resolve, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DaemonUpdatePreparation } from './update-daemon.js';
import { FELAN_VERSION } from './version.js';

const PACKAGE_NAME = '@felan-ai/felan';
const PACKAGE_DIRECTORY = ['@felan-ai', 'felan'] as const;
const LATEST_RELEASE_URL = 'https://registry.npmjs.org/@felan-ai%2Ffelan/latest';
const DEFAULT_VERSION_CHECK_TIMEOUT_MS = 10_000;

export type FelanInstallation =
  | { readonly kind: 'npm-prefix'; readonly packageDirectory: string; readonly prefix: string }
  | {
    readonly kind: 'linked' | 'pnpm' | 'bun' | 'yarn' | 'volta' | 'npx' | 'unknown';
    readonly packageDirectory: string;
  };

export function detectFelanInstallation(
  packageDirectory = dirname(dirname(fileURLToPath(import.meta.url))),
  platform: NodeJS.Platform = process.platform,
): FelanInstallation {
  const path = normalizedPath(packageDirectory, platform);
  const comparisonPath = platform === 'win32' ? path.toLowerCase() : path;
  const managers = [
    ['pnpm', /\/pnpm\/global\//u],
    ['bun', /\/\.bun\/install\/global\//u],
    ['yarn', /\/(?:yarn\/global|yarn\/data\/global)\//u],
    ['volta', /\/\.?volta\/tools\/image\//u],
    ['npx', /\/_npx\//u],
  ] as const;
  for (const [kind, pattern] of managers) {
    if (pattern.test(comparisonPath)) return { kind, packageDirectory };
  }

  const nodeModulesIndex = comparisonPath.lastIndexOf('/node_modules/');
  if (isSymbolicLink(packageDirectory) || nodeModulesIndex === -1) {
    return { kind: 'linked', packageDirectory: canonicalPath(packageDirectory) };
  }
  const packageParts = path.slice(nodeModulesIndex + 1).split('/');
  let parent = path.slice(0, nodeModulesIndex) || '/';
  for (const part of packageParts) {
    parent = `${parent.replace(/\/$/u, '')}/${part}`;
    if (isSymbolicLink(parent)) return { kind: 'linked', packageDirectory: canonicalPath(packageDirectory) };
  }

  const suffix = platform === 'win32'
    ? /^(.*)\/node_modules\/@felan-ai\/felan$/iu
    : /^(.*)\/lib\/node_modules\/@felan-ai\/felan$/u;
  const prefix = suffix.exec(path)?.[1];
  return prefix === undefined || !verifiedNpmBin(prefix || '/', packageDirectory, platform)
    ? { kind: 'unknown', packageDirectory }
    : { kind: 'npm-prefix', packageDirectory, prefix: prefix || '/' };
}

export function felanUpdateCommand(installation: FelanInstallation): string | undefined {
  switch (installation.kind) {
    case 'npm-prefix': return 'felan update';
    case 'pnpm': return `pnpm add --global ${PACKAGE_NAME}@latest`;
    case 'bun': return `bun add --global ${PACKAGE_NAME}@latest`;
    case 'yarn': return `yarn global add ${PACKAGE_NAME}@latest`;
    case 'volta': return `volta install ${PACKAGE_NAME}@latest`;
    case 'npx': return `npx ${PACKAGE_NAME}@latest`;
    case 'linked':
    case 'unknown': return undefined;
  }
}

export interface NpmResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface RunFelanUpdateOptions {
  readonly packageDirectory?: string;
  readonly platform?: NodeJS.Platform;
  readonly currentVersion?: string;
  readonly runNpm?: (args: readonly string[], cwd: string) => Promise<NpmResult>;
  readonly prepareDaemon?: () => Promise<DaemonUpdatePreparation>;
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
  const platform = options.platform ?? process.platform;
  const installation = detectFelanInstallation(packageDirectory, platform);
  const currentVersion = options.currentVersion ?? FELAN_VERSION;
  const runNpm = options.runNpm ?? runNpmCommand;

  if (installation.kind !== 'npm-prefix' && installation.kind !== 'unknown') {
    writeError(installationError(installation, ''));
    return 1;
  }
  const globalRootResult = await runNpm(['root', '--global'], packageDirectory);
  if (globalRootResult.status !== 0) {
    writeError(`Could not find npm's global installation: ${commandError(globalRootResult)}`);
    return 1;
  }

  let globalRoot = globalRootResult.stdout.trim();
  const prefixArguments: string[] = [];
  if (!verifiedPackageRoot(globalRoot, packageDirectory, platform)) {
    if (installation.kind === 'npm-prefix') {
      const prefixResult = await runNpm(['root', '--global', '--prefix', installation.prefix], packageDirectory);
      const prefixRoot = prefixResult.stdout.trim();
      if (prefixResult.status === 0 && verifiedPackageRoot(prefixRoot, packageDirectory, platform)) {
        globalRoot = prefixRoot;
        prefixArguments.push('--prefix', installation.prefix);
      }
    }
    if (prefixArguments.length === 0) {
      writeError(installationError(installation, globalRoot));
      return 1;
    }
  }

  const packageManifest = readPackageManifest(packageDirectory);
  if (!packageManifest || packageManifest.name !== PACKAGE_NAME || packageManifest.version !== currentVersion) {
    writeError('The running Felan Code package could not be verified. Update it manually with npm.');
    return 1;
  }

  const latestResult = await runNpm(['view', `${PACKAGE_NAME}@latest`, 'version'], globalRoot);
  if (latestResult.status !== 0) {
    writeError(`Could not check for a newer Felan Code release: ${commandError(latestResult)}`);
    return 1;
  }

  const latestVersion = latestResult.stdout.trim();
  if (!isStableVersion(latestVersion) || !isStableVersion(currentVersion)) {
    writeError('npm returned an invalid stable Felan Code version. Update Felan Code manually.');
    return 1;
  }

  const comparison = compareVersions(latestVersion, currentVersion);
  if (comparison <= 0) {
    writeOutput(`Felan Code ${currentVersion} is already up to date.`);
    return 0;
  }

  const daemon = await (options.prepareDaemon ?? (async () => {
    const { prepareDaemonForUpdate } = await import('./update-daemon.js');
    return prepareDaemonForUpdate({
      onStopping: () => writeOutput('Stopping the idle background daemon...'),
    });
  }))();
  if (daemon.kind === 'busy' && platform === 'win32') {
    writeError(`The background daemon has ${daemonActivity(daemon)} holding the installed files. `
      + 'Finish the tasks or exit the sessions, then run `felan daemon stop` '
      + 'or `felan daemon stop --force` to interrupt them, and retry `felan update`.');
    return 1;
  }

  const installResult = await runNpm(
    ['install', '--global', `${PACKAGE_NAME}@${latestVersion}`, ...prefixArguments],
    globalRoot,
  );
  if (installResult.status !== 0) {
    writeError(installFailure(installResult, globalRoot, platform));
    return 1;
  }

  const installedManifest = readPackageManifest(packageDirectory);
  if (installedManifest?.name !== PACKAGE_NAME || installedManifest.version !== latestVersion) {
    writeError(`Felan Code update could not verify version ${latestVersion}. Update Felan Code manually.`);
    return 1;
  }

  const updated = `Updated Felan Code from ${currentVersion} to ${latestVersion}.`;
  switch (daemon.kind) {
    case 'stopped':
      writeOutput(`${updated} The background daemon was stopped and starts with ${latestVersion} the next time you run Felan Code.`);
      break;
    case 'absent':
      writeOutput(`${updated} Start Felan Code to use the new version.`);
      break;
    case 'busy':
      writeOutput(`${updated} The background daemon still runs Felan Code ${currentVersion} against the new files with ${daemonActivity(daemon)}. `
        + 'Restart it soon with `felan daemon restart` or `/restart` in Felan Code once this work finishes.');
      break;
    case 'unavailable':
      writeOutput(`${updated} ${daemon.message}`);
      break;
  }
  return 0;
}

function daemonActivity(daemon: Extract<DaemonUpdatePreparation, { kind: 'busy' }>): string {
  return `${daemon.work} active task${daemon.work === 1 ? '' : 's'}, `
    + `${daemon.runs} active run${daemon.runs === 1 ? '' : 's'}, `
    + `and ${daemon.attachments} attached session${daemon.attachments === 1 ? '' : 's'}`;
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

function samePath(left: string, right: string, platform: NodeJS.Platform): boolean {
  const canonicalLeft = canonicalPath(left);
  const canonicalRight = canonicalPath(right);
  const normalizedLeft = normalizedPath(canonicalLeft, platform);
  const normalizedRight = normalizedPath(canonicalRight, platform);
  return platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function normalizedPath(path: string, platform: NodeJS.Platform): string {
  const paths = platform === 'win32' ? win32 : posix;
  return paths.normalize(path.replace(/\\/gu, '/')).replace(/\\/gu, '/').replace(/\/$/u, '');
}

function verifiedPackageRoot(root: string, packageDirectory: string, platform: NodeJS.Platform): boolean {
  const expectedPackageDirectory = join(root, ...PACKAGE_DIRECTORY);
  return Boolean(root)
    && samePath(packageDirectory, expectedPackageDirectory, platform)
    && detectFelanInstallation(expectedPackageDirectory, platform).kind === 'npm-prefix';
}

function verifiedNpmBin(prefix: string, packageDirectory: string, platform: NodeJS.Platform): boolean {
  try {
    if (platform === 'win32') {
      return /node_modules[\\/]@felan-ai[\\/]felan[\\/]dist[\\/]cli\.js/iu.test(
        readFileSync(join(prefix, 'felan.cmd'), 'utf8'),
      );
    }
    return realpathSync(join(prefix, 'bin', 'felan')) === realpathSync(join(packageDirectory, 'dist', 'cli.js'));
  } catch {
    return false;
  }
}

function installationError(installation: FelanInstallation, globalRoot: string): string {
  if (installation.kind === 'linked') {
    return `Felan Code is running from a linked installation at ${installation.packageDirectory}. `
      + 'Update and rebuild that checkout, or unlink it before reinstalling with your package manager.';
  }
  const command = felanUpdateCommand(installation);
  if (command && installation.kind !== 'npm-prefix') {
    return `Felan Code was installed with ${installation.kind}. Update this installation with \`${command}\`.`;
  }
  return `Could not verify the running Felan Code package at ${installation.packageDirectory} `
    + `against npm's global root at ${globalRoot || '(empty)'}. `
    + 'Update it with the package manager that installed it.';
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
  return commandErrorLines(result).slice(0, 4).join('; ') || `npm exited with status ${result.status}`;
}

function commandErrorLines(result: NpmResult): string[] {
  const details = result.stderr.trim() || result.stdout.trim();
  return details.split(/\r?\n/u)
    .map((line) => line.replace(/^npm\s+(?:error|ERR!|warn)\s*/u, '').trim())
    .filter((line) => line && !/^(?:at\s|A complete log|Log files?:)|[/\\]_logs[/\\]/iu.test(line));
}

function installFailure(result: NpmResult, globalRoot: string, platform: NodeJS.Platform): string {
  const details = commandErrorLines(result).join('\n');
  const syscall = /^syscall\s+(\S+)/imu.exec(details)?.[1];
  const removesOrRenames = syscall
    ? /^(?:rename|unlink|rmdir)$/iu.test(syscall)
    : /\bEPERM\b[^\n]*\b(?:rename|unlink|rmdir)\b/iu.test(details);
  const locked = result.status === -4082 || /\bEBUSY\b|-4082\b|resource busy|resource is locked/iu.test(details)
    || (platform === 'win32' && /\bEPERM\b/iu.test(details) && removesOrRenames);
  if (locked) {
    return `Felan Code update failed: ${commandError(result)} `
      + 'A running Felan Code process is using the installed files. Exit all Felan Code sessions, '
      + 'run `felan daemon stop`, then retry'
      + (platform === 'win32' ? ' from another directory, such as `%TEMP%`.' : '.');
  }
  if (/\b(?:EACCES|EPERM)\b/iu.test(details)) {
    const path = /^path\s+(.+)$/imu.exec(details)?.[1]?.trim() || globalRoot;
    return `Felan Code update failed: npm cannot modify ${path} because access was denied. `
      + "Fix permissions of npm's global directory or rerun with the account that installed Felan Code. "
      + 'See https://docs.npmjs.com/resolving-eacces-permissions-errors-when-installing-packages-globally.';
  }
  return `Felan Code update failed: ${commandError(result)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
