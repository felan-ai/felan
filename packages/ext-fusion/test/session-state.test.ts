import type { SessionEntry } from '@felan-ai/agent-core';
import { describe, expect, it } from 'vitest';
import { FUSION_STATE_ENTRY, fusionReviewBytes, latestFusionReview, validateFusionReview } from '../src/session-state.js';
import type { FusionReview } from '../src/contracts.js';

const review: FusionReview = {
  prompt: 'compare these',
  participants: ['one/model', 'two/model'],
  fusionModel: 'one/model',
  answers: [{ text: 'answer', model: 'one/model', durationMs: 10 }],
  updatedAt: 1,
};

describe('Fusion session state', () => {
  it('loads only the latest validated review from the active branch', () => {
    const branch = [
      { type: 'custom', customType: FUSION_STATE_ENTRY, data: review },
      { type: 'custom', customType: FUSION_STATE_ENTRY, data: { prompt: 'malformed' } },
    ] as SessionEntry[];
    expect(latestFusionReview(branch)).toBeUndefined();
    expect(latestFusionReview(branch.slice(0, 1))).toEqual(review);
  });

  it('rejects malformed and oversized persisted state', () => {
    expect(validateFusionReview({ ...review, answers: [{ ...review.answers[0], durationMs: -1 }] })).toBeUndefined();
    expect(validateFusionReview({ ...review, prompt: 'x'.repeat(20_001) })).toBeUndefined();
    const oversized = { ...review, answers: [{ ...review.answers[0], text: 'x'.repeat(50_001) }] };
    expect(validateFusionReview(oversized)).toBeUndefined();
    expect(fusionReviewBytes(review)).toBeGreaterThan(0);
  });
});
