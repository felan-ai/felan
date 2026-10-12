import { DETAILS_NAMESPACE, DETAILS_SCHEMA_VERSION } from './internal/contracts.js';

export const COMPACTION_MESSAGE_TYPE = 'felan.compaction.v1';
export type CompactionMethodLabel = 'Classifier' | 'Summary' | 'Native';
export interface CompactionPresentation { tokensBefore: number; method?: CompactionMethodLabel }
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }

export function compactionMethodForEntry(entry: { details?: unknown; fromHook?: boolean | undefined }): CompactionMethodLabel | undefined {
  const details = entry.details;
  if (record(details) && details.namespace === DETAILS_NAMESPACE && details.schemaVersion === DETAILS_SCHEMA_VERSION) {
    if (details.method === 'classifier') return 'Classifier';
    if (details.method === 'summary') return 'Summary';
  }
  return entry.fromHook === true ? undefined : 'Native';
}

export function compactionMethodForMessage(entries: readonly unknown[], message: { summary: string; tokensBefore: number; timestamp: number }): CompactionMethodLabel | undefined {
  const matching = entries.filter((entry): entry is Record<string, unknown> => record(entry) && entry.type === 'compaction'
    && entry.summary === message.summary && entry.tokensBefore === message.tokensBefore && typeof entry.timestamp === 'string');
  let closest = matching[0]; let distance = closest ? Math.abs(Date.parse(closest.timestamp as string) - message.timestamp) : Infinity;
  for (const entry of matching.slice(1)) {
    const next = Math.abs(Date.parse(entry.timestamp as string) - message.timestamp);
    if (next >= distance) continue;
    closest = entry; distance = next;
  }
  return closest ? compactionMethodForEntry({ details: closest.details, ...(typeof closest.fromHook === 'boolean' ? { fromHook: closest.fromHook } : {}) }) : undefined;
}

export function parseCompactionPresentation(value: unknown): CompactionPresentation {
  if (!record(value) || Object.keys(value).some(key => key !== 'tokensBefore' && key !== 'method')
    || !Number.isSafeInteger(value.tokensBefore) || (value.tokensBefore as number) < 0
    || value.method !== undefined && value.method !== 'Classifier' && value.method !== 'Summary' && value.method !== 'Native') throw new Error('Invalid compaction presentation.');
  return { tokensBefore: value.tokensBefore as number, ...(value.method === undefined ? {} : { method: value.method as CompactionMethodLabel }) };
}

export function compactionPresentation(entry: { tokensBefore: number; details?: unknown; fromHook?: boolean | undefined }): CompactionPresentation {
  const method = compactionMethodForEntry(entry);
  return parseCompactionPresentation({ tokensBefore: entry.tokensBefore, ...(method === undefined ? {} : { method }) });
}
