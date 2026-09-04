import type {
  AssistantMessage,
  SavingsMeasurement,
  SavingsModelReference,
  SavingsReporter,
} from '@felan-ai/agent-core';

const TERRA_V2_DISABLED_VISIBLE_CHARACTERS = 3_271;
const TERRA_V2_CONCISE_VISIBLE_CHARACTERS = 2_686;

export const CONCISE_SAVINGS_METHOD = 'concise-visible-text-ratio-terra-v2-20260827-v1';

export function reportConciseSavings(
  reporter: SavingsReporter | undefined,
  model: SavingsModelReference | undefined,
  message: AssistantMessage,
): void {
  if (!reporter || !model || message.stopReason === 'error' || message.stopReason === 'aborted') return;
  const actualOutput = estimateVisibleTextTokens(message.content);
  if (actualOutput === 0) return;
  const baselineOutput = Math.ceil(
    actualOutput * TERRA_V2_DISABLED_VISIBLE_CHARACTERS / TERRA_V2_CONCISE_VISIBLE_CHARACTERS,
  );
  const measurement: SavingsMeasurement = {
    category: 'output-optimization',
    operation: 'concise-response',
    baseline: { model, tokens: { input: 0, output: baselineOutput } },
    actual: { model, tokens: { input: 0, output: actualOutput } },
    basis: { kind: 'estimated-baseline', method: CONCISE_SAVINGS_METHOD },
    dimensions: { techniques: ['concise'] },
  };
  try {
    void reporter.report(measurement).catch(() => {});
  } catch {}
}

function estimateVisibleTextTokens(content: AssistantMessage['content']): number {
  let bytes = 0;
  for (const block of content) {
    if (block.type !== 'text') continue;
    bytes += new TextEncoder().encode(block.text).byteLength;
  }
  return Math.ceil(bytes / 4);
}
