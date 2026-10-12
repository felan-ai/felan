import {
  PREWALK_REVIEW_PRESENTER, PlanReviewRequestSchema, PlanReviewResultSchema, presentPrewalkPlan,
  type PlanReviewResult,
} from '@felan-ai/ext-prewalk/tui';
import { InteractionAnswerSchema, parseSchema } from '@felan-ai/session-protocol';
import type { ClientInteractionPresenters, InteractionPresenterUi } from './presenters.js';

export function registerPrewalkPresenter(
  presenters: Pick<ClientInteractionPresenters, 'registerCustom'>,
  ui: Pick<InteractionPresenterUi, 'custom'>,
): () => void {
  const answer = (result: PlanReviewResult) => {
    const parsed = parseSchema(PlanReviewResultSchema, result);
    return parseSchema(InteractionAnswerSchema, { kind: 'custom', presenter: PREWALK_REVIEW_PRESENTER, data: parsed });
  };
  return presenters.registerCustom(PREWALK_REVIEW_PRESENTER, async (data, signal, document) => {
    if (data !== null) throw new Error('Invalid Prewalk presenter metadata.');
    const request = parseSchema(PlanReviewRequestSchema, { plan: document });
    const result = await presentPrewalkPlan(ui, request.plan, signal, value => {
      try { answer(value); return undefined; }
      catch { return 'This response is invalid or too large. Shorten the feedback and try again.'; }
    });
    if (result === undefined) return undefined;
    const validated = answer(result);
    if (validated.kind !== 'custom') throw new Error('Prewalk answer kind changed.');
    return validated.data;
  });
}
