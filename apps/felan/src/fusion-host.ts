import type { FusionHost } from '@felan-ai/ext-fusion';
import { presentFusionModelPicker, presentFusionReview } from '@felan-ai/ext-fusion/tui';

export const legacyFusionPresentation: Pick<FusionHost, 'configure' | 'review'> = {
  configure(context, models, participants, fusionModel) {
    return presentFusionModelPicker(context.ui, { models, participants, fusionModel });
  },
  review(context, getReview, actions) {
    return presentFusionReview(context.ui, () => {
      const choices = context.scopedModels.length === 0
        ? context.modelRegistry.getAvailable()
        : context.scopedModels.map(({ model }) => model).filter(model => context.modelRegistry.hasConfiguredAuth(model));
      return choices.map(model => ({
        reference: `${model.provider}/${model.id}`, label: `${model.name} (${model.provider}/${model.id})`,
      }));
    }, getReview, actions);
  },
};
