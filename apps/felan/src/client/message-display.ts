import type { AgentSession } from '@felan-ai/agent-core';
import { MESSAGE_DISPLAY_ID, parseActiveMessageDisplay, readMessageDisplay, type Message, type SessionSnapshot } from '@felan-ai/session-protocol';
import { BACKGROUND_BASH_COMPLETION_MESSAGE_TYPE } from '@felan-ai/ext-background-bash/data';
import { SESSION_EXECUTION_COMPLETION_MESSAGE_TYPE } from '../execution-completion.js';

type NativeMessage = AgentSession['messages'][number];
type Assistant = Extract<NativeMessage, { role: 'assistant' }>;
type User = Extract<NativeMessage, { role: 'user' }>;
type Tool = Extract<NativeMessage, { role: 'toolResult' }>;

const projected = new WeakMap<Message, NativeMessage | null>();

/**
 * Transcripts re-project their whole history on every update, so results are shared per received message record, which is never
 * modified. Received records are frozen, so tool arguments and details are copied once for renderers that adjust them in place.
 */
export function projectedNativeMessage(message: Message): NativeMessage | undefined {
  const cached = projected.get(message);
  if (cached !== undefined) return cached ?? undefined;
  const native = projectMessage(message);
  projected.set(message, native ?? null);
  return native;
}

function projectMessage(message: Message): NativeMessage | undefined {
  if (message.role === 'custom' && [SESSION_EXECUTION_COMPLETION_MESSAGE_TYPE, BACKGROUND_BASH_COMPLETION_MESSAGE_TYPE].includes(message.customType ?? '')) {
    return { role: 'custom', customType: message.customType!, timestamp: message.timestamp, display: true, details: structuredClone(message.details),
      content: message.content.flatMap(part => part.type === 'text' ? [{ type: 'text' as const, text: part.text }] : []) };
  }
  if (message.role === 'custom' && message.customType === 'bashExecution') {
    const data = message.details;
    if (!data || typeof data !== 'object' || Array.isArray(data) || typeof data.command !== 'string'
      || !(data.exitCode === null || typeof data.exitCode === 'number' && Number.isSafeInteger(data.exitCode))
      || typeof data.cancelled !== 'boolean' || typeof data.truncated !== 'boolean' || typeof data.excludeFromContext !== 'boolean'
      || data.fullOutputPath !== undefined && typeof data.fullOutputPath !== 'string') return undefined;
    return { role: 'bashExecution', timestamp: message.timestamp, command: data.command,
      output: message.content.flatMap(part => part.type === 'text' ? [part.text] : []).join('\n'),
      exitCode: data.exitCode ?? undefined, cancelled: data.cancelled, truncated: data.truncated,
      excludeFromContext: data.excludeFromContext, ...(data.fullOutputPath ? { fullOutputPath: data.fullOutputPath } : {}) };
  }
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
        content.push({ type: 'toolCall', id: part.id, name: part.name, arguments: structuredClone(part.arguments) });
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
      content, isError: result.isError, ...(result.details === undefined ? {} : { details: structuredClone(result.details) }) };
  }
  return undefined;
}

export function projectedStreamingContent(snapshot: Pick<SessionSnapshot, 'activeStreams' | 'history'>): Array<
  { type: 'text'; text: string } | { type: 'thinking'; thinking: string }
> {
  const completed = new Set(snapshot.history.entries.map(message => message.id));
  const groups = new Map<string, SessionSnapshot['activeStreams']>();
  for (const stream of snapshot.activeStreams) {
    if (completed.has(stream.message)) continue;
    const group = groups.get(stream.message) ?? [];
    group.push(stream); groups.set(stream.message, group);
  }
  return [...groups.values()].flatMap(group => group.sort((a, b) => Number(a.id.slice(a.message.length + 1)) - Number(b.id.slice(b.message.length + 1)))
    .map(stream => stream.kind === 'thinking' ? { type: 'thinking' as const, thinking: stream.text } : { type: 'text' as const, text: stream.text }));
}

export function projectedStreamingMessage(snapshot: Pick<SessionSnapshot, 'presentation' | 'activeStreams' | 'history'>): Assistant | undefined {
  const item = snapshot.presentation.find(row => row.id === MESSAGE_DISPLAY_ID);
  if (!item || item.kind !== 'message_display') return undefined;
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
