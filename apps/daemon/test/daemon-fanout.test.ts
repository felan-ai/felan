import { afterEach, describe, expect, it, vi } from 'vitest';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { LIMITS, type SessionEvent, type SessionSnapshot, type TextStreamEvent } from '@felan-ai/session-protocol';
import { SessionFanout, type FanoutSink, type SnapshotSource } from '../src/daemon/fanout.js';
import type { ProjectionOutput } from '../src/daemon/projection.js';
import { serverFixture } from './fixtures/server.js';

const fixtures: Awaited<ReturnType<typeof serverFixture>>[] = [];
afterEach(async () => { await Promise.all(fixtures.splice(0).map(fixture => fixture.dispose())); });

function output(auto = true) {
  const messages: Record<string, unknown>[] = [];
  const callbacks: Array<(error?: Error | null) => void> = [];
  let blocked = false;
  const sink: FanoutSink = { close: vi.fn(), write(data, done) {
    messages.push(...new TextDecoder().decode(data).trimEnd().split('\n').map(line => JSON.parse(line))); callbacks.push(done);
    if (auto) done();
    return !blocked;
  } };
  return { sink, messages, callbacks, block: (value: boolean) => { blocked = value; } };
}

async function sourceFixture() {
  const fixture = await serverFixture(); fixtures.push(fixture);
  const snapshot = fixture.registry.projection(fixture.root.sessionId).snapshot();
  snapshot.revision = 7; snapshot.history.revision = 7;
  snapshot.activeStreams = [{ id: 'stream', message: 'message', kind: 'assistant', text: 'a😀', offset: 2 }];
  const listeners = new Set<(event: ProjectionOutput) => void>();
  const source: SnapshotSource = { snapshot: () => structuredClone(snapshot), subscribe(listener) {
    listeners.add(listener); return () => { listeners.delete(listener); };
  } };
  const emit = (event: ProjectionOutput) => { for (const listener of listeners) listener(event); };
  const event = (rev: number): SessionEvent => ({ v: 1, session: snapshot.session, rev,
    change: { type: 'metadata.updated', title: `${rev}`, state: 'open', residency: 'warm' } });
  const text = (offset: number, value: string): TextStreamEvent => ({ v: 1, session: snapshot.session,
    stream: { id: 'stream', message: 'message', kind: 'assistant', offset }, text: value });
  const response = (value: SessionSnapshot) => ({ v: 1, re: 'attach', outcome: 'accepted', result: { attachmentId: 'attachment', snapshot: value } });
  return { fixture, snapshot, listeners, source, emit, event, text, response };
}

describe('bounded per-connection fan-out', () => {
  it('waits for the outcome write callback before performing a deferred resnapshot', async () => {
    const out = output(false); const fanout = new SessionFanout(out.sink); const invalidate = vi.fn(() => fanout.close('resync_required'));
    fanout.send({ v: 1, re: 'label', outcome: 'accepted', result: {} }, invalidate);
    expect(out.messages).toHaveLength(0); await nextTurn();
    expect(out.messages).toHaveLength(1); expect(invalidate).not.toHaveBeenCalled(); expect(out.sink.close).not.toHaveBeenCalled();
    out.callbacks[0]!(); expect(invalidate).toHaveBeenCalledOnce(); expect(out.sink.close).toHaveBeenCalledWith('resync_required');
    out.callbacks[0]!(); expect(invalidate).toHaveBeenCalledOnce();
  });
  it('counts bytes until transport completion, including writes accepted into its own buffer', async () => {
    const out = output(false); const fanout = new SessionFanout(out.sink);
    expect(fanout.send({ v: 1, text: '😀' })).toBe(true);
    expect(fanout.pendingFrames).toBe(1);
    expect(fanout.pendingBytes).toBe(Buffer.byteLength(JSON.stringify({ v: 1, text: '😀' }) + '\n'));
    await nextTurn();
    out.callbacks[0]!(); expect(fanout.pendingBytes).toBe(0); expect(fanout.pendingFrames).toBe(0);
    out.callbacks[0]!(); expect(fanout.pendingBytes).toBe(0);
  });

  it('waits for drain without reordering queued frames', async () => {
    const out = output(false); out.block(true); const fanout = new SessionFanout(out.sink);
    fanout.send({ value: 1 }); await nextTurn(); fanout.send({ value: 2 }); fanout.send({ value: 3 });
    expect(out.messages).toEqual([{ value: 1 }]); expect(fanout.pendingFrames).toBe(3);
    out.callbacks[0]!(); expect(out.messages).toHaveLength(1);
    out.block(false); fanout.drain();
    await nextTurn();
    expect(out.messages).toEqual([{ value: 1 }, { value: 2 }, { value: 3 }]);
    expect(out.callbacks).toHaveLength(2); out.callbacks[1]!(); expect(fanout.pendingBytes).toBe(0);
  });

  it('handles synchronous write callbacks without leaking or recursively reordering', async () => {
    const out = output(); const fanout = new SessionFanout(out.sink);
    for (let value = 0; value < 10; value++) expect(fanout.send({ value })).toBe(true);
    expect(out.messages).toHaveLength(0); await nextTurn();
    expect(out.messages.map(message => message.value)).toEqual(Array.from({ length: 10 }, (_, value) => value));
    expect(fanout.pendingFrames).toBe(0);
    expect(out.callbacks).toHaveLength(1);
  });

  it('makes byte/frame overflow explicit, clears buffers and ignores late write callbacks', () => {
    for (const limits of [{ bytes: 20, frames: 10 }, { bytes: 1000, frames: 1 }]) {
      const out = output(false); const fanout = new SessionFanout(out.sink, limits);
      fanout.send({ text: 'first' }); expect(fanout.send({ text: 'second' })).toBe(false);
      expect(out.sink.close).toHaveBeenCalledExactlyOnceWith('resync_required');
      expect(fanout.closed).toBe(true); expect(fanout.pendingBytes).toBe(0); expect(fanout.pendingFrames).toBe(0);
      for (const callback of out.callbacks) callback();
      expect(fanout.pendingBytes).toBe(0); expect(fanout.send({ text: 'third' })).toBe(false);
    }
  });

  it('closes on transport errors and rejects unsafe or invalid limits', async () => {
    const out = output(false); const fanout = new SessionFanout(out.sink);
    fanout.send({ value: 1 }); await nextTurn(); out.callbacks[0]!(new Error('synthetic write error'));
    expect(out.sink.close).toHaveBeenCalledWith('transport_error');
    expect(() => new SessionFanout(out.sink, { bytes: 0, frames: 1 })).toThrow();
    const malformed = output(); const another = new SessionFanout(malformed.sink);
    expect(another.send({ bad: undefined })).toBe(false);
    expect(malformed.sink.close).toHaveBeenCalledWith('resync_required');
  });

  it('merges contiguous code-point deltas without mutating shared events or losing callbacks', async () => {
    const out = output(false); const fanout = new SessionFanout(out.sink, { bytes: 1024, frames: 1 });
    const first: TextStreamEvent = { v: 1, session: 'session', stream: { id: 'stream', message: 'message', kind: 'assistant', offset: 0 }, text: 'a😀' };
    const second = { ...first, stream: { ...first.stream, offset: 2 }, text: '\n"b' };
    const before = structuredClone([first, second]); const callbacks = [vi.fn(), vi.fn()];
    expect(fanout.send(first, callbacks[0])).toBe(true); expect(fanout.send(second, callbacks[1])).toBe(true);
    const merged = { ...first, text: first.text + second.text };
    expect(fanout.pendingFrames).toBe(1); expect(fanout.pendingBytes).toBe(Buffer.byteLength(JSON.stringify(merged) + '\n'));
    expect([first, second]).toEqual(before); await nextTurn();
    expect(out.messages).toEqual([merged]); expect(callbacks.every(callback => callback.mock.calls.length === 0)).toBe(true);
    out.callbacks[0]!(); out.callbacks[0]!(); fanout.close();
    for (const callback of callbacks) expect(callback).toHaveBeenCalledOnce();
  });

  it('keeps revisioned events, non-contiguous deltas and other streams in FIFO order', async () => {
    const out = output(); const fanout = new SessionFanout(out.sink);
    const text: TextStreamEvent = { v: 1, session: 'session', stream: { id: 'stream', message: 'message', kind: 'assistant', offset: 0 }, text: 'a' };
    const events = [text, { v: 1, session: 'session', rev: 1, change: { type: 'unknown' } },
      { ...text, stream: { ...text.stream, offset: 1 } }, { ...text, stream: { ...text.stream, offset: 3 } },
      { ...text, stream: { ...text.stream, offset: 4, kind: 'thinking' } },
      { ...text, stream: { ...text.stream, offset: 5, id: 'other' } },
      { ...text, stream: { ...text.stream, offset: 6, message: 'other' } },
      { ...text, session: 'other', stream: { ...text.stream, offset: 7 } }];
    for (const event of events) fanout.send(event);
    expect(fanout.pendingFrames).toBe(events.length); await nextTurn(); expect(out.messages).toEqual(events);
  });

  it('skips empty fragments without changing code-point offsets or byte accounting', async () => {
    const out = output(); const fanout = new SessionFanout(out.sink);
    const text: TextStreamEvent = { v: 1, session: 'session', stream: { id: 'stream', message: 'message', kind: 'assistant', offset: 0 }, text: '😀' };
    fanout.send(text);
    for (const value of ['', 'z']) fanout.send({ ...text, stream: { ...text.stream, offset: 1 }, text: value });
    const merged = { ...text, text: '😀z' };
    expect(fanout.pendingFrames).toBe(1); expect(fanout.pendingBytes).toBe(Buffer.byteLength(JSON.stringify(merged) + '\n'));
    await nextTurn(); expect(out.messages).toEqual([merged]); expect(fanout.pendingBytes).toBe(0);
  });

  it('does not merge past active-stream or pending-byte limits', async () => {
    const text: TextStreamEvent = { v: 1, session: 'session', stream: { id: 'stream', message: 'message', kind: 'assistant', offset: 0 }, text: 'x'.repeat(LIMITS.activeStreamBytes) };
    const out = output(); const fanout = new SessionFanout(out.sink);
    fanout.send(text); fanout.send({ ...text, stream: { ...text.stream, offset: text.text.length }, text: 'y' });
    expect(fanout.pendingFrames).toBe(2); await nextTurn(); expect(out.messages).toHaveLength(2);
    const bounded = output(); const small = { ...text, text: 'x' };
    const limited = new SessionFanout(bounded.sink, { bytes: Buffer.byteLength(JSON.stringify(small) + '\n'), frames: 2 });
    limited.send(small); expect(limited.send({ ...small, stream: { ...small.stream, offset: 1 } })).toBe(false);
    expect(bounded.sink.close).toHaveBeenCalledWith('resync_required'); expect(limited.pendingBytes).toBe(0);
  });

  it('runs queued, merged and in-flight callbacks once on close and ignores late completions', async () => {
    const out = output(false); const fanout = new SessionFanout(out.sink); const callbacks = [vi.fn(), vi.fn(), vi.fn()];
    fanout.send({ value: 1 }, callbacks[0]); await nextTurn();
    const text: TextStreamEvent = { v: 1, session: 'session', stream: { id: 'stream', message: 'message', kind: 'assistant', offset: 0 }, text: 'a' };
    fanout.send(text, callbacks[1]); fanout.send({ ...text, stream: { ...text.stream, offset: 1 } }, callbacks[2]);
    fanout.close(); out.callbacks[0]!(); await nextTurn();
    expect(out.messages).toEqual([{ value: 1 }]); expect(fanout.pendingFrames).toBe(0);
    for (const callback of callbacks) expect(callback).toHaveBeenCalledOnce();
  });
});

describe('atomic snapshot/live handoff', () => {
  it('coalesces only post-snapshot text after classifying held duplicates', async () => {
    const f = await sourceFixture(); const out = output(false); const fanout = new SessionFanout(out.sink);
    f.source.snapshot = () => { f.emit(f.text(0, 'a😀')); f.emit(f.text(2, 'b')); f.emit(f.text(3, '😀')); return structuredClone(f.snapshot); };
    fanout.attach(f.source, f.response);
    expect(fanout.pendingFrames).toBe(2);
    await nextTurn(); expect(out.messages.map(message => message.re ?? message.text)).toEqual(['attach', 'b😀']);
    out.callbacks[0]!(); expect(fanout.pendingBytes).toBe(0); fanout.close();
  });

  it('sends snapshot first, drops covered revisions/text, and preserves events reentered during send', async () => {
    const f = await sourceFixture(); const out = output(); const fanout = new SessionFanout(out.sink);
    f.source.snapshot = () => { f.emit(f.event(7)); f.emit(f.text(0, 'a😀')); return structuredClone(f.snapshot); };
    const write = out.sink.write;
    let first = true;
    out.sink.write = (data, done) => {
      const result = write(data, done);
      if (first) { first = false; f.emit(f.event(9)); f.emit(f.text(3, 'c')); }
      return result;
    };
    const detach = fanout.attach(f.source, snapshot => { f.emit(f.event(8)); f.emit(f.text(2, 'b')); return f.response(snapshot); });
    await nextTurn(); await nextTurn();
    expect(out.messages.map(message => message.re ?? message.rev ?? message.text)).toEqual(['attach', 8, 'b', 9, 'c']);
    f.emit(f.event(10)); await nextTurn(); expect(out.messages.at(-1)?.rev).toBe(10);
    detach(); f.emit(f.event(11)); expect(out.messages).toHaveLength(6);
    expect(f.listeners.size).toBe(0); expect(fanout.closed).toBe(false); expect(fanout.pendingBytes).toBe(0);
  });

  it('discards completed and completion-only text buffered at cutover', async () => {
    for (const completed of [false, true]) {
      const f = await sourceFixture(); const out = output(); const fanout = new SessionFanout(out.sink);
      if (completed) f.snapshot.history.entries.push({ id: 'message', entryId: 'entry', role: 'assistant', content: [{ type: 'text', text: 'done' }], timestamp: 1,
        origin: { kind: 'tui', attachment: 'fixture' } });
      else f.snapshot.completionOnlyStreams = [{ id: 'stream', message: 'message', kind: 'assistant', reason: 'lost' }];
      f.snapshot.activeStreams = [];
      fanout.attach(f.source, snapshot => { f.emit(f.text(100, 'not recoverable')); return f.response(snapshot); });
      await nextTurn();
      expect(out.messages).toHaveLength(1);
      fanout.close(); expect(f.listeners.size).toBe(0);
    }
  });

  it('requires resnapshot on an inconsistent stream prefix or a revision gap', async () => {
    for (const event of ['stream', 'revision'] as const) {
      const f = await sourceFixture(); const out = output(); const fanout = new SessionFanout(out.sink);
      fanout.attach(f.source, snapshot => {
        f.emit(event === 'stream' ? f.text(0, 'changed') : f.event(9)); return f.response(snapshot);
      });
      expect(out.sink.close).toHaveBeenCalledWith('resync_required'); expect(f.listeners.size).toBe(0);
    }
  });

  it('rejects live gaps and wrong-session events rather than inventing revisions or leaking another session', async () => {
    for (const wrongSession of [false, true]) {
      const f = await sourceFixture(); const out = output(); const fanout = new SessionFanout(out.sink);
      fanout.attach(f.source, f.response);
      await nextTurn();
      f.emit(wrongSession ? { ...f.event(8), session: 'other' } : f.event(9));
      expect(out.messages).toHaveLength(1); expect(out.sink.close).toHaveBeenCalledWith('resync_required');
      expect(f.listeners.size).toBe(0);
    }
  });

  it('bounds events held while taking a snapshot and unsubscribes on failure', async () => {
    const f = await sourceFixture(); const out = output(); const fanout = new SessionFanout(out.sink, { bytes: 8192, frames: 2 });
    f.source.snapshot = () => { for (let rev = 8; rev < 11; rev++) f.emit(f.event(rev)); return structuredClone(f.snapshot); };
    fanout.attach(f.source, f.response);
    expect(out.sink.close).toHaveBeenCalledWith('resync_required'); expect(out.messages).toEqual([]);
    expect(f.listeners.size).toBe(0); expect(fanout.pendingBytes).toBe(0);
    const next = new SessionFanout(output().sink);
    f.source.snapshot = () => { throw new Error('synthetic snapshot error'); };
    expect(() => next.attach(f.source, f.response)).toThrow('synthetic snapshot error');
    expect(f.listeners.size).toBe(0); expect(next.pendingFrames).toBe(0);
  });

  it('disconnects only a slow connection and never cancels the shared session', async () => {
    const f = await sourceFixture(); const slow = output(false); const fast = output();
    const slowFanout = new SessionFanout(slow.sink, { bytes: 16384, frames: 1 }); const fastFanout = new SessionFanout(fast.sink);
    const cancel = vi.spyOn(f.fixture.registry, 'cancel');
    slowFanout.attach(f.source, f.response); const detach = fastFanout.attach(f.source, f.response);
    await nextTurn();
    f.emit(f.event(8)); f.emit(f.event(9));
    await nextTurn();
    expect(slow.sink.close).toHaveBeenCalledWith('resync_required');
    expect(fast.messages.map(message => message.rev ?? message.re)).toEqual(['attach', 8, 9]);
    expect(f.listeners.size).toBe(1); expect(cancel).not.toHaveBeenCalled();
    detach(); expect(cancel).not.toHaveBeenCalled();
  });
});
