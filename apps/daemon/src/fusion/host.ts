import type { FusionHost } from '@felan-ai/ext-fusion';
import { setExtensionConfigValues } from '../settings.js';

export function createLocalFusionHost(agentDir: string, presentation: Pick<FusionHost, 'configure' | 'review'>): FusionHost {
  return {
    async selectRunAction(context, participants, fusionModel) {
      const model = fusionModel === 'inherit'
        ? `Current chat model (${context.model?.provider}/${context.model?.id})`
        : fusionModel;
      const choice = await context.ui.select(
        `Fusion lineup\n\nParticipants:\n${participants.map((reference) => `• ${cleanText(reference)}`).join('\n')}\n\nComparison / fusion: ${cleanText(model)}\n\n${participants.length} participant requests + 1 comparison request. Fuse adds another request. Provider billing may apply.`,
        ['Run with these models', 'Change models', 'Cancel'],
      );
      return choice === 'Run with these models' ? 'run' : choice === 'Change models' ? 'change' : 'cancel';
    },
    async confirm(context, participantCount) {
      return context.ui.confirm(
        'Run model comparison?',
        `This sends your prompt to ${participantCount} participant models and then makes one comparison request. Choosing Fuse later adds one more request. Provider billing may apply. Continue?`,
      );
    },
    async configure(context, models, configuredParticipants, configuredFusionModel) {
      if (models.length < 2) {
        context.ui.notify('Fusion needs at least two authenticated models in the current session model scope.', 'error');
        return undefined;
      }
      const selected = await presentation.configure(context, models, configuredParticipants, configuredFusionModel);
      if (!selected) return undefined;
      try {
        await setExtensionConfigValues(agentDir, 'fusion', {
          participants: selected.participants,
          fusionModel: selected.fusionModel,
        });
      } catch {
        context.ui.notify('Could not save Fusion model choices. No model requests were started.', 'error');
        return undefined;
      }
      return selected;
    },
    review(context, getReview, actions) {
      return presentation.review(context, getReview, actions);
    },
  };
}

function cleanText(value: string): string {
  return value
    .replace(/\u001b(?:\][^\u0007]*(?:\u0007|\u001b\\)|\[[0-?]*[ -/]*[@-~]|[@-_])/gu, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, ' ');
}
