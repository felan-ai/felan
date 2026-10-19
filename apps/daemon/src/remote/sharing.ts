import type { RemoteSessionRecord, RemoteSettings } from './state.js';

export interface SharingInput {
  configured: boolean;
  share: RemoteSettings['share'];
  record?: RemoteSessionRecord;
  rootRecord?: RemoteSessionRecord;
}
export interface SharingTransition { record: RemoteSessionRecord; changed: boolean; needsBackfill: boolean }

export function sessionShared({ configured, share, record, rootRecord }: SharingInput): boolean {
  if (!configured || record?.terminal || rootRecord?.terminal) return false;
  const effective = rootRecord ?? record;
  if (effective?.origin === 'web') return true;
  return effective?.explicit === false ? share === 'all' : effective?.shared ?? share === 'all';
}

export function webCreatedSession(): RemoteSessionRecord {
  return { shared: true, origin: 'web', backfilled: false, unsharedPending: false };
}

export function setSessionSharing(input: SharingInput, enabled: boolean): SharingTransition {
  const previous = input.rootRecord ?? input.record;
  if (previous?.terminal || input.record?.terminal) throw new Error('Terminal remote sessions cannot change sharing.');
  if (!enabled && previous?.origin === 'web') throw new Error('Web-created sessions are always shared.');
  const record: RemoteSessionRecord = previous ? { ...previous } : { shared: input.share === 'all', origin: 'local', backfilled: false, unsharedPending: false };
  record.shared = enabled; record.explicit = true;
  record.unsharedPending = enabled ? false : (previous?.unsharedPending === true || (previous?.shared === true && previous.backfilled) || sessionShared(input));
  return { record, changed: JSON.stringify(previous) !== JSON.stringify(record), needsBackfill: enabled && !record.backfilled };
}
