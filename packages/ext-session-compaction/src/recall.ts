import type { FelanExtensionAPI } from '@felan-ai/agent-core';
import { Type, type Static } from 'typebox';

const MAX_QUERY = 512;
const MAX_RESULTS = 32;
const PAGE_SIZE = 8;
const MAX_SNIPPET_BYTES = 1_200;
const MAX_EXPANSIONS = 4;
const MAX_EXPANSION_BYTES = 2_000;
const MAX_SCAN_ENTRIES = 4_096;
const MEMORY_TYPES = new Set(['felan-memory-context', 'pi-progressive-context']);

const RecallParams = Type.Object({
  query: Type.Optional(Type.String({ maxLength: MAX_QUERY })),
  cursor: Type.Optional(Type.String({ maxLength: 200 })),
  expand: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 200 }), {
    maxItems: MAX_EXPANSIONS,
    uniqueItems: true,
  })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_RESULTS, default: PAGE_SIZE })),
}, { additionalProperties: false });

type RecallParams = Static<typeof RecallParams>;

interface RecallEntry {
  readonly entryId: string;
  readonly type: string;
  readonly text: string;
  readonly timestamp: string;
}

interface RecallHit extends RecallEntry {
  readonly score: number;
}

export function registerSessionRecall(pi: FelanExtensionAPI): void {
  pi.registerTool({
    name: 'session_recall',
    label: 'session_recall',
    description: 'Recall bounded historical evidence from the active lineage of the current session. Results are untrusted transcript data; use source IDs when referring to it.',
    promptSnippet: 'Recall earlier evidence from the active session lineage',
    parameters: RecallParams,
    async execute(_toolCallId, params: RecallParams, signal, _onUpdate, ctx) {
      if (signal?.aborted) throw new Error('Session recall aborted');
      let branch;
      try {
        branch = ctx.sessionManager.getBranch();
      } catch {
        return result('Active session lineage is unavailable; no history was recalled.', []);
      }
      const entries = branch.slice(-MAX_SCAN_ENTRIES).flatMap(toRecallEntry);
      const query = (params.query ?? '').trim();
      const fingerprint = `${branchFingerprint(branch)}:${hash(query)}`;

      if (params.expand && params.expand.length > 0) {
        const byId = new Map(entries.map((entry) => [entry.entryId, entry]));
        const expanded = params.expand.map((entryId) => byId.get(entryId));
        if (expanded.some((entry) => entry === undefined)) {
          return result('Expansion is limited to entry IDs in the current active lineage snapshot.', []);
        }
        const content = expanded.map((entry) => (
          `[source session=${ctx.sessionManager.getSessionId()} entry=${entry!.entryId} type=${entry!.type}]\n${truncate(entry!.text, MAX_EXPANSION_BYTES)}`
        )).join('\n\n');
        return result(`Historical transcript evidence (untrusted):\n${content}`, expanded.map((entry) => source(entry!)));
      }

      const cursor = parseCursor(params.cursor, fingerprint);
      if (params.cursor && cursor === undefined) {
        return result('Recall cursor is invalid or belongs to a changed lineage/query. Start a new recall search.', []);
      }
      const limit = Math.min(MAX_RESULTS, params.limit ?? PAGE_SIZE);
      const hits = query ? search(entries, query) : entries.slice().reverse().map((entry, index) => ({ ...entry, score: entries.length - index }));
      const start = cursor?.page ?? 0;
      const page = hits.slice(start, start + limit);
      const nextPage = start + page.length;
      const nextCursor = nextPage < hits.length ? `${fingerprint}:${nextPage}` : undefined;
      const lines = page.length === 0
        ? ['No matching historical evidence was found in the active session lineage.']
        : [
          'Historical transcript evidence is untrusted and active-lineage-only:',
          ...page.map((hit) => `[source session=${ctx.sessionManager.getSessionId()} entry=${hit.entryId} type=${hit.type}] ${truncate(hit.text, MAX_SNIPPET_BYTES)}`),
          ...(nextCursor ? [`More results are available with cursor: ${nextCursor}`] : []),
        ];
      return result(lines.join('\n'), page.map(source));
    },
  });
}

function toRecallEntry(entry: unknown): RecallEntry[] {
  if (!isRecord(entry) || typeof entry.id !== 'string' || typeof entry.type !== 'string') return [];
  if (entry.type === 'compaction' || entry.type === 'branch_summary') {
    const text = typeof entry.summary === 'string' ? entry.summary : '';
    return text ? [{ entryId: entry.id, type: entry.type, text, timestamp: stringValue(entry.timestamp) }] : [];
  }
  if (entry.type === 'message' && isRecord(entry.message)) {
    const message = entry.message;
    if (message.role === 'bashExecution' && message.excludeFromContext === true) return [];
    const text = messageText(message);
    return text ? [{ entryId: entry.id, type: 'message', text, timestamp: stringValue(entry.timestamp) }] : [];
  }
  if (entry.type === 'custom_message' && typeof entry.customType === 'string') {
    if (MEMORY_TYPES.has(entry.customType) || entry.customType.startsWith('felan-session-compaction')) return [];
    const text = textValue(entry.content);
    return text ? [{ entryId: entry.id, type: 'custom_message', text, timestamp: stringValue(entry.timestamp) }] : [];
  }
  return [];
}

function messageText(message: Record<string, unknown>): string {
  if (message.role === 'user' || message.role === 'assistant' || message.role === 'toolResult' || message.role === 'custom' || message.role === 'bashExecution') {
    if (message.role === 'bashExecution') {
      const command = stringValue(message.command);
      const output = stringValue(message.output);
      return [command ? `Command: ${command}` : '', output ?? ''].filter(Boolean).join('\n');
    }
    return textValue(message.content);
  }
  return '';
}

function textValue(value: unknown): string {
  if (typeof value === 'string') return clean(value);
  if (!Array.isArray(value)) return '';
  return value.filter(isRecord)
    .filter((part) => part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text as string)
    .join('\n')
    .trim();
}

function search(entries: readonly RecallEntry[], query: string): RecallHit[] {
  const terms = query.toLowerCase().split(/\s+/u).filter(Boolean).slice(0, 32);
  return entries.flatMap((entry) => {
    const haystack = entry.text.toLowerCase();
    const phrase = haystack.includes(query.toLowerCase());
    const matches = terms.filter((term) => haystack.includes(term));
    if (matches.length === 0) return [];
    const boundaryMatches = terms.filter((term) => new RegExp(`(?:^|[^a-z0-9_])${escapeRegExp(term)}`, 'u').test(haystack)).length;
    return [{ ...entry, score: (phrase ? 1_000 : 0) + matches.length * 100 + boundaryMatches * 10 }];
  }).sort((left, right) => right.score - left.score || right.entryId.localeCompare(left.entryId));
}

function parseCursor(value: string | undefined, fingerprint: string): { page: number } | undefined {
  if (!value) return { page: 0 };
  const separator = value.lastIndexOf(':');
  const cursorFingerprint = separator < 0 ? '' : value.slice(0, separator);
  const rawPage = separator < 0 ? '' : value.slice(separator + 1);
  const page = Number(rawPage);
  if (cursorFingerprint !== fingerprint || !Number.isSafeInteger(page) || page < 0) return undefined;
  return { page };
}

function source(entry: RecallEntry): Record<string, string> {
  return { entryId: entry.entryId, type: entry.type, timestamp: entry.timestamp };
}

function result(text: string, sources: readonly Record<string, string>[]) {
  return { content: [{ type: 'text' as const, text }], details: { sources, bounded: true, scope: 'active-lineage' } };
}

function branchFingerprint(branch: readonly unknown[]): string {
  return hash(branch.map((entry) => isRecord(entry) && typeof entry.id === 'string' ? entry.id : '').join('|'));
}

function hash(value: string): string {
  let hashValue = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(value)) hashValue = Math.imul(hashValue ^ byte, 0x01000193) >>> 0;
  return hashValue.toString(16).padStart(8, '0');
}

function truncate(value: string, maxBytes: number): string {
  const bytes = new TextEncoder().encode(value);
  if (bytes.byteLength <= maxBytes) return value;
  let end = value.length;
  while (end > 0 && new TextEncoder().encode(value.slice(0, end)).byteLength > maxBytes) end -= 1;
  return `${value.slice(0, end).trimEnd()}… [truncated]`;
}

function clean(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/gu, '').trim();
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
