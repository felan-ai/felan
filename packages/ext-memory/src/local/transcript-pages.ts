import type { MemoryHistorySnapshot } from './history.js';
import { safeMemoryText } from './history.js';

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export type MemoryTranscriptHintData = {
  transcript: {
    cwd: string;
    page: number;
    pages: number;
    details: string[];
    messages: { role: string; [key: string]: JsonValue }[];
  };
};

export interface MemoryTranscriptPage {
  readonly markdown: string;
  readonly data: MemoryTranscriptHintData;
}

// Session protocol rejects hint data above 128 KiB; the headroom covers details and JSON framing.
const PAGE_BYTES = 96 * 1024;
const TEXT_LIMITS = [8 * 1024, 1024] as const;
const FALLBACK_TEXT_LIMIT = 2 * 1024;

export function memoryTranscriptPages(snapshot: MemoryHistorySnapshot): MemoryTranscriptPage[] {
  const details = memoryRunDetails(snapshot);
  const messages = snapshot.messages.map(message => displayMessage(message as unknown as Record<string, JsonValue>));
  const groups: (typeof messages)[] = [];
  for (const message of messages) {
    if (message.role === 'toolResult' && groups.length > 0) groups.at(-1)!.push(message);
    else groups.push([message]);
  }
  const pages: (typeof messages)[] = [];
  let page: typeof messages = [];
  let bytes = 0;
  const add = (items: typeof messages, size: number) => {
    if (page.length > 0 && bytes + size > PAGE_BYTES) { pages.push(page); page = []; bytes = 0; }
    page.push(...items); bytes += size;
  };
  // Keep a tool call on the same page as its results unless the group alone exceeds a page.
  for (const group of groups) {
    const sizes = group.map(jsonBytes);
    const total = sizes.reduce((sum, size) => sum + size, 0);
    if (total <= PAGE_BYTES) add(group, total);
    else group.forEach((message, index) => add([message], sizes[index]!));
  }
  if (page.length > 0 || pages.length === 0) pages.push(page);
  return pages.map((messages, index) => ({
    markdown: pageMarkdown(details, messages, index, pages.length),
    data: { transcript: { cwd: snapshot.session.cwd, page: index + 1, pages: pages.length, details, messages } },
  }));
}

function memoryRunDetails(snapshot: MemoryHistorySnapshot): string[] {
  const { session, metadata } = snapshot;
  const details = [
    `Project: ${safeMemoryText(session.cwd)}`,
    `Status: ${metadata?.status ?? 'unknown'}${metadata ? ` · Phase: ${metadata.phase}` : ''}`,
  ];
  if (metadata) {
    details.push(`Started: ${safeMemoryText(metadata.startedAt)}${metadata.finishedAt ? ` · Finished: ${safeMemoryText(metadata.finishedAt)}` : ''}`);
    if (metadata.model) details.push(`Model: ${safeMemoryText(`${metadata.model.provider}/${metadata.model.id}`)}`);
    if (metadata.error) details.push(`Error: ${safeMemoryText(metadata.error)}`);
  }
  details.push(...snapshot.diagnostics.map(safeMemoryText));
  if (snapshot.messages.length === 0) details.push('No messages were retained. The run may have stopped before the worker started.');
  else if (!snapshot.messages.some(message => message.role === 'assistant')) details.push('No assistant response was retained.');
  return details;
}

function displayMessage(message: Record<string, JsonValue>): { role: string; [key: string]: JsonValue } {
  for (const limit of TEXT_LIMITS) {
    const clipped = clip(withoutImages(message), limit) as { role: string; [key: string]: JsonValue };
    if (jsonBytes(clipped) <= PAGE_BYTES) return clipped;
  }
  const { role } = message;
  return { ...pick(message, ['role', 'timestamp', 'toolCallId', 'toolName', 'isError', 'stopReason']), role: String(role),
    content: [{ type: 'text', text: 'This message is too large to display. The retained transcript is unchanged.' }] };
}

function withoutImages(message: Record<string, JsonValue>): Record<string, JsonValue> {
  if (!Array.isArray(message.content)) return message;
  return { ...message, content: message.content.map(block => isRecord(block) && block.type === 'image'
    ? { type: 'text', text: '[image omitted]' } : block) };
}

function clip(value: JsonValue, limit: number): JsonValue {
  if (typeof value === 'string') return value.length > limit ? `${value.slice(0, limit)}\n… [${value.length - limit} characters truncated for display]` : value;
  if (Array.isArray(value)) return value.map(item => clip(item, limit));
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clip(item, limit)]));
  return value;
}

function pageMarkdown(details: readonly string[], messages: readonly Record<string, JsonValue>[], index: number, count: number): string {
  const sections = [`Page ${index + 1} of ${count}`, details.map(line => `- ${escapeMarkdown(line)}`).join('\n')];
  for (const message of messages) {
    const blocks = Array.isArray(message.content) ? message.content : [message.content];
    const text: string[] = [];
    for (const block of blocks) {
      if (typeof block === 'string') text.push(fallbackText(block));
      else if (isRecord(block) && block.type === 'text' && typeof block.text === 'string') text.push(fallbackText(block.text));
      else if (isRecord(block) && block.type === 'toolCall' && typeof block.name === 'string') text.push(`Tool call: ${escapeMarkdown(block.name)}`);
    }
    const heading = message.role === 'toolResult'
      ? `Tool result${typeof message.toolName === 'string' ? `: ${message.toolName}` : ''}${message.isError === true ? ' (error)' : ''}`
      : message.role === 'user' ? 'User' : message.role === 'assistant' ? 'Assistant' : String(message.role);
    sections.push(`### ${escapeMarkdown(heading)}\n\n${text.join('\n\n') || '(no text)'}`);
  }
  if (messages.length === 0) sections.push('No retained messages.');
  return sections.join('\n\n');
}

function fallbackText(value: string): string {
  return escapeMarkdown(value.length > FALLBACK_TEXT_LIMIT ? `${value.slice(0, FALLBACK_TEXT_LIMIT)} …` : value);
}

function escapeMarkdown(value: string): string {
  return value.replace(/[<>&]/gu, character => character === '<' ? '&lt;' : character === '>' ? '&gt;' : '&amp;')
    .replace(/[\\`*_{}[\]()!#|]/gu, character => `\\${character}`);
}

function pick(value: Record<string, JsonValue>, keys: readonly string[]): Record<string, JsonValue> {
  return Object.fromEntries(keys.flatMap(key => value[key] === undefined ? [] : [[key, value[key]!]]));
}

function isRecord(value: unknown): value is Record<string, JsonValue> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function jsonBytes(value: JsonValue): number {
  return Buffer.byteLength(JSON.stringify(value));
}
