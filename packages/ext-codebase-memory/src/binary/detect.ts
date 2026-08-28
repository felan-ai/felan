import type { AgentRuntime, ExecResult } from '@felan-ai/agent-core';
import { managedCbmExecutable } from '../installer.js';
import { joinRuntimePath } from '../runtime-path.js';

export type CbmBinaryStatus =
  | { readonly available: true; readonly command: string; readonly source: 'managed' | 'path' | 'local'; readonly version: string }
  | { readonly available: false; readonly reason: string };

const PROBE_TIMEOUT_MS = 5_000;

export async function detectCbmBinary(runtime: AgentRuntime): Promise<CbmBinaryStatus> {
  const candidates: Array<{ command: string; source: 'managed' | 'path' | 'local' }> = [
    { command: managedCbmExecutable(runtime), source: 'managed' },
    { command: 'codebase-memory-mcp', source: 'path' },
  ];
  const home = await runtime.exec('/bin/sh', ['-c', 'printf %s "$HOME"'], {
    cwd: runtime.cwd,
    timeout: PROBE_TIMEOUT_MS,
    maxOutputBytes: 4_096,
  }).catch(() => undefined);
  if (successful(home) && home.stdout.trim()) {
    candidates.push({ command: joinRuntimePath(home.stdout.trim(), '.local/bin/codebase-memory-mcp'), source: 'local' });
  }

  for (const candidate of candidates) {
    const result = await runtime.exec(candidate.command, ['--version'], {
      cwd: runtime.cwd,
      timeout: PROBE_TIMEOUT_MS,
      maxOutputBytes: 4_096,
    }).catch(() => undefined);
    if (!successful(result)) continue;
    const version = `${result.stdout}\n${result.stderr}`.match(/\b(\d+\.\d+\.\d+)\b/u)?.[1];
    if (version) return { available: true, ...candidate, version };
  }
  return { available: false, reason: 'codebase-memory-mcp was not found in managed storage, PATH, or ~/.local/bin' };
}

function successful(result: ExecResult | undefined): result is ExecResult {
  return result !== undefined && result.code === 0 && !result.killed;
}
