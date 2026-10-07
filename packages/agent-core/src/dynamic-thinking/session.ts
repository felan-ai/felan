import type { Api, AssistantMessage, Model } from '@earendil-works/pi-ai';
import type { ExtensionContext, InlineExtension } from '@earendil-works/pi-coding-agent';
import { createTurnClassificationRegistry, type TurnClassificationRegistry } from '../classifier/turn-classification.js';
import type { AgentRuntime } from '../runtime.js';
import type { SavingsReporter } from '../savings.js';
import type { ModelSelectionPersistenceScope } from '../model-selection.js';
import { isFelanThinkingLevel, type FelanThinkingLevel } from '../thinking.js';
import { reportDynamicThinkingSavings } from './savings.js';
import { dynamicThinkingQuestion, dynamicThinkingDecision, supportsDynamicThinking } from './selection.js';

export const DYNAMIC_THINKING_PRODUCER = '@felan-ai/agent-core/dynamic-thinking';

export function createDynamicThinkingSession(
  runtime: AgentRuntime,
  codexEffortUpdatesAvailable: boolean,
  reporter?: SavingsReporter,
  options: { selectionScope?: ModelSelectionPersistenceScope; turnClassification?: TurnClassificationRegistry } = {},
): InlineExtension {
  const classifier = runtime.classifier;
  if (!classifier) throw new Error('Dynamic thinking requires a classifier');
  const lifetime = new AbortController();
  let manualOverride = false;
  let expectedLevel: FelanThinkingLevel | undefined;
  let lastAutomaticLevel: FelanThinkingLevel | undefined;
  let pendingSavings: {
    readonly sessionId: string;
    readonly model: Model<Api>;
    readonly previous: FelanThinkingLevel;
    readonly selected: FelanThinkingLevel;
    readonly classifierCostUsd?: number;
    firstAssistant?: AssistantMessage;
    failed?: boolean;
  } | undefined;
  const canClassify = (api: string) => (api !== 'openai-codex-responses' && api !== 'openai-responses')
    || codexEffortUpdatesAvailable;
  const local = options.turnClassification ? undefined : createTurnClassificationRegistry(classifier, runtime.logger);
  const registry = options.turnClassification ?? local!;
  let prepared: { model: Model<Api>; original: FelanThinkingLevel } | undefined;

  return {
    name: DYNAMIC_THINKING_PRODUCER,
    hidden: true,
    factory: (pi) => {
      options.selectionScope?.onManualThinkingSelection(() => {
        manualOverride = true;
        pendingSavings = undefined;
      });
      pi.on('session_shutdown', () => { pendingSavings = undefined; lifetime.abort(); });
      pi.on('model_select', () => { pendingSavings = undefined; });
      pi.on('agent_settled', () => { pendingSavings = undefined; });
      pi.on('thinking_level_select', (event) => {
        if (options.selectionScope?.isAutomated()) {
          if (!options.selectionScope.owner && event.level === expectedLevel) {
            expectedLevel = undefined;
            return;
          }
          expectedLevel = undefined;
          lastAutomaticLevel = undefined;
          pendingSavings = undefined;
          return;
        }
        if (!options.selectionScope && event.level === expectedLevel) expectedLevel = undefined;
        else { manualOverride = true; pendingSavings = undefined; }
      });
      registry.register({
        id: 'thinking',
        prepare(input, ctx) {
          prepared = undefined;
          if (!input.prompt.trim() || options.selectionScope?.owner || manualOverride || lifetime.signal.aborted
            || !supportsDynamicThinking(ctx.model) || !canClassify(ctx.model.api)) return undefined;
          const original = pi.getThinkingLevel();
          if (lastAutomaticLevel !== undefined && original !== lastAutomaticLevel) {
            manualOverride = true;
            return undefined;
          }
          if (!isFelanThinkingLevel(original)) return undefined;
          const question = dynamicThinkingQuestion(ctx.model);
          if (!question) return undefined;
          prepared = { model: ctx.model, original };
          return { questions: { effort: question } };
        },
      });
      if (local) {
        pi.on('input', (event, ctx) => {
          if (event.streamingBehavior === undefined) local.start({ prompt: event.text, imageCount: event.images?.length ?? 0 }, ctx);
        });
        pi.on('turn_start', () => local.finish());
        pi.on('session_shutdown', () => local.dispose());
      }
      pi.on('before_agent_start', async (event, ctx) => {
        pendingSavings = undefined;
        const request = { prompt: event.prompt, imageCount: event.images?.length ?? 0 };
        local?.start(request, ctx);
        const result = await registry.result('thinking', request, ctx);
        const active = prepared;
        if (!result || !active || options.selectionScope?.owner || manualOverride || lifetime.signal.aborted) return;
        const { model, original } = active;
        if (ctx.model?.api !== model.api || ctx.model.provider !== model.provider
          || ctx.model.id !== model.id || pi.getThinkingLevel() !== original) return;
        const decision = dynamicThinkingDecision(model, original, result);
        if (!decision) return;
        const sessionId = ctx.sessionManager.getSessionId();
        expectedLevel = decision.level;
        if (options.selectionScope) options.selectionScope.run(false, () => pi.setThinkingLevel(decision.level));
        else pi.setThinkingLevel(decision.level);
        lastAutomaticLevel = decision.level;
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
