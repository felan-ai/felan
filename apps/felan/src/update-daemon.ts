import type { DaemonTarget } from '@felan-ai/daemon/client';
import { DAEMON_VERSION } from '@felan-ai/daemon/version';
import { SessionClient, type SessionClientOptions } from './client/client.js';
import { waitForDaemonStop } from './client/daemon-stop.js';
import { clientDaemonTarget } from './client-application.js';
import { FELAN_VERSION } from './version.js';

export type DaemonUpdatePreparation =
  | { kind: 'absent' }
  | { kind: 'stopped'; daemonVersion: string }
  | { kind: 'busy'; daemonVersion: string; work: number; runs: number; attachments: number }
  | { kind: 'unavailable'; message: string };

export async function prepareDaemonForUpdate(dependencies: {
  createClient?: (options: SessionClientOptions) => SessionClient;
  target?: DaemonTarget;
  signal?: AbortSignal;
  onStopping?: () => void;
} = {}): Promise<DaemonUpdatePreparation> {
  let client: SessionClient | undefined;
  try {
    dependencies.signal?.throwIfAborted();
    client = (dependencies.createClient ?? (options => new SessionClient(options)))({
      target: dependencies.target ?? clientDaemonTarget({}), clientVersion: FELAN_VERSION,
      expectedDaemonVersion: DAEMON_VERSION, kind: 'tui', reconnectAttempts: 0,
    });
    try { await client.connect(); }
    catch (error) {
      if (['ENOENT', 'stale_endpoint', 'unavailable'].includes((error as { code?: string } | null)?.code ?? '')) return { kind: 'absent' };
      throw error;
    }
    if (client.status !== 'ready') throw new Error('Daemon connection is incompatible or blocked.');
    const readStatus = async () => {
      const response = await client!.request('host.status', {});
      if (response.outcome !== 'accepted') throw new Error(response.error.message);
      if (response.result.state === 'blocked') throw new Error(response.result.blocked?.message ?? 'Daemon is blocked.');
      return response.result;
    };
    const busy = (status: Awaited<ReturnType<typeof readStatus>>): DaemonUpdatePreparation => ({
      kind: 'busy', daemonVersion: status.daemonVersion,
      work: status.active.work, runs: status.active.runs, attachments: status.active.attachments,
    });
    const activityAfterFailedStop = async (message: string): Promise<DaemonUpdatePreparation> => {
      const status = await readStatus();
      if (status.active.work === 0 && status.active.runs === 0 && status.active.attachments === 0) throw new Error(message);
      return busy(status);
    };
    const status = await readStatus();
    if (status.state !== 'ready' || status.active.work !== 0 || status.active.runs !== 0 || status.active.attachments !== 0) return busy(status);
    dependencies.signal?.throwIfAborted();
    dependencies.onStopping?.();
    const response = await client.control('host.stop', 'drain');
    if (response.state === 'blocked' || response.error?.code === 'host_blocked') {
      throw new Error(response.blocked?.message ?? response.error?.message ?? 'Daemon is blocked.');
    }
    if (response.outcome !== 'accepted') return await activityAfterFailedStop('The background daemon did not accept a stop request.');
    try { await waitForDaemonStop(client, dependencies.signal); }
    catch (error) {
      if (error instanceof Error && error.message.includes('the daemon kept running because work is still active')) {
        return await activityAfterFailedStop('The background daemon abandoned the stop request.');
      }
      throw error;
    }
    return { kind: 'stopped', daemonVersion: status.daemonVersion };
  } catch (error) {
    return { kind: 'unavailable', message: `${error instanceof Error ? error.message : 'Daemon status is unavailable.'} Run felan daemon restart after updating.` };
  } finally { client?.close(); }
}
