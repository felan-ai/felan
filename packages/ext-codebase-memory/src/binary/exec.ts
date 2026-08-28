import type { AgentRuntime, ExecResult } from '@felan-ai/agent-core';
import { MAX_OUTPUT_BYTES } from '../cbm/timeouts.js';
import { joinRuntimePath } from '../runtime-path.js';

export async function execCbm(
  runtime: AgentRuntime,
  binary: string,
  toolName: string,
  args: Readonly<Record<string, unknown>>,
  options: { readonly timeoutMs: number; readonly signal?: AbortSignal },
): Promise<ExecResult> {
  return runtime.exec(binary, ['cli', '--json', toolName, JSON.stringify(args)], {
    cwd: runtime.cwd,
    timeout: options.timeoutMs,
    maxOutputBytes: MAX_OUTPUT_BYTES,
    env: {
      CBM_SQLITE_MMAP_SIZE: '0',
      HOME: joinRuntimePath(runtime.storage('agent').root, 'codebase-memory/home'),
      XDG_CACHE_HOME: joinRuntimePath(runtime.storage('agent').root, 'codebase-memory/cache'),
    },
    ...(options.signal ? { signal: options.signal } : {}),
  });
}
