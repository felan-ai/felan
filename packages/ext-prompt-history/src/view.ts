import { PROMPT_HISTORY_SCOPES, type PromptHistoryScope, type PromptHistorySearchState } from './contracts.js';
import type { PromptHistoryDisplayMode } from './config.js';

export const PROMPT_HISTORY_PRESENTER = Object.freeze({ id: 'felan.prompt-history', version: '1' });
export const PROMPT_HISTORY_TEXT_BYTES = 64 * 1024 * 1024;
const encoder = new TextEncoder();
export type PromptHistoryViewRequest = { viewId: string; generation: number } & (
  { kind: 'browse'; scope: PromptHistoryScope; query: string; displayMode: PromptHistoryDisplayMode }
  | { kind: 'text'; index: number; chunks: number; bytes: number });
export type PromptHistoryViewChoice = { action: 'search'; scope: PromptHistoryScope; query: string }
  | { action: 'choose'; id: string } | { action: 'close' } | { action: 'chunk'; index: number } | { action: 'insert' };
export type PromptHistoryViewAction = { viewId: string; generation: number } & PromptHistoryViewChoice;
export interface PromptHistoryFrame extends PromptHistorySearchState { viewId: string; generation: number; version: number }
export interface PromptHistoryText { viewId: string; generation: number; index: number; text: string }
function invalid(): never { throw new Error('Invalid prompt history view data.'); }
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function exact(value: Record<string, unknown>, keys: readonly string[]) { if (Object.keys(value).some(key => !keys.includes(key))) invalid(); }
function id(value: unknown): value is string { return typeof value === 'string' && /^[\w-]{1,128}$/u.test(value); }
function count(value: unknown, max = Number.MAX_SAFE_INTEGER): value is number { return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= max; }
function text(value: unknown, max: number): value is string { return typeof value === 'string' && encoder.encode(value).length <= max; }
function scope(value: unknown): value is PromptHistoryScope { return PROMPT_HISTORY_SCOPES.includes(value as PromptHistoryScope); }

export function parsePromptHistoryRequest(value: unknown): PromptHistoryViewRequest {
  if (!object(value) || !id(value.viewId) || !count(value.generation) || value.generation === 0) invalid();
  if (value.kind === 'browse') {
    exact(value, ['viewId', 'generation', 'kind', 'scope', 'query', 'displayMode']);
    if (!scope(value.scope) || !text(value.query, 4096) || value.displayMode !== 'inline' && value.displayMode !== 'overlay') invalid();
  } else if (value.kind === 'text') {
    exact(value, ['viewId', 'generation', 'kind', 'index', 'chunks', 'bytes']);
    if (!count(value.chunks, 65536) || value.chunks === 0 || !count(value.index, value.chunks - 1) || !count(value.bytes, PROMPT_HISTORY_TEXT_BYTES)) invalid();
  } else invalid();
  return { ...value } as PromptHistoryViewRequest;
}

export function parsePromptHistoryAction(value: unknown, request: PromptHistoryViewRequest): PromptHistoryViewAction {
  if (!object(value) || value.viewId !== request.viewId || value.generation !== request.generation) invalid();
  const base = ['viewId', 'generation', 'action'];
  if (value.action === 'close') exact(value, base);
  else if (request.kind === 'browse' && value.action === 'search') {
    exact(value, [...base, 'scope', 'query']); if (!scope(value.scope) || !text(value.query, 4096)) invalid();
  } else if (request.kind === 'browse' && value.action === 'choose') {
    exact(value, [...base, 'id']); if (!id(value.id)) invalid();
  } else if (request.kind === 'text' && value.action === 'chunk') {
    exact(value, [...base, 'index']); if (!count(value.index, request.chunks - 1)) invalid();
  } else if (request.kind === 'text' && value.action === 'insert' && request.index === request.chunks - 1) exact(value, base);
  else invalid();
  return { ...value } as PromptHistoryViewAction;
}

export function parsePromptHistoryFrame(value: unknown): PromptHistoryFrame {
  if (!object(value)) invalid();
  exact(value, ['viewId', 'generation', 'version', 'items', 'loading', 'scanned', 'total', 'complete']);
  if (!id(value.viewId) || !count(value.generation) || !count(value.version) || !count(value.scanned)
    || value.total !== undefined && (!count(value.total) || value.total < value.scanned)
    || typeof value.loading !== 'boolean' || typeof value.complete !== 'boolean'
    || !Array.isArray(value.items) || value.items.length > 50 || encoder.encode(JSON.stringify(value)).length > 60 * 1024) invalid();
  const items = value.items.map(item => {
    if (!object(item)) invalid(); exact(item, ['id', 'text', 'cwd', 'sessionLabel', 'sessionName', 'timestamp']);
    if (!id(item.id) || !text(item.text, 512) || !text(item.cwd, 128) || !text(item.sessionLabel, 128)
      || item.sessionName !== undefined && !text(item.sessionName, 128) || !count(item.timestamp)) invalid();
    return { id: item.id, text: item.text, cwd: item.cwd, sessionLabel: item.sessionLabel, timestamp: item.timestamp,
      ...(item.sessionName === undefined ? {} : { sessionName: item.sessionName as string }) };
  });
  if (new Set(items.map(item => item.id)).size !== items.length) invalid();
  return { viewId: value.viewId, generation: value.generation, version: value.version, items, loading: value.loading,
    scanned: value.scanned, complete: value.complete, ...(value.total === undefined ? {} : { total: value.total as number }) };
}

export function parsePromptHistoryText(value: unknown): PromptHistoryText {
  if (!object(value)) invalid(); exact(value, ['viewId', 'generation', 'index', 'text']);
  if (!id(value.viewId) || !count(value.generation) || !count(value.index, 65535) || !text(value.text, 24 * 1024)
    || encoder.encode(JSON.stringify(value.text)).length > 24 * 1024) invalid();
  return { viewId: value.viewId, generation: value.generation, index: value.index, text: value.text };
}

export function splitPromptHistoryText(value: string): { chunks: string[]; bytes: number } {
  const bytes = encoder.encode(value).length;
  if (bytes > PROMPT_HISTORY_TEXT_BYTES) throw new Error('Selected prompt exceeds the safe display limit. It was not truncated.');
  const chunks: string[] = []; let chunk = ''; let size = 2;
  for (const char of value) {
    const cost = encoder.encode(JSON.stringify(char)).length - 2;
    if (size + cost > 24 * 1024) { chunks.push(chunk); chunk = ''; size = 2; }
    chunk += char; size += cost;
  }
  chunks.push(chunk); return { chunks, bytes };
}
