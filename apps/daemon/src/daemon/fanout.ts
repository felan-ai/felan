import { LIMITS, classifyTextDelta, codePointLength, encodeFrame, type SessionSnapshot, type TextStreamEvent } from '@felan-ai/session-protocol';
import type { ProjectionOutput } from './projection.js';

export interface FanoutSink {
  write(data: Uint8Array, done: (error?: Error | null) => void): boolean;
  close(reason: 'closed' | 'transport_error' | 'resync_required'): void;
}
export interface SnapshotSource {
  subscribe(listener: (event: ProjectionOutput) => void): () => void;
  snapshot(): SessionSnapshot;
}
interface Frame {
  data?: Uint8Array;
  bytes: number;
  state: 'held' | 'queued' | 'sending' | 'done';
  afterSend?: Array<() => void>;
  text?: { event: TextStreamEvent; parts: string[]; bytes: number; length: number };
}

function textEvent(value: unknown): TextStreamEvent | undefined {
  if (!value || typeof value !== 'object' || 'change' in value || 'rev' in value) return undefined;
  const event = value as Partial<TextStreamEvent>;
  const stream = event.stream;
  if (event.v !== 1 || typeof event.session !== 'string' || typeof event.text !== 'string'
    || !stream || typeof stream.id !== 'string' || typeof stream.message !== 'string'
    || (stream.kind !== 'assistant' && stream.kind !== 'thinking') || !Number.isSafeInteger(stream.offset) || stream.offset < 0) return undefined;
  return event as TextStreamEvent;
}

export class SessionFanout {
  private readonly frames = new Set<Frame>();
  private readonly queue: Frame[] = [];
  private readonly detachments = new Set<() => void>();
  private bytes = 0;
  private blocked = false;
  private flushing = false;
  private stopped = false;
  private scheduled: ReturnType<typeof setImmediate> | undefined;

  constructor(private readonly sink: FanoutSink, private readonly limits: { bytes: number; frames: number } = { bytes: LIMITS.unsentBytes, frames: 1024 }) {
    if (!Number.isSafeInteger(limits.bytes) || limits.bytes < 1 || limits.bytes > LIMITS.unsentBytes
      || !Number.isSafeInteger(limits.frames) || limits.frames < 1 || limits.frames > 4096) throw new Error('Invalid fan-out limits.');
  }

  get closed(): boolean { return this.stopped; }
  get pendingBytes(): number { return this.bytes; }
  get pendingFrames(): number { return this.frames.size; }

  send(value: unknown, afterSend?: () => void): boolean {
    const frame = this.reserve(value, afterSend, true);
    if (!frame) { afterSend?.(); return false; }
    if (frame.state === 'held') this.publish(frame);
    return !this.stopped;
  }

  drain(): void { this.blocked = false; this.schedule(); }

  attach(source: SnapshotSource, snapshotResponse: (snapshot: SessionSnapshot) => unknown): () => void {
    if (this.stopped) throw new Error('Fan-out connection is closed.');
    const held: Array<{ event: ProjectionOutput; frame: Frame }> = [];
    let buffering = true; let detached = false; let unsubscribe = () => {};
    let session = ''; let revision = 0;
    const detach = () => {
      if (detached) return;
      detached = true; unsubscribe(); this.detachments.delete(detach);
      for (const item of held.splice(0)) this.release(item.frame);
    };
    this.detachments.add(detach);
    try {
      unsubscribe = source.subscribe(event => {
        if (detached || this.stopped) return;
        if (!buffering) {
          if (event.session !== session) { this.close('resync_required'); return; }
          if ('change' in event) {
            if (event.rev <= revision) return;
            if (event.rev !== revision + 1) { this.close('resync_required'); return; }
            revision = event.rev;
          }
          this.send(event); return;
        }
        const frame = this.reserve(event);
        if (frame) held.push({ event, frame });
      });
      if (detached || this.stopped) { unsubscribe(); return detach; }
      const snapshot = source.snapshot();
      session = snapshot.session; revision = snapshot.revision;
      if (!this.send(snapshotResponse(snapshot))) { detach(); return detach; }
      const prefixes = new Map(snapshot.activeStreams.map(stream => [stream.id, stream]));
      const completed = new Set(snapshot.history.entries.map(message => message.id));
      const completionOnly = new Set(snapshot.completionOnlyStreams.map(stream => stream.id));
      const started = new Set<string>();
      while (held.length && !this.stopped && !detached) {
        const { event, frame } = held.shift()!;
        if (event.session !== snapshot.session) { this.close('resync_required'); break; }
        if ('change' in event) {
          if (event.rev <= revision) this.release(frame);
          else if (event.rev !== revision + 1) { this.release(frame); this.close('resync_required'); }
          else { revision = event.rev; this.publish(frame); }
        } else if (started.has(event.stream.id)) this.publish(frame);
        else {
          const state = completed.has(event.stream.message) ? 'completed' : completionOnly.has(event.stream.id) ? 'completion_only' : 'active';
          const classification = classifyTextDelta(prefixes.get(event.stream.id), event, state);
          if (classification === 'duplicate' || classification === 'ignore') this.release(frame);
          else if (classification === 'gap') { this.release(frame); this.close('resync_required'); }
          else { started.add(event.stream.id); this.publish(frame); }
        }
      }
      buffering = false;
      return detach;
    } catch (error) { detach(); throw error; }
  }

  close(reason: 'closed' | 'transport_error' | 'resync_required' = 'closed'): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.scheduled) { clearImmediate(this.scheduled); this.scheduled = undefined; }
    for (const detach of [...this.detachments]) detach();
    const completed = [...this.frames].flatMap(frame => frame.afterSend ?? []);
    for (const frame of this.frames) { frame.state = 'done'; delete frame.afterSend; }
    this.frames.clear(); this.queue.length = 0; this.bytes = 0;
    try { this.sink.close(reason); }
    finally { for (const callback of completed) { try { callback(); } catch {} } }
  }

  private reserve(value: unknown, afterSend?: () => void, merge = false): Frame | undefined {
    if (this.stopped) return undefined;
    let data: Uint8Array;
    try { data = encodeFrame(value); }
    catch { this.close('resync_required'); return undefined; }
    const frame: Frame = { data, bytes: data.byteLength, state: 'held', ...(afterSend ? { afterSend: [afterSend] } : {}) };
    const event = textEvent(value);
    if (event) frame.text = { event: { ...event, stream: { ...event.stream } }, parts: [event.text], bytes: Buffer.byteLength(event.text),
      length: codePointLength(event.text) };
    if (merge) {
      const previous = this.mergeQueued(frame);
      if (previous) return previous;
      if (this.stopped) return undefined;
    }
    if (this.frames.size >= this.limits.frames || this.bytes + frame.bytes > this.limits.bytes) {
      this.close('resync_required'); return undefined;
    }
    this.frames.add(frame); this.bytes += frame.bytes;
    return frame;
  }

  private mergeQueued(frame: Frame): Frame | undefined {
    const previous = this.queue.at(-1);
    const left = previous?.text; const right = frame.text;
    if (!previous || !left || !right || left.event.session !== right.event.session
      || left.event.stream.id !== right.event.stream.id || left.event.stream.message !== right.event.stream.message
      || left.event.stream.kind !== right.event.stream.kind || right.event.stream.offset !== left.event.stream.offset + left.length) return undefined;
    const text = right.event.text;
    if (left.bytes + right.bytes > LIMITS.activeStreamBytes) return undefined;
    const addedBytes = Buffer.byteLength(JSON.stringify(text)) - 2;
    const tracked = this.frames.has(frame);
    if (this.bytes - (tracked ? frame.bytes : 0) + addedBytes > this.limits.bytes) {
      this.close('resync_required'); return undefined;
    }
    if (tracked) { this.frames.delete(frame); this.bytes -= frame.bytes; }
    frame.state = 'done';
    delete previous.data; previous.bytes += addedBytes; this.bytes += addedBytes;
    if (text.length) left.parts.push(text);
    left.bytes += right.bytes; left.length += right.length;
    if (frame.afterSend) (previous.afterSend ??= []).push(...frame.afterSend);
    return previous;
  }

  private release(frame: Frame): void {
    if (!this.frames.delete(frame)) return;
    frame.state = 'done'; this.bytes -= frame.bytes;
    const callbacks = frame.afterSend; delete frame.afterSend;
    for (const callback of callbacks ?? []) { try { callback(); } catch { this.close('resync_required'); } }
  }

  private publish(frame: Frame): void {
    if (frame.state !== 'held' || this.stopped) { this.release(frame); return; }
    if (this.mergeQueued(frame) || this.stopped) return;
    frame.state = 'queued'; this.queue.push(frame); this.schedule();
  }

  private schedule(): void {
    if (this.scheduled || this.flushing || this.blocked || this.stopped || !this.queue.length) return;
    this.scheduled = setImmediate(() => { this.scheduled = undefined; this.flush(); });
  }

  private flush(): void {
    if (this.flushing || this.blocked || this.stopped) return;
    this.flushing = true;
    try {
      const frames = this.queue.splice(0);
      if (!frames.length) return;
      const data = Buffer.concat(frames.map(frame => {
        frame.state = 'sending';
        return frame.data ?? encodeFrame({ ...frame.text!.event, text: frame.text!.parts.join('') });
      }));
      const accepted = this.sink.write(data, error => {
        if (error) this.close('transport_error');
        else for (const frame of frames) this.release(frame);
      });
      if (!accepted) this.blocked = true;
    } catch { this.close('transport_error'); }
    finally { this.flushing = false; this.schedule(); }
  }
}
