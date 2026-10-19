import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PUBLICATION_LIMITS, parseSchema, TextStreamEventSchema, type TextStreamEvent } from '@felan-ai/session-protocol';
import { RemoteRealtime, type BroadcastChannel, type RealtimeClientPort, type RemoteRealtimeOptions } from '../src/remote/realtime.js';
import type { RemoteClock } from '../src/remote/backoff.js';

const id = '0199e5f0-0000-7000-8000-000000000001';
const clock: RemoteClock = {
  now: () => Date.now(), setTimeout: (callback, delay) => setTimeout(callback, delay),
  clearTimeout: timer => clearTimeout(timer as ReturnType<typeof setTimeout>),
};
class Channel implements BroadcastChannel {
  status: ((status: string) => void) | undefined;
  broadcast: ((message: { payload?: unknown }) => void) | undefined;
  sent: { at: number; event: string; payload: TextStreamEvent }[] = [];
  constructor(readonly topic: string, readonly order: string[], readonly subscribeDelay = 0) {}
  on(_type: 'broadcast', filter: { event: string }, callback: (message: { payload?: unknown }) => void): this {
    expect(filter.event).toBe('command'); this.broadcast = callback; return this;
  }
  subscribe(callback: (status: string) => void): this {
    this.order.push(`join:${this.topic}`); this.status = callback;
    if (this.subscribeDelay) setTimeout(() => callback('SUBSCRIBED'), this.subscribeDelay);
    else callback('SUBSCRIBED');
    return this;
  }
  async send(message: { type: 'broadcast'; event: string; payload: unknown }): Promise<string> {
    this.sent.push({ at: Date.now(), event: message.event, payload: parseSchema(TextStreamEventSchema, message.payload) }); return 'ok';
  }
  unsubscribe = vi.fn(async () => { this.status?.('CLOSED'); return 'ok'; });
}
const managers: RemoteRealtime[] = [];
function setup(options: Partial<RemoteRealtimeOptions> = {}, subscribeDelay = 0) {
  const order: string[] = [];
  const channels: Channel[] = [];
  const client: RealtimeClientPort = {
    realtime: { setAuth: vi.fn(async () => { order.push('auth'); }) },
    channel: vi.fn((topic, config) => {
      expect(config).toEqual({ config: { private: true } });
      const channel = new Channel(topic, order, subscribeDelay); channels.push(channel); return channel;
    }),
  };
  const manager = new RemoteRealtime(client, { clock, random: () => 1, authorize: async () => { await client.realtime.setAuth('cached'); }, ...options });
  managers.push(manager);
  return { manager, client, channels, order, sent: () => channels.flatMap(channel => channel.sent) };
}
function delta(text: string, offset = 0, stream = 'stream'): TextStreamEvent {
  return { v: 1, session: id, stream: { id: stream, message: 'message', kind: 'assistant', offset }, text };
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0); });
afterEach(async () => { for (const manager of managers.splice(0)) await manager.close(); vi.useRealTimers(); });

describe('RemoteRealtime', () => {
  it('sets auth before the first private join and treats validated commands only as hints', async () => {
    const f = setup(); const listener = vi.fn();
    const unsubscribe = f.manager.subscribeCommands(id, listener);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.order).toEqual(['auth', `join:host:${id}`]);
    f.channels[0]!.broadcast?.({ payload: { id, op: 'cancel' } });
    f.channels[0]!.broadcast?.({ payload: { id, op: 'shell' } });
    f.channels[0]!.broadcast?.({ payload: 'bad' });
    expect(listener.mock.calls).toEqual([[{ id, op: 'cancel' }]]);
    unsubscribe();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.channels[0]!.unsubscribe).toHaveBeenCalledOnce();
  });

  it.each(['CLOSED', 'CHANNEL_ERROR', 'TIMED_OUT'])('rejoins on %s with backoff and refreshed auth', async status => {
    const f = setup(); const onSubscribed = vi.fn();
    f.manager.subscribeCommands(id, vi.fn(), onSubscribed);
    await vi.advanceTimersByTimeAsync(0);
    expect(onSubscribed).toHaveBeenCalledOnce();
    f.channels[0]!.status?.(status);
    f.channels[0]!.status?.(status);
    await vi.advanceTimersByTimeAsync(999);
    expect(f.channels).toHaveLength(1);
    expect(onSubscribed).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(f.channels).toHaveLength(2);
    expect(f.order).toEqual(['auth', `join:host:${id}`, 'auth', `join:host:${id}`]);
    expect(f.channels[0]!.unsubscribe).toHaveBeenCalledOnce();
    expect(onSubscribed).toHaveBeenCalledTimes(2);
    f.channels[0]!.status?.('SUBSCRIBED');
    expect(onSubscribed).toHaveBeenCalledTimes(2);
  });

  it('notifies on every host subscription only while the listener is subscribed', async () => {
    const f = setup({}, 100); const onSubscribed = vi.fn();
    const unsubscribe = f.manager.subscribeCommands(id, vi.fn(), onSubscribed);
    await vi.advanceTimersByTimeAsync(99);
    expect(onSubscribed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onSubscribed).toHaveBeenCalledOnce();
    f.channels[0]!.status?.('SUBSCRIBED');
    expect(onSubscribed).toHaveBeenCalledTimes(2);
    f.manager.sendText(delta('text'));
    await vi.advanceTimersByTimeAsync(100);
    expect(onSubscribed).toHaveBeenCalledTimes(2);
    unsubscribe();
    f.channels[0]!.status?.('SUBSCRIBED');
    expect(onSubscribed).toHaveBeenCalledTimes(2);
  });

  it('isolates subscription callbacks and ignores readiness after close', async () => {
    const f = setup(); const listener = vi.fn(); const onSubscribed = vi.fn();
    f.manager.subscribeCommands(id, vi.fn(), () => { throw new Error('wake failed'); });
    f.manager.subscribeCommands(id, listener, onSubscribed);
    await vi.advanceTimersByTimeAsync(0);
    expect(onSubscribed).toHaveBeenCalledOnce();
    f.channels[0]!.broadcast?.({ payload: { id, op: 'cancel' } });
    expect(listener).toHaveBeenCalledWith({ id, op: 'cancel' });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(f.channels).toHaveLength(1);
    await f.manager.close();
    f.channels[0]!.status?.('SUBSCRIBED');
    expect(onSubscribed).toHaveBeenCalledOnce();
  });

  it('sends the first text immediately when ready and after the previous send is old enough', async () => {
    const f = setup();
    f.manager.sendText(delta('first'));
    await vi.advanceTimersByTimeAsync(0);
    expect(f.sent().map(message => message.at)).toEqual([0]);
    await vi.advanceTimersByTimeAsync(300);
    f.manager.sendText(delta(' second', 5));
    expect(f.sent().map(message => message.at)).toEqual([0, 300]);
  });

  it('coalesces subsequent text at the previous send deadline without postponing it', async () => {
    const f = setup();
    f.manager.sendText(delta('first'));
    await vi.advanceTimersByTimeAsync(100);
    f.manager.sendText(delta(' second', 5));
    await vi.advanceTimersByTimeAsync(100);
    f.manager.sendText(delta(' third', 12));
    await vi.advanceTimersByTimeAsync(49);
    expect(f.sent().map(message => message.at)).toEqual([0]);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.sent().map(message => message.at)).toEqual([0, 250]);
    expect(f.sent().map(message => message.payload.text)).toEqual(['first', ' second third']);
  });

  it('caps the leading-edge wait at 250ms when the clock moves backwards', async () => {
    const f = setup();
    f.manager.sendText(delta('first'));
    await vi.advanceTimersByTimeAsync(0);
    vi.setSystemTime(-1_000);
    f.manager.sendText(delta(' second', 5));
    await vi.advanceTimersByTimeAsync(249);
    expect(f.sent()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.sent().map(message => message.at)).toEqual([0, -750]);
    expect(f.sent().map(message => message.payload.text)).toEqual(['first', ' second']);
  });

  it('coalesces contiguous deltas to at most four messages per second per stream', async () => {
    const f = setup();
    for (let index = 0; index < 20; index++) {
      f.manager.sendText(delta('x', index));
      await vi.advanceTimersByTimeAsync(50);
    }
    const sent = f.sent();
    expect(sent).toHaveLength(5);
    expect(sent.map(message => message.at)).toEqual([0, 250, 500, 750, 1_000]);
    for (const { at } of sent) {
      expect(sent.filter(message => message.at >= at && message.at < at + 1_000).length).toBeLessThanOrEqual(4);
    }
    expect(sent.map(message => message.payload.text).join('')).toBe('x'.repeat(20));
    expect(sent.map(message => message.payload.stream.offset)).toEqual([0, 1, 5, 10, 15]);
  });

  it('chunks UTF-8 safely at 32 KiB with code-point offsets', async () => {
    const f = setup(); const text = '😀'.repeat(20_000);
    f.manager.sendText(delta(text, 7));
    await vi.advanceTimersByTimeAsync(750);
    const chunks = f.sent().map(message => message.payload);
    expect(chunks).toHaveLength(3);
    expect(chunks.map(chunk => chunk.text).join('')).toBe(text);
    expect(chunks.map(chunk => chunk.stream.offset)).toEqual([7, 7 + 8_192, 7 + 16_384]);
    for (const chunk of chunks) {
      expect(Buffer.byteLength(chunk.text)).toBeLessThanOrEqual(PUBLICATION_LIMITS.textChunkBytes);
      expect(chunk.text).not.toContain('\uFFFD');
    }
  });

  it('limits large buffered chunks to one send per 250ms per stream', async () => {
    const f = setup();
    f.manager.sendText(delta('a'.repeat(100_000)));
    f.manager.sendText(delta('b', 0, 'other-stream'));
    await vi.advanceTimersByTimeAsync(1_000);
    const stream = f.sent().filter(message => message.payload.stream.id === 'stream');
    expect(stream.map(message => message.at)).toEqual([0, 250, 500, 750]);
    expect(f.sent().filter(message => message.payload.stream.id === 'other-stream')).toHaveLength(1);
  });

  it('buffers the opening text until a delayed subscription, then drains in order at four messages per second', async () => {
    const f = setup({}, 1_000);
    const text = '🦊'.repeat(20_000);
    f.manager.sendText(delta(text));
    await vi.advanceTimersByTimeAsync(500);
    f.manager.sendText(delta('tail', 20_000));
    await vi.advanceTimersByTimeAsync(499);
    expect(f.sent()).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.sent().map(message => message.at)).toEqual([1_000]);
    await vi.advanceTimersByTimeAsync(500);
    const sent = f.sent();
    expect(sent.map(message => message.at)).toEqual([1_000, 1_250, 1_500]);
    expect(sent.map(message => message.payload.text).join('')).toBe(`${text}tail`);
    expect(sent.map(message => message.payload.stream.offset)).toEqual([0, 8_192, 16_384]);
  });

  it('keeps one send in flight per stream and immediately resumes after an overdue send completes', async () => {
    const f = setup({}, 100); let finish!: (value: string) => void;
    f.manager.sendText(delta('a'.repeat(70_000)));
    await vi.advanceTimersByTimeAsync(0);
    const channel = f.channels[0]!; const send = channel.send.bind(channel);
    vi.spyOn(channel, 'send').mockImplementationOnce(message => {
      void send(message); return new Promise(resolve => { finish = resolve; });
    });
    await vi.advanceTimersByTimeAsync(100);
    f.manager.sendText(delta('tail', 70_000));
    await vi.advanceTimersByTimeAsync(500);
    expect(f.sent().map(message => message.at)).toEqual([100]);
    finish('ok');
    await vi.advanceTimersByTimeAsync(0);
    expect(f.sent().map(message => message.at)).toEqual([100, 600]);
    await vi.advanceTimersByTimeAsync(249);
    expect(f.sent()).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.sent().map(message => message.at)).toEqual([100, 600, 850]);
    expect(f.sent().map(message => message.payload.text).join('')).toBe(`${'a'.repeat(70_000)}tail`);
  });

  it('holds a scheduled send while disconnected and sends immediately on rejoin', async () => {
    const f = setup();
    f.manager.sendText(delta('first'));
    await vi.advanceTimersByTimeAsync(100);
    f.manager.sendText(delta(' second', 5));
    f.channels[0]!.status?.('CHANNEL_ERROR');
    await vi.advanceTimersByTimeAsync(999);
    expect(f.sent().map(message => message.at)).toEqual([0]);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.sent().map(message => message.at)).toEqual([0, 1_100]);
    expect(f.sent().map(message => message.payload.text)).toEqual(['first', ' second']);
  });

  it('retains text while a session channel rejoins and after idle retirement', async () => {
    const f = setup({ idleMs: 4_000 }, 1_000);
    f.manager.sendText(delta('first'));
    await vi.advanceTimersByTimeAsync(1_250);
    f.channels[0]!.status?.('CLOSED');
    f.manager.sendText(delta(' second', 5));
    await vi.advanceTimersByTimeAsync(2_250);
    expect(f.sent().map(message => message.payload.text)).toEqual(['first', ' second']);
    await vi.advanceTimersByTimeAsync(4_000);
    f.manager.sendText(delta('after idle', 0, 'next-stream'));
    await vi.advanceTimersByTimeAsync(1_250);
    expect(f.sent().map(message => message.payload.text)).toEqual(['first', ' second', 'after idle']);
  });

  it('drops an entire gapped stream instead of relabeling offsets', async () => {
    const f = setup();
    f.manager.sendText(delta('first'));
    f.manager.sendText(delta('gap', 99));
    f.manager.sendText(delta('later', 102));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(f.sent()).toEqual([]);
  });

  it('bounds a single stream buffer and evicts oldest streams at the stream limit', async () => {
    const f = setup({ maxBufferBytes: 8, maxStreams: 1 }, 1_000);
    f.manager.sendText(delta('12345'));
    f.manager.sendText(delta('6789', 5));
    await vi.advanceTimersByTimeAsync(250);
    expect(f.sent()).toEqual([]);
    f.manager.sendText(delta('old', 0, 'old'));
    f.manager.sendText(delta('new', 0, 'new'));
    await vi.advanceTimersByTimeAsync(750);
    expect(f.sent().map(message => message.payload.text)).toEqual(['new']);
  });

  it('retains an active stream rate limiter while evicting less recently used streams at the default limit', async () => {
    const f = setup();
    f.manager.sendText(delta('first'));
    await vi.advanceTimersByTimeAsync(0);
    for (let index = 0; index < 63; index++) f.manager.sendText(delta('idle', 0, `idle-${index}`));
    await vi.advanceTimersByTimeAsync(50);
    f.manager.sendText(delta(' second', 5));
    f.manager.sendText(delta('new', 0, 'new'));
    f.manager.sendText(delta(' third', 12));
    await vi.advanceTimersByTimeAsync(199);
    const active = () => f.sent().filter(message => message.payload.stream.id === 'stream');
    expect(active().map(message => message.at)).toEqual([0]);
    await vi.advanceTimersByTimeAsync(1);
    expect(active().map(message => message.at)).toEqual([0, 250]);
    expect(active().map(message => message.payload)).toEqual([delta('first'), delta(' second third', 5)]);
  });

  it('preserves cooldowns when every stream slot is saturated', async () => {
    const f = setup(); f.manager.sendText(delta('first')); await vi.advanceTimersByTimeAsync(0);
    for (let index = 0; index < 64; index++) f.manager.sendText(delta('other', 0, `other-${index}`));
    f.manager.sendText(delta(' second', 5));
    const active = () => f.sent().filter(message => message.payload.stream.id === 'stream');
    await vi.advanceTimersByTimeAsync(249); expect(active().map(message => message.at)).toEqual([0]);
    await vi.advanceTimersByTimeAsync(1); expect(active().map(message => message.at)).toEqual([0, 250]);
    expect(active().map(message => message.payload)).toEqual([delta('first'), delta(' second', 5)]);
    f.manager.sendText(delta('resumed', 0, 'new')); await vi.advanceTimersByTimeAsync(0);
    expect(f.sent().filter(message => message.payload.stream.id === 'new')).toHaveLength(1);
  });

  it('retains in-flight sends when the stream limit is saturated beyond the cooldown', async () => {
    const f = setup({ maxStreams: 1 }, 100); let finish!: (value: string) => void;
    f.manager.sendText(delta('first')); await vi.advanceTimersByTimeAsync(0);
    const channel = f.channels[0]!; const send = channel.send.bind(channel);
    vi.spyOn(channel, 'send').mockImplementationOnce(message => {
      void send(message); return new Promise(resolve => { finish = resolve; });
    });
    await vi.advanceTimersByTimeAsync(400);
    f.manager.sendText(delta('other', 0, 'other')); f.manager.sendText(delta(' second', 5));
    expect(f.sent().map(message => message.payload.text)).toEqual(['first']);
    finish('ok'); await vi.advanceTimersByTimeAsync(0);
    expect(f.sent().map(message => message.payload)).toEqual([delta('first'), delta(' second', 5)]);
    expect(f.sent().map(message => message.at)).toEqual([100, 400]);
  });

  it('bounds total buffered UTF-8 bytes during subscription and drops the oldest whole stream', async () => {
    const f = setup({ maxBufferBytes: 12 }, 1_000);
    f.manager.sendText(delta('🦊🦊', 0, 'old'));
    f.manager.sendText(delta('new!', 0, 'new'));
    f.manager.sendText(delta('?', 4, 'new'));
    f.manager.sendText(delta('ignored', 2, 'old'));
    await vi.advanceTimersByTimeAsync(1_500);
    expect(f.sent().map(message => message.payload)).toEqual([delta('new!?', 0, 'new')]);
    f.manager.sendText(delta('reused', 0, 'third'));
    await vi.advanceTimersByTimeAsync(250);
    expect(f.sent().map(message => message.payload.text)).toEqual(['new!?', 'reused']);
  });

  it('joins sessions lazily and leaves after idle', async () => {
    const f = setup({ idleMs: 1_000 });
    expect(f.channels).toEqual([]);
    f.manager.sendText(delta('hi'));
    await vi.advanceTimersByTimeAsync(250);
    expect(f.channels.map(channel => channel.topic)).toEqual([`session:${id}`]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(f.channels[0]!.unsubscribe).toHaveBeenCalledOnce();
  });

  it('validates text before sending, ignores transport failure and closes all timers', async () => {
    const f = setup({}, 100);
    expect(() => f.manager.sendText({ ...delta('bad'), stream: { ...delta('bad').stream, offset: -1 } })).toThrow();
    f.manager.sendText(delta('valid'));
    await vi.advanceTimersByTimeAsync(0);
    const send = vi.spyOn(f.channels[0]!, 'send').mockRejectedValue(new Error('offline'));
    await vi.advanceTimersByTimeAsync(250);
    expect(send).toHaveBeenCalledOnce();
    f.channels[0]!.status?.('CLOSED');
    await f.manager.close();
    const count = f.channels.length;
    await vi.advanceTimersByTimeAsync(100_000);
    f.manager.sendText(delta('after close'));
    expect(f.channels).toHaveLength(count);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not join after closing while authorization is pending', async () => {
    let resolve!: () => void;
    const f = setup({ authorize: () => new Promise<void>(done => { resolve = done; }) });
    f.manager.subscribeCommands(id, vi.fn());
    await f.manager.close(); resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.channels).toEqual([]);
  });
});
