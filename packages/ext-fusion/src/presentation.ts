import type { FusionModelChoice, FusionReview } from './contracts.js';
import { validateFusionReview } from './review-data.js';

export const FUSION_PICKER_PRESENTER = Object.freeze({ id: 'felan.fusion.picker', version: '1' });
export const FUSION_REVIEW_PRESENTER = Object.freeze({ id: 'felan.fusion.review', version: '1' });

export interface FusionPickerRequest {
  readonly mode: 'lineup' | 'fusion';
  readonly models: readonly FusionModelChoice[];
  readonly participants: readonly string[];
  readonly fusionModel: string;
}
export interface FusionPickerResult {
  readonly participants: readonly string[];
  readonly fusionModel: string;
}
export type FusionReviewDecision =
  | { readonly action: 'close' | 'fuse' | 'retry_participants' | 'retry_comparison' }
  | { readonly action: 'choose_model'; readonly instruction: string };

export function parseFusionPickerRequest(value: unknown): FusionPickerRequest {
  if (!record(value) || (value.mode !== 'lineup' && value.mode !== 'fusion') || !Array.isArray(value.models)
    || value.models.length > 1024 || !strings(value.participants, 8) || !reference(value.fusionModel)) throw invalid();
  const models = value.models.map(model => {
    if (!record(model) || !reference(model.reference) || typeof model.label !== 'string' || model.label.length > 4096) throw invalid();
    return { reference: model.reference, label: model.label };
  });
  if (new Set(models.map(model => model.reference)).size !== models.length) throw invalid();
  return { mode: value.mode as FusionPickerRequest['mode'], models, participants: [...value.participants], fusionModel: value.fusionModel };
}

export function parseFusionPickerResult(value: unknown, request: FusionPickerRequest): FusionPickerResult {
  if (!record(value) || !keys(value, ['participants', 'fusionModel']) || !strings(value.participants, 8) || !reference(value.fusionModel)) throw invalid();
  const allowed = new Set(request.models.map(model => model.reference));
  if (new Set(value.participants).size !== value.participants.length) throw invalid();
  if (request.mode === 'lineup') {
    if (value.participants.length < 2 || value.participants.some(model => !allowed.has(model))) throw invalid();
    if (value.fusionModel !== 'inherit' && !allowed.has(value.fusionModel)) throw invalid();
  } else if (!allowed.has(value.fusionModel) || JSON.stringify(value.participants) !== JSON.stringify(request.participants)) throw invalid();
  return { participants: [...value.participants], fusionModel: value.fusionModel };
}

export function parseFusionReview(value: unknown): FusionReview {
  const review = validateFusionReview(value);
  if (!review) throw invalid();
  return review;
}

export function parseFusionReviewMetadata(value: unknown): { busy: boolean } {
  if (!record(value) || Object.keys(value).length !== 1 || typeof value.busy !== 'boolean') throw invalid();
  return { busy: value.busy };
}

export function parseFusionReviewDecision(value: unknown, review: FusionReview, busy: boolean): FusionReviewDecision {
  if (!record(value)) throw invalid();
  if (!keys(value, value.action === 'choose_model' ? ['action', 'instruction'] : ['action'])) throw invalid();
  if (value.action === 'close') return { action: 'close' };
  if (busy) throw invalid();
  if (value.action === 'fuse' && review.comparison) return { action: 'fuse' };
  if (value.action === 'choose_model' && review.comparison && typeof value.instruction === 'string' && value.instruction.length <= 32768) {
    return { action: 'choose_model', instruction: value.instruction };
  }
  if (value.action === 'retry_participants' && review.failures?.length) return { action: 'retry_participants' };
  if (value.action === 'retry_comparison' && review.answers.length >= 2) return { action: 'retry_comparison' };
  throw invalid();
}

function reference(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && value.length <= 300; }
function strings(value: unknown, maximum: number): value is string[] { return Array.isArray(value) && value.length <= maximum && value.every(reference); }
function keys(value: Record<string, unknown>, allowed: string[]): boolean { return Object.keys(value).every(key => allowed.includes(key)); }
function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function invalid(): Error { return new Error('Invalid Fusion presentation data.'); }
