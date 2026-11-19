import { describe, expect, it } from 'vitest';
import { PUBLICATION_LIMITS, type PublishedEvent, type PublishedSession, type PublishedTaskDetail } from '@felan-ai/session-protocol';
import { publicationBatches, taskDetailBatches } from '../src/remote/batch.js';

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

describe('remote task detail batches', () => {
  it('splits 257 tasks in order at the 256-task limit', () => {
    const tasks = Array.from({ length: 257 }, (_, index) => ({ id: `T-${index}` }));
    const batches = taskDetailBatches(session.session, tasks);
    expect(batches.map(batch => batch.length)).toEqual([256, 1]); expect(batches.flat()).toEqual(tasks);
  });
  it('accounts for UTF-8 JSON envelope bytes and commas at the 4 MiB boundary', () => {
    const tasks: PublishedTaskDetail[] = [{ id: 'T-ABC123', notes: '' }, { id: 'T-DEF456' }];
    const available = PUBLICATION_LIMITS.batchBytes - Buffer.byteLength(JSON.stringify({ p_session: session.session, p_tasks: tasks }));
    tasks[0]!.notes = '🦊'.repeat(Math.floor(available / 4)) + 'x'.repeat(available % 4);
    expect(Buffer.byteLength(JSON.stringify({ p_session: session.session, p_tasks: tasks }))).toBe(PUBLICATION_LIMITS.batchBytes);
    expect(taskDetailBatches(session.session, tasks)).toEqual([tasks]);
    tasks[0]!.notes += 'x';
    const batches = taskDetailBatches(session.session, tasks);
    expect(batches.map(batch => batch.length)).toEqual([1, 1]); expect(batches.flat()).toEqual(tasks);
    for (const batch of batches) expect(Buffer.byteLength(JSON.stringify({ p_session: session.session, p_tasks: batch }))).toBeLessThanOrEqual(PUBLICATION_LIMITS.batchBytes);
  });
  it('does not publish an empty task detail batch', () => { expect(taskDetailBatches(session.session, [])).toEqual([]); });
  it('rejects a task that cannot fit in a batch on its own', () => {
    const task: PublishedTaskDetail = { id: 'T-ABC123', notes: 'x'.repeat(PUBLICATION_LIMITS.batchBytes) };
    expect(() => taskDetailBatches(session.session, [task])).toThrow(/byte limit/u);
  });
});
