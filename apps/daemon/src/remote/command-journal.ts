import type { RemoteDatabase } from '../daemon/persistence.js';
import { RemoteIntegrityError } from './state.js';
import { parseClientEnvelope, parseRemoteCommandOutcome, requestTimestamp, type ClientEnvelope, type RemoteCommandOutcome } from '@felan-ai/session-protocol';
import { commandError } from '../daemon/commands.js';

export type RemoteCommandJournalEntry =
  | { id: string; identity: string; state: 'dispatching'; request: ClientEnvelope; createdSession?: string }
  | { id: string; identity: string; state: 'completed'; outcome: RemoteCommandOutcome };

export interface CommandJournal {
  get(id: string): RemoteCommandJournalEntry | undefined;
  write(entry: RemoteCommandJournalEntry): void;
  forget(id: string): void;
}

export class RemoteCommandJournal implements CommandJournal {
  private count: number | undefined;
  constructor(private readonly database: RemoteDatabase, private readonly capacity = 4096) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) throw commandError('invalid_request');
    database.assertCurrent();
  }

  get(id: string): RemoteCommandJournalEntry | undefined {
    id = id.toLowerCase();
    requestTimestamp(id);
    const data = this.database.record('command', id);
    if (data === undefined) return undefined;
    try { return this.validate(JSON.parse(data), id); }
    catch { throw new RemoteIntegrityError('Remote command journal is unreadable; refusing to replay.'); }
  }

  write(entry: RemoteCommandJournalEntry): void {
    requestTimestamp(entry.id);
    this.validate(entry, entry.id);
    const fresh = !this.get(entry.id);
    if (fresh && (this.count ??= this.database.records('command').length) >= this.capacity) {
      throw commandError('request_capacity', 'Remote command journal is full; acknowledge completed commands first.');
    }
    this.database.transaction(() => this.database.putRecord('command', entry.id.toLowerCase(), JSON.stringify(entry)));
    if (fresh) this.count = this.count! + 1;
  }

  forget(id: string): void {
    const entry = this.get(id);
    if (!entry) return;
    if (entry.state !== 'completed') throw commandError('invalid_request', 'An unfinished remote command cannot be forgotten.');
    this.database.transaction(() => this.database.deleteRecord('command', id.toLowerCase()));
    if (this.count !== undefined) this.count--;
  }

  private validate(value: unknown, id: string): RemoteCommandJournalEntry {
    if (!value || typeof value !== 'object' || !('id' in value) || value.id !== id || !('identity' in value)
      || typeof value.identity !== 'string' || !/^[a-f0-9]{64}$/u.test(value.identity) || !('state' in value)) throw commandError('storage_failure');
    if (value.state === 'completed' && 'outcome' in value) {
      const outcome = parseRemoteCommandOutcome(value.outcome);
      if (outcome.re !== id) throw commandError('storage_failure');
      // The generic protocol response union normalizes valid result fields away through its empty-result branch.
      const preserved = outcome.outcome === 'accepted'
        ? { ...outcome, result: structuredClone((value.outcome as ResponseResult).result) } : outcome;
      return { id, identity: value.identity, state: 'completed', outcome: preserved };
    }
    if (value.state === 'dispatching' && 'request' in value) {
      const request = parseClientEnvelope(value.request);
      const createdSession = 'createdSession' in value ? value.createdSession : undefined;
      if (createdSession !== undefined && typeof createdSession !== 'string') throw commandError('storage_failure');
      return { id, identity: value.identity, state: 'dispatching', request, ...(createdSession ? { createdSession } : {}) };
    }
    throw commandError('storage_failure');
  }
}

type ResponseResult = { result: Extract<RemoteCommandOutcome, { outcome: 'accepted' }>['result'] };
