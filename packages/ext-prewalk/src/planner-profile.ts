import {
  clampThinkingLevel, getModelStrength, selectModelForTier,
  type ExtensionContext, type FelanThinkingLevel,
} from '@felan-ai/agent-core';

export interface PlannerProfile {
  readonly model: NonNullable<ExtensionContext['model']>;
  readonly tier: 'high' | 'xhigh';
  readonly thinking: Extract<FelanThinkingLevel, 'high' | 'xhigh' | 'max'>;
}

export function plannerProfiles(ctx: ExtensionContext, currentThinking: string): PlannerProfile[] {
  if (!ctx.model) return [];
  const models = (ctx.scopedModels.length ? ctx.scopedModels.map(({ model }) => model) : ctx.modelRegistry.getAvailable())
    .filter(model => model.provider.toLowerCase() === ctx.model!.provider.toLowerCase()
      && ctx.modelRegistry.hasConfiguredAuth(model)
      && (['high', 'xhigh', 'max'] as const).some(level => clampThinkingLevel(model, level) === level));
  const current = models.find(model => model.provider === ctx.model!.provider && model.id === ctx.model!.id);
  const candidates = [
    ...(current && ['high', 'xhigh'].includes(getModelStrength(current) ?? '') ? [current] : []),
    selectModelForTier('high', models, { preferredModel: ctx.model })?.model,
    selectModelForTier('xhigh', models, { preferredModel: ctx.model })?.model,
  ].filter((model): model is NonNullable<typeof model> => model !== undefined);
  const profiles: PlannerProfile[] = [];
  for (const model of candidates) {
    const levels = ['high', 'xhigh', 'max'] as const;
    const preferred = levels.includes(currentThinking as typeof levels[number]) ? currentThinking : 'high';
    for (const thinking of [preferred, ...levels] as typeof levels[number][]) {
      if (clampThinkingLevel(model, thinking) !== thinking) continue;
      if (!profiles.some(profile => profile.model.provider === model.provider && profile.model.id === model.id
        && profile.thinking === thinking)) profiles.push({ model,
          tier: getModelStrength(model) as 'high' | 'xhigh', thinking });
    }
  }
  return profiles;
}
