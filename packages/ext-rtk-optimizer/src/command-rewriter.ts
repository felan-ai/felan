import type { AgentRuntime } from '@felan-ai/agent-core';
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

  if (isAlreadyRtk(command)) {
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
  try {
    const result = await runtime.exec('rtk', ['rewrite', command], {
      timeout: options.timeoutMs ?? 3_000,
    });
    const rewritten = result.stdout.trim();

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
      if (!rewritten) {
        return {
          changed: false,
          rewrittenCommand: command,
          exitCode: result.code,
          error: 'rtk returned empty output',
        };
      }
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
  try {
    const result = await runtime.exec('rtk', ['--version'], { timeout: 5_000 });
    if (result.code === 0) {
      return {
        rtkAvailable: true,
        lastCheckedAt: Date.now(),
        ...(result.stdout.trim() ? { version: trimMessage(result.stdout) } : {}),
      };
    }
    const detail = trimMessage(`${result.stderr} ${result.stdout}`);
    return {
      rtkAvailable: false,
      lastCheckedAt: Date.now(),
      lastError: detail || `exit ${result.code}`,
    };
  } catch (error) {
    return {
      rtkAvailable: false,
      lastCheckedAt: Date.now(),
      lastError: trimMessage(errorMessage(error)),
    };
  }
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
