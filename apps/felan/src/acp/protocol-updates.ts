import { methods, type AgentContext, type SessionUpdate } from '@agentclientprotocol/sdk';
import { type Message, type SessionSnapshot } from '@felan-ai/session-protocol';
import { AcpToolCallIdRegistry, createAcpToolCallUpdate } from './session-updates.js';

export class AcpProtocolUpdates {
  readonly #messages = new Set<string>();
  readonly #streams = new Map<string, { message: string; kind: 'assistant' | 'thinking'; text: string }>();
  readonly #tools = new Map<string, string>();
  #tail = Promise.resolve();
  #failure: unknown;

  constructor(
    readonly sessionId: string,
    readonly cwd: string,
    readonly client: AgentContext,
    readonly ids: AcpToolCallIdRegistry,
    readonly isActive: () => boolean,
  ) {}

  toolId(id: string): string { return this.ids.current(id) ?? this.ids.claim(id); }

  async replay(messages: readonly Message[]): Promise<void> {
    for (const message of messages) this.message(message);
    await this.flush();
  }

  observe(snapshot: SessionSnapshot): void {
    for (const message of snapshot.history.entries) this.message(message);
    for (const stream of snapshot.activeStreams) {
      if (this.#messages.has(stream.message)) continue;
      const previous = this.#streams.get(stream.id)?.text ?? '';
      if (!stream.text.startsWith(previous)) continue;
      this.text(stream.kind === 'assistant' ? 'agent_message_chunk' : 'agent_thought_chunk', stream.text.slice(previous.length));
      this.#streams.set(stream.id, { message: stream.message, kind: stream.kind, text: stream.text });
    }
    for (const tool of snapshot.tools) {
      const fingerprint = JSON.stringify(tool);
      if (this.#tools.get(tool.id) === fingerprint) continue;
      this.#tools.set(tool.id, fingerprint);
      const call = snapshot.history.entries.flatMap(message => message.content).find(part => part.type === 'tool_call' && part.id === tool.id);
      const details = createAcpToolCallUpdate(this.cwd, this.toolId(tool.id), tool.name, call?.type === 'tool_call' ? call.arguments : {});
      this.send({ sessionUpdate: 'tool_call_update', ...details,
        status: tool.state === 'running' ? 'in_progress' : tool.state === 'completed' ? 'completed' : 'failed',
        ...(tool.output ? { content: [{ type: 'content', content: { type: 'text', text: tool.output } }] } : {}) });
    }
  }

  private message(message: Message): void {
    if (this.#messages.has(message.id)) return;
    this.#messages.add(message.id);
    const streamed = { assistant: '', thinking: '' };
    for (const stream of this.#streams.values()) if (stream.message === message.id) streamed[stream.kind] += stream.text;
    for (const part of message.content) {
      if (part.type === 'text' || part.type === 'thinking') {
        const kind = part.type === 'thinking' ? 'thinking' : 'assistant';
        let text = part.text;
        if (message.role === 'assistant' && streamed[kind]) {
          const prefix = streamed[kind];
          const count = Math.min(prefix.length, text.length);
          if (prefix.slice(0, count) === text.slice(0, count)) { text = text.slice(count); streamed[kind] = prefix.slice(count); }
        }
        if (message.role === 'assistant') this.text(part.type === 'thinking' ? 'agent_thought_chunk' : 'agent_message_chunk', text);
        else if (message.role === 'user' && part.type === 'text') this.text('user_message_chunk', text);
      } else if (part.type === 'resource_link' && message.role === 'user') {
        this.send({ sessionUpdate: 'user_message_chunk', content: { ...part, name: part.name ?? part.uri } });
      } else if (part.type === 'tool_call') {
        this.send({ sessionUpdate: 'tool_call', ...createAcpToolCallUpdate(this.cwd, this.toolId(part.id), part.name, part.arguments), status: 'pending' });
      } else if (part.type === 'tool_result') {
        this.send({ sessionUpdate: 'tool_call_update', toolCallId: this.toolId(part.id), status: part.isError ? 'failed' : 'completed',
          content: [{ type: 'content', content: { type: 'text', text: part.text } }] });
      }
    }
    for (const [id, stream] of this.#streams) if (stream.message === message.id) this.#streams.delete(id);
  }

  private text(sessionUpdate: 'agent_message_chunk' | 'agent_thought_chunk' | 'user_message_chunk', text: string): void {
    // Chunk on code points so UTF-8 and surrogate pairs survive bounded notifications.
    let chunk = '';
    for (const point of text) {
      chunk += point;
      if (chunk.length >= 16_000) { this.send({ sessionUpdate, content: { type: 'text', text: chunk } }); chunk = ''; }
    }
    if (chunk) this.send({ sessionUpdate, content: { type: 'text', text: chunk } });
  }

  send(update: SessionUpdate): void {
    this.#tail = this.#tail.then(async () => {
      if (this.isActive() && this.#failure === undefined) await this.client.notify(methods.client.session.update, { sessionId: this.sessionId, update });
    }).catch(error => { this.#failure ??= error; });
  }

  async flush(): Promise<void> { await this.#tail; if (this.#failure !== undefined) throw this.#failure; }
}
