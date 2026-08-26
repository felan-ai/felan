import { join } from 'node:path';
import type {
  AgentRuntime,
  AgentRuntimeStorage,
  ExtensionContext,
  FelanExtensionAPI,
} from '@felan-ai/agent-core';
import { PROVIDER_NAMES, type StoredResult } from './types.js';

const CACHE_TTL_MS = 60 * 60 * 1_000;
const CACHE_DIRECTORY = 'web-access-results';
const CACHE_REFERENCE_VERSION = 1;
const CACHE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u;
const CACHE_KEY_PATTERN = /^[A-Za-z0-9_-]{1,128}\.json$/u;
const MAX_ITEM_BYTES = 32 * 1024 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_ENTRIES = 128;
const MAX_LEGACY_INLINE_BYTES = 256 * 1024;
const SESSION_ENTRY_TYPE = 'felan-web-access-result';
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const providerNames = new Set<string>(PROVIDER_NAMES);

export interface StoreLimits {
  maxEntries: number;
  maxItemBytes: number;
  maxTotalBytes: number;
  maxLegacyInlineBytes: number;
}

interface StoredResultReference {
  version: typeof CACHE_REFERENCE_VERSION;
  id: string;
  type: StoredResult['type'];
  timestamp: number;
  key: string;
  bytes: number;
}

interface StoredEntry {
  value: StoredResult;
  bytes: number;
  key?: string;
}

interface CacheCandidate {
  id: string;
  type: StoredResult['type'];
  timestamp: number;
  key: string;
  bytes: number;
}

const DEFAULT_LIMITS: StoreLimits = {
  maxEntries: MAX_ENTRIES,
  maxItemBytes: MAX_ITEM_BYTES,
  maxTotalBytes: MAX_TOTAL_BYTES,
  maxLegacyInlineBytes: MAX_LEGACY_INLINE_BYTES,
};

export class ResultStore {
  readonly #entries = new Map<string, StoredEntry>();
  readonly #storage: AgentRuntimeStorage;
  readonly #directory: string;
  readonly #limits: StoreLimits;
  #control = Promise.resolve();
  #totalBytes = 0;

  constructor(
    runtime: AgentRuntime,
    private readonly appendEntry: FelanExtensionAPI['appendEntry'],
    limits: Partial<StoreLimits> = {},
  ) {
    this.#storage = runtime.storage('session');
    this.#directory = join(this.#storage.root, CACHE_DIRECTORY);
    this.#limits = validateLimits({ ...DEFAULT_LIMITS, ...limits });
  }

  async restore(ctx: ExtensionContext): Promise<void> {
    await this.#run(async () => {
      this.#clearMemory();
      const now = Date.now();
      const cached = await this.#pruneCache(now);
      const restored: StoredEntry[] = [];
      const seen = new Set<string>();

      for (const entry of [...ctx.sessionManager.getBranch()].reverse()) {
        if (entry.type !== 'custom' || entry.customType !== SESSION_ENTRY_TYPE) continue;
        const reference = parseStoredResultReference(entry.data);
        if (reference) {
          if (seen.has(reference.id) || !isCurrent(reference.timestamp, now)) continue;
          const cacheEntry = cached.get(reference.key);
          if (!cacheEntry
            || cacheEntry.value.id !== reference.id
            || cacheEntry.value.type !== reference.type
            || cacheEntry.value.timestamp !== reference.timestamp
            || cacheEntry.bytes !== reference.bytes) continue;
          seen.add(reference.id);
          restored.push({ ...cacheEntry, key: reference.key });
          continue;
        }

        if (!isStoredResult(entry.data) || seen.has(entry.data.id) || !isCurrent(entry.data.timestamp, now)) continue;
        const bytes = serializedBytes(entry.data);
        if (bytes > this.#limits.maxLegacyInlineBytes || bytes > this.#limits.maxItemBytes) continue;
        seen.add(entry.data.id);
        restored.push({ value: entry.data, bytes });
      }

      restored.sort(compareStoredEntries);
      for (const entry of restored) this.#addMemoryEntry(entry);
      await this.#enforceMemoryLimits();
    });
  }

  async put(value: StoredResult): Promise<void> {
    await this.#run(async () => {
      const now = Date.now();
      if (!isStoredResult(value) || !isCurrent(value.timestamp, now)) {
        throw new Error('Stored web result is invalid');
      }
      const bytes = serialize(value);
      if (bytes.byteLength > this.#limits.maxItemBytes) {
        throw new Error('Stored web result exceeds the per-result storage limit');
      }

      const key = cacheKeyForId(value.id);
      const path = this.#cachePath(key);
      await this.#storage.mkdir(this.#directory, { recursive: true });
      await this.#storage.writeFile(path, bytes);

      let appended = false;
      try {
        const cached = await this.#pruneCache(now);
        this.#reconcileMemory(cached);
        const written = cached.get(key);
        if (!written || written.bytes !== bytes.byteLength) {
          throw new Error('Stored web result could not be retained within cache limits');
        }

        this.#removeMemoryEntry(value.id);
        this.#addMemoryEntry({ value, bytes: bytes.byteLength, key });
        await this.#enforceMemoryLimits();
        if (!this.#entries.has(value.id)) {
          throw new Error('Stored web result could not be retained within cache limits');
        }

        const reference: StoredResultReference = {
          version: CACHE_REFERENCE_VERSION,
          id: value.id,
          type: value.type,
          timestamp: value.timestamp,
          key,
          bytes: bytes.byteLength,
        };
        this.appendEntry(SESSION_ENTRY_TYPE, reference);
        appended = true;
      } finally {
        if (!appended) {
          this.#removeMemoryEntry(value.id);
          await removeIfPresent(this.#storage, path);
        }
      }
    });
  }

  async get(id: string): Promise<StoredResult | undefined> {
    return this.#run(async () => {
      if (!CACHE_ID_PATTERN.test(id)) return undefined;
      await this.#pruneExpiredMemory(Date.now());
      return this.#entries.get(id)?.value;
    });
  }

  async clear(): Promise<void> {
    await this.#run(async () => this.#clearMemory());
  }

  async #pruneCache(now: number): Promise<Map<string, StoredEntry>> {
    const cached = new Map<string, StoredEntry>();
    const candidates: CacheCandidate[] = [];
    let keys: string[];
    try {
      keys = await this.#storage.listFiles(this.#directory);
    } catch (error) {
      if (isNotFoundError(error)) return cached;
      throw error;
    }

    for (const key of keys) {
      if (!CACHE_KEY_PATTERN.test(key)) continue;
      const path = this.#cachePath(key);
      let bytes: Uint8Array;
      try {
        bytes = await this.#storage.readFile(path);
      } catch (error) {
        if (isNotFoundError(error)) continue;
        throw error;
      }
      if (bytes.byteLength > this.#limits.maxItemBytes) {
        await removeIfPresent(this.#storage, path);
        continue;
      }
      const value = parseStoredResult(bytes);
      if (!value || cacheKeyForId(value.id) !== key || !isCurrent(value.timestamp, now)) {
        await removeIfPresent(this.#storage, path);
        continue;
      }
      candidates.push({
        id: value.id,
        type: value.type,
        timestamp: value.timestamp,
        key,
        bytes: bytes.byteLength,
      });
    }

    candidates.sort(compareCacheCandidates);
    let firstRetained = 0;
    let retainedBytes = candidates.reduce((total, candidate) => total + candidate.bytes, 0);
    while (
      candidates.length - firstRetained > this.#limits.maxEntries
      || retainedBytes > this.#limits.maxTotalBytes
    ) {
      const evicted = candidates[firstRetained++];
      if (!evicted) break;
      retainedBytes -= evicted.bytes;
      await removeIfPresent(this.#storage, this.#cachePath(evicted.key));
    }

    for (const candidate of candidates.slice(firstRetained)) {
      const path = this.#cachePath(candidate.key);
      let bytes: Uint8Array;
      try {
        bytes = await this.#storage.readFile(path);
      } catch (error) {
        if (isNotFoundError(error)) continue;
        throw error;
      }
      const value = bytes.byteLength === candidate.bytes ? parseStoredResult(bytes) : undefined;
      if (!value || !matchesCandidate(value, candidate)) {
        await removeIfPresent(this.#storage, path);
        continue;
      }
      cached.set(candidate.key, { value, bytes: candidate.bytes, key: candidate.key });
    }
    return cached;
  }

  async #enforceMemoryLimits(): Promise<void> {
    const ordered = [...this.#entries.entries()].sort((left, right) => compareStoredEntries(left[1], right[1]));
    while (this.#entries.size > this.#limits.maxEntries || this.#totalBytes > this.#limits.maxTotalBytes) {
      const evicted = ordered.shift();
      if (!evicted) break;
      this.#removeMemoryEntry(evicted[0]);
      if (evicted[1].key) await removeIfPresent(this.#storage, this.#cachePath(evicted[1].key));
    }
  }

  async #pruneExpiredMemory(now: number): Promise<void> {
    for (const [id, entry] of this.#entries) {
      if (isCurrent(entry.value.timestamp, now)) continue;
      this.#removeMemoryEntry(id);
      if (entry.key) await removeIfPresent(this.#storage, this.#cachePath(entry.key));
    }
  }

  #reconcileMemory(cached: Map<string, StoredEntry>): void {
    for (const [id, entry] of this.#entries) {
      if (entry.key && !cached.has(entry.key)) this.#removeMemoryEntry(id);
    }
  }

  #cachePath(key: string): string {
    if (!CACHE_KEY_PATTERN.test(key)) throw new Error(`Invalid stored web result cache key: ${key}`);
    return join(this.#directory, key);
  }

  #addMemoryEntry(entry: StoredEntry): void {
    this.#entries.set(entry.value.id, entry);
    this.#totalBytes += entry.bytes;
  }

  #removeMemoryEntry(id: string): void {
    const entry = this.#entries.get(id);
    if (!entry) return;
    this.#entries.delete(id);
    this.#totalBytes -= entry.bytes;
  }

  #clearMemory(): void {
    this.#entries.clear();
    this.#totalBytes = 0;
  }

  async #run<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#control;
    let release!: () => void;
    this.#control = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

export function generateResponseId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 9)}`;
}

function cacheKeyForId(id: string): string {
  if (!CACHE_ID_PATTERN.test(id)) throw new Error(`Invalid stored web result id: ${id}`);
  return `${id}.json`;
}

function parseStoredResultReference(value: unknown): StoredResultReference | undefined {
  if (!isRecord(value)
    || value.version !== CACHE_REFERENCE_VERSION
    || typeof value.id !== 'string'
    || !CACHE_ID_PATTERN.test(value.id)
    || (value.type !== 'search' && value.type !== 'fetch' && value.type !== 'research')
    || !isFiniteTimestamp(value.timestamp)
    || typeof value.key !== 'string'
    || !CACHE_KEY_PATTERN.test(value.key)
    || value.key !== `${value.id}.json`
    || typeof value.bytes !== 'number'
    || !Number.isSafeInteger(value.bytes)
    || value.bytes <= 0
    || value.bytes > MAX_ITEM_BYTES) return undefined;
  return value as unknown as StoredResultReference;
}

function parseStoredResult(bytes: Uint8Array): StoredResult | undefined {
  try {
    const value: unknown = JSON.parse(decoder.decode(bytes));
    return isStoredResult(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function serialize(value: StoredResult): Uint8Array {
  return encoder.encode(JSON.stringify(value));
}

function serializedBytes(value: StoredResult): number {
  return serialize(value).byteLength;
}

function compareStoredEntries(left: StoredEntry, right: StoredEntry): number {
  return left.value.timestamp - right.value.timestamp || left.value.id.localeCompare(right.value.id);
}

function compareCacheCandidates(left: CacheCandidate, right: CacheCandidate): number {
  return left.timestamp - right.timestamp || left.id.localeCompare(right.id);
}

function matchesCandidate(value: StoredResult, candidate: CacheCandidate): boolean {
  return value.id === candidate.id
    && value.type === candidate.type
    && value.timestamp === candidate.timestamp;
}

function isCurrent(timestamp: number, now: number): boolean {
  return timestamp <= now && now - timestamp < CACHE_TTL_MS;
}

function validateLimits(limits: StoreLimits): StoreLimits {
  if (!Number.isSafeInteger(limits.maxEntries) || limits.maxEntries <= 0
    || !Number.isSafeInteger(limits.maxItemBytes) || limits.maxItemBytes <= 0
    || !Number.isSafeInteger(limits.maxTotalBytes) || limits.maxTotalBytes <= 0
    || limits.maxItemBytes > limits.maxTotalBytes
    || !Number.isSafeInteger(limits.maxLegacyInlineBytes) || limits.maxLegacyInlineBytes <= 0) {
    throw new Error('Stored web result limits must be positive integers');
  }
  return limits;
}

async function removeIfPresent(storage: AgentRuntimeStorage, path: string): Promise<void> {
  try {
    await storage.remove(path);
  } catch (error) {
    if (!isNotFoundError(error)) throw error;
  }
}

function isNotFoundError(error: unknown): boolean {
  return error instanceof Error && (
    ('code' in error && error.code === 'ENOENT')
    || /(?:not found|does not exist|no such file)/iu.test(error.message)
  );
}

function isStoredResult(value: unknown): value is StoredResult {
  if (!isRecord(value)
    || typeof value.id !== 'string'
    || !CACHE_ID_PATTERN.test(value.id)
    || !isFiniteTimestamp(value.timestamp)
    || (value.answer !== undefined && typeof value.answer !== 'string')) return false;
  if (value.type === 'search') return Array.isArray(value.queries) && value.queries.every(isSearchQueryRecord);
  if (value.type === 'fetch') return Array.isArray(value.urls) && value.urls.every(isExtractedContent);
  if (value.type === 'research') {
    return Array.isArray(value.queries)
      && value.queries.every(isSearchQueryRecord)
      && Array.isArray(value.urls)
      && value.urls.every(isExtractedContent)
      && isResearchArtifact(value.artifact);
  }
  return false;
}

function isSearchQueryRecord(value: unknown): boolean {
  return isRecord(value)
    && typeof value.query === 'string'
    && Array.isArray(value.responses)
    && value.responses.every(isSearchResponse)
    && Array.isArray(value.fetched)
    && value.fetched.every(isExtractedContent)
    && Array.isArray(value.errors)
    && value.errors.every((error) => isRecord(error) && providerNames.has(String(error.provider)) && typeof error.error === 'string');
}

function isSearchResponse(value: unknown): boolean {
  return isRecord(value)
    && providerNames.has(String(value.provider))
    && typeof value.answer === 'string'
    && Array.isArray(value.results)
    && value.results.every((result) => isRecord(result)
      && typeof result.title === 'string'
      && typeof result.url === 'string'
      && typeof result.snippet === 'string')
    && (value.inlineContent === undefined
      || (Array.isArray(value.inlineContent) && value.inlineContent.every(isExtractedContent)));
}

function isExtractedContent(value: unknown): boolean {
  return isRecord(value)
    && typeof value.url === 'string'
    && typeof value.title === 'string'
    && typeof value.content === 'string'
    && (value.error === null || typeof value.error === 'string')
    && (value.contentType === undefined || typeof value.contentType === 'string')
    && (value.truncated === undefined || typeof value.truncated === 'boolean')
    && (value.image === undefined || (isRecord(value.image)
      && typeof value.image.data === 'string'
      && typeof value.image.mimeType === 'string'))
    && (value.repository === undefined || (isRecord(value.repository)
      && typeof value.repository.owner === 'string'
      && typeof value.repository.repo === 'string'
      && (value.repository.mode === 'local-checkout' || value.repository.mode === 'github-api')
      && typeof value.repository.commit === 'string'
      && /^[0-9a-f]{40}$/iu.test(value.repository.commit)
      && (value.repository.requestedRef === undefined || typeof value.repository.requestedRef === 'string')
      && (value.repository.checkoutPath === undefined || typeof value.repository.checkoutPath === 'string')));
}

function isResearchArtifact(value: unknown): boolean {
  return isRecord(value)
    && typeof value.id === 'string'
    && value.type === 'research'
    && isFiniteTimestamp(value.timestamp)
    && typeof value.claim === 'string'
    && typeof value.provider === 'string'
    && (value.status === 'supported' || value.status === 'contradicted' || value.status === 'unclear' || value.status === 'missing-evidence')
    && typeof value.confidence === 'number'
    && Number.isFinite(value.confidence)
    && typeof value.rationale === 'string'
    && Array.isArray(value.summaries)
    && value.summaries.every((summary) => isRecord(summary) && providerNames.has(String(summary.provider)) && typeof summary.text === 'string')
    && Array.isArray(value.sources)
    && value.sources.every(isResearchSource)
    && Array.isArray(value.passages)
    && value.passages.every(isResearchPassage)
    && isStringArray(value.supportingPassages)
    && isStringArray(value.contradictingPassages)
    && isRecord(value.filters)
    && (value.filters.recency === undefined || value.filters.recency === 'day' || value.filters.recency === 'week' || value.filters.recency === 'month' || value.filters.recency === 'year')
    && isStringArray(value.filters.domainInclude)
    && isStringArray(value.filters.domainExclude)
    && Array.isArray(value.errors)
    && value.errors.every((error) => isRecord(error) && typeof error.query === 'string' && typeof error.error === 'string');
}

function isResearchSource(value: unknown): boolean {
  return isRecord(value)
    && isFiniteNumber(value.rank)
    && typeof value.url === 'string'
    && typeof value.title === 'string'
    && typeof value.snippet === 'string'
    && typeof value.quality === 'string'
    && typeof value.fetched === 'boolean'
    && (value.fetchError === undefined || typeof value.fetchError === 'string')
    && (value.contentHash === undefined || typeof value.contentHash === 'string');
}

function isResearchPassage(value: unknown): boolean {
  return isRecord(value)
    && typeof value.passageId === 'string'
    && typeof value.sourceUrl === 'string'
    && isFiniteNumber(value.sourceRank)
    && typeof value.text === 'string'
    && typeof value.contentHash === 'string'
    && (value.extractionSpan === undefined || (isRecord(value.extractionSpan)
      && isFiniteNumber(value.extractionSpan.start)
      && isFiniteNumber(value.extractionSpan.end)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isFiniteTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}
