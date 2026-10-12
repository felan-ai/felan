import { setTimeout as delay } from 'node:timers/promises';
import { connectLocalIpc } from '@felan-ai/daemon/internal/daemon/ipc';
import type { SessionClient } from './client.js';

export async function waitForDaemonStop(client: SessionClient, signal?: AbortSignal): Promise<void> {
  const deadline = performance.now() + 35_000;
  while (performance.now() < deadline) {
    signal?.throwIfAborted();
    try {
      const status = await client.control('host.status');
      if (status.state === 'blocked') throw new Error('Daemon shutdown is blocked; inspect status. Force requires a new explicit command.');
      if (status.state === 'stopped') return;
    } catch (error) {
      try { const socket = await connectLocalIpc(client.target); socket.destroy(); }
      catch (probe) { if (['ENOENT', 'stale_endpoint', 'unavailable'].includes((probe as { code?: string }).code ?? '')) return; throw probe; }
      if (error instanceof Error && error.message.startsWith('Daemon shutdown is blocked')) throw error;
    }
    await delay(25, undefined, signal ? { signal } : undefined);
  }
  throw new Error('Daemon shutdown did not finish before the deadline; inspect status.');
}
