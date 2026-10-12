import { createPiClassifier, formatModelReference, type Classifier, type ModelRuntime } from '@felan-ai/agent-core';

export type LocalClassifierModel = Parameters<ModelRuntime['classify']>[0];

export interface LocalClassifierSelection {
  readonly model?: LocalClassifierModel;
  readonly warnings: readonly string[];
}

export function selectLocalClassifierModel(
  models: readonly LocalClassifierModel[], configured = 'auto',
): LocalClassifierSelection {
  if (configured !== 'auto') {
    const model = models.find(model => formatModelReference(model) === configured);
    if (model) return { model, warnings: [] };
  }
  const model = [...models].sort((left, right) => preference(left) - preference(right))[0];
  return {
    ...(model === undefined ? {} : { model }),
    warnings: configured === 'auto' ? [] : ['Configured classifier model is unavailable; using Auto.'],
  };
}

export async function createLocalClassifier(
  models: Pick<ModelRuntime, 'getAvailableOfType' | 'classify'>, configured = 'auto',
): Promise<LocalClassifierSelection & { readonly classifier?: Classifier }> {
  let available: readonly LocalClassifierModel[];
  try {
    available = await models.getAvailableOfType('classifier');
  } catch {
    return { warnings: ['Classifier model discovery failed; classifier features will use their normal fallbacks.'] };
  }
  const selected = selectLocalClassifierModel(available, configured);
  return {
    ...selected,
    ...(selected.model === undefined ? {} : { classifier: createPiClassifier(models, selected.model) }),
  };
}

function preference(model: LocalClassifierModel): number {
  if (model.provider === 'typesafe' && model.id === 'jev-latest') return 0;
  if (model.provider === 'openrouter' && model.id === 'typesafe/jev-1.13') return 1;
  return /(?:^|\/)jev(?:[-.]|$)/iu.test(model.id) ? 2 : 3;
}
