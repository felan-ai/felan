import { afterEach, expect, it } from 'vitest';
import { RemoteOutbox } from '../src/remote/outbox.js';
import type { PersistenceBoundary } from '../src/daemon/persistence.js';
import { closeRemoteDatabases, openRemoteDatabase } from './remote-database.js';

afterEach(closeRemoteDatabases);
it.each<PersistenceBoundary>(['before_commit', 'after_commit'])('initializes the entire backfill atomically across a failure at %s', async boundary => {
  const fixture = await openRemoteDatabase(point => { if (point === boundary) throw new Error('crash'); });
  const session = '019a0000-0000-7000-8000-000000000001';
  const entries = [1, 2, 3].map(rev => ({ rev, occurredAt: rev, change: { type: 'metadata.updated' as const, title: String(rev), state: 'open' as const, residency: 'warm' as const } }));
  const box = new RemoteOutbox(fixture.database);
  expect(() => box.initialize(session, entries)).toThrow();
  const recovered = new RemoteOutbox(fixture.reopen()); recovered.initialize(session, entries);
  expect(recovered.pending(session).map(row => row.seq)).toEqual([1, 2, 3]);
  recovered.initialize(session, entries); expect(recovered.pending(session)).toHaveLength(3);
  recovered.acknowledge(session, 3); expect(recovered.nextSeq(session)).toBe(4);
});
