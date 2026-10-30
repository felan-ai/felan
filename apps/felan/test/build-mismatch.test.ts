import { expect, it, vi } from 'vitest';
import type { SessionClient } from '../src/client/client.js';
import { formatDaemonBuildMismatch, watchDaemonBuildMismatch } from '../src/client/build-mismatch.js';

it('distinguishes daemon versions from equal-version composition changes', () => {
  expect(formatDaemonBuildMismatch({ daemonVersion: '0.4.2', expectedDaemonVersion: '0.4.3' }, 'Run /restart.'))
    .toBe('Daemon 0.4.2 is running; this installation expects 0.4.3. Run /restart.');
  expect(formatDaemonBuildMismatch({ daemonVersion: '0.4.3', expectedDaemonVersion: '0.4.3' }, 'Run /restart.'))
    .toBe('Daemon 0.4.3 is running a different package/provider build from this installation. Run /restart.');
});

it('reports a mismatch once per identity and build state, not per event, retry or work count', () => {
  const listeners = new Set<() => void>();
  const client: Pick<SessionClient, 'status' | 'identity' | 'buildMismatch' | 'subscribe'> = {
    status: 'ready', identity: { namespaceId: 'fixture', instanceId: 'first', agentDir: '/fixture', rootSet: ['/fixture'] },
    buildMismatch: { daemonVersion: 'previous', expectedDaemonVersion: 'current', activeWork: 1 },
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
  const emit = () => { for (const listener of listeners) listener(); };
  const warn = vi.fn(); const stop = watchDaemonBuildMismatch(client, 'Run /restart.', warn);
  emit();
  Object.assign(client, { buildMismatch: { ...client.buildMismatch, activeWork: 0 } }); emit();
  Object.assign(client, { status: 'connecting', buildMismatch: undefined }); emit();
  Object.assign(client, { status: 'ready', buildMismatch: { daemonVersion: 'previous', expectedDaemonVersion: 'current' } }); emit();
  expect(warn).toHaveBeenCalledTimes(1);
  Object.assign(client, { identity: { ...client.identity, instanceId: 'second' } }); emit();
  expect(warn).toHaveBeenCalledTimes(2);
  Object.assign(client, { buildMismatch: { daemonVersion: 'next', expectedDaemonVersion: 'current' } }); emit();
  expect(warn).toHaveBeenCalledTimes(3);
  Object.assign(client, { buildMismatch: undefined }); emit();
  Object.assign(client, { buildMismatch: { daemonVersion: 'next', expectedDaemonVersion: 'current' } }); emit();
  expect(warn).toHaveBeenCalledTimes(4);
  stop(); expect(listeners.size).toBe(0);
  emit(); expect(warn).toHaveBeenCalledTimes(4);
});
