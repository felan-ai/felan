import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PUBLICATION_LIMITS } from '@felan-ai/session-protocol';
import { publishedEvent } from '../src/remote/content.js';
import { REMOTE_OUTBOX_PENDING_BYTES_LIMIT, REMOTE_OUTBOX_TOTAL_PENDING_BYTES_LIMIT, RemoteOutbox, RemoteOutboxCapacityError, type OutboxItem } from '../src/remote/outbox.js';
import { RemoteIntegrityError, RemoteStorageError } from '../src/remote/state.js';
import type { PersistenceBoundary, RemoteDatabase } from '../src/daemon/persistence.js';
import { closeRemoteDatabases, openRemoteDatabase } from './remote-database.js';

const item = (rev: number): OutboxItem => ({ rev, occurredAt: 123, change: { type: 'run.updated', run: { state: 'idle' } } });
const message = (text: string): OutboxItem => ({ rev: 1, occurredAt: 1, change: { type: 'message.completed', message: {
  id: 'm', entryId: 'e', role: 'assistant', timestamp: 1, content: [{ type: 'text', text }],
} } });
const large = message('x'.repeat(1_000_000));
const small = message('x'.repeat(1_000));
const limits = { session: 4_096, total: 17_000 };
const outboxBytes = (database: RemoteDatabase, session: string) => database.outbox(session).reduce((sum, row) => sum + row.bytes, 0);
afterEach(async () => { vi.restoreAllMocks(); await closeRemoteDatabases(); });

describe('durable remote outbox', () => {
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
  it('returns byte-bounded batches through a large backlog', async () => {
    const { database } = await openRemoteDatabase(); const box = new RemoteOutbox(database); const id = randomUUID();
    box.initialize(id, Array.from({ length: 5 }, () => large));
    let read = 0;
    for (let pass = 0; pass < 2; pass++) {
      const pending = box.pending(id); expect(pending).toHaveLength(pass === 0 ? 4 : 1);
      expect(pending.reduce((sum, row) => sum + Buffer.byteLength(JSON.stringify(row)) + 1, 0)).toBeLessThanOrEqual(PUBLICATION_LIMITS.batchBytes);
      read += pending.length; box.acknowledge(id, pending.at(-1)!.seq);
    }
    expect(read).toBe(5); expect(box.pending(id)).toEqual([]);
  });
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
      const acked = box.acked(id); const pending = box.pendingCount(); const next = box.nextSeq(id);
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
      expect(box.acked(id)).toBe(acked); expect(box.nextSeq(id)).toBe(next); expect(box.pendingCount()).toBe(pending);
      expect(fixture.database.outbox(id)).toEqual(stored); expect(fixture.database.record('outbox_cursor', id)).toBe(record);
      const durable = new RemoteOutbox(fixture.database); expect(durable.nextSeq(id)).toBe(operation === 'fastForward' ? 3 : 1);
      fault.mockRestore(); box.flush();
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
  it.each([false, true])('sanitizes legacy NUL-containing entries after reopening, with fast-forward %s', async fastForward => {
    const fixture = await openRemoteDatabase(); const id = randomUUID();
    const entry = { seq: 1, ...message('before\0after') };
    const data = JSON.stringify(entry);
    fixture.database.transaction(() => {
      fixture.database.insertOutbox(id, 1, Buffer.byteLength(data) + 1, data);
      fixture.database.putRecord('outbox_cursor', id, JSON.stringify({ version: 1, acked: 0, lastSeq: 1, dropped: false }));
    });
    const database = fixture.reopen(); const box = new RemoteOutbox(database);
    expect(database.outbox(id)[0]!.data).toContain('\\u0000');
    if (fastForward) box.fastForward(id, 10);
    const pending = box.pending(id);
    const events = pending.map(value => publishedEvent(id, value));
    expect(events).toHaveLength(1); expect(events[0]).toMatchObject({ seq: fastForward ? 11 : 1, rev: 1, occurredAt: 1,
      change: { message: { content: [{ type: 'text', text: 'before\uFFFDafter' }] } } });
    expect(JSON.stringify(events)).not.toContain('\\u0000');
    expect(Buffer.byteLength(JSON.stringify(events[0]!.change))).toBeLessThanOrEqual(PUBLICATION_LIMITS.changeBytes);
    if (!fastForward) expect(database.outbox(id)[0]!.data).toBe(data);
    box.acknowledge(id, events[0]!.seq); expect(box.pending(id)).toEqual([]); expect(box.pendingCount()).toBe(0);
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
    box.fastForward(id, 99);
    expect(box.acked(id)).toBe(99); expect(box.nextSeq(id)).toBe(104); expect(box.pendingCount()).toBe(4); expect(box.sessions()).toEqual([id]);
    const rows = fixture.database.outbox(id);
    expect(rows.map(row => row.seq)).toEqual([100, 101, 102, 103]);
    expect(rows.map(row => JSON.parse(row.data))).toEqual([22, 33, 44, 55].map((rev, index) => ({ seq: 100 + index, ...item(rev) })));
    for (const row of rows) expect(row.bytes).toBe(Buffer.byteLength(row.data) + 1);
    expect(JSON.parse(fixture.database.record('outbox_cursor', id)!)).toEqual({ version: 1, acked: 99, lastSeq: 103, dropped: false });
    expect(box.pending(id).map(row => row.seq)).toEqual([100, 101, 102, 103]);
    const reopened = new RemoteOutbox(fixture.reopen());
    expect(reopened.acked(id)).toBe(99); expect(reopened.pending(id).map(row => row.rev)).toEqual([22, 33, 44, 55]);
    expect(reopened.append(id, [item(66)])[0]!.seq).toBe(104); reopened.flush();
  });
  it('recovers a session despite unrelated corruption and preserves byte totals after repair', async () => {
    const fixture = await openRemoteDatabase(); const box = new RemoteOutbox(fixture.database); const id = randomUUID(); const other = randomUUID();
    box.initialize(id, [item(1), item(2)]); box.initialize(other, [item(3)]);
    const original = fixture.database.record('outbox_cursor', other)!;
    fixture.database.transaction(() => fixture.database.putRecord('outbox_cursor', other, '{'));
    const database = fixture.reopen(); const cold = new RemoteOutbox(database);
    cold.fastForward(id, 99);
    expect(cold.pending(id).map(row => [row.seq, row.rev])).toEqual([[100, 1], [101, 2]]);
    database.transaction(() => database.putRecord('outbox_cursor', other, original));
    const bytes = outboxBytes(database, id) + outboxBytes(database, other);
    const reopenedDatabase = fixture.reopen(); const reopened = new RemoteOutbox(reopenedDatabase);
    const added = reopened.append(id, [item(4)])[0]!; const total = bytes + Buffer.byteLength(JSON.stringify(added)) + 1;
    expect(added.seq).toBe(102); reopened.flush();
    expect(outboxBytes(reopenedDatabase, id) + outboxBytes(reopenedDatabase, other)).toBe(total);
  });
  it('recovers a full outbox despite sequence metadata growth while accounting bytes and limiting new appends', async () => {
    const fixture = await openRemoteDatabase(); const box = new RemoteOutbox(fixture.database, limits); const id = randomUUID(); const other = randomUUID();
    const entries = Array.from({ length: 3 }, () => small);
    const used = [...entries, message('')].reduce((sum, entry, index) => sum + Buffer.byteLength(JSON.stringify({ seq: index + 1, ...entry })) + 1, 0);
    entries.push(message('x'.repeat(limits.session - used)));
    box.initialize(other, [item(1)]); const otherBytes = outboxBytes(fixture.database, other);
    box.initialize(id, entries); expect(outboxBytes(fixture.database, id)).toBe(limits.session);
    box.fastForward(id, 9999);
    const growth = entries.reduce((sum, _, index) => sum + String(10_000 + index).length - String(index + 1).length, 0);
    const bytes = outboxBytes(fixture.database, id);
    expect(growth).toBeGreaterThan(0); expect(bytes).toBe(limits.session + growth);
    const database = fixture.reopen(); const reopened = new RemoteOutbox(database, limits); expect(reopened.acked(id)).toBe(9999); expect(reopened.nextSeq(id)).toBe(10_004);
    expect(() => reopened.append(id, [item(2)])).toThrow(expect.objectContaining({ scope: 'session' }));
    const added = reopened.append(other, [item(2)])[0]!;
    reopened.flush();
    expect(outboxBytes(database, id) + outboxBytes(database, other)).toBe(bytes + otherBytes + Buffer.byteLength(JSON.stringify(added)) + 1);
    reopened.acknowledge(id, 10_000); expect(reopened.append(id, [item(2)])[0]!.seq).toBe(10_004); reopened.flush();
  });
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
    const fixture = await openRemoteDatabase(); const box = new RemoteOutbox(fixture.database, limits); const id = randomUUID(); const other = randomUUID();
    box.append(id, Array.from({ length: 3 }, () => small));
    expect(() => box.append(id, [small])).toThrow(RemoteOutboxCapacityError);
    expect(box.pendingCount()).toBe(3); expect(box.nextSeq(id)).toBe(4); expect(fixture.database.outbox(id)).toEqual([]);
    expect(() => box.initialize(other, Array.from({ length: 4 }, () => small))).toThrow(RemoteOutboxCapacityError);
    expect(box.nextSeq(other)).toBe(1); box.append(other, [item(1)]); box.flush();
    const reopened = new RemoteOutbox(fixture.reopen(), limits);
    expect(() => reopened.append(id, [small])).toThrow(RemoteOutboxCapacityError);
    reopened.acknowledge(id, 1); expect(reopened.append(id, [small])[0]!.seq).toBe(4); reopened.flush();
    expect(reopened.pending(id, 1)[0]!.seq).toBe(2); expect(reopened.pendingCount()).toBe(4);
  });
  it('enforces the total cap across buffered and durable sessions, releasing dropped bytes', async () => {
    expect(REMOTE_OUTBOX_TOTAL_PENDING_BYTES_LIMIT).toBe(256 * 1024 * 1024);
    const fixture = await openRemoteDatabase(); const box = new RemoteOutbox(fixture.database, limits); const ids = Array.from({ length: 5 }, () => randomUUID());
    for (const id of ids.slice(0, 4)) box.initialize(id, Array.from({ length: 3 }, () => small));
    expect(() => box.initialize(ids[4]!, Array.from({ length: 3 }, () => small))).toThrow(expect.objectContaining({ scope: 'total' }));
    expect(box.nextSeq(ids[4]!)).toBe(1); box.append(ids[4]!, Array.from({ length: 2 }, () => small));
    expect(() => box.append(ids[4]!, [small])).toThrow(expect.objectContaining({ scope: 'total' })); box.flush();
    const reopened = new RemoteOutbox(fixture.reopen(), limits); expect(() => reopened.append(ids[4]!, [small])).toThrow(expect.objectContaining({ scope: 'total' }));
    reopened.acknowledge(ids[0]!, 3); expect(reopened.append(ids[4]!, [small])[0]!.seq).toBe(3); reopened.drop(ids[1]!);
    expect(reopened.append(randomUUID(), Array.from({ length: 3 }, () => small))).toHaveLength(3); reopened.flush();
  });
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
    it(`recovers an empty fast-forward at ${boundary}`, async () => {
      const fixture = await openRemoteDatabase(at => { if (at === boundary) throw new Error('injected'); });
      const box = new RemoteOutbox(fixture.database); const id = randomUUID(); box.nextSeq(id);
      expect(() => box.fastForward(id, 10)).toThrow(/commit failed/u);
      expect(() => box.nextSeq(id)).toThrow(/fenced/u);
      const reopened = new RemoteOutbox(fixture.reopen()); expect(reopened.acked(id)).toBe(boundary === 'after_commit' ? 10 : 0);
      expect(reopened.pendingCount()).toBe(0);
    });
    for (const operation of ['append', 'initialize', 'acknowledge', 'drop', 'discard', 'fastForward'] as const) {
      it(`recovers atomic ${operation} at ${boundary}`, async () => {
        let fail = false; const fixture = await openRemoteDatabase(at => { if (fail && at === boundary) throw new Error('injected'); });
        const id = randomUUID(); const box = new RemoteOutbox(fixture.database);
        if (operation !== 'initialize') box.initialize(id, [item(1), item(2)]);
        if (operation === 'fastForward') { box.acknowledge(id, 1); box.append(id, [item(3), item(4)]); }
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
