import type { AgentRuntime, ExecResult } from '@felan-ai/agent-core';
import { isWindowsRuntimePath, joinRuntimePath } from './runtime-path.js';

export const MARKITDOWN_VERSION = '0.1.7';

const MARKITDOWN_REQUIREMENT = `markitdown[docx,pptx,xlsx,xls,outlook]==${MARKITDOWN_VERSION}`;
const PYTHON_PROBE_TIMEOUT_MS = 10_000;
const MARKITDOWN_PROBE_TIMEOUT_MS = 60_000;
const VENV_TIMEOUT_MS = 60_000;
const INSTALL_TIMEOUT_MS = 180_000;

export interface MarkitdownInvocation {
  readonly command: string;
  readonly args: readonly string[];
  readonly source: 'managed' | 'path';
  readonly version: string;
}

export type MarkitdownDetection = {
  readonly available: true;
  readonly invocation: MarkitdownInvocation;
} | {
  readonly available: false;
  readonly reason: string;
};

export async function detectMarkitdown(runtime: AgentRuntime): Promise<MarkitdownDetection> {
  const managed = managedInvocation(runtime);
  const managedProbe = await probe(runtime, managed.command, managed.args, 'managed MarkItDown');
  if (managedProbe.available) {
    return {
      available: true,
      invocation: { ...managed, version: managedProbe.version },
    };
  }

  const pathProbe = await probe(runtime, 'markitdown', [], 'MarkItDown from PATH');
  if (pathProbe.available) {
    return {
      available: true,
      invocation: {
        command: 'markitdown',
        args: [],
        source: 'path',
        version: pathProbe.version,
      },
    };
  }

  return {
    available: false,
    reason: `Reviewed MarkItDown ${MARKITDOWN_VERSION} is unavailable. Run /markitdown install or install that exact version on PATH.`,
  };
}

export async function installManagedMarkitdown(
  runtime: AgentRuntime,
  onStatus: (message: string) => void,
): Promise<MarkitdownDetection> {
  const storage = runtime.storage('agent');
  await storage.mkdir('markitdown', { recursive: true });

  const managed = managedInvocation(runtime);
  let python = managed.command;
  const managedPython = await execute(runtime, python, ['--version'], PYTHON_PROBE_TIMEOUT_MS);
  if (!successful(managedPython)) {
    onStatus('Finding Python 3.10 or newer...');
    const systemPython = await findPython(runtime);
    if (!systemPython) {
      return {
        available: false,
        reason: 'Python 3.10 or newer was not found on PATH; MarkItDown was not installed.',
      };
    }

    onStatus('Creating the managed MarkItDown environment...');
    const created = await execute(runtime, systemPython, ['-m', 'venv', managedVenvDirectory(runtime)], VENV_TIMEOUT_MS);
    if (!successful(created)) {
      return {
        available: false,
        reason: `Failed to create the managed MarkItDown environment: ${resultDiagnostic(created)}`,
      };
    }
    python = managed.command;
  }

  onStatus(`Installing MarkItDown ${MARKITDOWN_VERSION} document support...`);
  const installed = await execute(runtime, python, [
    '-m',
    'pip',
    'install',
    '--disable-pip-version-check',
    '--no-input',
    '--quiet',
    MARKITDOWN_REQUIREMENT,
  ], INSTALL_TIMEOUT_MS);
  if (!successful(installed)) {
    return {
      available: false,
      reason: `Failed to install MarkItDown ${MARKITDOWN_VERSION}: ${resultDiagnostic(installed)}`,
    };
  }

  onStatus('Verifying the managed MarkItDown environment...');
  const verified = await probe(runtime, managed.command, managed.args, 'managed MarkItDown');
  if (!verified.available) {
    return {
      available: false,
      reason: `MarkItDown installation could not be verified: ${verified.reason}`,
    };
  }
  return {
    available: true,
    invocation: { ...managed, version: verified.version },
  };
}

export function managedVenvDirectory(runtime: AgentRuntime): string {
  return joinRuntimePath(runtime.storage('agent').root, 'markitdown/venv');
}

function managedInvocation(runtime: AgentRuntime): Omit<MarkitdownInvocation, 'version'> {
  const windowsRuntime = isWindowsRuntimePath(runtime.storage('agent').root);
  const executable = windowsRuntime ? 'python.exe' : 'python';
  const directory = windowsRuntime ? 'Scripts' : 'bin';
  return {
    command: joinRuntimePath(managedVenvDirectory(runtime), directory, executable),
    args: ['-m', 'markitdown'],
    source: 'managed',
  };
}

async function findPython(runtime: AgentRuntime): Promise<string | undefined> {
  for (const command of ['python3', 'python']) {
    const result = await execute(runtime, command, ['--version'], PYTHON_PROBE_TIMEOUT_MS);
    if (!successful(result)) continue;
    const version = parseVersion(`${result.stdout}\n${result.stderr}`);
    if (version && isAtLeast(version, '3.10.0')) return command;
  }
  return undefined;
}

async function probe(
  runtime: AgentRuntime,
  command: string,
  prefix: readonly string[],
  label: string,
): Promise<{ available: true; version: string } | { available: false; reason: string }> {
  const result = await execute(runtime, command, [...prefix, '--version'], MARKITDOWN_PROBE_TIMEOUT_MS);
  if (!successful(result)) {
    return { available: false, reason: `${label} did not run successfully: ${resultDiagnostic(result)}` };
  }
  const version = parseVersion(`${result.stdout}\n${result.stderr}`);
  if (!version) return { available: false, reason: `${label} did not report a semantic version` };
  if (version !== MARKITDOWN_VERSION) {
    return {
      available: false,
      reason: `${label} ${version} does not match reviewed version ${MARKITDOWN_VERSION}`,
    };
  }
  return { available: true, version };
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

function resultDiagnostic(result: ExecResult | Error): string {
  if (result instanceof Error) return sanitizeDiagnostic(result.message);
  if (result.killed) return 'command timed out or was terminated';
  return sanitizeDiagnostic(result.stderr || result.stdout || `command exited with code ${result.code}`);
}

function parseVersion(output: string): string | undefined {
  return output.match(/(?:^|\s)v?(\d+\.\d+\.\d+)(?=\s|$)/u)?.[1];
}

function isAtLeast(actual: string, minimum: string): boolean {
  const left = actual.split('.').map(Number);
  const right = minimum.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  return true;
}

function sanitizeDiagnostic(value: string): string {
  const normalized = value
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  return normalized.slice(0, 500) || 'no diagnostic output';
}
