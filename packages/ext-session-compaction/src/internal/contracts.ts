import type { SessionEntry } from '@felan-ai/agent-core';

export interface CompactionPreparation {
  readonly firstKeptEntryId: string;
  readonly messagesToSummarize: readonly unknown[];
  readonly turnPrefixMessages: readonly unknown[];
  readonly previousSummary?: string;
  readonly tokensBefore: number;
}
export type PreparedMessageValue = unknown;

export const DETAILS_NAMESPACE = 'felan.session-compaction' as const;
export const DETAILS_SCHEMA_VERSION = 1 as const;

export const FALLBACK_DIAGNOSTIC_CUSTOM_TYPE = 'felan-session-compaction-fallback' as const;
export const FALLBACK_DIAGNOSTIC_SCHEMA_VERSION = 1 as const;

export type NativeFallbackReason =
  | 'model-unavailable'
  | 'prompt-preparation-failed'
  | 'prompt-budget-exceeded'
  | 'model-request-failed'
  | 'model-timeout'
  | 'model-response-invalid'
  | 'model-response-unsupported'
  | 'summary-budget-exceeded';

export interface SessionCompactionFallbackDiagnosticV1 {
  readonly customType: typeof FALLBACK_DIAGNOSTIC_CUSTOM_TYPE;
  readonly schemaVersion: typeof FALLBACK_DIAGNOSTIC_SCHEMA_VERSION;
  readonly reason: NativeFallbackReason;
  readonly sessionId: string;
  readonly attemptId?: string;
  readonly trigger: 'manual' | 'threshold' | 'overflow';
  readonly willRetry: boolean;
  readonly requestedModel: string;
  readonly selectedModel?: string;
  readonly errorMessage?: string;
  readonly stopReason?: string;
  readonly detail?: string;
}

export type SpanSection = 'previous_summary' | 'messages_to_summarize' | 'turn_prefix';

export interface PreparedSource {
  readonly sourceId: string;
  readonly section: SpanSection;
  readonly index: number;
  readonly entryId?: string;
  readonly message?: PreparedMessageValue;
  readonly text?: string;
}

export interface PreparedSpan {
  readonly schemaVersion: 1;
  readonly firstKeptEntryId: string;
  readonly sources: readonly PreparedSource[];
  readonly omitted: OmissionReport;
}

export type EvidenceProvenance = 'requested' | 'observed' | 'agent-reported' | 'recorded-result';
export type EvidenceKind =
  | 'request'
  | 'constraint'
  | 'decision'
  | 'open-loop'
  | 'report'
  | 'tool-call'
  | 'observation'
  | 'file'
  | 'command'
  | 'test'
  | 'error'
  | 'task'
  | 'background-job'
  | 'rtk-pointer';
export type EvidenceStatus =
  | 'unknown'
  | 'requested'
  | 'observed'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'partial'
  | 'completed'
  | 'cancelled'
  | 'blocked';

export interface EvidenceItem {
  readonly id: string;
  readonly sourceId: string;
  readonly provenance: EvidenceProvenance;
  readonly kind: EvidenceKind;
  readonly status: EvidenceStatus;
  readonly text: string;
  readonly toolCallId?: string;
  readonly toolName?: string;
  readonly key?: string;
  readonly paths?: readonly string[];
  readonly recoveryPath?: string;
  readonly techniques?: readonly string[];
}

export interface EvidenceBundle {
  readonly schemaVersion: 1;
  readonly items: readonly EvidenceItem[];
  readonly omitted: OmissionReport;
}

export interface OmissionReport {
  readonly itemCount: number;
  readonly byteCount: number;
  readonly reasons: readonly string[];
}

export type ContinuityKind = 'request' | 'constraint' | 'decision' | 'open-loop' | 'file-state' | 'failure' | 'task-state' | 'background-job';

export interface ContinuityFact {
  readonly key: string;
  readonly kind: ContinuityKind;
  readonly text: string;
  readonly sourceIds: readonly string[];
}

export interface ContinuityStateV1 {
  readonly schemaVersion: 1;
  readonly facts: readonly ContinuityFact[];
  readonly omitted: OmissionReport;
}

export interface ContinuityResolution {
  readonly targetKey: string;
  readonly evidenceId: string;
  readonly mode: 'positive' | 'override';
}

export interface SessionCompactionDetailsV1 {
  readonly namespace: typeof DETAILS_NAMESPACE;
  readonly schemaVersion: typeof DETAILS_SCHEMA_VERSION;
  readonly continuity: ContinuityStateV1;
}

export interface PreparedSpanInput {
  readonly preparation: CompactionPreparation;
  readonly branchEntries: readonly SessionEntry[];
}
