import { randomUUID } from 'node:crypto';
import type { AgentRuntime, AgentRuntimeStorage, ExecResult } from '@felan-ai/agent-core';
import { CLAUDE_AGENT_SDK_ENTRY_FILE, CLAUDE_AGENT_SDK_ENTRY_SOURCE } from '../sdk/runtime.js';
import packageLock from './agent-sdk-package-lock.json' with { type: 'json' };
import { detectLinuxLibc } from './linux-libc.js';
import { isWindowsRuntimePath, joinRuntimePath } from './runtime-path.js';

export const MANAGED_CLAUDE_AGENT_SDK_VERSION = '0.3.293';

const STORAGE_DIRECTORY = 'claude-code';
const DIRECTORY = `${STORAGE_DIRECTORY}/agent-sdk-${MANAGED_CLAUDE_AGENT_SDK_VERSION}`;
const DEPENDENCIES = packageLock.packages[''].dependencies;
const INSTALL_TIMEOUT_MS = 15 * 60 * 1000;
const PROBE_TIMEOUT_MS = 5_000;

export type ClaudeCodeRuntimeStatus =
  | { available: true; version: string; entryPath: string }
  | { available: false; reason: string };

export function managedClaudeAgentSdkDirectory(runtime: AgentRuntime): string {
  return joinRuntimePath(runtime.storage('agent').root, DIRECTORY);
}

export async function inspectClaudeCodeRuntime(runtime: AgentRuntime): Promise<ClaudeCodeRuntimeStatus> {
  const unsupported = unsupportedReason(runtime);
  if (unsupported) return { available: false, reason: unsupported };

  try {
    const storage = runtime.storage('agent');
    await storage.readFile(joinRuntimePath(DIRECTORY, CLAUDE_AGENT_SDK_ENTRY_FILE));
    await verifyInstallation(storage, DIRECTORY);
    return available(runtime);
  } catch (error) {
    return {
      available: false,
      reason: `Claude Agent SDK is not installed or is incomplete; run /claude-code install. ${diagnostic(error)}`,
    };
  }
}

export async function installManagedClaudeAgentSdk(
  runtime: AgentRuntime,
  onStatus: (message: string) => void = () => {},
): Promise<ClaudeCodeRuntimeStatus> {
  const unsupported = unsupportedReason(runtime);
  if (unsupported) return { available: false, reason: unsupported };

  const current = await inspectClaudeCodeRuntime(runtime);
  if (current.available) return current;
  if (!runtime.files?.move) {
    return { available: false, reason: 'The managed Claude Agent SDK requires runtime file move support for installation.' };
  }

  onStatus('Checking npm availability...');
  const npm = await execute(runtime, ['--version'], runtime.cwd, PROBE_TIMEOUT_MS);
  if (!successful(npm)) {
    return { available: false, reason: `npm is required to install the Claude Agent SDK: ${diagnostic(npm)}` };
  }

  const storage = runtime.storage('agent');
  await sweepStaleStaging(runtime, storage);
  const staging = `${DIRECTORY}.staging-${randomUUID()}`;
  try {
    onStatus('Preparing the managed Claude Agent SDK staging directory...');
    await storage.mkdir(staging, { recursive: true });
    const manifest = { private: true, type: 'module', dependencies: DEPENDENCIES };
    await storage.writeFile(
      joinRuntimePath(staging, 'package.json'),
      new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`),
    );
    await storage.writeFile(
      joinRuntimePath(staging, 'package-lock.json'),
      new TextEncoder().encode(`${JSON.stringify(packageLock, null, 2)}\n`),
    );

    onStatus(`Installing Claude Agent SDK ${MANAGED_CLAUDE_AGENT_SDK_VERSION} in Felan agent storage...`);
    const installed = await execute(
      runtime,
      ['ci', '--ignore-scripts', '--no-audit', '--no-fund'],
      joinRuntimePath(storage.root, staging),
      INSTALL_TIMEOUT_MS,
    );
    if (!successful(installed)) throw new Error(`npm ci failed: ${diagnostic(installed)}`);

    onStatus('Verifying the installed Claude Agent SDK and its dependencies...');
    await verifyInstallation(storage, staging);
    await storage.writeFile(
      joinRuntimePath(staging, CLAUDE_AGENT_SDK_ENTRY_FILE),
      new TextEncoder().encode(CLAUDE_AGENT_SDK_ENTRY_SOURCE),
    );
    const existing = await inspectClaudeCodeRuntime(runtime);
    if (existing.available) {
      try {
        await removeDirectory(storage, staging);
      } catch (error) {
        runtime.logger.warn(`Could not remove the unused Claude Agent SDK staging installation: ${diagnostic(error)}`);
      }
      return existing;
    }
    await removeDirectory(storage, DIRECTORY);
    await runtime.files.move(joinRuntimePath(storage.root, staging), managedClaudeAgentSdkDirectory(runtime));
    return available(runtime);
  } catch (error) {
    let reason = `Managed Claude Agent SDK installation failed: ${diagnostic(error)}`;
    try {
      await removeDirectory(storage, staging);
    } catch (cleanupError) {
      reason += ` Could not remove the staging installation: ${diagnostic(cleanupError)}`;
    }
    return { available: false, reason };
  }
}

function unsupportedReason(runtime: AgentRuntime): string | undefined {
  if (runtime.kind !== 'host') return 'The managed Claude Agent SDK requires a host runtime.';
  if (process.platform === 'win32' || isWindowsRuntimePath(runtime.storage('agent').root)) {
    return 'The managed Claude Agent SDK supports macOS and Linux only; Windows paths are not supported.';
  }
  if (process.platform !== 'darwin' && process.platform !== 'linux') {
    return `The managed Claude Agent SDK does not support ${process.platform}/${process.arch}; macOS or Linux is required.`;
  }
  return undefined;
}

function available(runtime: AgentRuntime): ClaudeCodeRuntimeStatus {
  return {
    available: true,
    version: MANAGED_CLAUDE_AGENT_SDK_VERSION,
    entryPath: joinRuntimePath(managedClaudeAgentSdkDirectory(runtime), CLAUDE_AGENT_SDK_ENTRY_FILE),
  };
}

async function verifyInstallation(storage: AgentRuntimeStorage, directory: string): Promise<void> {
  for (const [name, version] of Object.entries(DEPENDENCIES)) {
    await verifyPackageVersion(storage, directory, name, version);
  }
  const suffix = process.platform === 'linux' && detectLinuxLibc() === 'musl' ? '-musl' : '';
  const name = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}${suffix}`;
  try {
    await verifyPackageVersion(storage, directory, name, MANAGED_CLAUDE_AGENT_SDK_VERSION);
    const binaries = await storage.listFiles(joinRuntimePath(directory, 'node_modules', name), { pattern: 'claude', limit: 1 });
    if (!binaries.includes('claude')) throw new Error(`${name} is missing its claude binary.`);
  } catch (error) {
    throw new Error(`No usable Claude Agent SDK platform binary for ${process.platform}/${process.arch}${suffix}: ${diagnostic(error)}`);
  }
}

async function verifyPackageVersion(storage: AgentRuntimeStorage, directory: string, name: string, expected: string): Promise<void> {
  const path = joinRuntimePath(directory, 'node_modules', name, 'package.json');
  const manifest: unknown = JSON.parse(new TextDecoder().decode(await storage.readFile(path)));
  const version = typeof manifest === 'object' && manifest !== null && 'version' in manifest
    ? manifest.version
    : undefined;
  if (version !== expected) {
    throw new Error(`${name} reported ${typeof version === 'string' ? version : 'no version'} instead of ${expected}.`);
  }
}

async function sweepStaleStaging(runtime: AgentRuntime, storage: AgentRuntimeStorage): Promise<void> {
  let entries: string[];
  try {
    entries = await storage.listFiles(STORAGE_DIRECTORY, {
      pattern: 'agent-sdk-*.staging-*',
      includeDirectories: true,
      recursive: false,
    });
  } catch (error) {
    if (typeof error !== 'object' || error === null || !('code' in error) || error.code !== 'ENOENT') {
      runtime.logger.warn(`Could not list stale Claude Agent SDK staging installations: ${diagnostic(error)}`);
    }
    return;
  }

  const cutoff = Date.now() - INSTALL_TIMEOUT_MS;
  for (const entry of entries) {
    if (!/^agent-sdk-[^/\\]+\.staging-[^/\\]+$/u.test(entry)) continue;
    const directory = joinRuntimePath(STORAGE_DIRECTORY, entry);
    try {
      if (runtime.files?.inspect) {
        const info = await runtime.files.inspect(joinRuntimePath(storage.root, directory));
        if (info.kind !== 'directory' || !Number.isFinite(info.modifiedAt) || info.modifiedAt > cutoff) continue;
      }
      await removeDirectory(storage, directory);
    } catch (error) {
      runtime.logger.warn(`Could not remove a stale Claude Agent SDK staging installation: ${diagnostic(error)}`);
    }
  }
}

async function removeDirectory(storage: AgentRuntimeStorage, directory: string): Promise<void> {
  try {
    await storage.remove(directory, { recursive: true });
  } catch (error) {
    if (typeof error !== 'object' || error === null || !('code' in error) || error.code !== 'ENOENT') throw error;
  }
}

async function execute(
  runtime: AgentRuntime,
  args: readonly string[],
  cwd: string,
  timeout: number,
): Promise<ExecResult | Error> {
  try {
    return await runtime.exec('npm', args, { cwd, timeout });
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}

function successful(result: ExecResult | Error): result is ExecResult {
  return !(result instanceof Error) && !result.killed && result.code === 0;
}

function diagnostic(error: unknown): string {
  let message: string;
  if (error instanceof Error) message = error.message;
  else if (typeof error === 'object' && error !== null && 'killed' in error && 'code' in error) {
    const result = error as ExecResult;
    message = result.killed
      ? 'command timed out or was terminated'
      : result.stderr || result.stdout || `command exited with code ${result.code}`;
  } else message = String(error);
  return message
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, '')
    .replace(/[\u0000-\u001f\u007f]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 500) || 'no diagnostic output';
}
