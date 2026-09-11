import { DEFAULT_EXTRACTION_BOUNDS, emptyOmission, freezeOmission, omit, stableIdentifier } from './bounds.js';
import type { ExtractionBounds } from './bounds.js';
import type {
  PreparedMessageValue,
  PreparedSource,
  PreparedSpan,
  PreparedSpanInput,
  SpanSection,
} from './contracts.js';

export function prepareEvidenceSpan(
  input: PreparedSpanInput,
  bounds: ExtractionBounds = DEFAULT_EXTRACTION_BOUNDS,
): PreparedSpan {
  const omitted = emptyOmission();
  const branch = input.branchEntries.slice(-bounds.maxBranchEntries);
  if (branch.length < input.branchEntries.length) {
    omit(omitted, 'branch-entry-limit', input.branchEntries.length - branch.length);
  }

  const identities = new Map<object, string>();
  const fingerprints = new Map<string, string[]>();
  let previousSummaryEntryId: string | undefined;
  for (const entry of branch) {
    if (entry.type === 'message' && typeof entry.message === 'object' && entry.message !== null) {
      identities.set(entry.message, entry.id);
      const key = messageFingerprint(entry.message);
      const ids = fingerprints.get(key) ?? [];
      ids.push(entry.id);
      fingerprints.set(key, ids);
    }
    if (
      input.preparation.previousSummary !== undefined
      && entry.type === 'compaction'
      && entry.summary === input.preparation.previousSummary
    ) previousSummaryEntryId = entry.id;
  }

  const sources: PreparedSource[] = [];
  if (input.preparation.previousSummary !== undefined) {
    sources.push({
      sourceId: previousSummaryEntryId
        ? `entry:${stableIdentifier(previousSummaryEntryId, 'compaction')}`
        : 'prepared:previous-summary',
      section: 'previous_summary',
      index: 0,
      ...(previousSummaryEntryId === undefined ? {} : { entryId: previousSummaryEntryId }),
      text: input.preparation.previousSummary,
    });
  }

  const messages = [
    ...tagMessages(input.preparation.messagesToSummarize, 'messages_to_summarize'),
    ...tagMessages(input.preparation.turnPrefixMessages, 'turn_prefix'),
  ];
  const selected = messages.slice(0, bounds.maxMessages);
  if (selected.length < messages.length) omit(omitted, 'message-limit', messages.length - selected.length);

  const fingerprintOffsets = new Map<string, number>();
  for (const item of selected) {
    const objectId = typeof item.message === 'object' && item.message !== null
      ? identities.get(item.message)
      : undefined;
    const fingerprint = messageFingerprint(item.message);
    const offset = fingerprintOffsets.get(fingerprint) ?? 0;
    const fallbackId = fingerprints.get(fingerprint)?.[offset];
    if (!objectId && fallbackId) fingerprintOffsets.set(fingerprint, offset + 1);
    const entryId = objectId ?? fallbackId;
    sources.push({
      sourceId: entryId
        ? `entry:${stableIdentifier(entryId, 'message')}`
        : `prepared:${item.section}:${item.index}`,
      section: item.section,
      index: item.index,
      ...(entryId === undefined ? {} : { entryId }),
      message: item.message,
    });
  }

  return {
    schemaVersion: 1,
    firstKeptEntryId: stableIdentifier(input.preparation.firstKeptEntryId, 'first-kept'),
    sources,
    omitted: freezeOmission(omitted),
  };
}

function tagMessages(messages: readonly PreparedMessageValue[], section: SpanSection): Array<{
  message: PreparedMessageValue;
  section: SpanSection;
  index: number;
}> {
  return messages.map((message, index) => ({ message, section, index }));
}

function messageFingerprint(message: unknown): string {
  if (!isRecord(message)) return String(message);
  const role = typeof message.role === 'string' ? message.role : '';
  const timestamp = typeof message.timestamp === 'number' ? message.timestamp : '';
  const toolCallId = typeof message.toolCallId === 'string' ? message.toolCallId : '';
  const toolName = typeof message.toolName === 'string' ? message.toolName : '';
  const content = Array.isArray(message.content)
    ? message.content.map((block) => isRecord(block) && typeof block.text === 'string' ? block.text : '').join('\u241e')
    : typeof message.content === 'string' ? message.content : '';
  return `${role}\u241f${timestamp}\u241f${toolCallId}\u241f${toolName}\u241f${content}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
