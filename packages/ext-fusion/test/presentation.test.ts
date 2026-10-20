import { describe, expect, it } from 'vitest';
import { parseFusionPickerRequest, parseFusionPickerResult, parseFusionReviewDecision, parseFusionReviewMetadata, parseFusionReview } from '../src/presentation.js';
import { fusionReviewBytes } from '../src/review-data.js';
import type { FusionReview } from '../src/contracts.js';

const models = [{ reference: 'one/model', label: 'One' }, { reference: 'two/model', label: 'Two' }];
const review: FusionReview = { prompt: 'Compare', participants: models.map(model => model.reference), fusionModel: 'one/model',
  answers: models.map(model => ({ model: model.reference, text: 'answer', durationMs: 1 })),
  comparison: { model: 'one/model', text: 'comparison', durationMs: 1 }, failures: [{ model: 'two/model', message: 'failed' }], updatedAt: 1 };

describe('Fusion presentation contracts', () => {
  it('validates choices against the displayed model scope and preserves order', () => {
    const request = parseFusionPickerRequest({ mode: 'lineup', models, participants: [], fusionModel: 'inherit' });
    expect(parseFusionPickerResult({ participants: ['two/model', 'one/model'], fusionModel: 'inherit' }, request).participants).toEqual(['two/model', 'one/model']);
    for (const participants of [['one/model'], ['one/model', 'one/model'], ['one/model', 'outside/model']]) {
      expect(() => parseFusionPickerResult({ participants, fusionModel: 'inherit' }, request)).toThrow();
    }
  });

  it('does not let an alternate-model selection mutate the participant lineup or inherit silently', () => {
    const request = parseFusionPickerRequest({ mode: 'fusion', models, participants: review.participants, fusionModel: 'one/model' });
    expect(() => parseFusionPickerResult({ participants: review.participants, fusionModel: 'inherit' }, request)).toThrow();
    expect(() => parseFusionPickerResult({ participants: [...review.participants].reverse(), fusionModel: 'one/model' }, request)).toThrow();
  });

  it('limits actions to the current phase and available review data', () => {
    expect(parseFusionReviewDecision({ action: 'close' }, review, true)).toEqual({ action: 'close' });
    for (const action of ['fuse', 'retry_participants', 'retry_comparison', 'invalid']) {
      expect(() => parseFusionReviewDecision({ action }, review, true)).toThrow();
    }
    expect(() => parseFusionReviewDecision({ action: 'fuse', model: 'outside/model' }, review, false)).toThrow();
    expect(() => parseFusionReviewDecision({ action: 'fuse' }, { ...review, comparison: undefined } as unknown as FusionReview, false)).toThrow();
    expect(() => parseFusionReviewMetadata({ busy: false, extra: true })).toThrow();
  });

  it('preserves large structured Unicode reviews with portable UTF-8 accounting', () => {
    const large = { ...review, answers: models.map(model => ({ model: model.reference, text: '界'.repeat(30_000), durationMs: 1 })) };
    expect(fusionReviewBytes(large)).toBe(new TextEncoder().encode(JSON.stringify(large)).byteLength);
    expect(parseFusionReview(large)).toEqual(large);
    expect(() => parseFusionReview({ ...large, answers: [...large.answers, ...large.answers] })).toThrow();
  });
});
