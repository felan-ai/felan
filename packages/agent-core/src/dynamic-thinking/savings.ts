import type { Api, AssistantMessage, Model } from '@earendil-works/pi-ai';
import type { SavingsReporter, SavingsTokenUsage } from '../savings.js';
import type { FelanThinkingLevel } from '../thinking.js';
import { supportsDynamicThinking } from './selection.js';

const HIGH_EFFORT_REASONING_UPLIFT_DENOMINATOR = 20;
const EFFORT_LEVELS: readonly FelanThinkingLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];

export const DYNAMIC_THINKING_SAVINGS_METHOD = 'high-effort-reasoning-5pct-heuristic-v2';

export function estimateHighEffortOutputTokens(
  model: Model<Api>,
  baseline: FelanThinkingLevel,
  selected: FelanThinkingLevel,
  usage: { readonly output: number; readonly reasoning?: number },
  supportsNativeThinkingUpdates?: (model: Model<Api>) => boolean,
): number | undefined {
  const baselineRank = EFFORT_LEVELS.indexOf(baseline);
  const selectedRank = EFFORT_LEVELS.indexOf(selected);
  if (!supportsDynamicThinking(model, supportsNativeThinkingUpdates)
    || baselineRank < EFFORT_LEVELS.indexOf('high') || selectedRank < 0 || selectedRank >= baselineRank) {
    return undefined;
  }
  const { output, reasoning } = usage;
  if (!Number.isSafeInteger(output) || output <= 0 || reasoning === undefined
    || !Number.isSafeInteger(reasoning) || reasoning <= 0 || reasoning > output) return undefined;
  const extra = Math.floor(reasoning / HIGH_EFFORT_REASONING_UPLIFT_DENOMINATOR);
  const estimated = output + extra;
  return extra > 0 && Number.isSafeInteger(estimated) ? estimated : undefined;
}

export async function reportDynamicThinkingSavings(
  reporter: SavingsReporter | undefined,
  model: Model<Api>,
  baseline: FelanThinkingLevel,
  selected: FelanThinkingLevel,
  message: AssistantMessage,
  classifierCostUsd?: number,
  supportsNativeThinkingUpdates?: (model: Model<Api>) => boolean,
): Promise<void> {
  if (!reporter || (message.stopReason !== 'stop' && message.stopReason !== 'toolUse')) return;
  const { usage } = message;
  const baselineOutput = estimateHighEffortOutputTokens(model, baseline, selected, usage, supportsNativeThinkingUpdates);
  if (baselineOutput === undefined || ![usage.input, usage.output, usage.cacheRead, usage.cacheWrite]
    .every((value) => Number.isSafeInteger(value) && value >= 0)
    || (usage.cacheWrite1h !== undefined && (!Number.isSafeInteger(usage.cacheWrite1h)
      || usage.cacheWrite1h < 0 || usage.cacheWrite1h > usage.cacheWrite))
    || !Number.isFinite(usage.cost.total) || usage.cost.total < 0
    || !Number.isFinite(usage.cost.output) || usage.cost.output <= 0
    || (classifierCostUsd !== undefined && (!Number.isFinite(classifierCostUsd) || classifierCostUsd < 0))) return;

  const extraCostUsd = (baselineOutput - usage.output) * usage.cost.output / usage.output;
  if (extraCostUsd <= (classifierCostUsd ?? 0)) return;
  const modelRef = { provider: model.provider, id: model.id };
  const tokens: SavingsTokenUsage = {
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    ...(usage.cacheWrite1h === undefined ? {} : { cacheWrite1h: usage.cacheWrite1h }),
  };
  try {
    await reporter.report({
      category: 'output-optimization',
      operation: 'dynamic-thinking',
      baseline: {
        model: modelRef, tokens: { ...tokens, output: baselineOutput },
        costUsd: usage.cost.total + extraCostUsd,
      },
      actual: {
        model: modelRef, tokens, costUsd: usage.cost.total + (classifierCostUsd ?? 0),
      },
      basis: { kind: 'estimated-baseline', method: DYNAMIC_THINKING_SAVINGS_METHOD },
    });
  } catch {}
}
