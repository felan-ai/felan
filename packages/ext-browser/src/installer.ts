import { createHash, randomUUID } from 'node:crypto';
import type { AgentRuntime, ExecResult } from '@felan-ai/agent-core';
import { isWindowsRuntimePath, joinRuntimePath } from './runtime-path.js';

export const MANAGED_AGENT_BROWSER_VERSION = '0.31.1';

const ARCHIVE_URL = `https://registry.npmjs.org/agent-browser/-/agent-browser-${MANAGED_AGENT_BROWSER_VERSION}.tgz`;
const ARCHIVE_SHA512_BASE64 = 'RjgfT0EsHe1oZQbwzUqJTPb7w3sU8DGbbAjMxLNI5dW1y0cc81TbVsqgjqQJmsy3GEbEcKe/ryARwmWGqJAXXQ==';
const MAX_ARCHIVE_BYTES = 96 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 120_000;
const EXTRACT_TIMEOUT_MS = 120_000;
const PROBE_TIMEOUT_MS = 10_000;
const INSTALL_MARKER = '.felan-install.json';
const NEGATIVE_DETECTION_CACHE_MS = 5_000;

const unavailableDetectionCache = new WeakMap<AgentRuntime, {
  readonly expiresAt: number;
  readonly detection: AgentBrowserDetection;
}>();

const REVIEWED_ASSETS = {
  'agent-browser-darwin-arm64': 'fd7acd17b3071ff7f75a03c1ecd30501959d9c2d063bdaa05adb6f77abf2a7bf',
  'agent-browser-darwin-x64': '05aa3e2ed3550e06fb3eb7423a1cef0d9d6031c4d6a8835b9dbe033baf83ef6d',
  'agent-browser-linux-arm64': '5f80bff26b25e9a9f712be64dda1f8ea2b22213a1a07c0f97ea8f9f226c2894b',
  'agent-browser-linux-musl-arm64': '1ca397f714820ca954c6b575e816c08acc937ffacea2b901f5cf6524fc4a6853',
  'agent-browser-linux-musl-x64': 'b7492a3e00e52790bffbd2900c399265e6a80598276f89fb8b2fbfa314cc8d22',
  'agent-browser-linux-x64': '72c13bcfd2fd6b188325bdd23c646d06ca69a1a964a9cdaab37e4ff8f47aa5c6',
  'agent-browser-win32-x64.exe': '0a355020b0ff2f9199fbb7385a0b8b7e16b548bb0d6df64498b456b76898adfa',
} as const;

export interface AgentBrowserInvocation {
  readonly command: string;
  readonly source: 'managed' | 'path';
  readonly version: string;
}

export type AgentBrowserDetection = {
  readonly available: true;
  readonly invocation: AgentBrowserInvocation;
} | {
  readonly available: false;
  readonly reason: string;
};

export interface ManagedAgentBrowserEnvironment {
  readonly platform?: NodeJS.Platform;
  readonly arch?: string;
  readonly musl?: boolean;
}

export interface ReviewedAgentBrowserAsset {
  readonly name: keyof typeof REVIEWED_ASSETS;
  readonly sha256: string;
}

export function resolveReviewedAgentBrowserAsset(
  platform: NodeJS.Platform,
  arch: string,
  musl = false,
): ReviewedAgentBrowserAsset | undefined {
  const normalizedArch = arch === 'x86_64' ? 'x64' : arch === 'aarch64' ? 'arm64' : arch;
  let name: string;
  if (platform === 'darwin' && (normalizedArch === 'arm64' || normalizedArch === 'x64')) {
    name = `agent-browser-darwin-${normalizedArch}`;
  } else if (platform === 'linux' && (normalizedArch === 'arm64' || normalizedArch === 'x64')) {
    name = `agent-browser-linux-${musl ? 'musl-' : ''}${normalizedArch}`;
  } else if (platform === 'win32' && (normalizedArch === 'x64' || normalizedArch === 'arm64')) {
    name = 'agent-browser-win32-x64.exe';
  } else {
    return undefined;
  }
  if (!Object.hasOwn(REVIEWED_ASSETS, name)) return undefined;
  const reviewedName = name as keyof typeof REVIEWED_ASSETS;
  return { name: reviewedName, sha256: REVIEWED_ASSETS[reviewedName] };
}

export function managedAgentBrowserDirectory(runtime: AgentRuntime): string {
  return joinRuntimePath(
    runtime.storage('agent').root,
    managedAgentBrowserRelativeDirectory(),
  );
}

export async function managedAgentBrowserExecutable(
  runtime: AgentRuntime,
  environment: ManagedAgentBrowserEnvironment = {},
): Promise<string | undefined> {
  const asset = await reviewedAssetForRuntime(runtime, environment);
  if (!asset) return undefined;
  return (await findManagedInstallation(runtime, asset)).command;
}

export async function inspectAgentBrowserRuntime(
  runtime: AgentRuntime,
  environment: ManagedAgentBrowserEnvironment = {},
  signal?: AbortSignal,
): Promise<AgentBrowserDetection> {
  throwIfAborted(signal);
  const cacheable = isDefaultEnvironment(environment);
  const cached = cacheable ? unavailableDetectionCache.get(runtime) : undefined;
  if (cached && cached.expiresAt > Date.now()) return cached.detection;
  if (cached) unavailableDetectionCache.delete(runtime);
  const failures: string[] = [];
  const asset = await reviewedAssetForRuntime(runtime, environment, signal);
  throwIfAborted(signal);
  const managed = asset === undefined
    ? { command: undefined, reason: undefined }
    : await findManagedInstallation(runtime, asset);
  const candidates = [
    ...(managed.command === undefined
      ? []
      : [{ command: managed.command, source: 'managed' as const }]),
    { command: 'agent-browser', source: 'path' as const },
  ];
  if (managed.reason !== undefined) failures.push(`managed: ${managed.reason}`);

  for (const candidate of candidates) {
    throwIfAborted(signal);
    const result = await execute(runtime, candidate.command, ['--version'], PROBE_TIMEOUT_MS, signal);
    throwIfAborted(signal);
    if (successful(result)) {
      const version = parseAgentBrowserVersion(`${result.stdout}\n${result.stderr}`);
      if (version === MANAGED_AGENT_BROWSER_VERSION) {
        unavailableDetectionCache.delete(runtime);
        return {
          available: true,
          invocation: { command: candidate.command, source: candidate.source, version },
        };
      }
      failures.push(version === undefined
        ? `${candidate.source}: did not report an agent-browser semantic version`
        : `${candidate.source}: version ${version} does not match reviewed ${MANAGED_AGENT_BROWSER_VERSION}`);
      continue;
    }
    failures.push(`${candidate.source}: ${resultDiagnostic(result)}`);
  }

  const detail = failures.length > 0
    ? ` (${sanitizeDiagnostic(failures.join('; ')).slice(0, 320)})`
    : '';
  const detection: AgentBrowserDetection = {
    available: false,
    reason: `agent-browser is unavailable${detail}. Use Felan dependency onboarding or install agent-browser on PATH.`,
  };
  if (cacheable) {
    unavailableDetectionCache.set(runtime, {
      expiresAt: Date.now() + NEGATIVE_DETECTION_CACHE_MS,
      detection,
    });
  }
  return detection;
}

export function invalidateAgentBrowserRuntimeCache(runtime: AgentRuntime): void {
  unavailableDetectionCache.delete(runtime);
}

export async function installManagedAgentBrowser(
  runtime: AgentRuntime,
  onStatus: (message: string) => void = () => {},
  environment: ManagedAgentBrowserEnvironment = {},
): Promise<AgentBrowserDetection> {
  if (!hasManagedTarget(runtime, environment)) {
    return unavailable(`Managed agent-browser ${MANAGED_AGENT_BROWSER_VERSION} installation is available only for host runtimes; preinstall the reviewed CLI on the target runtime PATH.`);
  }
  const platform = environment.platform ?? process.platform;
  const arch = environment.arch ?? process.arch;
  const asset = await reviewedAssetForRuntime(runtime, { ...environment, platform, arch });
  if (!asset) {
    return unavailable(`Managed agent-browser ${MANAGED_AGENT_BROWSER_VERSION} is unavailable for ${platform}-${arch}; install a compatible CLI on PATH.`);
  }

  const sessionStorage = runtime.storage('session');
  const agentStorage = runtime.storage('agent');
  const archiveRelativePath = `browser/install-${randomUUID()}.tgz`;
  const archivePath = joinRuntimePath(sessionStorage.root, archiveRelativePath);
  const packageRelativePath = `${managedAgentBrowserInstallationsRelativeDirectory()}/${randomUUID()}`;
  const packagePath = joinRuntimePath(agentStorage.root, packageRelativePath);
  const executablePath = joinRuntimePath(packagePath, 'bin', asset.name);
  let installationReady = false;
  let packageTouched = false;

  try {
    await sessionStorage.mkdir('browser', { recursive: true });
    onStatus(`Downloading reviewed agent-browser ${MANAGED_AGENT_BROWSER_VERSION} package...`);
    const downloaded = await execute(runtime, 'curl', [
      '--proto',
      '=https',
      '--tlsv1.2',
      '--fail',
      '--silent',
      '--show-error',
      '--location',
      '--max-filesize',
      String(MAX_ARCHIVE_BYTES),
      ARCHIVE_URL,
      '--output',
      archivePath,
    ], DOWNLOAD_TIMEOUT_MS);
    if (!successful(downloaded)) {
      return unavailable(`Failed to download agent-browser: ${resultDiagnostic(downloaded)}`);
    }

    const archive = await sessionStorage.readFile(archiveRelativePath);
    if (archive.byteLength > MAX_ARCHIVE_BYTES) {
      return unavailable(`The agent-browser archive exceeded ${MAX_ARCHIVE_BYTES} bytes; refusing to extract it.`);
    }
    const archiveDigest = createHash('sha512').update(archive).digest('base64');
    if (archiveDigest !== ARCHIVE_SHA512_BASE64) {
      return unavailable('The agent-browser archive did not match the reviewed SHA-512 integrity; refusing to extract it.');
    }

    onStatus(`Extracting agent-browser ${MANAGED_AGENT_BROWSER_VERSION} in Felan agent storage...`);
    packageTouched = true;
    await agentStorage.mkdir(managedAgentBrowserInstallationsRelativeDirectory(), { recursive: true });
    await agentStorage.mkdir(packageRelativePath, { recursive: true });
    const extracted = await execute(runtime, 'tar', [
      '-xzf',
      archivePath,
      '-C',
      packagePath,
      '--strip-components=1',
    ], EXTRACT_TIMEOUT_MS);
    if (!successful(extracted)) {
      return unavailable(`Failed to extract the reviewed agent-browser package: ${resultDiagnostic(extracted)}`);
    }

    const packageMetadata = await readManagedFile(agentStorage, `${packageRelativePath}/package.json`);
    if (!packageMetadata) return unavailable('The extracted agent-browser package has no readable package.json.');
    if (packageVersion(packageMetadata) !== MANAGED_AGENT_BROWSER_VERSION) {
      return unavailable(`The extracted package did not report agent-browser ${MANAGED_AGENT_BROWSER_VERSION}.`);
    }
    const skill = await readManagedFile(agentStorage, `${packageRelativePath}/skill-data/core/SKILL.md`);
    if (!skill || skill.byteLength === 0) {
      return unavailable('The extracted agent-browser package is missing its version-matched core skill.');
    }
    const executable = await readManagedFile(agentStorage, `${packageRelativePath}/bin/${asset.name}`);
    if (!executable) return unavailable(`The extracted package is missing ${asset.name}.`);
    const executableDigest = createHash('sha256').update(executable).digest('hex');
    if (executableDigest !== asset.sha256) {
      return unavailable(`The extracted ${asset.name} did not match the reviewed SHA-256 digest.`);
    }

    if (!isWindowsRuntimePath(agentStorage.root)) {
      const chmod = await execute(runtime, 'chmod', ['755', executablePath], PROBE_TIMEOUT_MS);
      if (!successful(chmod)) {
        return unavailable(`The managed agent-browser executable could not be made executable: ${resultDiagnostic(chmod)}`);
      }
    }

    onStatus('Verifying the managed agent-browser CLI and bundled skills...');
    const verified = await execute(runtime, executablePath, ['--version'], PROBE_TIMEOUT_MS);
    if (!successful(verified)) {
      return unavailable(`Managed agent-browser could not be verified: ${resultDiagnostic(verified)}`);
    }
    const version = parseAgentBrowserVersion(`${verified.stdout}\n${verified.stderr}`);
    if (version !== MANAGED_AGENT_BROWSER_VERSION) {
      return unavailable(`Managed agent-browser reported ${version ?? 'no version'} instead of ${MANAGED_AGENT_BROWSER_VERSION}.`);
    }

    await agentStorage.writeFile(
      `${packageRelativePath}/${INSTALL_MARKER}`,
      new TextEncoder().encode(`${JSON.stringify(installMarker(asset))}\n`),
    );
    installationReady = true;
    invalidateAgentBrowserRuntimeCache(runtime);

    return {
      available: true,
      invocation: { command: executablePath, source: 'managed', version },
    };
  } catch (error) {
    return unavailable(`Managed agent-browser installation failed: ${sanitizeDiagnostic(errorMessage(error))}`);
  } finally {
    await sessionStorage.remove(archiveRelativePath).catch(() => {});
    if (!installationReady && packageTouched) {
      await agentStorage.remove(packageRelativePath, { recursive: true }).catch(() => {});
    }
  }
}

async function reviewedAssetForRuntime(
  runtime: AgentRuntime,
  environment: ManagedAgentBrowserEnvironment,
  signal?: AbortSignal,
): Promise<ReviewedAgentBrowserAsset | undefined> {
  if (!hasManagedTarget(runtime, environment)) return undefined;
  const platform = environment.platform ?? process.platform;
  const arch = environment.arch ?? process.arch;
  const musl = environment.musl ?? (platform === 'linux' && await isMuslRuntime(runtime, signal));
  return resolveReviewedAgentBrowserAsset(platform, arch, musl);
}

async function isMuslRuntime(runtime: AgentRuntime, signal?: AbortSignal): Promise<boolean> {
  const result = await execute(runtime, 'ldd', ['--version'], PROBE_TIMEOUT_MS, signal);
  if (result instanceof Error) return false;
  return `${result.stdout}\n${result.stderr}`.toLowerCase().includes('musl');
}

async function findManagedInstallation(
  runtime: AgentRuntime,
  asset: ReviewedAgentBrowserAsset,
): Promise<{ readonly command?: string; readonly reason?: string }> {
  const storage = runtime.storage('agent');
  const installationsRelativePath = managedAgentBrowserInstallationsRelativeDirectory();
  let files: string[];
  try {
    files = await storage.listFiles(installationsRelativePath, { recursive: true });
  } catch {
    return { reason: 'no verified managed installation was found' };
  }
  const installationIds = files
    .map((path) => path.replace(/\\/gu, '/'))
    .map((path) => /^([0-9a-f-]{36})\/\.felan-install\.json$/iu.exec(path)?.[1])
    .filter((value): value is string => value !== undefined)
    .sort();
  let firstFailure: string | undefined;
  for (const installationId of installationIds) {
    const packageRelativePath = `${installationsRelativePath}/${installationId}`;
    const failure = await managedInstallationFailure(runtime, asset, packageRelativePath);
    if (failure === undefined) {
      return {
        command: joinRuntimePath(storage.root, packageRelativePath, 'bin', asset.name),
      };
    }
    firstFailure ??= failure;
  }
  return { reason: firstFailure ?? 'no verified managed installation was found' };
}

async function managedInstallationFailure(
  runtime: AgentRuntime,
  asset: ReviewedAgentBrowserAsset,
  packageRelativePath: string,
): Promise<string | undefined> {
  const storage = runtime.storage('agent');
  const marker = await readManagedFile(storage, `${packageRelativePath}/${INSTALL_MARKER}`);
  if (!marker || !matchesInstallMarker(marker, asset)) return 'reviewed installation marker is missing or invalid';

  const packageMetadata = await readManagedFile(storage, `${packageRelativePath}/package.json`);
  if (!packageMetadata || packageVersion(packageMetadata) !== MANAGED_AGENT_BROWSER_VERSION) {
    return 'package metadata is missing or has the wrong version';
  }
  const skill = await readManagedFile(storage, `${packageRelativePath}/skill-data/core/SKILL.md`);
  if (!skill || skill.byteLength === 0) return 'version-matched core skill is missing';
  const executable = await readManagedFile(storage, `${packageRelativePath}/bin/${asset.name}`);
  if (!executable) return `${asset.name} is missing`;
  const digest = createHash('sha256').update(executable).digest('hex');
  return digest === asset.sha256 ? undefined : `${asset.name} failed its reviewed SHA-256 check`;
}

function installMarker(asset: ReviewedAgentBrowserAsset): Record<string, unknown> {
  return {
    schemaVersion: 1,
    package: 'agent-browser',
    version: MANAGED_AGENT_BROWSER_VERSION,
    archiveSha512: ARCHIVE_SHA512_BASE64,
    asset: asset.name,
    assetSha256: asset.sha256,
  };
}

function matchesInstallMarker(content: Uint8Array, asset: ReviewedAgentBrowserAsset): boolean {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(content)) as unknown;
    if (!isRecord(parsed)) return false;
    const expected = installMarker(asset);
    return Object.entries(expected).every(([key, value]) => parsed[key] === value);
  } catch {
    return false;
  }
}

function managedAgentBrowserRelativeDirectory(): string {
  return `browser/agent-browser-${MANAGED_AGENT_BROWSER_VERSION}`;
}

function managedAgentBrowserInstallationsRelativeDirectory(): string {
  return `${managedAgentBrowserRelativeDirectory()}/installs`;
}

function hasManagedTarget(
  runtime: AgentRuntime,
  environment: ManagedAgentBrowserEnvironment,
): boolean {
  return runtime.kind === 'host'
    || (environment.platform !== undefined && environment.arch !== undefined);
}

function isDefaultEnvironment(environment: ManagedAgentBrowserEnvironment): boolean {
  return environment.platform === undefined
    && environment.arch === undefined
    && environment.musl === undefined;
}

async function readManagedFile(
  storage: ReturnType<AgentRuntime['storage']>,
  path: string,
): Promise<Uint8Array | undefined> {
  try {
    return await storage.readFile(path);
  } catch {
    return undefined;
  }
}

function packageVersion(content: Uint8Array): string | undefined {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(content)) as unknown;
    return isRecord(parsed) && typeof parsed.version === 'string' ? parsed.version : undefined;
  } catch {
    return undefined;
  }
}

async function execute(
  runtime: AgentRuntime,
  command: string,
  args: readonly string[],
  timeout: number,
  signal?: AbortSignal,
): Promise<ExecResult | Error> {
  try {
    return await runtime.exec(command, args, {
      cwd: runtime.cwd,
      timeout,
      ...(signal === undefined ? {} : { signal }),
    });
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error('agent-browser detection aborted');
}

function successful(result: ExecResult | Error): result is ExecResult {
  return !(result instanceof Error) && !result.killed && result.code === 0;
}

function unavailable(reason: string): AgentBrowserDetection {
  return { available: false, reason: sanitizeDiagnostic(reason) };
}

function resultDiagnostic(result: ExecResult | Error): string {
  if (result instanceof Error) return sanitizeDiagnostic(result.message);
  if (result.killed) return 'command timed out or was terminated';
  return sanitizeDiagnostic(result.stderr || result.stdout || `command exited with code ${result.code}`);
}

function parseAgentBrowserVersion(output: string): string | undefined {
  return output.match(/(?:^|\s)agent-browser\s+v?(\d+\.\d+\.\d+)(?=\s|$)/iu)?.[1];
}

function sanitizeDiagnostic(value: string): string {
  const normalized = value
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, '')
    .replace(/[\u0000-\u001f\u007f]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  return normalized.slice(0, 700) || 'no diagnostic output';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
