import type { FelanExtension } from '@felan-ai/agent-core';

export const OUTPUT_STYLES = ['concise', 'explanatory'] as const;
export type OutputStyle = typeof OUTPUT_STYLES[number];

export const DEFAULT_OUTPUT_STYLE: OutputStyle = 'concise';

const OUTPUT_STYLE_START = '<output_style>';
const OUTPUT_STYLE_END = '</output_style>';

const STYLE_INSTRUCTIONS: Readonly<Record<OutputStyle, readonly string[]>> = {
  concise: [
    'Keep responses concise and direct. Lead with the outcome or next action.',
    'Use headings and bullets only when they make the response easier to scan.',
    'Do not omit necessary caveats, verification results, or blockers for brevity.',
  ],
  explanatory: [
    'Explain the reasoning and important tradeoffs behind recommendations and changes.',
    'Provide enough context for the user to understand how the result works and how to verify it.',
    'Keep explanations relevant to the request and avoid repeating the same point.',
  ],
};

export function parseOutputStyle(value: unknown = DEFAULT_OUTPUT_STYLE): OutputStyle {
  if (typeof value === 'string' && OUTPUT_STYLES.includes(value as OutputStyle)) {
    return value as OutputStyle;
  }
  throw new Error(`outputStyle must be one of: ${OUTPUT_STYLES.join(', ')}`);
}

export function formatOutputStyleSection(style: OutputStyle): string {
  return [
    '## Output Style',
    '',
    OUTPUT_STYLE_START,
    ...STYLE_INSTRUCTIONS[style].map((instruction) => `- ${instruction}`),
    OUTPUT_STYLE_END,
  ].join('\n');
}

export function createOutputStyleExtension(value: unknown = DEFAULT_OUTPUT_STYLE): FelanExtension {
  const style = parseOutputStyle(value);
  const section = formatOutputStyleSection(style);

  return (pi) => {
    pi.on('before_agent_start', (event) => {
      return { systemPrompt: `${event.systemPrompt}\n\n${section}` };
    });
  };
}

const outputStyleExtension = createOutputStyleExtension();

export default outputStyleExtension;
