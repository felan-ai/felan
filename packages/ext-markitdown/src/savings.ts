import type {
  SavingsMeasurement,
  SavingsModelReference,
  SavingsReporter,
} from '@felan-ai/agent-core';

const MARKITDOWN_BASELINE_PROMPT_TOKENS = 21_569;
const MARKITDOWN_ACTUAL_PROMPT_TOKENS = 18_603;

export const MARKITDOWN_SAVINGS_METHOD = 'markitdown-prompt-token-ratio-202609-v1';

export function reportMarkitdownSavings(
  reporter: SavingsReporter | undefined,
  model: SavingsModelReference | undefined,
  tool: 'read',
  content: readonly unknown[],
): void {
  if (!reporter || !model) return;
  const actualInput = estimateTextTokens(content);
  if (actualInput === 0) return;
  const baselineInput = Math.ceil(actualInput * MARKITDOWN_BASELINE_PROMPT_TOKENS / MARKITDOWN_ACTUAL_PROMPT_TOKENS);
  const measurement: SavingsMeasurement = {
    category: 'output-optimization',
    operation: 'document-read',
    baseline: { model, tokens: { input: baselineInput, output: 0 } },
    actual: { model, tokens: { input: actualInput, output: 0 } },
    basis: { kind: 'estimated-baseline', method: MARKITDOWN_SAVINGS_METHOD },
    dimensions: { tool },
  };
  try {
    void reporter.report(measurement).catch(() => {});
  } catch {}
}

function estimateTextTokens(content: readonly unknown[]): number {
  let bytes = 0;
  for (const block of content) {
    if (!isRecord(block) || block.type !== 'text' || typeof block.text !== 'string') continue;
    bytes += new TextEncoder().encode(block.text).byteLength;
  }
  return Math.ceil(bytes / 4);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
