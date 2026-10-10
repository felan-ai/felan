import type { SessionEntry } from '@felan-ai/agent-core';
import type { FusionAnswer, FusionReview, FusionStageResult } from './contracts.js';

export const FUSION_STATE_ENTRY = 'felan.fusion-review.v1';
const MAX_REVIEW_BYTES = 240_000;
const MAX_PROMPT_CHARS = 20_000;
const MAX_ANSWERS = 8;

export function latestFusionReview(entries: readonly SessionEntry[]): FusionReview | undefined {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry?.type !== 'custom' || entry.customType !== FUSION_STATE_ENTRY) continue;
    return validateFusionReview(entry.data);
  }
  return undefined;
}

export function validateFusionReview(value: unknown): FusionReview | undefined {
  if (!isRecord(value) || typeof value.prompt !== 'string' || value.prompt.length > MAX_PROMPT_CHARS
    || !Array.isArray(value.participants) || value.participants.length < 2 || value.participants.length > MAX_ANSWERS
    || !value.participants.every((model) => typeof model === 'string' && model.length <= 300)
    || new Set(value.participants).size !== value.participants.length
    || typeof value.fusionModel !== 'string' || value.fusionModel.length > 300
    || !Array.isArray(value.answers) || value.answers.length > MAX_ANSWERS
    || typeof value.updatedAt !== 'number' || !Number.isFinite(value.updatedAt)) return undefined;
  if (!value.answers.every(isFusionAnswer)) return undefined;
  if (value.failures !== undefined && (!Array.isArray(value.failures)
    || value.failures.length > MAX_ANSWERS
    || !value.failures.every(isFusionFailure))) return undefined;
  if (value.comparison !== undefined && !isStageResult(value.comparison)) return undefined;
  if (value.fused !== undefined && !isStageResult(value.fused)) return undefined;
  try {
    if (Buffer.byteLength(JSON.stringify(value)) > MAX_REVIEW_BYTES) return undefined;
  } catch {
    return undefined;
  }
  return value as unknown as FusionReview;
}

export function fusionReviewBytes(review: FusionReview): number {
  return Buffer.byteLength(JSON.stringify(review));
}

function isFusionAnswer(value: unknown): value is FusionAnswer {
  return isRecord(value)
    && isStageResult(value)
    && typeof value.model === 'string' && value.model.length <= 300
    && (value.actualModel === undefined || (typeof value.actualModel === 'string' && value.actualModel.length <= 300));
}

function isStageResult(value: unknown): value is FusionStageResult {
  if (!isRecord(value)
    || typeof value.text !== 'string' || value.text.length > 50_000
    || typeof value.model !== 'string' || value.model.length > 300
    || typeof value.durationMs !== 'number' || !Number.isFinite(value.durationMs) || value.durationMs < 0
    || (value.truncated !== undefined && typeof value.truncated !== 'boolean')) return false;
  if (value.usage === undefined) return true;
  if (!isRecord(value.usage)) return false;
  const usage = value.usage;
  return ['input', 'output', 'totalTokens', 'estimatedCost'].every((key) => {
    const amount = usage[key];
    return typeof amount === 'number' && Number.isFinite(amount) && amount >= 0;
  });
}

function isFusionFailure(value: unknown): boolean {
  return isRecord(value)
    && typeof value.model === 'string' && value.model.length <= 300
    && typeof value.message === 'string' && value.message.length <= 400;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
