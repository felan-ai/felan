import { createHash, randomUUID } from 'node:crypto';
import type { AgentRuntime, ExecResult } from '@felan-ai/agent-core';
import { isWindowsRuntimePath, joinRuntimePath } from './runtime-path.js';

export const MANAGED_CBM_VERSION = '0.10.8';
export const CBM_INSTALLER_SHA256 = '2fdd4d6563fc8e540bb32e233c5fdef22ecf05d7ebd5a80657cd4fec953b3475';

const INSTALLER_URL = `https://raw.githubusercontent.com/DeusData/codebase-memory-mcp/v${MANAGED_CBM_VERSION}/install.sh`;
const RELEASE_URL = `https://github.com/DeusData/codebase-memory-mcp/releases/download/v${MANAGED_CBM_VERSION}`;
const MAX_INSTALLER_BYTES = 256 * 1024;
const DOWNLOAD_TIMEOUT_MS = 30_000;
const INSTALL_TIMEOUT_MS = 180_000;
const PROBE_TIMEOUT_MS = 5_000;

export type CbmInstallStatus =
  | { readonly available: true; readonly command: string; readonly source: 'managed'; readonly version: string }
  | { readonly available: false; readonly reason: string };

export function managedCbmDirectory(runtime: AgentRuntime): string {
  return joinRuntimePath(runtime.storage('agent').root, 'codebase-memory/bin');
}

export function managedCbmExecutable(runtime: AgentRuntime): string {
  return joinRuntimePath(
    managedCbmDirectory(runtime),
    isWindowsRuntimePath(runtime.storage('agent').root) ? 'codebase-memory-mcp.exe' : 'codebase-memory-mcp',
  );
}

export async function installManagedCbm(
  runtime: AgentRuntime,
  onStatus: (message: string) => void = () => {},
): Promise<CbmInstallStatus> {
  if (isWindowsRuntimePath(runtime.storage('agent').root)) {
    return unavailable('The official Codebase Memory installer supports Linux and macOS only.');
  }
  const storage = runtime.storage('agent');
  const relativeScriptPath = `codebase-memory/install-${randomUUID()}.sh`;
  const scriptPath = joinRuntimePath(storage.root, relativeScriptPath);
  await storage.mkdir('codebase-memory', { recursive: true });
  try {
    onStatus('Downloading the pinned official Codebase Memory installer...');
    const downloaded = await execute(runtime, 'curl', [
      '--proto', '=https', '--tlsv1.2', '--fail', '--silent', '--show-error', '--location',
      '--max-filesize', String(MAX_INSTALLER_BYTES), INSTALLER_URL, '--output', scriptPath,
    ], DOWNLOAD_TIMEOUT_MS);
    if (!successful(downloaded)) return unavailable(`Installer download failed: ${diagnostic(downloaded)}`);

    const installer = await storage.readFile(relativeScriptPath);
    if (installer.byteLength > MAX_INSTALLER_BYTES) return unavailable('Installer exceeded the maximum reviewed size.');
    if (createHash('sha256').update(installer).digest('hex') !== CBM_INSTALLER_SHA256) {
      return unavailable('Installer did not match the reviewed SHA-256 digest; refusing to execute it.');
    }

    onStatus(`Installing Codebase Memory ${MANAGED_CBM_VERSION} in Felan agent storage...`);
    const installed = await execute(runtime, '/bin/sh', [
      scriptPath, '--dir', managedCbmDirectory(runtime), '--skip-config',
    ], INSTALL_TIMEOUT_MS, { CBM_DOWNLOAD_URL: RELEASE_URL });
    if (!successful(installed)) return unavailable(`Installer failed: ${diagnostic(installed)}`);

    const verified = await execute(runtime, managedCbmExecutable(runtime), ['--version'], PROBE_TIMEOUT_MS);
    if (!successful(verified)) return unavailable(`Installed binary could not be verified: ${diagnostic(verified)}`);
    const version = `${verified.stdout}\n${verified.stderr}`.match(/\b(\d+\.\d+\.\d+)\b/u)?.[1];
    if (version !== MANAGED_CBM_VERSION) {
      return unavailable(`Installed binary reported ${version ?? 'no version'} instead of ${MANAGED_CBM_VERSION}.`);
    }
    return { available: true, command: managedCbmExecutable(runtime), source: 'managed', version };
  } catch (error) {
    return unavailable(`Managed installation failed: ${diagnostic(error)}`);
  } finally {
    await storage.remove(relativeScriptPath).catch(() => {});
  }
}

async function execute(
  runtime: AgentRuntime,
  command: string,
  args: readonly string[],
  timeout: number,
  env?: Readonly<Record<string, string>>,
): Promise<ExecResult | Error> {
  try {
    return await runtime.exec(command, args, {
      cwd: runtime.cwd,
      timeout,
      maxOutputBytes: 5 * 1024 * 1024,
      ...(env ? { env } : {}),
    });
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}

function successful(result: ExecResult | Error): result is ExecResult {
  return !(result instanceof Error) && result.code === 0 && !result.killed;
}

function unavailable(reason: string): CbmInstallStatus { return { available: false, reason }; }

function diagnostic(value: unknown): string {
  const text = value instanceof Error
    ? value.message
    : typeof value === 'object' && value !== null
      ? String(Reflect.get(value, 'stderr') || Reflect.get(value, 'stdout') || `exit ${Reflect.get(value, 'code')}`)
      : String(value);
  return text.replace(/[\u0000-\u001f\u007f]/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, 500);
}
