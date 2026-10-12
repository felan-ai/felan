import type { AgentSessionEvent } from '@felan-ai/agent-core';

export function headlessJsonEvent(event: AgentSessionEvent): unknown {
  if (event.type !== 'message_update') return event;
  if (event.message.role !== 'assistant') throw new Error('Invalid assistant update event.');
  const value = event.assistantMessageEvent;
  if (value.type === 'toolcall_start') {
    const tool = value.partial.content[value.contentIndex];
    if (tool?.type !== 'toolCall') throw new Error('Invalid tool-call start event.');
    const { partial: _partial, ...rest } = value;
    return { type: event.type, usage: event.message.usage, assistantMessageEvent: { ...rest, id: tool.id, toolName: tool.name } };
  }
  if ('partial' in value) {
    const { partial: _partial, ...rest } = value;
    return { type: event.type, usage: event.message.usage, assistantMessageEvent: rest };
  }
  return { type: event.type, usage: event.message.usage, assistantMessageEvent: value };
}
