import type { AgentSession } from '@felan-ai/agent-core';
import { MESSAGE_DISPLAY_PRESENTER, parseActiveMessageDisplay, readMessageDisplay, type Message, type SessionSnapshot } from '@felan-ai/session-protocol';

type NativeMessage = AgentSession['messages'][number];
type Assistant = Extract<NativeMessage, { role: 'assistant' }>;
type User = Extract<NativeMessage, { role: 'user' }>;
type Tool = Extract<NativeMessage, { role: 'toolResult' }>;

export function projectedNativeMessage(message: Message): NativeMessage | undefined {
  if (message.role === 'user') {
    const content: Exclude<User['content'], string> = [];
    for (const part of message.content) {
      if (part.type === 'text') content.push({ type: 'text', text: part.text });
      else if (part.type === 'image') content.push({ type: 'image', data: part.data, mimeType: part.mimeType });
      else return undefined;
    }
    return { role: 'user', timestamp: message.timestamp, content };
  }
  const display = readMessageDisplay(message.details);
  if (message.role === 'assistant' && display?.kind === 'assistant') {
    const content: Assistant['content'] = [];
    for (const part of message.content) {
      if (part.type === 'text') content.push({ type: 'text', text: part.text });
      else if (part.type === 'thinking') content.push({ type: 'thinking', thinking: part.text });
      else if (part.type === 'tool_call' && part.arguments && typeof part.arguments === 'object' && !Array.isArray(part.arguments)) {
        content.push({ type: 'toolCall', id: part.id, name: part.name, arguments: part.arguments });
      } else return undefined;
    }
    const { kind: _kind, ...metadata } = display;
    return { role: 'assistant', ...metadata, content };
  }
  if (message.role === 'tool' && display?.kind === 'tool') {
    const results = message.content.filter(part => part.type === 'tool_result');
    if (results.length !== 1) return undefined;
    const result = results[0]!; const content: Tool['content'] = [];
    for (const part of message.content) {
      if (part.type === 'tool_result') content.push({ type: 'text', text: part.text });
      else if (part.type === 'image') content.push({ type: 'image', mimeType: part.mimeType, data: part.data });
      else return undefined;
    }
    return { role: 'toolResult', toolCallId: result.id, toolName: display.name, timestamp: display.timestamp,
      content, isError: result.isError, ...(result.details === undefined ? {} : { details: result.details }) };
  }
  return undefined;
}

export function projectedStreamingMessage(snapshot: Pick<SessionSnapshot, 'presentation' | 'activeStreams' | 'history'>): Assistant | undefined {
  const item = snapshot.presentation.find(row => row.id === MESSAGE_DISPLAY_PRESENTER.id);
  if (!item || item.kind !== 'custom' || item.presenter.id !== MESSAGE_DISPLAY_PRESENTER.id || item.presenter.version !== MESSAGE_DISPLAY_PRESENTER.version) return undefined;
  const active = parseActiveMessageDisplay(item.data);
  if (snapshot.history.entries.some(message => message.id === active.message)) return undefined;
  const parts: Array<{ index: number; content: Assistant['content'][number] }> = [];
  for (const stream of snapshot.activeStreams) {
    if (stream.message !== active.message) continue;
    const suffix = stream.id.slice(active.message.length + 1); const index = Number(suffix);
    if (!Number.isSafeInteger(index) || index < 0 || stream.id !== `${active.message}:${index}` || parts.some(part => part.index === index)) return undefined;
    parts.push({ index, content: stream.kind === 'thinking' ? { type: 'thinking', thinking: stream.text } : { type: 'text', text: stream.text } });
  }
  const { kind: _kind, ...metadata } = active.display;
  return { role: 'assistant', ...metadata, content: parts.sort((left, right) => left.index - right.index).map(part => part.content) };
}
