import type { DaemonBuildMismatch, SessionClient } from './client.js';

export function formatDaemonBuildMismatch(mismatch: DaemonBuildMismatch, recovery: string): string {
  const difference = mismatch.expectedDaemonVersion && mismatch.daemonVersion !== mismatch.expectedDaemonVersion
    ? `Daemon ${mismatch.daemonVersion} is running; this installation expects ${mismatch.expectedDaemonVersion}.`
    : `Daemon ${mismatch.daemonVersion} is running a different package/provider build from this installation.`;
  return `${difference} ${recovery}`;
}

export function watchDaemonBuildMismatch(client: Pick<SessionClient, 'status' | 'identity' | 'buildMismatch' | 'subscribe'>,
  recovery: string, warn: (message: string) => void): () => void {
  let previous: string | undefined;
  const check = () => {
    if (client.status !== 'ready') return;
    const mismatch = client.buildMismatch;
    if (!mismatch) { previous = undefined; return; }
    const key = JSON.stringify([client.identity, mismatch.daemonVersion, mismatch.expectedDaemonVersion,
      mismatch.composition, mismatch.expectedComposition]);
    if (key === previous) return;
    previous = key;
    warn(formatDaemonBuildMismatch(mismatch, recovery));
  };
  const unsubscribe = client.subscribe(check);
  check();
  return unsubscribe;
}
