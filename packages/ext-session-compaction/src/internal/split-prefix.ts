import { sanitizeText, stableIdentifier, utf8Bytes } from './bounds.js';
import type { EvidenceBundle, EvidenceItem, PreparedSource, PreparedSpan } from './contracts.js';

interface PrefixCandidate {
  readonly sourceIndex: number;
  readonly ordinal: number;
  readonly text: string;
  readonly priority: number;
  readonly required: boolean;
}

export function renderSplitTurnPrefix(
  span: PreparedSpan,
  evidence: EvidenceBundle,
  maxBytes: number,
  expectedMessages: number,
): string | undefined {
  if (evidence.omitted.reasons.includes('required-prefix-evidence-limit')) return undefined;
  const sources = span.sources.filter((source) => source.section === 'turn_prefix');
  if (sources.length !== expectedMessages) return undefined;
  if (sources.length === 0) return '(none)';

  const sourceIndexes = new Map(sources.map((source, index) => [source.sourceId, index]));
  const itemsBySource = groupEvidence(evidence.items, sourceIndexes);
  const completedCalls = new Set(sources.flatMap((source) => {
    const message = source.message;
    return isRecord(message) && message.role === 'toolResult' && typeof message.toolCallId === 'string'
      ? [stableIdentifier(message.toolCallId, 'call')]
      : [];
  }));
  const candidates: PrefixCandidate[] = [];

  for (const [sourceIndex, source] of sources.entries()) {
    const narrative = narrativeCandidates(source, sourceIndex, maxBytes);
    if (narrative === undefined) return undefined;
    candidates.push(...narrative);
    for (const [ordinal, item] of (itemsBySource.get(source.sourceId) ?? []).entries()) {
      if (isNarrativeEvidence(source, item)) continue;
      if (item.kind === 'tool-call' && item.toolCallId && completedCalls.has(item.toolCallId)) continue;
      candidates.push({
        sourceIndex,
        ordinal: toolEvidenceOrdinal(source, item, ordinal),
        text: renderToolEvidence(item),
        priority: toolEvidencePriority(item),
        required: isRequiredToolEvidence(item),
      });
    }
  }

  if (candidates.length === 0) return undefined;
  const required = candidates.filter((candidate) => candidate.required);
  const selected = [...required];
  let bytes = joinedBytes(selected);
  if (bytes > maxBytes) return undefined;

  const optional = candidates
    .filter((candidate) => !candidate.required)
    .sort((left, right) => right.priority - left.priority || right.sourceIndex - left.sourceIndex || right.ordinal - left.ordinal);
  for (const candidate of optional) {
    const added = utf8Bytes(candidate.text) + (selected.length === 0 ? 0 : 2);
    if (bytes + added > maxBytes) continue;
    selected.push(candidate);
    bytes += added;
  }

  return selected
    .sort((left, right) => left.sourceIndex - right.sourceIndex || left.ordinal - right.ordinal)
    .map((candidate) => candidate.text)
    .join('\n\n');
}

function narrativeCandidates(source: PreparedSource, sourceIndex: number, maxBytes: number): PrefixCandidate[] | undefined {
  const message = source.message;
  if (!isRecord(message) || typeof message.role !== 'string') return undefined;
  const candidates: PrefixCandidate[] = [];
  let complete = true;
  const add = (label: string, value: unknown, ordinal: number): void => {
    if (typeof value !== 'string') return;
    const sanitized = sanitizeText(value, maxBytes);
    if (!sanitized.text) return;
    if (sanitized.omittedBytes > 0) complete = false;
    candidates.push({
      sourceIndex,
      ordinal,
      text: `[${label} source=${source.sourceId}] ${sanitized.text}`,
      priority: 1_000,
      required: true,
    });
  };

  if (message.role === 'assistant') {
    for (const [blockIndex, block] of arrayValue(message.content).entries()) {
      if (!isRecord(block)) continue;
      if (block.type === 'thinking') add('assistant reasoning', block.thinking, blockIndex * 2);
      else if (block.type === 'text') add('assistant', block.text, blockIndex * 2);
    }
    return complete ? candidates : undefined;
  }

  if (message.role === 'toolResult') return candidates;

  if (message.role === 'bashExecution') {
    add('user bash request', message.command, 0);
    if (typeof message.output === 'string') {
      const output = sanitizeText(message.output, Math.min(maxBytes, 2_048));
      if (output.text) candidates.push({
        sourceIndex,
        ordinal: 1,
        text: `[bash result source=${source.sourceId}] ${output.text}`,
        priority: 750,
        required: false,
      });
    }
    return complete ? candidates : undefined;
  }
  if (message.role === 'branchSummary' || message.role === 'compactionSummary') {
    add(message.role, message.summary, 0);
    return complete ? candidates : undefined;
  }
  if (message.role !== 'user' && message.role !== 'custom') return undefined;
  for (const [index, text] of textContent(message.content).entries()) add(message.role, text, index * 2);
  return complete ? candidates : undefined;
}

function groupEvidence(
  items: readonly EvidenceItem[],
  sourceIndexes: ReadonlyMap<string, number>,
): Map<string, EvidenceItem[]> {
  const grouped = new Map<string, EvidenceItem[]>();
  for (const item of items) {
    if (!sourceIndexes.has(item.sourceId)) continue;
    const sourceItems = grouped.get(item.sourceId) ?? [];
    sourceItems.push(item);
    grouped.set(item.sourceId, sourceItems);
  }
  return grouped;
}

function isNarrativeEvidence(source: PreparedSource, item: EvidenceItem): boolean {
  const message = source.message;
  if (!isRecord(message)) return false;
  if (message.role === 'assistant') return item.kind === 'report';
  if (message.role !== 'user') return false;
  return item.kind === 'request' || item.kind === 'constraint' || item.kind === 'decision' || item.kind === 'open-loop';
}

function renderToolEvidence(item: EvidenceItem): string {
  const tool = item.toolName ? ` tool=${item.toolName}` : '';
  const call = item.toolCallId ? ` call=${item.toolCallId}` : '';
  const label = item.kind === 'tool-call' ? 'assistant tool call' : 'tool result';
  return `[${label}/${item.kind}/${item.status}${tool}${call} source=${item.sourceId}] ${item.text}`;
}

function toolEvidenceOrdinal(source: PreparedSource, item: EvidenceItem, fallback: number): number {
  const message = source.message;
  const blocks = isRecord(message) ? arrayValue(message.content) : [];
  if (item.kind === 'tool-call' && item.toolCallId) {
    const blockIndex = blocks.findIndex((block) => isRecord(block)
      && block.type === 'toolCall'
      && typeof block.id === 'string'
      && stableIdentifier(block.id, 'call') === item.toolCallId);
    if (blockIndex >= 0) return blockIndex * 2;
  }
  return blocks.length * 2 + fallback;
}

function isRequiredToolEvidence(item: EvidenceItem): boolean {
  return item.status === 'failed' || item.kind === 'error' || item.kind === 'test';
}

function toolEvidencePriority(item: EvidenceItem): number {
  if (item.status === 'failed' || item.kind === 'error') return 950;
  if (item.kind === 'test' || item.kind === 'file' || item.kind === 'task' || item.kind === 'background-job') return 850;
  if (item.kind === 'command' || item.kind === 'rtk-pointer') return 750;
  if (item.kind === 'tool-call') return 600;
  return 300;
}

function joinedBytes(candidates: readonly PrefixCandidate[]): number {
  if (candidates.length === 0) return 0;
  return candidates.reduce((sum, candidate) => sum + utf8Bytes(candidate.text), 0) + (candidates.length - 1) * 2;
}

function textContent(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  return arrayValue(value)
    .filter(isRecord)
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string);
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
