import type { ExtensionContext, FelanExtensionAPI } from '@felan-ai/agent-core';
import type { StoredResult } from './types.js';

const CACHE_TTL_MS = 60 * 60 * 1_000;
const MAX_ITEM_BYTES = 32 * 1024 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const SESSION_ENTRY_TYPE = 'felan-web-access-result';

interface StoredEntry {
  value: StoredResult;
  bytes: number;
}

export class ResultStore {
  readonly #entries = new Map<string, StoredEntry>();
  #totalBytes = 0;
  #persistedBytes = 0;

  constructor(private readonly appendEntry: FelanExtensionAPI['appendEntry']) {}

  restore(ctx: ExtensionContext): void {
    this.#entries.clear();
    this.#totalBytes = 0;
    this.#persistedBytes = 0;
    const now = Date.now();
    const branch = [...ctx.sessionManager.getBranch()].reverse();
    for (const entry of branch) {
      if (entry.type !== 'custom' || entry.customType !== SESSION_ENTRY_TYPE || !isStoredResult(entry.data)) continue;
      if (now - entry.data.timestamp > CACHE_TTL_MS || this.#entries.has(entry.data.id)) continue;
      const bytes = serializedBytes(entry.data);
      this.#persistedBytes += bytes;
      if (bytes > MAX_ITEM_BYTES || this.#totalBytes + bytes > MAX_TOTAL_BYTES) continue;
      this.#entries.set(entry.data.id, { value: entry.data, bytes });
      this.#totalBytes += bytes;
    }
  }

  put(value: StoredResult): void {
    const bytes = serializedBytes(value);
    if (bytes > MAX_ITEM_BYTES) throw new Error('Stored web result exceeds the per-result storage limit');
    this.pruneExpired();
    while (this.#totalBytes + bytes > MAX_TOTAL_BYTES && this.#entries.size > 0) {
      const oldest = this.#entries.keys().next().value as string | undefined;
      if (!oldest) break;
      this.delete(oldest);
    }
    this.#entries.set(value.id, { value, bytes });
    this.#totalBytes += bytes;
    if (this.#persistedBytes + bytes <= MAX_TOTAL_BYTES) {
      this.appendEntry(SESSION_ENTRY_TYPE, value);
      this.#persistedBytes += bytes;
    }
  }

  get(id: string): StoredResult | undefined {
    this.pruneExpired();
    return this.#entries.get(id)?.value;
  }

  clear(): void {
    this.#entries.clear();
    this.#totalBytes = 0;
    this.#persistedBytes = 0;
  }

  private delete(id: string): void {
    const entry = this.#entries.get(id);
    if (!entry) return;
    this.#entries.delete(id);
    this.#totalBytes -= entry.bytes;
  }

  private pruneExpired(): void {
    const threshold = Date.now() - CACHE_TTL_MS;
    for (const [id, entry] of this.#entries) {
      if (entry.value.timestamp < threshold) this.delete(id);
    }
  }
}

export function generateResponseId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 9)}`;
}

function serializedBytes(value: StoredResult): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function isStoredResult(value: unknown): value is StoredResult {
  if (!value || typeof value !== 'object') return false;
  const result = value as Partial<StoredResult>;
  return typeof result.id === 'string'
    && typeof result.timestamp === 'number'
    && (result.type === 'search' || result.type === 'fetch' || result.type === 'research');
}
