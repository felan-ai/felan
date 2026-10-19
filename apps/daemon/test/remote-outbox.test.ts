import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PUBLICATION_LIMITS } from '@felan-ai/session-protocol';
import { REMOTE_OUTBOX_PENDING_BYTES_LIMIT, REMOTE_OUTBOX_TOTAL_PENDING_BYTES_LIMIT, RemoteOutbox, RemoteOutboxCapacityError, type OutboxItem } from '../src/remote/outbox.js';
import { RemoteIntegrityError, RemoteStorageError } from '../src/remote/state.js';
import type { PersistenceBoundary, RemoteDatabase } from '../src/daemon/persistence.js';
import { closeRemoteDatabases, openRemoteDatabase } from './remote-database.js';

type CapacityCheck = { checkCapacity(session: string, previous: number, bytes: number): void };
const item = (rev: number): OutboxItem => ({ rev, occurredAt: 123, change: { type: 'run.updated', run: { state: 'idle' } } });
const message = (text: string): OutboxItem => ({ rev: 1, occurredAt: 1, change: { type: 'message.completed', message: {
  id: 'm', entryId: 'e', role: 'assistant', timestamp: 1, content: [{ type: 'text', text }],
} } });
const large = message('x'.repeat(1_000_000));
const outboxBytes = (database: RemoteDatabase, session: string) => database.outbox(session).reduce((sum, row) => sum + row.bytes, 0);
afterEach(async () => { vi.restoreAllMocks(); await closeRemoteDatabases(); });

describe('durable remote outbox', () => {
  it('group-commits buffered appends once and reads warm cursors without table scans', async () => {
    const { database } = await openRemoteDatabase(); const box = new RemoteOutbox(database); const id = randomUUID(); box.nextSeq(id);
    const record = vi.spyOn(database, 'record'); const records = vi.spyOn(database, 'records'); const rows = vi.spyOn(database, 'outbox');
    const transaction = vi.spyOn(database, 'transaction'); const insert = vi.spyOn(database, 'insertOutbox');
    for (let index = 0; index < 1000; index++) box.append(id, [item(index + 1)]);
    expect(insert).not.toHaveBeenCalled(); expect(transaction).not.toHaveBeenCalled();
    expect(box.pendingCount()).toBe(1000); expect(box.nextSeq(id)).toBe(1001);
    const listings = records.mock.calls.length;
    for (let index = 0; index < 10; index++) { expect(box.pendingCount()).toBe(1000); expect(box.sessions()).toEqual([id]); }
    expect(record).not.toHaveBeenCalled(); expect(rows).not.toHaveBeenCalled(); expect(records).toHaveBeenCalledTimes(listings);
    box.flush(); expect(transaction).toHaveBeenCalledTimes(1); expect(insert).toHaveBeenCalledTimes(1000);
    box.flush(); expect(transaction).toHaveBeenCalledTimes(1);
  });
  it('flushes once per session in the next immediate and flushes pending pages synchronously', async () => {
    const fixture = await openRemoteDatabase(); const box = new RemoteOutbox(fixture.database); const id = randomUUID(); const other = randomUUID();
    const transaction = vi.spyOn(fixture.database, 'transaction');
    box.append(id, [item(1)]); box.append(id, [item(2)]); box.append(other, [item(1)]);
    expect(transaction).not.toHaveBeenCalled(); expect(box.pendingCount()).toBe(3);
    await new Promise<void>(resolve => setImmediate(resolve)); expect(transaction).toHaveBeenCalledTimes(2);
    box.append(id, [item(3)]); expect(box.pending(id)).toHaveLength(3); expect(transaction).toHaveBeenCalledTimes(3);
    await new Promise<void>(resolve => setImmediate(resolve)); expect(transaction).toHaveBeenCalledTimes(3);
    expect(new RemoteOutbox(fixture.reopen()).pendingCount()).toBe(4);
  });
  it('maintains the global byte cache across mutations without aggregate queries or table rescans', async () => {
    const { database } = await openRemoteDatabase(); const box = new RemoteOutbox(database);
    const [first, second, third] = [randomUUID(), randomUUID(), randomUUID()] as [string, string, string];
    for (const id of [first, second, third]) box.nextSeq(id);
    box.initialize(first, [item(1)]);
    const records = vi.spyOn(database, 'records'); const rows = vi.spyOn(database, 'outbox');
    box.append(first, [item(2)]); box.initialize(second, [item(1), item(2)]); box.acknowledge(first, 1);
    box.drop(second); box.append(third, [item(1)]); box.discard(third);
    expect(box.pendingCount()).toBe(1); expect(box.sessions()).toEqual([first]);
    expect(records).not.toHaveBeenCalled(); expect(rows).not.toHaveBeenCalled();
  });
  it('reports a scheduled storage failure and fences subsequent operations', async () => {
    let fail = false;
    const fixture = await openRemoteDatabase(at => { if (fail && at === 'after_commit') throw new Error('injected'); });
    const box = new RemoteOutbox(fixture.database); const id = randomUUID(); const onError = vi.fn(); box.setErrorHandler(onError);
    box.append(id, [item(1)]); box.flush(); fail = true;
    box.append(id, [item(2)]); await new Promise<void>(resolve => setImmediate(resolve));
    expect(onError).toHaveBeenCalledExactlyOnceWith(id, expect.any(RemoteStorageError));
    for (const action of [() => box.nextSeq(id), () => box.pendingCount(), () => box.flush(), () => box.append(id, [item(3)])]) expect(action).toThrow(/fenced/u);
    expect(new RemoteOutbox(fixture.reopen()).nextSeq(id)).toBe(3);
  });
  it('uses a bounded database query for a warm pending page', async () => {
    const { database } = await openRemoteDatabase(); const box = new RemoteOutbox(database); const id = randomUUID();
    box.append(id, Array.from({ length: 1000 }, (_, index) => item(index + 1))); box.flush();
    const rows = vi.spyOn(database, 'outbox');
    expect(box.pending(id, 3).map(entry => entry.seq)).toEqual([1, 2, 3]); expect(rows).toHaveBeenCalledExactlyOnceWith(id, 0, 3);
  });
  it('reads only one byte-bounded batch per pass through a large backlog', async () => {
    const { database } = await openRemoteDatabase(); const box = new RemoteOutbox(database); const id = randomUUID();
    box.initialize(id, Array.from({ length: 24 }, () => large));
    const rows = vi.spyOn(database, 'outbox'); let read = 0;
    for (let pass = 0; pass < 6; pass++) {
      const pending = box.pending(id); expect(pending).toHaveLength(4);
      expect(rows).toHaveBeenLastCalledWith(id, pass * 4, 4);
      const fetched = rows.mock.results.at(-1)!.value as ReturnType<RemoteDatabase['outbox']>;
      expect(fetched.reduce((sum, row) => sum + row.bytes, 0)).toBeLessThanOrEqual(PUBLICATION_LIMITS.batchBytes);
      read += fetched.length; box.acknowledge(id, pending.at(-1)!.seq);
    }
    expect(read).toBe(24); expect(box.pending(id)).toEqual([]); expect(rows).toHaveBeenCalledTimes(6);
  }, 30_000);
  it.each(['record', 'records', 'outbox'] as const)('classifies %s read failures as storage failures', async method => {
    const { database } = await openRemoteDatabase(); const box = new RemoteOutbox(database); const id = randomUUID();
    vi.spyOn(database, method).mockImplementation(() => { throw new Error('SQLite read failure'); });
    expect(() => method === 'records' ? box.sessions() : box.nextSeq(id)).toThrow(RemoteStorageError);
  });
  it('does not persist buffered entries until flush and initializes only an empty outbox', async () => {
    const fixture = await openRemoteDatabase(); const box = new RemoteOutbox(fixture.database); const id = randomUUID();
    box.append(id, [item(1)]); expect(new RemoteOutbox(fixture.database).nextSeq(id)).toBe(1);
    box.initialize(id, [item(2), item(3)]); expect(box.nextSeq(id)).toBe(2);
    box.flush(); const reopened = new RemoteOutbox(fixture.reopen());
    expect(reopened.pending(id).map(row => row.rev)).toEqual([1]);
    reopened.initialize(id, [item(4)]); expect(reopened.nextSeq(id)).toBe(2);
    const empty = randomUUID(); reopened.initialize(empty, []); reopened.initialize(empty, [item(5)]);
    expect(reopened.pending(empty).map(row => row.rev)).toEqual([5]);
  });
  for (const operation of ['append', 'initialize', 'fastForward'] as const) {
    it(`rolls back a partially executed ${operation} batch`, async () => {
      const fixture = await openRemoteDatabase(); const box = new RemoteOutbox(fixture.database); const id = randomUUID();
      box.initialize(randomUUID(), [item(100)]); box.nextSeq(id);
      if (operation === 'fastForward') { box.initialize(id, [item(1), item(2)]); box.append(id, [item(3)]); }
      if (operation === 'append') box.append(id, [item(1), item(2), item(3)]);
      const cursor = structuredClone(box['cursors'].get(id)); const total = box['totalPendingBytes']; const pending = box.pendingCount(); const next = box.nextSeq(id);
      const stored = fixture.database.outbox(id); const record = fixture.database.record('outbox_cursor', id);
      const insert = fixture.database.insertOutbox.bind(fixture.database); let count = 0;
      const fault = vi.spyOn(fixture.database, 'insertOutbox').mockImplementation((...args) => {
        if (++count === 2) throw new Error('injected between rows');
        insert(...args);
      });
      const act = () => {
        if (operation === 'initialize') box.initialize(id, [item(1), item(2), item(3)]);
        else if (operation === 'fastForward') box.fastForward(id, 10);
        else box.flush();
      };
      expect(act).toThrow(/commit failed/u);
      expect(box['cursors'].get(id)).toEqual(cursor); expect(box['totalPendingBytes']).toBe(total);
      expect(box.acked(id)).toBe(cursor!.acked); expect(box.nextSeq(id)).toBe(next); expect(box.pendingCount()).toBe(pending);
      expect(fixture.database.outbox(id)).toEqual(stored); expect(fixture.database.record('outbox_cursor', id)).toBe(record);
      const durable = new RemoteOutbox(fixture.database); expect(durable.nextSeq(id)).toBe(operation === 'fastForward' ? 3 : 1);
      fault.mockRestore(); box.flush(); expect(box['cursors'].get(id)!.buffered).toEqual([]);
      expect(box.append(id, [item(4)])[0]!.seq).toBe(next); box.flush();
      const reopened = new RemoteOutbox(fixture.reopen()); expect(reopened.nextSeq(id)).toBe(next + 1); expect(reopened.pendingCount()).toBe(pending + 1);
    });
  }
  it('checks database ownership even for cached cursor reads', async () => {
    const { database } = await openRemoteDatabase(); const box = new RemoteOutbox(database); const id = randomUUID();
    box.initialize(id, [item(1)]); database.close();
    expect(() => box.nextSeq(id)).toThrow(RemoteStorageError); expect(() => box.pendingCount()).toThrow(RemoteStorageError);
  });
  it('assigns contiguous sequences across revision gaps and restarts', async () => {
    const fixture = await openRemoteDatabase(); const id = randomUUID(); let box = new RemoteOutbox(fixture.database);
    for (let index = 0; index < 100; index++) {
      if (index && index % 20 === 0) { box.flush(); box = new RemoteOutbox(fixture.reopen()); }
      expect(box.append(id, [item(index * 4096 + 1), item(index * 4096 + 3)]).map(entry => entry.seq)).toEqual([2 * index + 1, 2 * index + 2]);
    }
    box.flush(); const reopened = new RemoteOutbox(fixture.reopen()); expect(reopened.nextSeq(id)).toBe(201); expect(reopened.pendingCount()).toBe(200);
    expect(reopened.pending(id).map(entry => entry.seq)).toEqual(Array.from({ length: 200 }, (_, index) => index + 1));
  });
  it('trims only acknowledged entries atomically, retaining the high-water mark after full trim', async () => {
    const fixture = await openRemoteDatabase(); const box = new RemoteOutbox(fixture.database); const id = randomUUID();
    box.append(id, [item(1), item(2), item(3)]); box.acknowledge(id, 2);
    expect(box.acked(id)).toBe(2); expect(box.pending(id).map(entry => entry.seq)).toEqual([3]); expect(fixture.database.outbox(id)).toHaveLength(1);
    box.acknowledge(id, 2); box.acknowledge(id, 1); expect(box.acked(id)).toBe(2);
    box.acknowledge(id, 3); expect(box.sessions()).toEqual([]); expect(box.pendingCount()).toBe(0); expect(fixture.database.outbox(id)).toEqual([]);
    const reopened = new RemoteOutbox(fixture.reopen()); expect(reopened.nextSeq(id)).toBe(4); expect(reopened.append(id, [item(7)])[0]!.seq).toBe(4);
    expect(() => reopened.acknowledge(id, 5)).toThrow(/highest appended/u); reopened.flush();
  });
  it('fast-forwards durable and buffered entries in one transaction without replaying the acknowledged prefix', async () => {
    const fixture = await openRemoteDatabase(); const box = new RemoteOutbox(fixture.database); const id = randomUUID();
    box.initialize(id, [item(11), item(22), item(33)]); box.acknowledge(id, 1); box.append(id, [item(44), item(55)]);
    const transaction = vi.spyOn(fixture.database, 'transaction'); const insert = vi.spyOn(fixture.database, 'insertOutbox');
    const read = vi.spyOn(fixture.database, 'outbox');
    box.fastForward(id, 99);
    expect(transaction).toHaveBeenCalledTimes(1); expect(insert).toHaveBeenCalledTimes(4);
    expect(read).toHaveBeenCalledExactlyOnceWith(id, 1);
    expect(box.acked(id)).toBe(99); expect(box.nextSeq(id)).toBe(104); expect(box.pendingCount()).toBe(4); expect(box.sessions()).toEqual([id]);
    const rows = fixture.database.outbox(id);
    expect(rows.map(row => row.seq)).toEqual([100, 101, 102, 103]);
    expect(rows.map(row => JSON.parse(row.data))).toEqual([22, 33, 44, 55].map((rev, index) => ({ seq: 100 + index, ...item(rev) })));
    for (const row of rows) expect(row.bytes).toBe(Buffer.byteLength(row.data) + 1);
    expect(JSON.parse(fixture.database.record('outbox_cursor', id)!)).toEqual({ version: 1, acked: 99, lastSeq: 103, dropped: false });
    expect(box.pending(id).map(row => row.seq)).toEqual([100, 101, 102, 103]);
    await new Promise<void>(resolve => setImmediate(resolve)); expect(transaction).toHaveBeenCalledTimes(1);
    const reopened = new RemoteOutbox(fixture.reopen());
    expect(reopened.acked(id)).toBe(99); expect(reopened.pending(id).map(row => row.rev)).toEqual([22, 33, 44, 55]);
    expect(reopened.append(id, [item(66)])[0]!.seq).toBe(104); reopened.flush();
  });
  it('recalculates fast-forward byte sizes and the total cache for later append, acknowledgement and drop', async () => {
    const { database } = await openRemoteDatabase(); const box = new RemoteOutbox(database); const id = randomUUID(); const other = randomUUID();
    box.initialize(id, [item(1), item(2)]); box.initialize(other, [item(3)]);
    const otherBytes = outboxBytes(database, other); const originalBytes = outboxBytes(database, id);
    const buffered = box.append(id, [item(4)])[0]!; const bufferedBytes = Buffer.byteLength(JSON.stringify(buffered)) + 1;
    const previous = originalBytes + bufferedBytes; const total = previous + otherBytes;
    const capacity = vi.spyOn(box as unknown as CapacityCheck, 'checkCapacity');
    box.fastForward(id, 999);
    const rows = database.outbox(id); const bytes = rows.reduce((sum, row) => sum + row.bytes, 0);
    expect(bytes).toBeGreaterThan(previous); expect(capacity).not.toHaveBeenCalled();
    expect(box['totalPendingBytes']).toBe(total + bytes - previous);
    const appended = box.append(id, [item(5)])[0]!; const appendedBytes = Buffer.byteLength(JSON.stringify(appended)) + 1;
    expect(capacity).toHaveBeenCalledExactlyOnceWith(id, bytes, bytes + appendedBytes);
    expect(box['totalPendingBytes']).toBe(otherBytes + bytes + appendedBytes); capacity.mockClear();
    box.acknowledge(id, 1000);
    const otherEntry = box.append(other, [item(6)])[0]!; const addedBytes = Buffer.byteLength(JSON.stringify(otherEntry)) + 1;
    expect(box['totalPendingBytes']).toBe(otherBytes + bytes + appendedBytes - rows[0]!.bytes + addedBytes); capacity.mockClear();
    box.drop(id); const last = box.append(other, [item(7)])[0]!;
    expect(capacity).toHaveBeenCalledExactlyOnceWith(other, otherBytes + addedBytes, expect.any(Number));
    expect(box['totalPendingBytes']).toBe(otherBytes + addedBytes + Buffer.byteLength(JSON.stringify(last)) + 1); box.flush();
  });
  it('recovers a cold outbox without scanning unrelated corruption and rebuilds byte totals after repair', async () => {
    const fixture = await openRemoteDatabase(); const box = new RemoteOutbox(fixture.database); const id = randomUUID(); const other = randomUUID();
    box.initialize(id, [item(1), item(2)]); box.initialize(other, [item(3)]);
    const original = fixture.database.record('outbox_cursor', other)!;
    fixture.database.transaction(() => fixture.database.putRecord('outbox_cursor', other, '{'));
    const database = fixture.reopen(); const cold = new RemoteOutbox(database);
    const record = vi.spyOn(database, 'record'); const records = vi.spyOn(database, 'records'); const rows = vi.spyOn(database, 'outbox');
    cold.fastForward(id, 99);
    expect(record).toHaveBeenCalledExactlyOnceWith('outbox_cursor', id); expect(records).not.toHaveBeenCalled();
    expect(rows.mock.calls).toEqual([[id], [id, 0]]); expect(cold['totalPendingBytes']).toBeUndefined();
    expect(cold.pending(id).map(row => [row.seq, row.rev])).toEqual([[100, 1], [101, 2]]);
    database.transaction(() => database.putRecord('outbox_cursor', other, original));
    const bytes = outboxBytes(database, id) + outboxBytes(database, other);
    const reopenedDatabase = fixture.reopen(); const reopened = new RemoteOutbox(reopenedDatabase);
    expect(reopened['totalPendingBytes']).toBeUndefined();
    const added = reopened.append(id, [item(4)])[0]!; const total = bytes + Buffer.byteLength(JSON.stringify(added)) + 1;
    expect(added.seq).toBe(102); expect(reopened['totalPendingBytes']).toBe(total); reopened.flush();
    expect(outboxBytes(reopenedDatabase, id) + outboxBytes(reopenedDatabase, other)).toBe(total);
  });
  it('recovers a full outbox despite sequence metadata growth while accounting bytes and limiting new appends', async () => {
    const fixture = await openRemoteDatabase(); const box = new RemoteOutbox(fixture.database); const id = randomUUID(); const other = randomUUID();
    const entries = Array.from({ length: 67 }, () => large);
    const used = [...entries, message('')].reduce((sum, entry, index) => sum + Buffer.byteLength(JSON.stringify({ seq: index + 1, ...entry })) + 1, 0);
    entries.push(message('x'.repeat(REMOTE_OUTBOX_PENDING_BYTES_LIMIT - used)));
    box.initialize(other, [item(1)]); const otherBytes = outboxBytes(fixture.database, other);
    box.initialize(id, entries); expect(outboxBytes(fixture.database, id)).toBe(REMOTE_OUTBOX_PENDING_BYTES_LIMIT);
    const capacity = vi.spyOn(box as unknown as CapacityCheck, 'checkCapacity');
    box.fastForward(id, 9999); expect(capacity).not.toHaveBeenCalled();
    const growth = entries.reduce((sum, _, index) => sum + String(10_000 + index).length - String(index + 1).length, 0);
    const bytes = outboxBytes(fixture.database, id);
    expect(growth).toBeGreaterThan(0); expect(bytes).toBe(REMOTE_OUTBOX_PENDING_BYTES_LIMIT + growth);
    expect(box['totalPendingBytes']).toBe(bytes + otherBytes);
    const reopened = new RemoteOutbox(fixture.reopen()); expect(reopened.acked(id)).toBe(9999); expect(reopened.nextSeq(id)).toBe(10_068);
    expect(() => reopened.append(id, [item(2)])).toThrow(expect.objectContaining({ scope: 'session' }));
    const added = reopened.append(other, [item(2)])[0]!;
    expect(reopened['totalPendingBytes']).toBe(bytes + otherBytes + Buffer.byteLength(JSON.stringify(added)) + 1);
    reopened.acknowledge(id, 10_000); expect(reopened.append(id, [item(2)])[0]!.seq).toBe(10_068); reopened.flush();
  }, 30_000);
  it('rejects invalid, backwards, overflowing and dropped fast-forwards without writing', async () => {
    const { database } = await openRemoteDatabase(); const box = new RemoteOutbox(database); const id = randomUUID();
    box.initialize(id, [item(1), item(2)]); box.append(id, [item(3)]);
    const transaction = vi.spyOn(database, 'transaction');
    for (const seq of [-Infinity, -1, 0, 1, 2, 3, 4.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => box.fastForward(id, seq)).toThrow(/next remote outbox sequence/u);
    }
    for (const seq of [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER - 1]) expect(() => box.fastForward(id, seq)).toThrow(/exhausted/u);
    expect(() => box.fastForward('invalid', 4)).toThrow(/UUID/u);
    expect(transaction).not.toHaveBeenCalled(); expect(box.nextSeq(id)).toBe(4); expect(box.acked(id)).toBe(0);
    box.fastForward(id, box.nextSeq(id)); expect(box.pending(id).map(row => row.seq)).toEqual([5, 6, 7]);
    box.drop(id); transaction.mockClear(); expect(() => box.fastForward(id, 99)).toThrow(/permanently/u); expect(transaction).not.toHaveBeenCalled();
  });
  it('fast-forwards an empty session durably and permits the last safe publication sequence', async () => {
    const fixture = await openRemoteDatabase(); const box = new RemoteOutbox(fixture.database); const id = randomUUID();
    box.fastForward(id, 20); expect(box.acked(id)).toBe(20); expect(box.nextSeq(id)).toBe(21); expect(box.pendingCount()).toBe(0); expect(box.sessions()).toEqual([]);
    const reopened = new RemoteOutbox(fixture.reopen()); expect(reopened.acked(id)).toBe(20);
    expect(reopened.append(id, [item(1)])[0]!.seq).toBe(21); reopened.fastForward(id, Number.MAX_SAFE_INTEGER - 1);
    expect(reopened.pending(id)[0]!.seq).toBe(Number.MAX_SAFE_INTEGER); expect(() => reopened.nextSeq(id)).toThrow(/exhausted/u);
  });
  it('bounds pending pages and includes buffered sessions in counts', async () => {
    const { database } = await openRemoteDatabase(); const box = new RemoteOutbox(database); const id = randomUUID(); const other = randomUUID();
    box.append(id, Array.from({ length: 510 }, (_, index) => item(index + 1))); box.append(other, [item(1)]);
    expect(box.pending(id)).toHaveLength(500); expect(box.pending(id, 3)).toHaveLength(3);
    expect(box.sessions()).toEqual([id, other].sort()); expect(box.pendingCount()).toBe(511);
    for (const limit of [0, -1, 501, Infinity]) expect(() => box.pending(id, limit)).toThrow(/limit/u);
    box.flush();
  });
  it('persists permanent tombstones including for never-flushed entries', async () => {
    const fixture = await openRemoteDatabase(); const box = new RemoteOutbox(fixture.database); const id = randomUUID();
    box.append(id, [item(1)]); box.drop(id); box.drop(id);
    const reopened = new RemoteOutbox(fixture.reopen()); expect(reopened.pending(id)).toEqual([]); expect(reopened.sessions()).toEqual([]);
    expect(() => reopened.append(id, [item(2)])).toThrow(/permanently/u); expect(() => reopened.nextSeq(id)).toThrow(/permanently/u);
  });
  it('discards unpublished buffered or durable entries without a tombstone', async () => {
    const fixture = await openRemoteDatabase();
    for (const durable of [false, true]) {
      const box = new RemoteOutbox(fixture.database); const id = randomUUID(); box.append(id, [item(1), item(2)]); if (durable) box.flush(id);
      box.discard(id); expect(box.pendingCount()).toBe(0); expect(box.sessions()).toEqual([]); expect(box.nextSeq(id)).toBe(1);
      expect(fixture.database.outbox(id)).toEqual([]); expect(fixture.database.record('outbox_cursor', id)).toBeUndefined();
      expect(new RemoteOutbox(fixture.database).nextSeq(id)).toBe(1);
    }
  });
  it('never discards acknowledged entries or a permanent tombstone', async () => {
    const { database } = await openRemoteDatabase(); const box = new RemoteOutbox(database); const id = randomUUID(); box.append(id, [item(1), item(2)]); box.acknowledge(id, 1);
    expect(() => box.discard(id)).toThrow(/unpublished/u); expect(box.acked(id)).toBe(1); expect(box.pending(id)[0]!.seq).toBe(2);
    const dropped = randomUUID(); box.drop(dropped); expect(() => box.discard(dropped)).toThrow(/unpublished/u);
  });
  it('caps pending bytes including buffered entries and initialization, releasing acknowledged bytes', async () => {
    expect(REMOTE_OUTBOX_PENDING_BYTES_LIMIT).toBe(64 * 1024 * 1024);
    const fixture = await openRemoteDatabase(); const box = new RemoteOutbox(fixture.database); const id = randomUUID(); const other = randomUUID();
    box.append(id, Array.from({ length: 64 }, () => large));
    expect(() => box.append(id, Array.from({ length: 4 }, () => large))).toThrow(RemoteOutboxCapacityError);
    expect(box.pendingCount()).toBe(64); expect(box.nextSeq(id)).toBe(65); expect(fixture.database.outbox(id)).toEqual([]);
    expect(() => box.initialize(other, Array.from({ length: 68 }, () => large))).toThrow(RemoteOutboxCapacityError);
    expect(box.nextSeq(other)).toBe(1); box.append(other, [item(1)]); box.flush();
    const reopened = new RemoteOutbox(fixture.reopen());
    expect(() => reopened.append(id, Array.from({ length: 4 }, () => large))).toThrow(RemoteOutboxCapacityError);
    reopened.acknowledge(id, 1); expect(reopened.append(id, [large])[0]!.seq).toBe(65); reopened.flush();
    expect(reopened.pending(id, 1)[0]!.seq).toBe(2); expect(reopened.pendingCount()).toBe(65);
  }, 30_000);
  it('enforces the total cap across buffered and durable sessions, releasing dropped bytes', async () => {
    expect(REMOTE_OUTBOX_TOTAL_PENDING_BYTES_LIMIT).toBe(256 * 1024 * 1024);
    const fixture = await openRemoteDatabase(); const box = new RemoteOutbox(fixture.database); const ids = Array.from({ length: 5 }, () => randomUUID());
    for (const id of ids.slice(0, 4)) box.initialize(id, Array.from({ length: 64 }, () => large));
    expect(() => box.initialize(ids[4]!, Array.from({ length: 13 }, () => large))).toThrow(expect.objectContaining({ scope: 'total' }));
    expect(box.nextSeq(ids[4]!)).toBe(1); box.append(ids[4]!, Array.from({ length: 12 }, () => large));
    expect(() => box.append(ids[4]!, [large])).toThrow(expect.objectContaining({ scope: 'total' })); box.flush();
    const reopened = new RemoteOutbox(fixture.reopen()); expect(() => reopened.append(ids[4]!, [large])).toThrow(expect.objectContaining({ scope: 'total' }));
    reopened.acknowledge(ids[0]!, 64); expect(reopened.append(ids[4]!, [large])[0]!.seq).toBe(13); reopened.drop(ids[1]!);
    expect(reopened.append(randomUUID(), Array.from({ length: 64 }, () => large))).toHaveLength(64); reopened.flush();
  }, 30_000);
  it('rejects invalid session IDs and records before writing', async () => {
    const { database } = await openRemoteDatabase(); const box = new RemoteOutbox(database);
    for (const id of ['../escape', '', 'not-a-uuid', `${randomUUID()}/suffix`]) {
      expect(() => box.append(id, [item(1)])).toThrow(/UUID/u); expect(() => box.drop(id)).toThrow(/UUID/u);
    }
    expect(() => box.append(randomUUID(), [item(0)])).toThrow();
    const id = randomUUID(); expect(() => box.append(id, [{ ...item(1), change: { v: 1, session: id, stream: { message: 'm', id: 's', kind: 'assistant', offset: 0 }, text: 'stream' } as unknown as OutboxItem['change'] }])).toThrow();
    expect(box.nextSeq(id)).toBe(1); expect(database.outbox(id)).toEqual([]);
  });
  it('fails closed on invalid rows, sequence gaps, missing rows and mismatched byte counts', async () => {
    for (const mutation of ['invalid', 'gap', 'missing', 'bytes', 'cursor']) {
      const fixture = await openRemoteDatabase(); const box = new RemoteOutbox(fixture.database); const id = randomUUID(); box.initialize(id, [item(1), item(2)]);
      const rows = fixture.database.outbox(id);
      fixture.database.transaction(() => {
        if (mutation === 'cursor') { fixture.database.deleteRecord('outbox_cursor', id); return; }
        fixture.database.deleteOutbox(id);
        for (const row of rows) {
          if (mutation === 'missing' && row.seq === 2) continue;
          fixture.database.insertOutbox(id, mutation === 'gap' && row.seq === 2 ? 5 : row.seq,
            row.bytes + (mutation === 'bytes' ? 1 : 0), mutation === 'invalid' ? '{' : row.data);
        }
      });
      expect(() => new RemoteOutbox(fixture.reopen()).nextSeq(id)).toThrow(RemoteIntegrityError);
    }
  });
  for (const boundary of ['before_commit', 'after_commit'] as PersistenceBoundary[]) {
    it(`does not update a cold fast-forward byte cache at ${boundary}`, async () => {
      const fixture = await openRemoteDatabase(at => { if (at === boundary) throw new Error('injected'); });
      const box = new RemoteOutbox(fixture.database); const id = randomUUID(); box.nextSeq(id);
      const cursor = structuredClone(box['cursors'].get(id));
      expect(box['totalPendingBytes']).toBeUndefined(); expect(() => box.fastForward(id, 10)).toThrow(/commit failed/u);
      expect(box['cursors'].get(id)).toEqual(cursor); expect(box['totalPendingBytes']).toBeUndefined();
      const reopened = new RemoteOutbox(fixture.reopen()); expect(reopened.acked(id)).toBe(boundary === 'after_commit' ? 10 : 0);
      expect(reopened.pendingCount()).toBe(0);
    });
    for (const operation of ['append', 'initialize', 'acknowledge', 'drop', 'discard', 'fastForward'] as const) {
      it(`recovers atomic ${operation} at ${boundary}`, async () => {
        let fail = false; const fixture = await openRemoteDatabase(at => { if (fail && at === boundary) throw new Error('injected'); });
        const id = randomUUID(); const box = new RemoteOutbox(fixture.database);
        if (operation !== 'initialize') box.initialize(id, [item(1), item(2)]);
        if (operation === 'fastForward') { box.acknowledge(id, 1); box.append(id, [item(3), item(4)]); }
        const cursor = operation === 'fastForward' ? structuredClone(box['cursors'].get(id)) : undefined;
        const total = box['totalPendingBytes'];
        fail = true;
        const act = () => {
          if (operation === 'append') { box.append(id, [item(3), item(4)]); box.flush(); }
          if (operation === 'initialize') box.initialize(id, [item(1), item(2), item(3)]);
          if (operation === 'acknowledge') box.acknowledge(id, 1);
          if (operation === 'drop') box.drop(id);
          if (operation === 'discard') box.discard(id);
          if (operation === 'fastForward') box.fastForward(id, 99);
        };
        expect(act).toThrow(/commit failed/u); expect(() => box.nextSeq(id)).toThrow(/fenced/u);
        if (operation === 'fastForward') { expect(box['cursors'].get(id)).toEqual(cursor); expect(box['totalPendingBytes']).toBe(total); }
        const reopened = new RemoteOutbox(fixture.reopen()); const committed = boundary === 'after_commit';
        if (operation === 'append') { expect(reopened.nextSeq(id)).toBe(committed ? 5 : 3); expect(reopened.pendingCount()).toBe(committed ? 4 : 2); }
        if (operation === 'initialize') { expect(reopened.nextSeq(id)).toBe(committed ? 4 : 1); expect(reopened.pendingCount()).toBe(committed ? 3 : 0); }
        if (operation === 'acknowledge') { expect(reopened.acked(id)).toBe(committed ? 1 : 0); expect(reopened.pending(id).map(row => row.seq)).toEqual(committed ? [2] : [1, 2]); expect(reopened.nextSeq(id)).toBe(3); }
        if (operation === 'drop') { if (committed) expect(() => reopened.nextSeq(id)).toThrow(/permanently/u); else expect(reopened.nextSeq(id)).toBe(3); expect(reopened.pendingCount()).toBe(committed ? 0 : 2); }
        if (operation === 'discard') { expect(reopened.nextSeq(id)).toBe(committed ? 1 : 3); expect(reopened.pendingCount()).toBe(committed ? 0 : 2); }
        if (operation === 'fastForward') {
          expect(reopened.acked(id)).toBe(committed ? 99 : 1); expect(reopened.nextSeq(id)).toBe(committed ? 103 : 3);
          expect(reopened.pending(id).map(row => [row.seq, row.rev])).toEqual(committed ? [[100, 2], [101, 3], [102, 4]] : [[2, 2]]);
          expect(reopened.pendingCount()).toBe(committed ? 3 : 1);
        }
      });
    }
  }
});
