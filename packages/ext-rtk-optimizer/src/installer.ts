import { createHash, randomUUID } from 'node:crypto';
import type { AgentRuntime, ExecResult } from '@felan-ai/agent-core';
import { isWindowsRuntimePath, joinRuntimePath } from './runtime-path.js';
import type { RuntimeStatus } from './types.js';

export const MANAGED_RTK_VERSION = '0.45.0';

const INSTALLER_COMMIT = 'b34be37caf3796b69a50952a28e60e32b5daad43';
const INSTALLER_SHA256 = 'd6eb73a772903e13ff34ee1be8a8b24e896ba9a978f20d2279a08b4083ea6f77';
const INSTALLER_URL = `https://raw.githubusercontent.com/rtk-ai/rtk/${INSTALLER_COMMIT}/install.sh`;
const MAX_INSTALLER_BYTES = 64 * 1024;
const DOWNLOAD_TIMEOUT_MS = 30_000;
const INSTALL_TIMEOUT_MS = 180_000;
const PROBE_TIMEOUT_MS = 5_000;

export function managedRtkDirectory(runtime: AgentRuntime): string {
  return joinRuntimePath(runtime.storage('agent').root, 'rtk-optimizer/bin');
}

export function managedRtkExecutable(runtime: AgentRuntime): string {
  return joinRuntimePath(
    managedRtkDirectory(runtime),
    isWindowsRuntimePath(runtime.storage('agent').root) ? 'rtk.exe' : 'rtk',
  );
}

export function supportsManagedRtk(runtime: AgentRuntime): boolean {
  return !isWindowsRuntimePath(runtime.storage('agent').root);
}

export async function installManagedRtk(
  runtime: AgentRuntime,
  onStatus: (message: string) => void = () => {},
): Promise<RuntimeStatus> {
  if (!supportsManagedRtk(runtime)) {
    return unavailable('The official RTK installer supports Linux and macOS only; install rtk.exe on PATH manually.');
  }

  const sessionStorage = runtime.storage('session');
  const relativeScriptPath = `rtk-optimizer/install-${randomUUID()}.sh`;
  const scriptPath = joinRuntimePath(sessionStorage.root, relativeScriptPath);
  await sessionStorage.mkdir('rtk-optimizer', { recursive: true });

  try {
    onStatus('Downloading the pinned official RTK installer...');
    const downloaded = await execute(runtime, 'curl', [
      '--proto',
      '=https',
      '--tlsv1.2',
      '--fail',
      '--silent',
      '--show-error',
      '--location',
      '--max-filesize',
      String(MAX_INSTALLER_BYTES),
      INSTALLER_URL,
      '--output',
      scriptPath,
    ], DOWNLOAD_TIMEOUT_MS);
    if (!successful(downloaded)) {
      return unavailable(`Failed to download the official RTK installer: ${resultDiagnostic(downloaded)}`);
    }

    const installer = await sessionStorage.readFile(relativeScriptPath);
    if (installer.byteLength > MAX_INSTALLER_BYTES) {
      return unavailable(`The RTK installer exceeded ${MAX_INSTALLER_BYTES} bytes; refusing to execute it.`);
    }
    const digest = createHash('sha256').update(installer).digest('hex');
    if (digest !== INSTALLER_SHA256) {
      return unavailable('The RTK installer did not match the reviewed SHA-256 digest; refusing to execute it.');
    }

    onStatus(`Installing RTK ${MANAGED_RTK_VERSION} in Felan agent storage...`);
    const installed = await execute(runtime, '/usr/bin/env', [
      `RTK_VERSION=v${MANAGED_RTK_VERSION}`,
      `RTK_INSTALL_DIR=${managedRtkDirectory(runtime)}`,
      '/bin/sh',
      scriptPath,
    ], INSTALL_TIMEOUT_MS);
    if (!successful(installed)) {
      return unavailable(`The official RTK installer failed: ${resultDiagnostic(installed)}`);
    }

    const verified = await execute(runtime, managedRtkExecutable(runtime), ['--version'], PROBE_TIMEOUT_MS);
    if (!successful(verified)) {
      return unavailable(`The managed RTK installation could not be verified: ${resultDiagnostic(verified)}`);
    }
    const version = parseVersion(`${verified.stdout}\n${verified.stderr}`);
    if (version !== MANAGED_RTK_VERSION) {
      return unavailable(`Managed RTK reported ${version ?? 'no version'} instead of ${MANAGED_RTK_VERSION}.`);
    }

    return {
      rtkAvailable: true,
      lastCheckedAt: Date.now(),
      command: managedRtkExecutable(runtime),
      source: 'managed',
      version: trimDiagnostic(verified.stdout || verified.stderr),
    };
  } catch (error) {
    return unavailable(`Managed RTK installation failed: ${trimDiagnostic(errorMessage(error))}`);
  } finally {
    await sessionStorage.remove(relativeScriptPath).catch(() => {});
  }
}

async function execute(
  runtime: AgentRuntime,
  command: string,
  args: readonly string[],
  timeout: number,
): Promise<ExecResult | Error> {
  try {
    return await runtime.exec(command, args, { cwd: runtime.cwd, timeout });
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}

function successful(result: ExecResult | Error): result is ExecResult {
  return !(result instanceof Error) && !result.killed && result.code === 0;
}

function unavailable(reason: string): RuntimeStatus {
  return { rtkAvailable: false, lastCheckedAt: Date.now(), lastError: reason };
}

function resultDiagnostic(result: ExecResult | Error): string {
  if (result instanceof Error) return trimDiagnostic(result.message);
  if (result.killed) return 'command timed out or was terminated';
  return trimDiagnostic(result.stderr || result.stdout || `command exited with code ${result.code}`);
}

function parseVersion(output: string): string | undefined {
  return output.match(/(?:^|\s)v?(\d+\.\d+\.\d+)(?=\s|$)/u)?.[1];
}

function trimDiagnostic(value: string): string {
  const clean = value
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, '')
    .replace(/[\u0000-\u001f\u007f]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  return clean.slice(0, 500) || 'no diagnostic output';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
