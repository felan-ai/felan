import type { AgentRuntime } from '@felan-ai/agent-core';
import { managedRtkExecutable, supportsManagedRtk } from './installer.js';
import type { RuntimeStatus } from './types.js';

export interface RewriteDecision {
  readonly changed: boolean;
  readonly originalCommand: string;
  readonly rewrittenCommand: string;
  readonly reason: 'ok' | 'empty' | 'already_rtk' | 'no_match';
  readonly warning?: string;
}

export interface ResolveRtkRewriteOptions {
  readonly timeoutMs?: number;
  readonly executable?: string;
}

export interface RtkRewriteResult {
  readonly changed: boolean;
  readonly rewrittenCommand: string;
  readonly exitCode: number;
  readonly error?: string;
}

export async function computeRewriteDecision(
  runtime: AgentRuntime,
  command: string,
  options?: ResolveRtkRewriteOptions,
): Promise<RewriteDecision> {
  if (!command.trim()) {
    return {
      changed: false,
      originalCommand: command,
      rewrittenCommand: command,
      reason: 'empty',
    };
  }

  if (isAlreadyManagedRtk(command, options?.executable)) {
    return {
      changed: false,
      originalCommand: command,
      rewrittenCommand: command,
      reason: 'already_rtk',
    };
  }

  if (isAlreadyRtk(command)) {
    const executable = options?.executable;
    if (executable && executable !== 'rtk') {
      return {
        changed: true,
        originalCommand: command,
        rewrittenCommand: qualifyManagedRewrite(command, executable),
        reason: 'ok',
      };
    }
    return {
      changed: false,
      originalCommand: command,
      rewrittenCommand: command,
      reason: 'already_rtk',
    };
  }

  const result = await resolveRtkRewrite(runtime, command, options);
  if (result.changed) {
    return {
      changed: true,
      originalCommand: command,
      rewrittenCommand: result.rewrittenCommand,
      reason: 'ok',
    };
  }

  return {
    changed: false,
    originalCommand: command,
    rewrittenCommand: command,
    reason: 'no_match',
    ...(result.error === undefined ? {} : { warning: result.error }),
  };
}

export async function resolveRtkRewrite(
  runtime: AgentRuntime,
  command: string,
  options: ResolveRtkRewriteOptions = {},
): Promise<RtkRewriteResult> {
  const executable = options.executable ?? 'rtk';
  try {
    const result = await runtime.exec(executable, ['rewrite', command], {
      timeout: options.timeoutMs ?? 3_000,
    });
    const rawRewritten = result.stdout.trim();

    if (result.code === 1) {
      return { changed: false, rewrittenCommand: command, exitCode: result.code };
    }
    if (result.code === 2) {
      return {
        changed: false,
        rewrittenCommand: command,
        exitCode: result.code,
        error: result.stderr.trim() || 'rtk denied rewrite',
      };
    }
    if (result.code === 0 || result.code === 3) {
      if (!rawRewritten) {
        return {
          changed: false,
          rewrittenCommand: command,
          exitCode: result.code,
          error: 'rtk returned empty output',
        };
      }
      const rewritten = rawRewritten === command
        ? rawRewritten
        : qualifyManagedRewrite(rawRewritten, executable);
      return {
        changed: rewritten !== command,
        rewrittenCommand: rewritten,
        exitCode: result.code,
      };
    }

    return {
      changed: false,
      rewrittenCommand: command,
      exitCode: result.code,
      error: `unexpected exit code ${result.code}`,
    };
  } catch (error) {
    return {
      changed: false,
      rewrittenCommand: command,
      exitCode: -1,
      error: errorMessage(error),
    };
  }
}

export async function inspectRtkRuntime(runtime: AgentRuntime): Promise<RuntimeStatus> {
  const failures: string[] = [];
  const candidates = [
    ...(supportsManagedRtk(runtime)
      ? [{ command: managedRtkExecutable(runtime), source: 'managed' as const }]
      : []),
    { command: 'rtk', source: 'path' as const },
  ];

  for (const candidate of candidates) {
    try {
      const result = await runtime.exec(candidate.command, ['--version'], { timeout: 5_000 });
      if (result.code === 0 && !result.killed) {
        return {
          rtkAvailable: true,
          lastCheckedAt: Date.now(),
          command: candidate.command,
          source: candidate.source,
          ...(result.stdout.trim() ? { version: trimMessage(result.stdout) } : {}),
        };
      }
      const detail = result.killed
        ? 'timed out or was terminated'
        : trimMessage(`${result.stderr} ${result.stdout}`) || `exit ${result.code}`;
      failures.push(`${candidate.source}: ${detail}`);
    } catch (error) {
      failures.push(`${candidate.source}: ${trimMessage(errorMessage(error))}`);
    }
  }

  return {
    rtkAvailable: false,
    lastCheckedAt: Date.now(),
    lastError: trimMessage(failures.join('; ')),
  };
}

export function isAlreadyRtk(command: string): boolean {
  const effectiveCommand = splitLeadingEnvAssignments(command.trimStart()).command.trimStart();
  return effectiveCommand === 'rtk' || effectiveCommand.startsWith('rtk ');
}

export function splitLeadingEnvAssignments(input: string): {
  readonly envPrefix: string;
  readonly command: string;
} {
  const singleQuoted = "'(?:'\\\\''|[^'])*'";
  const value = `(?:"[^"]*"|${singleQuoted}|[^\\s]+)`;
  const prefixPattern = new RegExp(`^((?:[A-Za-z_][A-Za-z0-9_]*=${value}\\s+)*)`);
  const envPrefix = input.match(prefixPattern)?.[1] ?? '';
  return { envPrefix, command: input.slice(envPrefix.length) };
}

function trimMessage(value: string, maxLength = 220): string {
  const clean = value.replace(/\s+/g, ' ').trim();
  return clean.length <= maxLength ? clean : `${clean.slice(0, maxLength - 1)}…`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function qualifyManagedRewrite(rewritten: string, executable: string): string {
  if (executable === 'rtk' || !rewritten) return rewritten;
  return `${managedPathPrefix(executable)}${rewritten}\n\n)`;
}

function isAlreadyManagedRtk(command: string, executable: string | undefined): boolean {
  if (!executable || executable === 'rtk') return false;
  const effectiveCommand = splitLeadingEnvAssignments(command.trimStart()).command.trimStart();
  return effectiveCommand.startsWith(managedPathPrefix(executable));
}

function managedPathPrefix(executable: string): string {
  const separator = executable.lastIndexOf('/');
  const directory = separator < 0 ? '.' : executable.slice(0, separator);
  return `(PATH=${quotePosixShellArgument(directory)}:"$PATH"; export PATH; `;
}

function quotePosixShellArgument(value: string): string {
  return `'${value.replace(/'/gu, `'\\''`)}'`;
}
