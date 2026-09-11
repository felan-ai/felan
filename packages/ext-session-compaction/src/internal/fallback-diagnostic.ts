import { sanitizeText, utf8Bytes } from './bounds.js';
import {
  FALLBACK_DIAGNOSTIC_CUSTOM_TYPE,
  FALLBACK_DIAGNOSTIC_SCHEMA_VERSION,
  type NativeFallbackReason,
  type SessionCompactionFallbackDiagnosticV1,
} from './contracts.js';

const MAX_DIAGNOSTIC_FIELD_BYTES = 512;
const MAX_DIAGNOSTIC_ERROR_BYTES = 1_024;

export interface FallbackDiagnosticInput {
  readonly reason: NativeFallbackReason;
  readonly sessionId: string;
  readonly attemptId?: string;
  readonly trigger: SessionCompactionFallbackDiagnosticV1['trigger'];
  readonly willRetry: boolean;
  readonly requestedModel: string;
  readonly selectedModel?: string;
  readonly errorMessage?: unknown;
  readonly stopReason?: unknown;
  readonly detail?: unknown;
}

export function createFallbackDiagnostic(input: FallbackDiagnosticInput): SessionCompactionFallbackDiagnosticV1 {
  const diagnostic: SessionCompactionFallbackDiagnosticV1 = {
    customType: FALLBACK_DIAGNOSTIC_CUSTOM_TYPE,
    schemaVersion: FALLBACK_DIAGNOSTIC_SCHEMA_VERSION,
    reason: input.reason,
    sessionId: bounded(input.sessionId),
    trigger: input.trigger,
    willRetry: input.willRetry,
    requestedModel: bounded(input.requestedModel),
    ...(boundedOptional(input.attemptId) ? { attemptId: boundedOptional(input.attemptId) } : {}),
    ...(boundedOptional(input.selectedModel) ? { selectedModel: boundedOptional(input.selectedModel) } : {}),
    ...(sanitizedError(input.errorMessage) ? { errorMessage: sanitizedError(input.errorMessage) } : {}),
    ...(boundedUnknown(input.stopReason) ? { stopReason: boundedUnknown(input.stopReason) } : {}),
    ...(boundedUnknown(input.detail) ? { detail: boundedUnknown(input.detail) } : {}),
  };
  return diagnostic;
}

export function fallbackDiagnosticText(diagnostic: SessionCompactionFallbackDiagnosticV1): string {
  const error = diagnostic.errorMessage ? `: ${diagnostic.errorMessage}` : '';
  return `Session compaction fell back to Pi native compaction (${diagnostic.reason}${error}).`;
}

function sanitizedError(value: unknown): string {
  const text = typeof value === 'string' ? value : value instanceof Error ? value.message : value === undefined ? '' : String(value);
  return redactSecrets(sanitizeText(text, MAX_DIAGNOSTIC_ERROR_BYTES).text);
}

function boundedUnknown(value: unknown): string {
  return bounded(value === undefined ? '' : String(value));
}

function boundedOptional(value: unknown): string {
  return bounded(value === undefined ? '' : String(value));
}

function bounded(value: string): string {
  return sanitizeText(redactSecrets(value), MAX_DIAGNOSTIC_FIELD_BYTES).text;
}

function redactSecrets(value: string): string {
  return value
    .replace(/\bBearer\s+[^\s,;]+/giu, 'Bearer [redacted]')
    .replace(/([?&](?:code|state|token|access_token|refresh_token|client_secret)=)[^&#\s]*/giu, '$1[redacted]')
    .replace(/(\b(?:api[_-]?key|secret|password|token)\s*[=:]\s*)[^\s,;]+/giu, '$1[redacted]');
}

export function fallbackDiagnosticBytes(value: SessionCompactionFallbackDiagnosticV1): number {
  return utf8Bytes(JSON.stringify(value));
}
