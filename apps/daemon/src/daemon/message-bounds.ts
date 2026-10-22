import { LIMITS, MESSAGE_DISPLAY_KEY, type Message } from '@felan-ai/session-protocol';

const messageBytes = LIMITS.pageBytes / 4;
const notice = '[Clipped for display; full content remains in the canonical transcript.]';
const omitted = { projectionNotice: notice };
const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value));

export function boundMessage(message: Message): Message {
  if (bytes(message) <= messageBytes) return message;
  const details = message.details;
  const projected: Message = { ...message, content: [], ...(details === undefined ? {} : {
    details: bytes(details) <= LIMITS.structuredBytes ? details : {
      ...omitted,
      ...(details && typeof details === 'object' && !Array.isArray(details) && MESSAGE_DISPLAY_KEY in details
        && bytes(details[MESSAGE_DISPLAY_KEY]) <= LIMITS.structuredBytes / 2 ? { [MESSAGE_DISPLAY_KEY]: details[MESSAGE_DISPLAY_KEY] } : {}),
    },
  }) };
  const marker: Message['content'][number] = { type: 'text', text: notice };
  let remaining = messageBytes - bytes(projected) - bytes(marker) - 2;
  for (const original of message.content) {
    if (remaining < 256) break;
    let part = original;
    if (part.type === 'tool_call' && bytes(part.arguments) > LIMITS.structuredBytes) part = { ...part, arguments: omitted };
    if (part.type === 'tool_result' && part.details !== undefined && bytes(part.details) > LIMITS.structuredBytes) part = { ...part, details: omitted };
    if (bytes(part) + 1 > remaining) {
      if (part.type === 'text' || part.type === 'thinking' || part.type === 'tool_result') {
        const overhead = bytes({ ...part, text: '' });
        part = { ...part, text: encodedPrefix(part.text, remaining - overhead - 1) };
      } else if (part.type === 'tool_call') part = { ...part, arguments: omitted };
      else part = { type: 'text', text: '[Image omitted from display.]' };
    }
    const size = bytes(part) + 1;
    if (size > remaining) break;
    projected.content.push(part);
    remaining -= size;
  }
  projected.content.push(marker);
  return projected;
}

function encodedPrefix(text: string, budget: number): string {
  let low = 0; let high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (bytes(text.slice(0, middle)) - 2 <= budget) low = middle;
    else high = middle - 1;
  }
  const last = text.charCodeAt(low - 1);
  if (last >= 0xd800 && last <= 0xdbff) low--;
  return text.slice(0, low);
}
