import {
  FUSION_PICKER_PRESENTER, FUSION_REVIEW_PRESENTER, parseFusionPickerRequest, parseFusionPickerResult,
  parseFusionReview, parseFusionReviewMetadata, parseFusionReviewDecision, presentFusionModelPicker, presentFusionDecision,
} from '@felan-ai/ext-fusion/tui';
import { InteractionAnswerSchema, parseSchema } from '@felan-ai/session-protocol';
import type { ClientInteractionPresenters, InteractionPresenterUi } from './presenters.js';

export function registerFusionPresenters(
  presenters: Pick<ClientInteractionPresenters, 'registerCustom'>,
  ui: Pick<InteractionPresenterUi, 'custom' | 'notify'>,
): () => void {
  const removePicker = presenters.registerCustom(FUSION_PICKER_PRESENTER, async (data, signal, document) => {
    if (data !== null) throw new Error('Invalid Fusion picker metadata.');
    const request = parseFusionPickerRequest(document);
    const selected = await presentFusionModelPicker(ui, { ...request, ...(request.mode === 'fusion' ? {
      allowParticipants: false, allowInherit: false, initialMode: 'fusion', minParticipants: 0,
    } : {}) }, signal);
    if (!selected) return undefined;
    const result = parseFusionPickerResult(selected, request);
    return { participants: [...result.participants], fusionModel: result.fusionModel };
  });
  try {
    const removeReview = presenters.registerCustom(FUSION_REVIEW_PRESENTER, async (data, signal, document) => {
      const { busy } = parseFusionReviewMetadata(data);
      const review = parseFusionReview(document);
      const answer = (value: unknown) => parseSchema(InteractionAnswerSchema, {
        kind: 'custom', presenter: FUSION_REVIEW_PRESENTER, data: parseFusionReviewDecision(value, review, busy),
      });
      const selected = await presentFusionDecision(ui, review, busy, signal, value => {
        try { answer(value); return undefined; }
        catch { return 'This response is invalid or too large. Shorten the instruction and try again.'; }
      });
      if (!selected) return undefined;
      const result = answer(selected);
      if (result.kind !== 'custom') throw new Error('Fusion answer kind changed.');
      return result.data;
    });
    return () => { removeReview(); removePicker(); };
  } catch (error) { removePicker(); throw error; }
}
