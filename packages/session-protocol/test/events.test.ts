import { describe, expect, it } from 'vitest';
import { LIMITS, SessionSnapshotSchema, classifyRevision, classifyTextDelta, parseSchema, parseServerEnvelope, parseSessionEvent, parseSessionSnapshot,
  parseStoredEventRow } from '../src/index.js';
import { history, interaction, message, policy, process, snapshot, tool } from './fixtures.js';

describe('snapshot cutover and stream convergence', () => {
  it('retains complete independent assistant/thinking prefixes and a pinned history revision', () => {
    expect(parseSessionSnapshot(snapshot)).toEqual(snapshot);
    expect(() => parseSessionSnapshot({ ...snapshot, history: { ...history, revision: 6 } })).toThrow(/cutover/);
    expect(() => parseSessionSnapshot({ ...snapshot, history: { ...history, branch: 'different' } })).toThrow(/cutover/);
    expect(() => parseSessionSnapshot({ ...snapshot, activeStreams: [{ ...snapshot.activeStreams[0], offset: 3 }] })).toThrow(/prefix/);
    expect(() => parseSessionSnapshot({ ...snapshot, activeStreams: [...snapshot.activeStreams, snapshot.activeStreams[0]] })).toThrow(/identities/);
  });
  it('bounds retained prefixes per stream, in aggregate and by count', () => {
    const stream = { message: 'message', id: 's', kind: 'assistant', text: 'a'.repeat(LIMITS.activeStreamBytes), offset: LIMITS.activeStreamBytes };
    expect(parseSessionSnapshot({ ...snapshot, activeStreams: [stream] }).activeStreams).toHaveLength(1);
    expect(() => parseSessionSnapshot({ ...snapshot, activeStreams: [{ ...stream, text: stream.text + 'a', offset: stream.offset + 1 }] })).toThrow();
    expect(() => parseSessionSnapshot({ ...snapshot, activeStreams: Array.from({ length: 5 }, (_, i) => ({ ...stream, id: String(i) })) })).toThrow(/aggregate/);
    expect(() => parseSessionSnapshot({ ...snapshot, activeStreams: [], completionOnlyStreams: Array.from({ length: 9 }, (_, i) => ({ message: 'm', id: String(i), kind: 'thinking', reason: 'lost' })) })).toThrow();
  });
  it('uses Unicode code points and distinguishes duplicates, gaps, late and completion-only deltas', () => {
    const prefix = snapshot.activeStreams[0]!;
    const delta = { v: 1, session: 'session', stream: { message: prefix.message, id: prefix.id, kind: prefix.kind, offset: 2 }, text: '✓😀' };
    expect(classifyTextDelta(prefix, delta)).toBe('append');
    expect(classifyTextDelta(prefix, { ...delta, stream: { ...delta.stream, offset: 1 }, text: '😀' })).toBe('duplicate');
    expect(classifyTextDelta(prefix, { ...delta, stream: { ...delta.stream, offset: 1 }, text: 'wrong' })).toBe('gap');
    expect(classifyTextDelta(prefix, { ...delta, stream: { ...delta.stream, offset: 3 } })).toBe('gap');
    expect(classifyTextDelta(prefix, { ...delta, stream: { ...delta.stream, kind: 'thinking' } })).toBe('gap');
    expect(classifyTextDelta(prefix, delta, 'completion_only')).toBe('ignore');
    expect(classifyTextDelta(undefined, delta)).toBe('gap');
    expect(classifyTextDelta(undefined, delta, 'completed')).toBe('ignore');
    expect(parseServerEnvelope(delta)).toEqual(delta);
  });
  it('allows one completion-only identity without inventing a partial prefix', () => {
    const value = { ...snapshot, activeStreams: [], completionOnlyStreams: [{ message: 'message', id: 'stream', kind: 'assistant', reason: 'lost' }] };
    expect(parseSessionSnapshot(value).completionOnlyStreams).toHaveLength(1);
    expect(() => parseSessionSnapshot({ ...value, activeStreams: [{ message: 'message', id: 'stream', kind: 'assistant', text: '', offset: 0 }] })).toThrow();
  });
  it('does not serialize obsolete session environment metadata', () => {
    const output = parseSessionSnapshot({ ...snapshot, environment: { available: false, missingNames: ['PATH'], values: { SECRET: 'fake-secret' } } });
    expect(JSON.stringify(output)).not.toContain('fake-secret');
    expect(output).not.toHaveProperty('environment');
  });
});

describe('durable revisions and coalesced state changes', () => {
  const changes = [
    { type: 'message.completed', message }, { type: 'tool.updated', tool },
    { type: 'run.updated', run: snapshot.run }, { type: 'queue.updated', queue: [] },
    { type: 'interaction.requested', interaction },
    { type: 'interaction.resolved', interaction: { ...interaction, state: 'answered', responder: 'tui', resolvedAt: interaction.createdAt + 1, result: { kind: 'confirm', confirmed: true } } },
    { type: 'metadata.updated', title: 'title', state: 'open', residency: 'evicted' },
    { type: 'model.updated', model: snapshot.model, thinking: 'high' }, { type: 'branch.updated', branch: 'branch', history },
    { type: 'policy.updated', policy }, { type: 'child.updated', child: { session: 'child', parent: 'session', root: 'session', title: 'child', run: { state: 'idle' }, state: 'open' } },
    { type: 'process.updated', process }, { type: 'presentation.updated', presentation: { id: 'status', kind: 'status', text: 'working' } },
    { type: 'presentation.removed', id: 'status' }, { type: 'catalog.updated', catalog: snapshot.catalog },
    { type: 'stream.completion_only', stream: { message: 'message', id: 'stream', kind: 'thinking', reason: 'limit' } },
  ];
  it.each(changes.map(change => [change.type, change] as const))('%s is revisioned and has a transport-neutral row', (_type, change) => {
    const event = { v: 1, session: 'session', rev: 8, change };
    expect(parseSessionEvent(event)).toEqual(event);
    const { v: _v, ...row } = event;
    expect(parseStoredEventRow({ schemaVersion: 1, ...row })).toEqual({ schemaVersion: 1, ...row });
    expect(() => parseSessionEvent({ ...event, rev: undefined })).toThrow();
  });
  it('bounds replacement tool/status projections and preserves authoritative completion', () => {
    expect(parseSessionEvent({ v: 1, session: 'session', rev: 8, change: { type: 'tool.updated', tool: { ...tool, state: 'completed', output: 'final' } } })).toBeTruthy();
    expect(() => parseSessionEvent({ v: 1, session: 'session', rev: 8, change: { type: 'tool.updated', tool: { ...tool, output: 'a'.repeat(LIMITS.statusTextBytes + 1) } } })).toThrow();
    expect(() => parseSessionEvent({ v: 1, session: 'session', rev: 8, change: { type: 'presentation.updated', presentation: { id: 's', kind: 'status', text: 'a'.repeat(LIMITS.structuredBytes) } } })).toThrow();
    expect(parseSessionEvent({ v: 1, session: 'session', rev: 9, change: { type: 'message.completed', message } })).toMatchObject({ rev: 9 });
  });
  it('ignores unknown additive event kinds without forgiving malformed known kinds', () => {
    expect(parseSessionEvent({ v: 1, session: 'session', rev: 8, change: { type: 'future.addition', data: { safe: true } } })).toMatchObject({ rev: 8 });
    expect(() => parseSessionEvent({ v: 1, session: 'session', rev: 8, change: { type: 'tool.updated' } })).toThrow();
    expect(() => parseStoredEventRow({ schemaVersion: 2, session: 's', rev: 1, change: { type: 'future.addition' } })).toThrow();
    expect(classifyRevision(7, 8)).toBe('next');
    expect(classifyRevision(7, 7)).toBe('duplicate');
    expect(classifyRevision(7, 6)).toBe('duplicate');
    expect(classifyRevision(7, 9)).toBe('gap');
    expect(() => classifyRevision(7, Number.MAX_SAFE_INTEGER + 1)).toThrow();
  });
  it('bounds snapshot/history page entries', () => {
    expect(() => parseSchema(SessionSnapshotSchema, { ...snapshot, history: { ...history, entries: Array.from({ length: 257 }, () => message) } })).toThrow();
    expect(() => parseSessionEvent({ v: 1, session: 's', rev: 0, change: { type: 'future.addition' } })).toThrow();
    expect(() => parseSessionEvent({ v: 1, session: 's', rev: 8, change: { type: 'interaction.resolved', interaction } })).toThrow();
    const entries = Array.from({ length: 200 }, () => ({ ...message, content: [{ type: 'text', text: 'a'.repeat(65536) }] }));
    expect(() => parseSessionSnapshot({ ...snapshot, history: { ...history, entries } })).toThrow(/limit/);
    expect([LIMITS.unsentBytes, LIMITS.inflightRequests]).toEqual([32 * 1024 * 1024, 64]);
  });
});
