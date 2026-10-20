import {
  PUBLICATION_LIMITS, TextStreamEventSchema, codePointLength, parseRealtimeNotification, parseSchema,
  type RealtimeNotification, type TextStreamEvent,
} from '@felan-ai/session-protocol';
import { retryDelay, schedule, systemClock, type RemoteClock, type RetryOptions, type TimerHandle } from './backoff.js';

export interface BroadcastChannel {
  on(type: 'broadcast', filter: { event: string }, listener: (message: { payload?: unknown }) => void): BroadcastChannel;
  subscribe(listener: (status: string) => void): BroadcastChannel;
  send(message: { type: 'broadcast'; event: string; payload: unknown }): PromiseLike<unknown>;
  unsubscribe(): PromiseLike<unknown>;
}
export interface RealtimeClientPort {
  channel(topic: string, options: { config: { private: boolean } }): BroadcastChannel;
  removeChannel?(channel: BroadcastChannel): PromiseLike<unknown>;
  realtime: { setAuth(token: string): PromiseLike<void> };
}
export interface RemoteRealtimeOptions extends RetryOptions {
  authorize: () => Promise<void>;
  clock?: RemoteClock;
  idleMs?: number;
  maxBufferBytes?: number;
  maxStreams?: number;
}
export type CommandNotification = Extract<RealtimeNotification, { event: 'command' }>['payload'];
interface ChannelState {
  topic: string;
  channel?: BroadcastChannel | undefined;
  listeners: Map<(notification: CommandNotification) => void, (() => void) | undefined>;
  ready: boolean;
  joining: boolean;
  attempt: number;
  retry?: TimerHandle | undefined;
  idle?: TimerHandle | undefined;
}
interface StreamState {
  key: string;
  event: TextStreamEvent;
  text: string;
  bytes: number;
  nextOffset: number;
  dropped: boolean;
  flushing: boolean;
  lastSentAt?: number;
  timer?: TimerHandle | undefined;
  idle?: TimerHandle | undefined;
}

function takeChunk(text: string): string {
  let bytes = 0;
  let length = 0;
  for (const point of text) {
    const size = Buffer.byteLength(point);
    if (bytes + size > PUBLICATION_LIMITS.textChunkBytes) break;
    bytes += size;
    length += point.length;
  }
  return text.slice(0, length);
}

export class RemoteRealtime {
  #client: RealtimeClientPort;
  #options: RemoteRealtimeOptions;
  #clock: RemoteClock;
  #channels = new Map<string, ChannelState>();
  #streams = new Map<string, StreamState>();
  #bufferBytes = 0;
  #closed = false;

  constructor(client: RealtimeClientPort, options: RemoteRealtimeOptions) {
    this.#client = client;
    this.#options = options;
    this.#clock = options.clock ?? systemClock;
  }

  subscribeCommands(hostId: string, listener: (notification: CommandNotification) => void, onSubscribed?: () => void): () => void {
    if (this.#closed) return () => {};
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(hostId)) throw new Error('Invalid host ID.');
    const state = this.#channel(`host:${hostId}`);
    state.listeners.set(listener, onSubscribed);
    if (state.idle) this.#clock.clearTimeout(state.idle);
    state.idle = undefined;
    return () => {
      state.listeners.delete(listener);
      if (!state.listeners.size) this.#retireAfterIdle(state);
    };
  }

  sendText(value: TextStreamEvent): void {
    if (this.#closed) return;
    const event = parseSchema(TextStreamEventSchema, value);
    if (!event.text) return;
    const key = JSON.stringify([event.session, event.stream.id, event.stream.message, event.stream.kind]);
    let state = this.#streams.get(key);
    if (!state) {
      while (this.#streams.size >= Math.max(1, this.#options.maxStreams ?? 64)) {
        const now = this.#clock.now();
        const leastRecent = [...this.#streams.values()].find(stream => !stream.flushing && (stream.lastSentAt === undefined || now - stream.lastSentAt >= 250));
        if (!leastRecent) return;
        this.#dropStream(leastRecent);
      }
      state = { key, event: { ...event, stream: { ...event.stream }, text: '' }, text: '', bytes: 0, nextOffset: event.stream.offset, dropped: false, flushing: false };
    }
    this.#streams.delete(key);
    this.#streams.set(key, state);
    if (state.idle) this.#clock.clearTimeout(state.idle);
    state.idle = schedule(this.#clock, () => this.#dropStream(state!), this.#options.idleMs ?? 60_000);
    if (state.dropped) return;
    if (event.stream.offset !== state.nextOffset) {
      // A display stream with missing text cannot safely resume at a fabricated offset.
      this.#discardStream(state);
      return;
    }
    const bytes = Buffer.byteLength(event.text);
    state.text += event.text;
    state.bytes += bytes;
    this.#bufferBytes += bytes;
    state.nextOffset += codePointLength(event.text);
    for (const buffered of this.#streams.values()) {
      if (this.#bufferBytes <= (this.#options.maxBufferBytes ?? 128 * 1024)) break;
      this.#discardStream(buffered);
    }
    if (state.dropped) return;
    this.#channel(`session:${event.session}`);
    this.#queueFlush(state);
  }

  async close(): Promise<void> {
    this.#closed = true;
    for (const stream of this.#streams.values()) this.#dropStream(stream);
    const channels = [...this.#channels.values()];
    this.#channels.clear();
    await Promise.all(channels.map(state => this.#remove(state)));
  }

  #channel(topic: string): ChannelState {
    let state = this.#channels.get(topic);
    if (!state) {
      state = { topic, listeners: new Map(), ready: false, joining: false, attempt: 0 };
      this.#channels.set(topic, state);
      void this.#join(state);
    }
    if (topic.startsWith('session:')) this.#retireAfterIdle(state);
    return state;
  }

  async #join(state: ChannelState): Promise<void> {
    if (this.#closed || state.joining || this.#channels.get(state.topic) !== state) return;
    state.joining = true;
    try {
      await this.#options.authorize();
      if (this.#closed || this.#channels.get(state.topic) !== state) return;
      const channel = this.#client.channel(state.topic, { config: { private: true } });
      state.channel = channel;
      if (state.topic.startsWith('host:')) channel.on('broadcast', { event: 'command' }, message => {
        if (this.#closed || state.channel !== channel) return;
        let notification: RealtimeNotification;
        try { notification = parseRealtimeNotification({ event: 'command', payload: message.payload }); }
        catch { return; }
        if (notification.event !== 'command') return;
        for (const listener of state.listeners.keys()) {
          try { listener(notification.payload); } catch { /* a notification is only a wake-up hint */ }
        }
      });
      channel.subscribe(status => {
        if (this.#closed || state.channel !== channel) return;
        if (status === 'SUBSCRIBED') {
          state.ready = true;
          state.attempt = 0;
          for (const onSubscribed of state.listeners.values()) {
            try { onSubscribed?.(); } catch {}
          }
          for (const stream of this.#streams.values()) {
            if (state.topic === `session:${stream.event.session}`) this.#queueFlush(stream);
          }
        } else if (['CLOSED', 'CHANNEL_ERROR', 'TIMED_OUT'].includes(status)) {
          state.ready = false;
          this.#rejoin(state);
        }
      });
    } catch { this.#rejoin(state); }
    finally { state.joining = false; }
  }

  #rejoin(state: ChannelState): void {
    if (this.#closed || state.retry || this.#channels.get(state.topic) !== state) return;
    state.retry = schedule(this.#clock, () => {
      state.retry = undefined;
      void (async () => {
        await this.#removeChannel(state);
        await this.#join(state);
      })();
    }, retryDelay(state.attempt++, this.#options));
  }

  #queueFlush(state: StreamState): void {
    if (state.timer || state.flushing || !state.text || state.dropped || this.#closed) return;
    if (!this.#channels.get(`session:${state.event.session}`)?.ready) return;
    const delay = state.lastSentAt === undefined ? 0 : Math.min(250, Math.max(0, state.lastSentAt + 250 - this.#clock.now()));
    if (delay <= 0) { void this.#flush(state); return; }
    state.timer = schedule(this.#clock, () => {
      state.timer = undefined;
      void this.#flush(state);
    }, delay);
  }

  async #flush(state: StreamState): Promise<void> {
    if (this.#closed || state.dropped || state.flushing || !state.text) return;
    const channel = this.#channel(`session:${state.event.session}`);
    if (!channel.ready || !channel.channel) return;
    state.flushing = true;
    const text = takeChunk(state.text);
    const event = { ...state.event, stream: { ...state.event.stream }, text };
    state.text = state.text.slice(text.length);
    const bytes = Buffer.byteLength(text);
    state.bytes -= bytes;
    this.#bufferBytes -= bytes;
    state.event.stream.offset += codePointLength(text);
    state.lastSentAt = this.#clock.now();
    try {
      await channel.channel.send({ type: 'broadcast', event: 'text', payload: parseSchema(TextStreamEventSchema, event) });
    } catch { /* live text is display-only; failed chunks are not replayed */ }
    finally {
      state.flushing = false;
      this.#queueFlush(state);
    }
  }

  #discardStream(state: StreamState): void {
    if (state.timer) this.#clock.clearTimeout(state.timer);
    state.timer = undefined;
    state.dropped = true;
    state.text = '';
    this.#bufferBytes -= state.bytes;
    state.bytes = 0;
  }

  #dropStream(state: StreamState): void {
    this.#discardStream(state);
    if (state.idle) this.#clock.clearTimeout(state.idle);
    this.#streams.delete(state.key);
  }

  #retireAfterIdle(state: ChannelState): void {
    if (state.idle) this.#clock.clearTimeout(state.idle);
    state.idle = schedule(this.#clock, () => {
      state.idle = undefined;
      if (state.listeners.size || this.#closed) return;
      this.#channels.delete(state.topic);
      void this.#remove(state);
    }, this.#options.idleMs ?? 60_000);
  }

  async #removeChannel(state: ChannelState): Promise<void> {
    const channel = state.channel;
    state.channel = undefined;
    state.ready = false;
    if (channel) {
      try { await (this.#client.removeChannel?.(channel) ?? channel.unsubscribe()); }
      catch { /* a closed transport must not prevent local cleanup */ }
    }
  }

  async #remove(state: ChannelState): Promise<void> {
    if (state.idle) this.#clock.clearTimeout(state.idle);
    if (state.retry) this.#clock.clearTimeout(state.retry);
    state.idle = undefined;
    state.retry = undefined;
    await this.#removeChannel(state);
  }
}
