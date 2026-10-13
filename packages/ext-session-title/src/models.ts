import type { Logger, ModelsService, TextModelInfo } from '@felan-ai/agent-core';
import type { SessionTitleHost } from './contracts.js';

export function createSessionTitleModelsHost(models: ModelsService, logger: Logger): SessionTitleHost {
  return {
    async prepare({ currentModel, prompt, signal }) {
      signal.throwIfAborted();
      if (!currentModel) return undefined;
      const available = await models.getAvailable(currentModel.provider, { signal });
      signal.throwIfAborted();
      return {
        prompt,
        provider: currentModel.provider,
        models: available.filter(model => model.provider === currentModel.provider && model.input.includes('text')),
        preferredModel: currentModel,
      };
    },
    async complete({ sessionId, requestId, model, context, options }) {
      const response = await models.completeSimple({ provider: model.provider, id: model.id }, context, options);
      logger.debug({
        component: 'session-title', sessionId, requestId,
        model: { provider: response.provider, id: response.model },
        stopReason: response.stopReason, usage: response.usage,
      }, 'Session title completion received.');
      return response;
    },
    reportError({ sessionId, stage }) {
      logger.warn({ component: 'session-title', sessionId, stage }, 'Session title generation failed.');
    },
    reportSkip({ sessionId, reason }) {
      logger.debug({ component: 'session-title', sessionId, reason }, 'Session title generation skipped.');
    },
  };
}

export function sessionTitleModelInfo(model: TextModelInfo): TextModelInfo {
  return {
    id: model.id, name: model.name, api: model.api, provider: model.provider,
    input: model.input, cost: model.cost, reasoning: model.reasoning,
    contextWindow: model.contextWindow, maxTokens: model.maxTokens,
    ...(model.thinkingLevelMap === undefined ? {} : { thinkingLevelMap: model.thinkingLevelMap }),
  };
}
