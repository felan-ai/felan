import { describe, expect, it } from 'vitest';
import { PUBLICATION_LIMITS, type PublishedEvent, type PublishedSession } from '@felan-ai/session-protocol';
import { publicationBatches } from '../src/remote/batch.js';

const session: PublishedSession = { schemaVersion: 1, session: '01999999-1111-7111-8111-111111111111', title: 'Test', directory: 'project', state: 'open', runState: 'idle', shared: true };
function event(seq: number, title = ''): PublishedEvent { return { schemaVersion: 1, session: session.session, seq, rev: seq, occurredAt: 1, change: { type: 'metadata.updated', title, state: 'open', residency: 'warm' } }; }

describe('remote publication batches', () => {
  it('splits 501 events in order at the 500-event limit', () => {
    const events = Array.from({ length: 501 }, (_, i) => event(i + 1)); const batches = publicationBatches(session, events);
    expect(batches.map(batch => batch.length)).toEqual([500, 1]); expect(batches.flat()).toEqual(events);
  });
  it('accounts for UTF-8 JSON envelope bytes and commas at the 4 MiB boundary', () => {
    const events = Array.from({ length: 5 }, (_, i) => event(i + 1, '🦊'.repeat(256_000)));
    const batches = publicationBatches(session, events); expect(batches.map(batch => batch.length)).toEqual([4, 1]);
    for (const batch of batches) expect(Buffer.byteLength(JSON.stringify({ p_session: session, p_events: batch }))).toBeLessThanOrEqual(PUBLICATION_LIMITS.batchBytes);
    expect(batches.flat()).toEqual(events);
  });
  it('does not fit four 1 MiB changes once envelope overhead is included', () => {
    const events = Array.from({ length: 4 }, (_, i) => event(i + 1, 'a'.repeat(PUBLICATION_LIMITS.changeBytes - 100)));
    expect(publicationBatches(session, events).map(batch => batch.length)).toEqual([3, 1]);
  });
  it('provides an empty-events batch for a one-time unshare index update', () => { expect(publicationBatches(session, [])).toEqual([[]]); });
  it('rejects an oversized single event and a foreign session', () => {
    expect(() => publicationBatches(session, [event(1, 'x'.repeat(PUBLICATION_LIMITS.batchBytes))])).toThrow(/byte limit/u);
    expect(() => publicationBatches(session, [{ ...event(1), session: '01999999-2222-7222-8222-222222222222' }])).toThrow(/another session/u);
  });
});
