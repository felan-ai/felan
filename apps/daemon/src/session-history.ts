import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { setImmediate as yieldTurn } from 'node:timers/promises';
import { migrateSessionEntries, type FileEntry } from '@earendil-works/pi-coding-agent';
import {
  SESSION_HISTORY_LIMITS,
  SessionsServiceError,
  type HistoryRevision,
  type SessionEntry,
  type SessionHistoryInfo,
  type SessionPageOptions,
  type SessionRef,
  type SessionsHistory,
  type SessionsRequestOptions,
} from '@felan-ai/agent-core';

export interface SessionHistorySource {
  /** Private locator, resolved only by the injected reader. Never returned to consumers. */
  readonly key: string;
  readonly sessionId: string;
  readonly id?: string;
  readonly root?: string;
  readonly parent?: string;
  readonly cwd: string;
  readonly title: string;
  readonly updatedAt: number;
  readonly state: 'open' | 'closed';
  /** The transcript may grow without a generation() change, so cached inventories re-check it through refresh. */
  readonly growing?: boolean;
  readonly bytes?: number;
  readonly fingerprint?: string;
  readonly diagnostic?: SessionHistoryInfo['diagnostic'];
}

export interface CreateSessionHistoryBackendOptions {
  readonly current: SessionRef;
  readonly project: string;
  /** Must include only sources visible to this session under current host policy. */
  readonly inventory: (options: SessionsRequestOptions) => Promise<readonly SessionHistorySource[]>;
  /** Cheap token that changes whenever the visible source set, its metadata or the set of growing sources may have changed. Must not stat or read files. */
  readonly generation: () => string;
  /** Current inventory row for one source key, or undefined when it is no longer visible. Must apply the same policy as `inventory`. */
  readonly refresh: (source: SessionHistorySource, options: SessionsRequestOptions) => Promise<SessionHistorySource | undefined>;
  /** Must verify source ownership/identity and return one consistent, bounded byte snapshot. */
  readonly read: (source: SessionHistorySource, options: { readonly maxBytes: number; readonly signal?: AbortSignal }) => Promise<Uint8Array>;
}

interface InventoryRow {
  readonly source: SessionHistorySource;
  readonly info: SessionHistoryInfo;
  readonly identity: string;
}

interface Snapshot {
  readonly rows: readonly InventoryRow[];
  readonly revision: string;
}

interface Loaded {
  readonly identity: string;
  readonly entries: readonly SessionEntry[];
  readonly startedAt?: string;
  readonly revision: string;
  readonly branch: string | null;
  readonly byteLength: number;
}

interface CachedTranscript {
  readonly loaded: Loaded;
  lastUsed: number;
}

interface Cursor {
  readonly kind: 'list' | 'history';
  readonly target: string;
  readonly revision: string;
  readonly branch: string | null;
  readonly offset: number;
}

interface PageRequest {
  readonly limit: number;
  readonly signal?: AbortSignal;
  readonly cursor?: string;
}

const identifier = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u;
const digestPattern = /^[a-f0-9]{64}$/u;
const maxCachedTranscripts = 32;
const maxCachedTranscriptBytes = 64 * 1024 * 1024;
const maxCachedTranscriptIdleMs = 30_000;

export function createSessionHistoryBackend(options: CreateSessionHistoryBackendOptions): SessionsHistory {
  if (!options || !validRef(options.current) || typeof options.project !== 'string'
    || typeof options.inventory !== 'function' || typeof options.read !== 'function'
    || typeof options.generation !== 'function' || typeof options.refresh !== 'function') fail('invalid');
  const current = Object.freeze(copyRef(options.current));
  const { inventory, read, generation, refresh, project } = options;
  const cursorKey = randomBytes(32);
  let inventoryCache: { readonly generation: string; readonly state: Snapshot } | undefined;
  const parsedCache = new Map<string, CachedTranscript>();
  let parsedCacheBytes = 0;
  let parsedCacheTimer: ReturnType<typeof setTimeout> | undefined;

  function encodeCursor(cursor: Cursor): string {
    const body = Buffer.from(JSON.stringify(cursor)).toString('base64url');
    return `${body}.${createHmac('sha256', cursorKey).update(body).digest('base64url')}`;
  }

  function decodeCursor(value: string): Cursor {
    const parts = value.split('.');
    if (parts.length !== 2 || !parts.every(part => /^[a-zA-Z0-9_-]+$/u.test(part))) fail('invalid');
    const body = parts[0]!;
    const expected = createHmac('sha256', cursorKey).update(body).digest();
    const supplied = Buffer.from(parts[1]!, 'base64url');
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) fail('invalid');
    let decoded: unknown;
    try { decoded = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); }
    catch { fail('invalid'); }
    if (!isRecord(decoded) || !['list', 'history'].includes(String(decoded.kind)) || typeof decoded.target !== 'string'
      || !validDigest(decoded.revision) || decoded.branch !== null && !validId(decoded.branch)
      || !Number.isSafeInteger(decoded.offset) || (decoded.offset as number) < 1) fail('invalid');
    return decoded as unknown as Cursor;
  }

  async function snapshot(signal?: AbortSignal, listRevision?: string): Promise<Snapshot> {
    checkAbort(signal);
    const token = generation();
    if (typeof token !== 'string') fail('inaccessible');
    if (inventoryCache?.generation === token) {
      const state = inventoryCache.state;
      if (listRevision === state.revision) return state;
      const rows: InventoryRow[] = [];
      let changed = false;
      for (const row of state.rows) {
        const next = row.source.growing === true ? await refreshed(row.source, signal) : row;
        if (next?.identity !== row.identity) changed = true;
        if (next) rows.push(next);
      }
      if (!changed) return state;
      const updated = buildSnapshot(rows);
      inventoryCache = { generation: token, state: updated };
      return updated;
    }
    const sources = await inventory(signal ? { signal } : {});
    checkAbort(signal);
    if (!Array.isArray(sources)) fail('inaccessible');
    if (sources.length > 65_536) fail('oversize');
    const copied = sources.map(sourceCopy);
    const rows: InventoryRow[] = [];
    for (const [index, source] of copied.entries()) {
      rows.push(inventoryRow(source));
      if (index % 128 === 127) await yieldTurn(undefined, signal ? { signal } : {});
    }
    checkAbort(signal);
    const state = buildSnapshot(rows);
    inventoryCache = { generation: token, state };
    return state;
  }

  async function refreshed(source: SessionHistorySource, signal?: AbortSignal): Promise<InventoryRow | undefined> {
    checkAbort(signal);
    const value = await refresh(source, signal ? { signal } : {});
    checkAbort(signal);
    return value === undefined ? undefined : inventoryRow(sourceCopy(value));
  }

  function stale(): never {
    inventoryCache = undefined;
    for (const identity of parsedCache.keys()) dropParsed(identity);
    fail('stale');
  }

  function staleSource(row: InventoryRow, listed: InventoryRow): never {
    dropParsed(row.identity);
    if (!listed.source.growing) inventoryCache = undefined;
    fail('stale');
  }

  function dropParsed(identity: string): void {
    const cached = parsedCache.get(identity);
    if (!cached) return;
    parsedCache.delete(identity);
    parsedCacheBytes -= cached.loaded.byteLength;
    if (parsedCache.size === 0 && parsedCacheTimer) {
      clearTimeout(parsedCacheTimer);
      parsedCacheTimer = undefined;
    }
  }

  function scheduleParsedEviction(): void {
    if (parsedCacheTimer) return;
    const oldest = parsedCache.values().next().value;
    if (!oldest) return;
    parsedCacheTimer = setTimeout(() => {
      parsedCacheTimer = undefined;
      const cutoff = Date.now() - maxCachedTranscriptIdleMs;
      for (const [identity, cached] of parsedCache) {
        if (cached.lastUsed <= cutoff) dropParsed(identity);
      }
      scheduleParsedEviction();
    }, Math.max(0, oldest.lastUsed + maxCachedTranscriptIdleMs - Date.now()));
    parsedCacheTimer.unref();
  }

  // A cached inventory only maps an ID to its source; the refreshed row is authoritative for every read.
  async function load(id: string, signal?: AbortSignal): Promise<Loaded> {
    if (!validId(id)) fail('invalid');
    checkAbort(signal);
    const find = (state?: Snapshot) => state?.rows.find(value => value.info.id === id);
    const listed = find(inventoryCache?.state) ?? find(await snapshot(signal));
    if (!listed) fail('inaccessible');
    const row = await refreshed(listed.source, signal);
    if (row?.identity !== listed.identity && !listed.source.growing) inventoryCache = undefined;
    if (!row) fail('inaccessible');
    if (row.info.id !== id) stale();
    if (row.source.diagnostic) fail(row.source.diagnostic);
    if (row.source.bytes !== undefined && row.source.bytes > SESSION_HISTORY_LIMITS.fileBytes) fail('oversize');
    const cached = row.source.bytes === undefined ? undefined : parsedCache.get(row.identity);
    if (cached) {
      if (Date.now() - cached.lastUsed < maxCachedTranscriptIdleMs) {
        cached.lastUsed = Date.now();
        parsedCache.delete(row.identity);
        parsedCache.set(row.identity, cached);
        return cached.loaded;
      }
      dropParsed(row.identity);
    }
    const value = await read(row.source, { maxBytes: SESSION_HISTORY_LIMITS.fileBytes, ...(signal ? { signal } : {}) });
    checkAbort(signal);
    if (!(value instanceof Uint8Array)) fail('inaccessible');
    if (value.byteLength > SESSION_HISTORY_LIMITS.fileBytes) fail('oversize');
    const bytes = new Uint8Array(value);
    const revision = hash(bytes);
    if (row.source.fingerprint !== undefined && row.source.fingerprint !== revision) staleSource(row, listed);
    if (row.source.bytes !== undefined && row.source.bytes !== bytes.byteLength) staleSource(row, listed);
    const parsed = await parseTranscript(bytes, row.source.sessionId, signal);
    // Pi resumes a transcript at its last entry, so that entry is the active leaf.
    const branch = parsed.entries.at(-1)?.id ?? null;
    if ((await refreshed(row.source, signal))?.identity !== row.identity) staleSource(row, listed);
    const loaded = { ...parsed, identity: row.identity, revision, branch, byteLength: bytes.byteLength };
    // Without a byte count, the source identity cannot distinguish rewritten content.
    if (row.source.bytes !== undefined) {
      dropParsed(row.identity);
      parsedCache.set(row.identity, { loaded, lastUsed: Date.now() });
      parsedCacheBytes += loaded.byteLength;
      while (parsedCache.size > maxCachedTranscripts || parsedCacheBytes > maxCachedTranscriptBytes) {
        dropParsed(parsedCache.keys().next().value!);
      }
      scheduleParsedEviction();
    }
    return loaded;
  }

  return Object.freeze({
    current,
    list: (filter, options) => safely(options?.signal, async () => {
      const request = pageRequest(options);
      if (!filter || !['root', 'project', 'visible'].includes(filter.scope)) fail('invalid');
      const scope = filter.scope;
      const state = await snapshot(request.signal, request.cursor ? decodeCursor(request.cursor).revision : undefined);
      const rows = state.rows.filter(row => scope === 'visible' || (scope === 'root' ? row.info.root === current.root : row.info.cwd === project));
      const offset = pageOffset(request, { kind: 'list', target: scope, revision: state.revision, branch: null });
      return packPage(rows.map(row => row.info), 'items', {}, request, offset,
        next => encodeCursor({ kind: 'list', target: scope, revision: state.revision, branch: null, offset: next }));
    }),
    history: (id, options) => safely(options?.signal, async () => {
      const request = pageRequest(options);
      const at = copyRevision(options?.at);
      const loaded = await load(id, request.signal);
      if (at && (at.sessionId !== id || !sameRevision(at, loaded))) fail('stale');
      const offset = pageOffset(request, { kind: 'history', target: id, ...loaded });
      const page = packPage(loaded.entries, 'entries', { sessionId: id, revision: loaded.revision, branch: loaded.branch,
        ...(loaded.startedAt === undefined ? {} : { startedAt: loaded.startedAt }) }, request, offset,
        next => encodeCursor({ kind: 'history', target: id, revision: loaded.revision, branch: loaded.branch, offset: next }));
      if (!page.nextCursor) dropParsed(loaded.identity);
      return page;
    }),
    checkpoint: (id, options) => safely(options?.signal, async () => {
      const request = requestOptions(options);
      const loaded = await load(id, request.signal);
      const byId = new Map(loaded.entries.map(entry => [entry.id, entry]));
      const branch: SessionEntry[] = [];
      let leaf = loaded.branch;
      while (leaf !== null) {
        const entry = byId.get(leaf);
        if (!entry) fail('invalid');
        branch.push(entry);
        leaf = entry.parentId;
      }
      branch.reverse();
      checkAbort(request.signal);
      return { sessionId: id, revision: loaded.revision, branch: loaded.branch,
        byteLength: loaded.byteLength, transcriptDigest: hash(canonicalJson(branch)) };
    }),
  } satisfies SessionsHistory);

  function pageOffset(request: PageRequest, expected: Omit<Cursor, 'offset'>): number {
    if (!request.cursor) return 0;
    const cursor = decodeCursor(request.cursor);
    if (cursor.kind !== expected.kind || cursor.target !== expected.target || !sameRevision(cursor, expected)) fail('stale');
    return cursor.offset;
  }
}

function packPage<T, K extends 'items' | 'entries', M extends object>(
  values: readonly T[], key: K, metadata: M, request: PageRequest, offset: number, cursor: (next: number) => string,
): M & Record<K, readonly T[]> & { readonly nextCursor?: string } {
  if (offset > values.length) fail('stale');
  const items: T[] = [];
  const next = offset + 1 < values.length ? cursor(values.length) : undefined;
  const overhead = Buffer.byteLength(JSON.stringify({ ...metadata, [key]: [], ...(next ? { nextCursor: next } : {}) }));
  let bytes = 0;
  for (let index = offset; index < values.length && items.length < request.limit; index += 1) {
    checkAbort(request.signal);
    const value = values[index]!;
    const itemBytes = Buffer.byteLength(JSON.stringify(value));
    if (overhead + bytes + itemBytes + items.length > SESSION_HISTORY_LIMITS.pageBytes) {
      if (items.length === 0) fail('oversize');
      break;
    }
    items.push(value);
    bytes += itemBytes;
  }
  const nextCursor = offset + items.length < values.length ? cursor(offset + items.length) : undefined;
  return { ...metadata, [key]: items, ...(nextCursor ? { nextCursor } : {}) } as M & Record<K, readonly T[]> & { readonly nextCursor?: string };
}

function sourceCopy(value: SessionHistorySource): SessionHistorySource {
  if (!value || typeof value !== 'object' || !validId(value.sessionId)
    || typeof value.key !== 'string' || value.key.length === 0 || value.key.length > 8192
    || value.id !== undefined && !validId(value.id) || value.root !== undefined && !validId(value.root)
    || value.parent !== undefined && !validId(value.parent)
    || typeof value.cwd !== 'string' || value.cwd.length > 4096 || typeof value.title !== 'string' || value.title.length > 4096
    || !Number.isSafeInteger(value.updatedAt) || value.updatedAt < 0 || !['open', 'closed'].includes(value.state)
    || value.growing !== undefined && typeof value.growing !== 'boolean'
    || value.bytes !== undefined && (!Number.isSafeInteger(value.bytes) || value.bytes < 0)
    || value.fingerprint !== undefined && !validDigest(value.fingerprint)
    || value.diagnostic !== undefined && !['inaccessible', 'oversize', 'unsupported'].includes(value.diagnostic)) fail('inaccessible');
  return Object.freeze({ key: value.key, sessionId: value.sessionId, cwd: value.cwd, title: value.title,
    updatedAt: value.updatedAt, state: value.state,
    ...(value.id === undefined ? {} : { id: value.id }), ...(value.root === undefined ? {} : { root: value.root }),
    ...(value.parent === undefined ? {} : { parent: value.parent }),
    ...(value.growing === undefined ? {} : { growing: value.growing }),
    ...(value.bytes === undefined ? {} : { bytes: value.bytes }),
    ...(value.fingerprint === undefined ? {} : { fingerprint: value.fingerprint }),
    ...(value.diagnostic === undefined ? {} : { diagnostic: value.diagnostic }),
  });
}

function inventoryRow(source: SessionHistorySource): InventoryRow {
  const id = source.id ?? `history-${hash(JSON.stringify([source.key, source.sessionId]))}`;
  const info: SessionHistoryInfo = Object.freeze({
    id, root: source.root ?? id, ...(source.parent === undefined ? {} : { parent: source.parent }),
    cwd: source.cwd, title: source.title, updatedAt: source.updatedAt, state: source.state,
    ...(source.diagnostic === undefined ? {} : { diagnostic: source.diagnostic }),
  });
  return { source, info, identity: hash(canonicalJson(source)) };
}

function buildSnapshot(rows: InventoryRow[]): Snapshot {
  const keys = new Set<string>();
  const ids = new Set<string>();
  for (const row of rows) {
    if (keys.has(row.source.key) || ids.has(row.info.id)) fail('inaccessible');
    keys.add(row.source.key);
    ids.add(row.info.id);
  }
  rows.sort((a, b) => b.info.updatedAt - a.info.updatedAt || compare(a.info.id, b.info.id));
  return { rows, revision: hash(JSON.stringify(rows.map(row => row.identity))) };
}

async function parseTranscript(bytes: Uint8Array, sessionId: string, signal?: AbortSignal): Promise<{ entries: SessionEntry[]; startedAt?: string }> {
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { fail('invalid'); }
  let header: Record<string, unknown> | undefined;
  const entries: SessionEntry[] = [];
  const ids = new Set<string>();
  let lineNumber = 0;
  for (const line of text.split('\n')) {
    checkAbort(signal);
    if (!line.trim()) continue;
    let value: unknown;
    try { value = JSON.parse(line); }
    catch { fail('invalid'); }
    assertJson(value);
    if (!isRecord(value)) fail('invalid');
    if (!header) {
      if (Buffer.byteLength(line) > 64 * 1024) fail('oversize');
      if (value.type !== 'session' || value.id !== sessionId || typeof value.cwd !== 'string') fail('invalid');
      if (value.version !== 2 && value.version !== 3) fail('unsupported');
      header = value;
    } else {
      validateEntry(value);
      if (value.id === sessionId || ids.has(value.id) || value.parentId !== null && !ids.has(value.parentId)) fail('invalid');
      ids.add(value.id);
      entries.push(value as unknown as SessionEntry);
    }
    if (++lineNumber % 64 === 0) await yieldTurn(undefined, signal ? { signal } : {});
  }
  if (!header) fail('invalid');
  // Pi's v1 migration creates random IDs; only its stable v2-to-v3 migration is safe for paging.
  if (header.version === 2) migrateSessionEntries([header, ...entries] as unknown as FileEntry[]);
  checkAbort(signal);
  deepFreeze(entries);
  const startedAt = typeof header.timestamp === 'string' && header.timestamp.length <= 128
    && /^\d{4}-\d{2}-\d{2}T/u.test(header.timestamp) && Number.isFinite(Date.parse(header.timestamp)) ? header.timestamp : undefined;
  return { entries, ...(startedAt === undefined ? {} : { startedAt }) };
}

function deepFreeze(value: unknown): void {
  if (value === null || typeof value !== 'object') return;
  for (const child of Object.values(value)) deepFreeze(child);
  Object.freeze(value);
}

function validateEntry(value: Record<string, unknown>): asserts value is Record<string, unknown> & { id: string; parentId: string | null } {
  if (!validId(value.id) || value.parentId !== null && !validId(value.parentId)
    || typeof value.timestamp !== 'string' || value.timestamp.length > 128 || !Number.isFinite(Date.parse(value.timestamp))) fail('invalid');
  const string = (key: string) => typeof value[key] === 'string';
  const optionalString = (key: string) => value[key] === undefined || string(key);
  const content = (input: unknown) => typeof input === 'string' || Array.isArray(input);
  switch (value.type) {
    case 'message':
      if (!isRecord(value.message) || typeof value.message.role !== 'string') fail('invalid');
      break;
    case 'thinking_level_change': if (!string('thinkingLevel')) fail('invalid'); break;
    case 'model_change': if (!string('provider') || !string('modelId')) fail('invalid'); break;
    case 'usage': if (!string('kind') || !string('provider') || !string('model') || !isRecord(value.usage)) fail('invalid'); break;
    case 'compaction':
      if (!string('summary') || !validId(value.firstKeptEntryId) || typeof value.tokensBefore !== 'number' || value.tokensBefore < 0) fail('invalid');
      break;
    case 'branch_summary': if (!string('summary') || !validId(value.fromId)) fail('invalid'); break;
    case 'custom': if (!string('customType')) fail('invalid'); break;
    case 'custom_message': if (!string('customType') || !content(value.content) || typeof value.display !== 'boolean') fail('invalid'); break;
    case 'context_edit':
      if (!validId(value.targetId) || value.replacement !== null && (!isRecord(value.replacement) || !content(value.replacement.content))) fail('invalid');
      break;
    case 'label': if (!validId(value.targetId) || !optionalString('label')) fail('invalid'); break;
    case 'session_info': if (!optionalString('name')) fail('invalid'); break;
    default: fail('unsupported');
  }
}

function requestOptions(value?: SessionsRequestOptions): SessionsRequestOptions {
  if (value !== undefined && (!value || typeof value !== 'object')) fail('invalid');
  const signal = value?.signal;
  if (signal !== undefined && !(signal instanceof AbortSignal)) fail('invalid');
  checkAbort(signal);
  return signal ? { signal } : {};
}

function pageRequest(value?: SessionPageOptions): PageRequest {
  const request = requestOptions(value);
  if (value?.limit !== undefined && (!Number.isSafeInteger(value.limit) || value.limit < 1 || value.limit > SESSION_HISTORY_LIMITS.pageEntries)
    || value?.cursor !== undefined && (typeof value.cursor !== 'string' || !value.cursor || value.cursor.length > 4096)) fail('invalid');
  return { ...request, limit: value?.limit ?? SESSION_HISTORY_LIMITS.pageEntries, ...(value?.cursor === undefined ? {} : { cursor: value.cursor }) };
}

function copyRevision(value: HistoryRevision | undefined): HistoryRevision | undefined {
  if (value === undefined) return undefined;
  if (!value || !validId(value.sessionId) || !validDigest(value.revision) || value.branch !== null && !validId(value.branch)) fail('invalid');
  return { sessionId: value.sessionId, revision: value.revision, branch: value.branch };
}

function sameRevision(a: Pick<HistoryRevision, 'revision' | 'branch'>, b: Pick<HistoryRevision, 'revision' | 'branch'>): boolean { return a.revision === b.revision && a.branch === b.branch; }
function validId(value: unknown): value is string { return typeof value === 'string' && identifier.test(value); }
function validDigest(value: unknown): value is string { return typeof value === 'string' && digestPattern.test(value); }
function validRef(value: SessionRef): boolean {
  return !!value && validId(value.id) && validId(value.root) && (value.parent === undefined || validId(value.parent));
}
function copyRef(value: SessionRef): SessionRef { return { id: value.id, root: value.root, ...(value.parent === undefined ? {} : { parent: value.parent }) }; }
function isRecord(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function compare(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
function hash(value: string | Uint8Array): string { return createHash('sha256').update(value).digest('hex'); }
function checkAbort(signal?: AbortSignal): void { if (signal?.aborted) throw new DOMException('Session history request aborted.', 'AbortError'); }
function fail(code: ConstructorParameters<typeof SessionsServiceError>[0]): never { throw new SessionsServiceError(code); }

async function safely<T>(signal: AbortSignal | undefined, work: () => Promise<T>): Promise<T> {
  try { return await work(); }
  catch (error) {
    checkAbort(signal);
    if (error instanceof SessionsServiceError) throw new SessionsServiceError(error.code);
    throw new SessionsServiceError('inaccessible');
  }
}

function assertJson(value: unknown): void {
  const pending: { value: unknown; depth: number }[] = [{ value, depth: 0 }];
  while (pending.length) {
    const item = pending.pop()!;
    if (item.depth > 256 || typeof item.value === 'number' && !Number.isFinite(item.value)) fail('invalid');
    if (item.value !== null && typeof item.value === 'object') {
      for (const child of Object.values(item.value)) pending.push({ value: child, depth: item.depth + 1 });
    }
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().filter(key => value[key] !== undefined)
    .map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value) as string;
}
