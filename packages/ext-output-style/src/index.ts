import { associateExtensionConfig, configField, defineExtensionConfig, type FelanExtension, type FelanExtensionAPI } from '@felan-ai/agent-core';

export const OUTPUT_STYLES = ['concise', 'explanatory', 'caveman'] as const;
export type OutputStyle = typeof OUTPUT_STYLES[number];

export const DEFAULT_OUTPUT_STYLE: OutputStyle = 'concise';
export const OUTPUT_STYLE_CONFIG = defineExtensionConfig({
  id: 'outputStyle',
  title: 'Output style',
  fields: {
    style: configField.enum(OUTPUT_STYLES, {
      default: DEFAULT_OUTPUT_STYLE,
      description: 'Response detail and explanation style',
      cliName: 'output-style',
    }),
  },
});

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
  caveman: [
    'Use the fewest words that preserve correctness. Prefer short fragments, compact bullets, and standard abbreviations.',
    'Omit greetings, restatements, transitions, and filler.',
    'Expand enough to be clear for errors, security warnings, destructive actions, blockers, and complex plans.',
    'Keep code, commands, paths, identifiers, numbers, and error messages exact.',
    'Never omit required caveats, verification results, or blockers for brevity.',
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

const outputStyleExtension: FelanExtension = ((pi: FelanExtensionAPI) => createOutputStyleExtension(
  pi.config?.style ?? DEFAULT_OUTPUT_STYLE,
)(pi));
associateExtensionConfig(outputStyleExtension, OUTPUT_STYLE_CONFIG);

export default outputStyleExtension;
