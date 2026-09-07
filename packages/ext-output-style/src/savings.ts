import type {
  AssistantMessage,
  SavingsMeasurement,
  SavingsModelReference,
  SavingsReporter,
} from '@felan-ai/agent-core';

const CONCISE_BASELINE_OUTPUT_TOKENS = 4_187;
const CONCISE_ACTUAL_OUTPUT_TOKENS = 3_500;

export const CONCISE_SAVINGS_METHOD = 'concise-output-token-ratio-202609-v1';

export function reportConciseSavings(
  reporter: SavingsReporter | undefined,
  model: SavingsModelReference | undefined,
  message: AssistantMessage,
): void {
  if (!reporter || !model || message.stopReason === 'error' || message.stopReason === 'aborted') return;
  const actualOutput = estimateVisibleTextTokens(message.content);
  if (actualOutput === 0) return;
  const baselineOutput = Math.ceil(actualOutput * CONCISE_BASELINE_OUTPUT_TOKENS / CONCISE_ACTUAL_OUTPUT_TOKENS);
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
