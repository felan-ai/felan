import type { OmissionReport } from './contracts.js';

export interface ExtractionBounds {
  readonly maxMessages: number;
  readonly maxBranchEntries: number;
  readonly maxWorkUnits: number;
  readonly maxEvidenceItems: number;
  readonly maxEvidenceBytes: number;
  readonly maxTextBytes: number;
  readonly maxPathsPerItem: number;
  readonly maxContinuityItems: number;
  readonly maxContinuityBytes: number;
}

export const DEFAULT_EXTRACTION_BOUNDS: ExtractionBounds = Object.freeze({
  maxMessages: 512,
  maxBranchEntries: 4_096,
  maxWorkUnits: 12_000,
  maxEvidenceItems: 256,
  maxEvidenceBytes: 64 * 1_024,
  maxTextBytes: 2_048,
  maxPathsPerItem: 32,
  maxContinuityItems: 128,
  maxContinuityBytes: 32 * 1_024,
});

const encoder = new TextEncoder();

export function sanitizeText(value: unknown, maxBytes: number): { text: string; omittedBytes: number } {
  if (typeof value !== 'string' || maxBytes <= 0) return { text: '', omittedBytes: 0 };
  const clean = value
    .replace(/\r\n?/gu, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '')
    .replace(/[\u202a-\u202e\u2066-\u2069]/gu, '')
    .trim();
  const bytes = encoder.encode(clean);
  if (bytes.byteLength <= maxBytes) return { text: clean, omittedBytes: 0 };
  let end = Math.min(clean.length, maxBytes);
  while (end > 0 && encoder.encode(clean.slice(0, end)).byteLength > maxBytes) end -= 1;
  const text = clean.slice(0, end).replace(/[\uD800-\uDBFF]$/u, '').trimEnd();
  return { text, omittedBytes: bytes.byteLength - encoder.encode(text).byteLength };
}

export function utf8Bytes(value: string): number {
  return encoder.encode(value).byteLength;
}

export function emptyOmission(): MutableOmission {
  return { itemCount: 0, byteCount: 0, reasons: [] };
}

export interface MutableOmission {
  itemCount: number;
  byteCount: number;
  reasons: string[];
}

export function omit(target: MutableOmission, reason: string, items = 1, bytes = 0): void {
  target.itemCount += Math.max(0, items);
  target.byteCount += Math.max(0, bytes);
  if (!target.reasons.includes(reason)) target.reasons.push(reason);
}

export function freezeOmission(value: MutableOmission): OmissionReport {
  return {
    itemCount: value.itemCount,
    byteCount: value.byteCount,
    reasons: [...value.reasons].sort(),
  };
}

export function stableIdentifier(value: unknown, fallback: string): string {
  if (typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value)) return value;
  return `${fallback}-${fnv1a(typeof value === 'string' ? value : String(value))}`;
}

function fnv1a(value: string): string {
  let hash = 0x811c9dc5;
  for (const byte of encoder.encode(value)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}
