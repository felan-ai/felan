import type { Api, AssistantMessage, Model } from '@earendil-works/pi-ai';
import type { InlineExtension } from '@earendil-works/pi-coding-agent';
import { collectClassifierSessionEvidence } from '../classifier/index.js';
import type { AgentRuntime } from '../runtime.js';
import type { SavingsReporter } from '../savings.js';
import { isFelanThinkingLevel, type FelanThinkingLevel } from '../thinking.js';
import { reportDynamicThinkingSavings } from './savings.js';
import { evaluateDynamicThinkingLevel, supportsDynamicThinking } from './selection.js';

export const DYNAMIC_THINKING_PRODUCER = '@felan-ai/agent-core/dynamic-thinking';

export function createDynamicThinkingSession(
  runtime: AgentRuntime,
  codexEffortUpdatesAvailable: boolean,
  reporter?: SavingsReporter,
): InlineExtension {
  const classifier = runtime.classifier;
  if (!classifier) throw new Error('Dynamic thinking requires a classifier');
  const lifetime = new AbortController();
  let manualOverride = false;
  let expectedLevel: FelanThinkingLevel | undefined;
  let pendingSavings: {
    readonly sessionId: string;
    readonly model: Model<Api>;
    readonly previous: FelanThinkingLevel;
    readonly selected: FelanThinkingLevel;
    readonly classifierCostUsd?: number;
    firstAssistant?: AssistantMessage;
    failed?: boolean;
  } | undefined;
  const canClassify = (api: string) => api !== 'openai-codex-responses' || codexEffortUpdatesAvailable;

  return {
    name: DYNAMIC_THINKING_PRODUCER,
    hidden: true,
    factory: (pi) => {
      pi.on('session_shutdown', () => { pendingSavings = undefined; lifetime.abort(); });
      pi.on('model_select', () => { pendingSavings = undefined; });
      pi.on('agent_settled', () => { pendingSavings = undefined; });
      pi.on('thinking_level_select', (event) => {
        if (event.level === expectedLevel) expectedLevel = undefined;
        else { manualOverride = true; pendingSavings = undefined; }
      });
      pi.on('before_agent_start', async (event, ctx) => {
        pendingSavings = undefined;
        if (manualOverride || lifetime.signal.aborted || !supportsDynamicThinking(ctx.model)
          || !canClassify(ctx.model.api)) return;
        const model = ctx.model;
        const original = pi.getThinkingLevel();
        if (!isFelanThinkingLevel(original)) return;
        const sessionId = ctx.sessionManager.getSessionId();
        const evidence = collectClassifierSessionEvidence(ctx.sessionManager);
        const decision = await evaluateDynamicThinkingLevel(
          classifier, model, event.prompt, evidence, original, lifetime.signal,
        );
        if (!decision || manualOverride || lifetime.signal.aborted || sessionId !== ctx.sessionManager.getSessionId()
          || ctx.model?.api !== model.api || ctx.model?.provider !== model.provider
          || ctx.model?.id !== model.id || pi.getThinkingLevel() !== original) return;
        expectedLevel = decision.level;
        pi.setThinkingLevel(decision.level);
        if (reporter && original === 'high' && (decision.level === 'low' || decision.level === 'medium')) {
          pendingSavings = { sessionId, model, previous: original, selected: decision.level,
            ...(decision.classifierCostUsd === undefined ? {} : { classifierCostUsd: decision.classifierCostUsd }) };
        }
      });
      pi.on('turn_end', (event, ctx) => {
        if (event.message.role !== 'assistant') return;
        const pending = pendingSavings;
        if (!pending || manualOverride || lifetime.signal.aborted
          || pending.sessionId !== ctx.sessionManager.getSessionId()
          || ctx.model?.api !== pending.model.api || ctx.model?.provider !== pending.model.provider
          || ctx.model?.id !== pending.model.id || pi.getThinkingLevel() !== pending.selected
          || event.message.api !== pending.model.api || event.message.provider !== pending.model.provider
          || event.message.model !== pending.model.id) {
          pendingSavings = undefined;
          return;
        }
        pending.firstAssistant ??= event.message;
        if ((event.message.stopReason !== 'stop' && event.message.stopReason !== 'toolUse')
          || event.toolResults.some((result) => result.isError)) pending.failed = true;
      });
      pi.on('agent_before_settle', async (event, ctx) => {
        if (event.continue || event.context.pendingMessages.length > 0) return;
        const pending = pendingSavings;
        pendingSavings = undefined;
        if (!pending || pending.failed || !pending.firstAssistant || event.outcome !== 'completed'
          || manualOverride || lifetime.signal.aborted || pending.sessionId !== ctx.sessionManager.getSessionId()
          || ctx.model?.api !== pending.model.api || ctx.model?.provider !== pending.model.provider
          || ctx.model?.id !== pending.model.id || pi.getThinkingLevel() !== pending.selected) return;
        await reportDynamicThinkingSavings(
          reporter, pending.model, pending.previous, pending.selected, pending.firstAssistant,
          pending.classifierCostUsd,
        );
      });
    },
  };
}
