import {
  DEFAULT_EXTRACTION_BOUNDS,
  emptyOmission,
  freezeOmission,
  omit,
  sanitizeText,
  utf8Bytes,
} from './bounds.js';
import type { ExtractionBounds } from './bounds.js';
import {
  DETAILS_NAMESPACE,
  DETAILS_SCHEMA_VERSION,
  type ContinuityFact,
  type ContinuityResolution,
  type ContinuityStateV1,
  type EvidenceBundle,
  type EvidenceItem,
  type SessionCompactionDetailsV1,
} from './contracts.js';

export function readContinuityDetails(value: unknown): ContinuityStateV1 | undefined {
  if (!isRecord(value)
    || value.namespace !== DETAILS_NAMESPACE
    || value.schemaVersion !== DETAILS_SCHEMA_VERSION
    || !isRecord(value.continuity)
    || value.continuity.schemaVersion !== 1
    || !Array.isArray(value.continuity.facts)) return undefined;
  const facts: ContinuityFact[] = [];
  for (const candidate of value.continuity.facts.slice(0, DEFAULT_EXTRACTION_BOUNDS.maxContinuityItems)) {
    if (!isContinuityFact(candidate)) return undefined;
    facts.push({
      key: candidate.key,
      kind: candidate.kind,
      text: candidate.text,
      sourceIds: [...candidate.sourceIds],
    });
  }
  return { schemaVersion: 1, facts, omitted: normalizeOmission(value.continuity.omitted) };
}

export function mergeContinuity(
  previous: ContinuityStateV1 | undefined,
  evidence: EvidenceBundle,
  resolutions: readonly ContinuityResolution[] = [],
  bounds: ExtractionBounds = DEFAULT_EXTRACTION_BOUNDS,
): ContinuityStateV1 {
  const omitted = emptyOmission();
  const evidenceById = new Map(evidence.items.map((item) => [item.id, item]));
  const allowedResolutions = new Set<string>();
  for (const resolution of resolutions) {
    const proof = evidenceById.get(resolution.evidenceId);
    if (resolution.mode === 'override' && proof?.provenance === 'requested') {
      allowedResolutions.add(resolution.targetKey);
    }
    if (resolution.mode === 'positive' && proof?.provenance === 'recorded-result' && isPositive(proof)) {
      allowedResolutions.add(resolution.targetKey);
    }
  }

  const merged = new Map<string, ContinuityFact>();
  for (const fact of previous?.facts ?? []) {
    if (!allowedResolutions.has(fact.key) && isContinuityFact(fact)) merged.set(fact.key, fact);
  }
  for (const item of evidence.items) {
    const fact = factFromEvidence(item, bounds);
    if (fact) merged.set(fact.key, fact);
  }

  const facts: ContinuityFact[] = [];
  let bytes = 0;
  for (const fact of merged.values()) {
    const size = utf8Bytes(JSON.stringify(fact));
    if (facts.length >= bounds.maxContinuityItems) {
      omit(omitted, 'continuity-item-limit');
      continue;
    }
    if (bytes + size > bounds.maxContinuityBytes) {
      omit(omitted, 'continuity-byte-limit', 1, size);
      continue;
    }
    facts.push(fact);
    bytes += size;
  }
  return { schemaVersion: 1, facts, omitted: freezeOmission(omitted) };
}

export function createCompactionDetails(continuity: ContinuityStateV1): SessionCompactionDetailsV1 {
  return { namespace: DETAILS_NAMESPACE, schemaVersion: DETAILS_SCHEMA_VERSION, continuity };
}

export function renderContinuity(
  state: ContinuityStateV1,
  maxBytes = DEFAULT_EXTRACTION_BOUNDS.maxContinuityBytes,
): string {
  const lines = state.facts.map((fact) => `- [${fact.kind}] ${fact.text}`);
  if (state.omitted.itemCount > 0 || state.omitted.byteCount > 0) {
    lines.push(`- [bounded] Additional continuity was omitted (${state.omitted.itemCount} items, ${state.omitted.byteCount} bytes).`);
  }
  return sanitizeText(lines.join('\n'), maxBytes).text;
}

function factFromEvidence(item: EvidenceItem, bounds: ExtractionBounds): ContinuityFact | undefined {
  const text = sanitizeText(item.text, bounds.maxTextBytes).text;
  if (!text) return undefined;
  if (item.kind === 'request' || item.kind === 'constraint' || item.kind === 'decision' || item.kind === 'open-loop') {
    return fact(item.key ?? `${item.kind}:${item.id}`, item.kind, text, item.sourceId);
  }
  if (item.kind === 'file' && item.status !== 'failed') {
    if (item.paths?.length === 1) return fact(`file:${item.paths[0]}`, 'file-state', text, item.sourceId);
    return fact(item.key ?? `file-result:${item.id}`, 'file-state', text, item.sourceId);
  }
  if ((item.kind === 'error' || item.kind === 'test' || item.kind === 'command') && item.status === 'failed') {
    return fact(item.key ?? `failure:${item.id}`, 'failure', text, item.sourceId);
  }
  if (item.kind === 'task') return fact(item.key ?? `task:${item.id}`, 'task-state', text, item.sourceId);
  if (item.kind === 'background-job') {
    return fact(item.key ?? `background:${item.id}`, 'background-job', text, item.sourceId);
  }
  return undefined;
}

function fact(key: string, kind: ContinuityFact['kind'], text: string, sourceId: string): ContinuityFact {
  return { key, kind, text, sourceIds: [sourceId] };
}

function isPositive(item: EvidenceItem): boolean {
  return item.status === 'succeeded' || item.status === 'completed' || item.status === 'cancelled';
}

function isContinuityFact(value: unknown): value is ContinuityFact {
  if (!isRecord(value)
    || typeof value.key !== 'string'
    || value.key.length > 512
    || typeof value.text !== 'string'
    || value.text.length > DEFAULT_EXTRACTION_BOUNDS.maxTextBytes
    || !Array.isArray(value.sourceIds)
    || value.sourceIds.length > 32
    || !value.sourceIds.every((id) => typeof id === 'string' && id.length <= 256)) return false;
  return value.kind === 'request'
    || value.kind === 'constraint'
    || value.kind === 'decision'
    || value.kind === 'open-loop'
    || value.kind === 'file-state'
    || value.kind === 'failure'
    || value.kind === 'task-state'
    || value.kind === 'background-job';
}

function normalizeOmission(value: unknown): ContinuityStateV1['omitted'] {
  if (!isRecord(value)) return freezeOmission(emptyOmission());
  return {
    itemCount: safeCount(value.itemCount),
    byteCount: safeCount(value.byteCount),
    reasons: Array.isArray(value.reasons)
      ? value.reasons.filter((reason): reason is string => typeof reason === 'string').slice(0, 32)
      : [],
  };
}

function safeCount(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
