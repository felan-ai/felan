import { setTimeout as delay } from 'node:timers/promises';
import { connectLocalIpc } from '@felan-ai/daemon/client';
import type { SessionClient } from './client.js';
import { formatHostBlocked, type DaemonRecovery } from './daemon-blocked.js';

/** Covers the daemon's settlement deadline plus release. */
const STOP_DEADLINE_MS = 65_000;

/** Waits after an accepted stop or restart; a daemon back in `ready` abandoned a drain because work is still active. */
export async function waitForDaemonStop(client: SessionClient, signal?: AbortSignal, recovery: DaemonRecovery = { client: 'cli' }): Promise<void> {
  const deadline = performance.now() + STOP_DEADLINE_MS;
  while (performance.now() < deadline) {
    signal?.throwIfAborted();
    let status: Awaited<ReturnType<SessionClient['control']>> | undefined;
    try { status = await client.control('host.status'); }
    catch {
      try { const socket = await connectLocalIpc(client.target); socket.destroy(); }
      catch (probe) { if (['ENOENT', 'stale_endpoint', 'unavailable'].includes((probe as { code?: string }).code ?? '')) return; throw probe; }
    }
    if (status?.state === 'blocked') throw new Error(formatHostBlocked(status.blocked, recovery));
    if (status?.state === 'ready') throw new Error('Daemon shutdown failed: the daemon kept running because work is still active. Use force to interrupt it.');
    if (status?.state === 'stopped') return;
    await delay(25, undefined, signal ? { signal } : undefined);
  }
  throw new Error('Daemon shutdown did not finish before the deadline; inspect status.');
}
