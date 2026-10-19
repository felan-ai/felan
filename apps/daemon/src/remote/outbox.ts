import { Type } from 'typebox';
import { CounterSchema, KnownSessionChangeSchema, PUBLICATION_LIMITS, parseSchema } from '@felan-ai/session-protocol';
import { ControlStoreError } from '../daemon/control-state.js';
import type { RemoteDatabase } from '../daemon/persistence.js';
import { publishedEvent, type PublicationEntry, type PublishedChange } from './content.js';
import { RemoteIntegrityError, RemoteStorageError, remoteSessionId } from './state.js';

const counter = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const cursorSchema = Type.Object({ version: Type.Literal(1), acked: counter, lastSeq: counter, dropped: Type.Boolean() }, { additionalProperties: false });
const sequence = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const entrySchema = Type.Object({ seq: sequence, rev: sequence, occurredAt: CounterSchema, change: KnownSessionChangeSchema }, { additionalProperties: false });
interface Cursor { version: 1; acked: number; lastSeq: number; dropped: boolean }
interface StoredEntry { seq: number; bytes: number; data: string }
interface CachedCursor extends Cursor {
  pendingSizes: number[];
  pendingBytes: number;
  buffered: StoredEntry[];
}
export interface OutboxItem { rev: number; occurredAt: number; change: PublishedChange }
export type OutboxEntry = PublicationEntry;
export const REMOTE_OUTBOX_PENDING_BYTES_LIMIT = 64 * 1024 * 1024;
export const REMOTE_OUTBOX_TOTAL_PENDING_BYTES_LIMIT = 256 * 1024 * 1024;
export class RemoteOutboxCapacityError extends Error {
  constructor(readonly session?: string, readonly scope: 'session' | 'total' = 'session') {
    super(`Remote outbox pending data exceeds the ${scope === 'session' ? '64 MiB per-session' : '256 MiB total'} limit.`);
  }
}

export class RemoteOutbox {
  private readonly cursors = new Map<string, CachedCursor>();
  private sessionIds: Set<string> | undefined;
  private totalPendingBytes: number | undefined;
  private scheduled: NodeJS.Immediate | undefined;
  private errorHandler: ((session: string, error: Error) => void) | undefined;
  constructor(private readonly database: RemoteDatabase) {}
  setErrorHandler(handler: (session: string, error: Error) => void): void { this.errorHandler = handler; }
  append(session: string, items: readonly OutboxItem[]): OutboxEntry[] {
    const id = remoteSessionId(session); const cursor = this.scan(id);
    if (cursor.dropped) throw new Error('Remote outbox session was dropped permanently.');
    const entries = this.entries(id, items, cursor.lastSeq);
    if (!entries.length) return [];
    const rows = this.rows(entries); const bytes = rows.reduce((sum, row) => sum + row.bytes, 0);
    this.checkCapacity(id, cursor.pendingBytes, cursor.pendingBytes + bytes);
    for (const row of rows) { cursor.buffered.push(row); cursor.pendingSizes.push(row.bytes); }
    cursor.pendingBytes += bytes; cursor.lastSeq = entries.at(-1)!.seq;
    this.adjustTotal(bytes);
    this.sessionIds?.add(id); this.schedule();
    return entries;
  }
  flush(session?: string): void {
    this.assertCurrent();
    if (session !== undefined) this.flushSession(remoteSessionId(session));
    else for (const id of this.cursors.keys()) this.flushSession(id);
    if (this.scheduled && ![...this.cursors.values()].some(cursor => cursor.buffered.length)) {
      clearImmediate(this.scheduled); this.scheduled = undefined;
    }
  }
  initialize(session: string, items: readonly OutboxItem[]): void {
    const id = remoteSessionId(session); const cursor = this.scan(id);
    if (cursor.dropped) throw new Error('Remote outbox session was dropped permanently.');
    if (cursor.lastSeq) return;
    const entries = this.entries(id, items, 0); const rows = this.rows(entries);
    const bytes = rows.reduce((sum, row) => sum + row.bytes, 0); this.checkCapacity(id, cursor.pendingBytes, bytes);
    const next = { ...cursor, lastSeq: entries.length, pendingSizes: rows.map(row => row.bytes), pendingBytes: bytes };
    this.commit(() => {
      for (const row of rows) this.database.insertOutbox(id, row.seq, row.bytes, row.data);
      this.writeCursor(id, next);
    });
    this.cursors.set(id, next); this.sessionIds?.add(id);
    this.adjustTotal(bytes - cursor.pendingBytes);
  }
  pending(session: string, limit: number = PUBLICATION_LIMITS.eventsPerBatch): OutboxEntry[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > PUBLICATION_LIMITS.eventsPerBatch) throw new Error('Invalid remote outbox page limit.');
    const id = remoteSessionId(session); this.flush(id); const cursor = this.scan(id);
    if (cursor.dropped || cursor.lastSeq === cursor.acked) return [];
    let count = 1; let bytes = cursor.pendingSizes[0]!;
    while (count < Math.min(limit, cursor.pendingSizes.length) && bytes + cursor.pendingSizes[count]! <= PUBLICATION_LIMITS.batchBytes) bytes += cursor.pendingSizes[count++]!;
    return this.query(() => this.database.outbox(id, cursor.acked, count)).map(row => this.entry(id, row));
  }
  acknowledge(session: string, lastSeq: number): void {
    const id = remoteSessionId(session); this.flush(id); const cursor = this.scan(id);
    if (!Number.isSafeInteger(lastSeq) || lastSeq < 0 || lastSeq > cursor.lastSeq) throw new Error('Acknowledgement exceeds the highest appended sequence.');
    if (lastSeq <= cursor.acked || cursor.dropped) return;
    const count = lastSeq - cursor.acked;
    const bytes = cursor.pendingSizes.slice(0, count).reduce((sum, size) => sum + size, 0);
    const next = { ...cursor, acked: lastSeq, pendingSizes: cursor.pendingSizes.slice(count), pendingBytes: cursor.pendingBytes - bytes };
    this.commit(() => { this.writeCursor(id, next); this.database.deleteOutbox(id, lastSeq); });
    this.cursors.set(id, next);
    this.adjustTotal(-bytes);
  }
  fastForward(session: string, platformLastSeq: number): void {
    const id = remoteSessionId(session); const cursor = this.scan(id);
    if (cursor.dropped) throw new Error('Remote outbox session was dropped permanently.');
    if (!Number.isSafeInteger(platformLastSeq) || platformLastSeq <= cursor.lastSeq) throw new Error('Platform sequence must be at least the next remote outbox sequence.');
    const pending = [...this.query(() => this.database.outbox(id, cursor.acked)), ...cursor.buffered];
    if (!Number.isSafeInteger(platformLastSeq + pending.length)) throw new Error('Remote publication sequence exhausted.');
    const rows = this.rows(pending.map((row, index) => ({ ...this.entry(id, row), seq: platformLastSeq + index + 1 })));
    // Extra sequence digits must not block recovery of already accepted data at capacity.
    const bytes = rows.reduce((sum, row) => sum + row.bytes, 0);
    const next = { ...cursor, acked: platformLastSeq, lastSeq: platformLastSeq + rows.length,
      pendingSizes: rows.map(row => row.bytes), pendingBytes: bytes, buffered: [] };
    this.commit(() => {
      this.database.deleteOutbox(id);
      for (const row of rows) this.database.insertOutbox(id, row.seq, row.bytes, row.data);
      this.writeCursor(id, next);
    });
    this.cursors.set(id, next); this.sessionIds?.add(id);
    this.adjustTotal(bytes - cursor.pendingBytes);
  }
  acked(session: string): number { return this.scan(remoteSessionId(session)).acked; }
  nextSeq(session: string): number {
    const cursor = this.scan(remoteSessionId(session));
    if (cursor.dropped) throw new Error('Remote outbox session was dropped permanently.');
    if (!Number.isSafeInteger(cursor.lastSeq + 1)) throw new Error('Remote publication sequence exhausted.');
    return cursor.lastSeq + 1;
  }
  drop(session: string): void {
    const id = remoteSessionId(session); const cursor = this.scan(id);
    const next = { ...cursor, dropped: true, acked: cursor.lastSeq, pendingSizes: [], pendingBytes: 0, buffered: [] };
    this.commit(() => { this.writeCursor(id, next); this.database.deleteOutbox(id); });
    this.cursors.set(id, next); this.sessionIds?.add(id);
    this.adjustTotal(-cursor.pendingBytes);
  }
  discard(session: string): void {
    const id = remoteSessionId(session); const cursor = this.scan(id);
    if (cursor.acked !== 0 || cursor.dropped) throw new Error('Only an unpublished remote outbox can be discarded.');
    this.commit(() => { this.database.deleteOutbox(id); this.database.deleteRecord('outbox_cursor', id); });
    this.cursors.delete(id); this.sessionIds?.delete(id);
    this.adjustTotal(-cursor.pendingBytes);
  }
  sessions(): string[] {
    const ids: string[] = [];
    for (const [id, cursor] of this.storedCursors(true)) if (!cursor.dropped && cursor.lastSeq > cursor.acked) ids.push(id);
    return ids.sort();
  }
  pendingCount(): number {
    let count = 0;
    for (const [, cursor] of this.storedCursors()) if (!cursor.dropped) count += cursor.lastSeq - cursor.acked;
    return count;
  }
  private *storedCursors(tolerateErrors = false): Generator<[string, CachedCursor]> {
    for (const id of this.storedIds()) {
      try { yield [id, this.scan(remoteSessionId(id))]; }
      catch (error) {
        if (!tolerateErrors || !this.errorHandler) throw error;
        this.errorHandler(id, error instanceof Error ? error : new RemoteIntegrityError('Remote outbox cannot be read.'));
      }
    }
  }
  private storedIds(): Set<string> {
    this.assertCurrent();
    return this.sessionIds ??= new Set([...this.query(() => this.database.records('outbox_cursor')).map(row => remoteSessionId(row.id)), ...this.cursors.keys()]);
  }
  private writeCursor(id: string, { version, acked, lastSeq, dropped }: Cursor): void {
    this.database.putRecord('outbox_cursor', id, JSON.stringify({ version, acked, lastSeq, dropped }));
  }
  private scan(id: string): CachedCursor {
    this.assertCurrent();
    const cached = this.cursors.get(id);
    if (cached) return cached;
    const raw = this.query(() => this.database.record('outbox_cursor', id));
    const cursor = raw === undefined ? { version: 1 as const, acked: 0, lastSeq: 0, dropped: false } : parseStored(cursorSchema, raw);
    if (cursor.acked > cursor.lastSeq) throw new RemoteIntegrityError('Invalid remote acknowledgement cursor.');
    const value: CachedCursor = { ...cursor, pendingSizes: [], pendingBytes: 0, buffered: [] };
    let last = cursor.acked;
    for (const row of this.query(() => this.database.outbox(id))) {
      const entry = this.entry(id, row);
      if (cursor.dropped || entry.seq !== last + 1) throw new RemoteIntegrityError('Remote outbox sequence is not contiguous.');
      value.pendingSizes.push(row.bytes); value.pendingBytes += row.bytes; last = entry.seq;
    }
    if (last !== cursor.lastSeq) throw new RemoteIntegrityError('Remote outbox is missing unacknowledged entries.');
    this.cursors.set(id, value); return value;
  }
  private entries(id: string, items: readonly OutboxItem[], lastSeq: number): OutboxEntry[] {
    return items.map((item, index) => {
      const row = publishedEvent(id, { ...item, seq: lastSeq + index + 1 });
      return { seq: row.seq, rev: row.rev, occurredAt: row.occurredAt, change: row.change as PublishedChange };
    });
  }
  private rows(entries: OutboxEntry[]): StoredEntry[] {
    return entries.map(entry => { const data = JSON.stringify(entry); return { seq: entry.seq, bytes: Buffer.byteLength(data) + 1, data }; });
  }
  private entry(id: string, row: StoredEntry): OutboxEntry {
    const entry = parseStored(entrySchema, row.data);
    if (entry.seq !== row.seq || row.bytes !== Buffer.byteLength(row.data) + 1) throw new RemoteIntegrityError('Remote outbox contains an invalid record.');
    const value = publishedEvent(id, { ...entry, change: entry.change as PublishedChange });
    return { seq: value.seq, rev: value.rev, occurredAt: value.occurredAt, change: value.change as PublishedChange };
  }
  private checkCapacity(id: string, previous: number, bytes: number): void {
    if (bytes > REMOTE_OUTBOX_PENDING_BYTES_LIMIT) throw new RemoteOutboxCapacityError(id);
    if (this.totalPendingBytes === undefined) {
      let total = 0;
      for (const [, cursor] of this.storedCursors()) total += cursor.pendingBytes;
      this.totalPendingBytes = total;
    }
    if (this.totalPendingBytes + bytes - previous > REMOTE_OUTBOX_TOTAL_PENDING_BYTES_LIMIT) throw new RemoteOutboxCapacityError(id, 'total');
  }
  private adjustTotal(bytes: number): void {
    if (this.totalPendingBytes !== undefined) this.totalPendingBytes += bytes;
  }
  private assertCurrent(): void {
    try { this.database.assertCurrent(); }
    catch (error) {
      const fenced = error instanceof ControlStoreError && error.code === 'storage_failure';
      throw new RemoteStorageError(fenced ? 'Remote persistence is fenced after a failed commit; reopen it.' : 'Remote storage access failed.', { cause: error });
    }
  }
  private query<T>(read: () => T): T {
    try { return read(); }
    catch (error) {
      if (error instanceof RemoteIntegrityError || error instanceof RemoteStorageError) throw error;
      throw new RemoteStorageError('Remote storage access failed.', { cause: error });
    }
  }
  private commit(action: () => void): void {
    this.assertCurrent();
    try { this.database.transaction(action); }
    catch (error) { throw new RemoteStorageError('Remote storage commit failed.', { cause: error }); }
  }
  private flushSession(id: string): void {
    const cursor = this.cursors.get(id);
    if (!cursor?.buffered.length) return;
    this.commit(() => {
      for (const row of cursor.buffered) this.database.insertOutbox(id, row.seq, row.bytes, row.data);
      this.writeCursor(id, cursor);
    });
    cursor.buffered = [];
  }
  private schedule(): void {
    this.scheduled ??= setImmediate(() => {
      this.scheduled = undefined;
      for (const [id, cursor] of this.cursors) {
        if (!cursor.buffered.length) continue;
        try { this.flush(id); }
        catch (error) { this.errorHandler?.(id, error instanceof Error ? error : new RemoteStorageError('Remote outbox flush failed.')); }
      }
    });
  }
}

function parseStored<T extends import('typebox').TSchema>(schema: T, value: string): import('typebox').Static<T> {
  try { return parseSchema(schema, JSON.parse(value)); }
  catch { throw new RemoteIntegrityError('Remote outbox contains an invalid record.'); }
}
