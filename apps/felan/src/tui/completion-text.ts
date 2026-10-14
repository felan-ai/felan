import { stripTerminalSequences } from '@earendil-works/pi-tui';

export const MAX_DETAIL_LINES = 3;
const MAX_INLINE_CHARACTERS = 240;
const INLINE_CONTROL_CHARACTERS = /[\u0000-\u001F\u007F-\u009F]/gu;

export function summaryLines(value: string | readonly string[]): string[] {
  const text = typeof value === 'string' ? value : value.join('\n');
  return stripTerminalSequences(text)
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => inlineText(line).replace(/^(?:#{1,6}|[-*+])\s+/u, ''))
    .filter(Boolean);
}

export function inlineText(value: string): string {
  const normalized = stripTerminalSequences(value)
    .replace(INLINE_CONTROL_CHARACTERS, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return normalized.length <= MAX_INLINE_CHARACTERS
    ? normalized
    : `${normalized.slice(0, MAX_INLINE_CHARACTERS - 1)}…`;
}

export function messageText(content: string | readonly { type: string; text?: string }[]): string {
  if (typeof content === 'string') return content;
  return content
    .filter((entry) => entry.type === 'text' && typeof entry.text === 'string')
    .map((entry) => entry.text!)
    .join('\n');
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
