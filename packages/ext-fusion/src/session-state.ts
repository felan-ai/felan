import type { SessionEntry } from '@felan-ai/agent-core';
import type { FusionReview } from './contracts.js';
import { validateFusionReview } from './review-data.js';
export { validateFusionReview, fusionReviewBytes } from './review-data.js';

export const FUSION_STATE_ENTRY = 'felan.fusion-review.v1';

export function latestFusionReview(entries: readonly SessionEntry[]): FusionReview | undefined {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry?.type !== 'custom' || entry.customType !== FUSION_STATE_ENTRY) continue;
    return validateFusionReview(entry.data);
  }
  return undefined;
}
