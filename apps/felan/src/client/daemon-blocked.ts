import type { HostBlocked } from '@felan-ai/session-protocol';

export interface DaemonRecovery { client: 'cli' | 'tui'; action?: 'stop' | 'restart'; daemonRuntime?: string }

export function daemonRecoveryHint(blocked: HostBlocked | undefined, recovery: DaemonRecovery): string {
  if (blocked?.recoverable === false) return `Cleanup cannot be retried safely; ${forceTermination(blocked.pid)}, then start Felan again.`;
  const action = recovery.action ?? 'restart';
  const runtime = recovery.daemonRuntime;
  const target = runtime ? ` --daemon-runtime ${/^[\w\-./~:@]+$/u.test(runtime) ? runtime : `'${runtime.replaceAll("'", "'\\''")}'`}` : '';
  return `Use ${recovery.client === 'cli' ? `felan daemon ${action} --force${target}` : `/daemon ${action} force`} to retry cleanup.`;
}

/** A blocked daemon answers SIGTERM with a drain request, which it refuses, so only a forced termination ends it. */
function forceTermination(pid: number | undefined): string {
  if (pid === undefined) return 'force-terminate the daemon process';
  return `force-terminate the daemon process (pid ${pid}) with \`${process.platform === 'win32' ? `taskkill /F /PID ${pid}` : `kill -9 ${pid}`}\``;
}

/** The structured detail when the daemon sent it; otherwise its own message, which already carries a recovery instruction. */
export function hostBlockedRejection(message: string, blocked: HostBlocked | undefined, recovery: DaemonRecovery): string {
  return blocked ? formatHostBlocked(blocked, recovery) : message;
}

export function describeHostBlocked(blocked?: HostBlocked): string {
  if (!blocked) return 'Daemon is blocked after an incomplete shutdown.';
  return `Daemon shutdown failed${blocked.step ? ` at ${blocked.step}` : ''}${blocked.session ? ` (session ${blocked.session.slice(0, 8)})` : ''}: ${blocked.message}${/[.!?]$/u.test(blocked.message) ? '' : '.'}`;
}

export function formatHostBlocked(blocked: HostBlocked | undefined, recovery: DaemonRecovery): string {
  return `${describeHostBlocked(blocked)} ${daemonRecoveryHint(blocked, recovery)}`;
}
