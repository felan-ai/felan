import type { AgentRuntime } from '@felan-ai/agent-core';

const REQUIRED_POSIX_COMMANDS = ['sh', 'nohup', 'ps', 'tr', 'kill', 'date', 'cat', 'mv'] as const;
const PROBE_TIMEOUT_MS = 5_000;

export type BackgroundBashRuntimeStatus = {
  readonly available: true;
} | {
  readonly available: false;
  readonly reason: string;
};

export async function inspectBackgroundBashRuntime(
  runtime: AgentRuntime,
): Promise<BackgroundBashRuntimeStatus> {
  const script = [
    'missing=',
    `for name in ${REQUIRED_POSIX_COMMANDS.join(' ')}; do`,
    '  command -v "$name" >/dev/null 2>&1 || missing="$missing $name"',
    'done',
    'if [ -n "$missing" ]; then',
    '  printf "missing required commands:%s\\n" "$missing" >&2',
    '  exit 1',
    'fi',
  ].join('\n');

  try {
    const result = await runtime.shell(script, {
      cwd: runtime.cwd,
      timeout: PROBE_TIMEOUT_MS,
    });
    if (!result.killed && result.code === 0) return { available: true };
    const reason = result.killed
      ? 'POSIX runtime probe timed out or was terminated'
      : sanitize(result.stderr || result.stdout || `POSIX runtime probe exited with code ${result.code}`);
    return { available: false, reason };
  } catch (error) {
    return {
      available: false,
      reason: sanitize(error instanceof Error ? error.message : String(error)),
    };
  }
}

function sanitize(value: string): string {
  return value
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, '')
    .replace(/[\u0000-\u001f\u007f]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 500) || 'POSIX runtime probe failed';
}
