import {
  MEMORY_INPUT_PROJECTION_VERSION,
  type MemoryInputProjection,
  type MemoryInputRelation,
  type SessionCheckpoint,
} from './contracts.js';

export const MEMORY_INPUT_JSONL_FORMAT = 'felan-memory-input-jsonl-v1' as const;

export type MemoryTranscriptLineSource = () => AsyncIterable<string>;

export interface MaterializeMemoryInputDeltaOptions {
  readonly lines: MemoryTranscriptLineSource;
  readonly checkpoint: SessionCheckpoint;
  readonly previousCheckpoint?: SessionCheckpoint;
  readonly maxOutputBytes?: number;
  readonly signal?: AbortSignal;
}

export type MemoryInputMaterializationFailureCode =
  | 'cancelled'
  | 'checkpoint_changed'
  | 'invalid_checkpoint'
  | 'invalid_source'
  | 'output_too_large'
  | 'previous_checkpoint_changed'
  | 'source_changed'
  | 'source_unavailable';

export interface MemoryInputMaterializationFailure {
  readonly ok: false;
  readonly code: MemoryInputMaterializationFailureCode;
  readonly message: string;
}

export interface MemoryInputMaterializationSuccess {
  readonly ok: true;
  readonly format: typeof MEMORY_INPUT_JSONL_FORMAT;
  readonly text: string;
  readonly materializedDigest: string;
  readonly byteLength: number;
  readonly redactionCount: number;
  readonly projection: MemoryInputProjection;
}

export type MemoryInputMaterializationResult =
  | MemoryInputMaterializationFailure
  | MemoryInputMaterializationSuccess;

interface IndexedEntry {
  readonly lineNumber: number;
  readonly parentId: string | null;
  readonly hidden: boolean;
}

interface SessionIndex {
  readonly entries: ReadonlyMap<string, IndexedEntry>;
  readonly lineDigests: readonly string[];
}

interface BranchSelection {
  readonly ids: readonly string[];
  readonly positions: ReadonlyMap<string, number>;
  readonly hiddenEntryCount: number;
}

interface RedactionState {
  count: number;
}

const DIGEST_PATTERN = /^[a-f0-9]{64}$/u;
const SECRET_FIELD_PATTERN = /^(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|authorization)$/iu;
const MEMORY_CONTEXT_CUSTOM_TYPE = 'felan-memory-context';
const encoder = new TextEncoder();

export async function materializeMemoryInputDelta(
  options: MaterializeMemoryInputDeltaOptions,
): Promise<MemoryInputMaterializationResult> {
  try {
    validateOptions(options);
    throwIfAborted(options.signal);
    const index = await indexSource(options.lines, options.checkpoint, options.signal);
    validateGraph(index);
    const current = selectVisibleBranch(index, options.checkpoint.leafId);
    const previous = options.previousCheckpoint === undefined
      ? undefined
      : selectVisibleBranch(index, options.previousCheckpoint.leafId);
    const commonPrefixEntryCount = previous === undefined ? 0 : longestCommonPrefix(current.ids, previous.ids);
    const relation = classifyRelation(current.ids, previous?.ids, commonPrefixEntryCount);
    const includedIds = relation === 'diverged'
      ? current.ids
      : current.ids.slice(commonPrefixEntryCount);
    const includedPositions = new Map(includedIds.map((id, position) => [id, position]));
    const currentEntries: Record<string, unknown>[] = [];
    const previousEntries: Record<string, unknown>[] = [];
    const evidence: string[] = [];
    let evidenceBytes = 0;
    let evidenceRecordCount = 0;
    let removedEntryCount = current.hiddenEntryCount;
    let redactionCount = 0;
    let outputTooLarge = false;
    let replayLineCount = 0;

    await consumeSource(options.lines, options.signal, async (line, lineNumber) => {
      replayLineCount += 1;
      if (lineNumber >= index.lineDigests.length || await sha256(line) !== index.lineDigests[lineNumber]) {
        fail('source_changed', 'Memory checkpoint source changed while it was being read');
      }
      if (lineNumber === 0 || line.trim().length === 0) return;
      const entry = parseRecord(line);
      const id = entry.id as string;
      const currentPosition = current.positions.get(id);
      if (currentPosition !== undefined) currentEntries[currentPosition] = normalizeVisibleEntry(entry, index);
      const previousPosition = previous?.positions.get(id);
      if (previousPosition !== undefined) previousEntries[previousPosition] = normalizeVisibleEntry(entry, index);

      if (!includedPositions.has(id)) return;
      const projected = projectEvidenceEntry(normalizeVisibleEntry(entry, index));
      if (projected === undefined) {
        removedEntryCount += 1;
        return;
      }
      evidenceRecordCount += 1;
      const state: RedactionState = { count: 0 };
      const jsonlRecord = `${canonicalJson(redactValue(projected, state))}\n`;
      redactionCount += state.count;
      const recordBytes = byteLength(jsonlRecord);
      if (options.maxOutputBytes !== undefined && evidenceBytes + recordBytes > options.maxOutputBytes) {
        outputTooLarge = true;
        return;
      }
      if (!outputTooLarge) {
        evidence.push(jsonlRecord);
        evidenceBytes += recordBytes;
      }
    });

    if (replayLineCount !== index.lineDigests.length) {
      fail('source_changed', 'Memory checkpoint source changed while it was being read');
    }
    if (currentEntries.length !== current.ids.length
      || await digestCanonicalArray(currentEntries) !== options.checkpoint.transcriptDigest) {
      fail('checkpoint_changed', 'Memory checkpoint transcript changed before processing');
    }
    if (previous !== undefined && (
      previousEntries.length !== previous.ids.length
      || await digestCanonicalArray(previousEntries) !== options.previousCheckpoint!.transcriptDigest
    )) {
      fail('previous_checkpoint_changed', 'Previously processed memory checkpoint changed before processing');
    }
    if (outputTooLarge) {
      fail('output_too_large', 'Memory checkpoint evidence exceeds the output byte limit');
    }

    const text = evidence.join('');
    return {
      ok: true,
      format: MEMORY_INPUT_JSONL_FORMAT,
      text,
      materializedDigest: await sha256(text),
      byteLength: byteLength(text),
      redactionCount,
      projection: {
        version: MEMORY_INPUT_PROJECTION_VERSION,
        relation,
        includedEntryCount: includedIds.length,
        evidenceRecordCount,
        removedEntryCount,
        ...(options.previousCheckpoint === undefined ? {} : { previousCheckpoint: options.previousCheckpoint }),
      },
    };
  } catch (error) {
    if (error instanceof MaterializationError) {
      return { ok: false, code: error.code, message: error.message };
    }
    return {
      ok: false,
      code: options.signal?.aborted ? 'cancelled' : 'source_unavailable',
      message: options.signal?.aborted
        ? 'Memory input materialization was cancelled'
        : 'Memory checkpoint source is unavailable',
    };
  }
}

function validateOptions(options: MaterializeMemoryInputDeltaOptions): void {
  validateCheckpoint(options.checkpoint, 'current');
  if (options.previousCheckpoint !== undefined) {
    validateCheckpoint(options.previousCheckpoint, 'previous');
    if (options.previousCheckpoint.sessionId !== options.checkpoint.sessionId) {
      fail('invalid_checkpoint', 'Previous memory checkpoint belongs to another session');
    }
  }
  if (options.maxOutputBytes !== undefined && (
    !Number.isSafeInteger(options.maxOutputBytes) || options.maxOutputBytes < 0
  )) {
    fail('invalid_checkpoint', 'Memory input output byte limit is invalid');
  }
}

function validateCheckpoint(checkpoint: SessionCheckpoint, label: 'current' | 'previous'): void {
  if (typeof checkpoint.sessionId !== 'string' || checkpoint.sessionId.length === 0
    || typeof checkpoint.sessionFile !== 'string' || checkpoint.sessionFile.length === 0
    || (checkpoint.leafId !== null && (typeof checkpoint.leafId !== 'string' || checkpoint.leafId.length === 0))
    || typeof checkpoint.transcriptDigest !== 'string' || !DIGEST_PATTERN.test(checkpoint.transcriptDigest)) {
    fail('invalid_checkpoint', `${label === 'current' ? 'Current' : 'Previous'} memory checkpoint is invalid`);
  }
}

async function indexSource(
  lines: MemoryTranscriptLineSource,
  checkpoint: SessionCheckpoint,
  signal: AbortSignal | undefined,
): Promise<SessionIndex> {
  const entries = new Map<string, IndexedEntry>();
  const lineDigests: string[] = [];
  let sawHeader = false;
  await consumeSource(lines, signal, async (line, lineNumber) => {
    lineDigests.push(await sha256(line));
    if (line.includes('\n') || line.includes('\r')) {
      fail('invalid_source', 'Memory checkpoint source yielded an invalid line');
    }
    if (lineNumber === 0) {
      const header = parseRecord(line);
      if (header.type !== 'session' || typeof header.id !== 'string' || header.id.length === 0
        || header.id !== checkpoint.sessionId
        || (header.timestamp !== undefined && (typeof header.timestamp !== 'string' || header.timestamp.length === 0))
        || (header.cwd !== undefined && (typeof header.cwd !== 'string' || header.cwd.length === 0))
        || (header.parentSession !== undefined && (typeof header.parentSession !== 'string' || header.parentSession.length === 0))
        || (header.version !== undefined && (!Number.isSafeInteger(header.version) || (header.version as number) < 1))) {
        fail('invalid_source', 'Memory checkpoint session header is invalid');
      }
      sawHeader = true;
      return;
    }
    if (line.trim().length === 0) return;
    const entry = parseRecord(line);
    if (entry.type === 'session') fail('invalid_source', 'Memory checkpoint source contains multiple session headers');
    if (typeof entry.type !== 'string' || entry.type.length === 0
      || typeof entry.id !== 'string' || entry.id.length === 0
      || (entry.parentId !== null && (typeof entry.parentId !== 'string' || entry.parentId.length === 0))) {
      fail('invalid_source', 'Memory checkpoint source contains an invalid entry');
    }
    if (entries.has(entry.id)) fail('invalid_source', 'Memory checkpoint source contains duplicate entry IDs');
    entries.set(entry.id, {
      lineNumber,
      parentId: entry.parentId as string | null,
      hidden: isMemoryContextEntry(entry),
    });
  });
  if (!sawHeader) fail('invalid_source', 'Memory checkpoint session header is missing');
  return { entries, lineDigests };
}

function validateGraph(index: SessionIndex): void {
  for (const entry of index.entries.values()) {
    if (entry.parentId === null) continue;
    if (!index.entries.has(entry.parentId)) fail('invalid_source', 'Memory checkpoint source contains a missing parent');
  }

  const complete = new Set<string>();
  for (const id of index.entries.keys()) {
    const path = new Set<string>();
    let current: string | null = id;
    while (current !== null && !complete.has(current)) {
      if (path.has(current)) fail('invalid_source', 'Memory checkpoint transcript contains a cycle');
      path.add(current);
      current = index.entries.get(current)?.parentId ?? null;
    }
    for (const entryId of path) complete.add(entryId);
  }

  for (const entry of index.entries.values()) {
    if (entry.parentId === null) continue;
    if (index.entries.get(entry.parentId)!.lineNumber >= entry.lineNumber) {
      fail('invalid_source', 'Memory checkpoint source contains an invalid branch order');
    }
  }
}

function selectVisibleBranch(index: SessionIndex, leafId: string | null): BranchSelection {
  if (leafId === null) return { ids: [], positions: new Map(), hiddenEntryCount: 0 };
  const path: string[] = [];
  let hiddenEntryCount = 0;
  let current: string | null = leafId;
  while (current !== null) {
    const entry = index.entries.get(current);
    if (entry === undefined) fail('invalid_source', 'Memory checkpoint leaf is not present in the transcript');
    if (entry.hidden) hiddenEntryCount += 1;
    else path.push(current);
    current = entry.parentId;
  }
  path.reverse();
  return {
    ids: path,
    positions: new Map(path.map((id, position) => [id, position])),
    hiddenEntryCount,
  };
}

function normalizeVisibleEntry(
  entry: Record<string, unknown>,
  index: SessionIndex,
): Record<string, unknown> {
  if (typeof entry.parentId !== 'string' || !index.entries.get(entry.parentId)?.hidden) return entry;
  let parentId: string | null = entry.parentId;
  while (parentId !== null && index.entries.get(parentId)?.hidden) {
    parentId = index.entries.get(parentId)?.parentId ?? null;
  }
  return { ...entry, parentId };
}

function projectEvidenceEntry(entry: Record<string, unknown>): Record<string, unknown> | undefined {
  if (entry.type === 'compaction' || entry.type === 'branch_summary') return entry;
  if (entry.type !== 'message' || !isRecord(entry.message)) return undefined;
  const role = entry.message.role;
  if (role === 'user' || role === 'assistant') {
    return {
      type: 'message',
      id: entry.id,
      parentId: entry.parentId,
      message: { role, content: projectContent(entry.message.content, role === 'assistant') },
    };
  }
  if (role === 'toolResult' && typeof entry.message.toolName === 'string') {
    return {
      type: 'message',
      id: entry.id,
      parentId: entry.parentId,
      message: {
        role,
        toolName: entry.message.toolName,
        isError: entry.message.isError === true,
        content: projectContent(entry.message.content, false),
      },
    };
  }
  return undefined;
}

function projectContent(value: unknown, includeToolCalls: boolean): unknown {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return [];
  return value.flatMap((part): readonly Record<string, unknown>[] => {
    if (!isRecord(part)) return [];
    if (part.type === 'text' && typeof part.text === 'string') return [{ type: 'text', text: part.text }];
    if (part.type === 'image') return [{ type: 'image', data: '[IMAGE_DATA_OMITTED]' }];
    if (includeToolCalls && part.type === 'toolCall' && typeof part.name === 'string') {
      return [{ type: 'toolCall', name: part.name, arguments: part.arguments ?? null }];
    }
    return [];
  });
}

function classifyRelation(
  current: readonly string[],
  previous: readonly string[] | undefined,
  commonPrefixEntryCount: number,
): MemoryInputRelation {
  if (previous === undefined) return 'initial';
  if (current.length === previous.length && commonPrefixEntryCount === current.length) return 'unchanged';
  if (commonPrefixEntryCount === previous.length) return 'appended';
  return 'diverged';
}

function longestCommonPrefix(left: readonly string[], right: readonly string[]): number {
  const limit = Math.min(left.length, right.length);
  let length = 0;
  while (length < limit && left[length] === right[length]) length += 1;
  return length;
}

function redactValue(value: unknown, state: RedactionState, key?: string): unknown {
  if (key !== undefined && SECRET_FIELD_PATTERN.test(key) && value !== null) {
    state.count += 1;
    return '[REDACTED_SECRET]';
  }
  if (typeof value === 'string') return redactString(value, state);
  if (Array.isArray(value)) return value.map((entry) => redactValue(entry, state));
  if (!isRecord(value)) return value;
  const image = value.type === 'image' && typeof value.data === 'string';
  const result: Record<string, unknown> = {};
  for (const [field, entry] of Object.entries(value)) {
    const projectedField = redactString(field, state);
    if (image && field === 'data') {
      result[projectedField] = '[IMAGE_DATA_OMITTED]';
      state.count += 1;
    } else {
      result[projectedField] = redactValue(entry, state, field);
    }
  }
  return result;
}

function redactString(value: string, state: RedactionState): string {
  const replace = (pattern: RegExp, replacement: string): void => {
    value = value.replace(pattern, (...args: unknown[]) => {
      state.count += 1;
      return replacement.replace('$1', String(args[1] ?? ''));
    });
  };
  replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/gu, '[REDACTED_PRIVATE_KEY]');
  replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{12,})\b/gu, '[REDACTED_TOKEN]');
  replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/giu, '$1[REDACTED_TOKEN]');
  replace(/(["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|authorization)["']?\s*[:=]\s*["']?)[^"'\s,}]+/giu, '$1[REDACTED_SECRET]');
  return value;
}

async function consumeSource(
  source: MemoryTranscriptLineSource,
  signal: AbortSignal | undefined,
  consume: (line: string, lineNumber: number) => Promise<void>,
): Promise<void> {
  throwIfAborted(signal);
  const iterable = source();
  if (!isAsyncIterable(iterable)) fail('invalid_source', 'Memory checkpoint line source is invalid');
  let lineNumber = 0;
  for await (const line of iterable) {
    throwIfAborted(signal);
    if (typeof line !== 'string') fail('invalid_source', 'Memory checkpoint source yielded an invalid line');
    await consume(line, lineNumber);
    lineNumber += 1;
  }
  throwIfAborted(signal);
}

function parseRecord(line: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    fail('invalid_source', 'Memory checkpoint source contains invalid JSONL');
  }
  if (!isRecord(value)) fail('invalid_source', 'Memory checkpoint source contains an invalid record');
  return value;
}

function isMemoryContextEntry(entry: Record<string, unknown>): boolean {
  return entry.type === 'custom_message' && entry.customType === MEMORY_CONTEXT_CUSTOM_TYPE;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(',')}}`;
}

async function digestCanonicalArray(entries: readonly unknown[]): Promise<string> {
  return sha256(`[${entries.map(canonicalJson).join(',')}]`);
}

async function sha256(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', encoder.encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function byteLength(value: string): number {
  return encoder.encode(value).byteLength;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) fail('cancelled', 'Memory input materialization was cancelled');
}

function isAsyncIterable(value: unknown): value is AsyncIterable<string> {
  return typeof value === 'object' && value !== null && Symbol.asyncIterator in value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

class MaterializationError extends Error {
  constructor(
    readonly code: MemoryInputMaterializationFailureCode,
    message: string,
  ) {
    super(message);
    this.name = 'MemoryInputMaterializationError';
  }
}

function fail(code: MemoryInputMaterializationFailureCode, message: string): never {
  throw new MaterializationError(code, message);
}
