import { associateExtensionConfig, configField, defineExtensionConfig, type FelanExtension, type FelanExtensionAPI } from '@felan-ai/agent-core';

export const OUTPUT_STYLES = ['concise', 'explanatory', 'custom'] as const;
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
    instructions: configField.string({
      default: '',
      description: 'Custom system-prompt instructions used when output style is custom',
      cliName: 'output-style-instructions',
    }),
  },
});

const OUTPUT_STYLE_START = '<output_style>';
const OUTPUT_STYLE_END = '</output_style>';

const STYLE_INSTRUCTIONS: Readonly<Record<Exclude<OutputStyle, 'custom'>, readonly string[]>> = {
  concise: [
    'Use the fewest words that preserve correctness, clarity, and all required technical substance. Lead with the outcome or next action.',
    'Omit greetings, restatements, filler, decorative prose, emoji, redundant transitions, duplicate recaps, and filler closings.',
    'Prefer short sentences, compact bullets, and concise paragraphs. Fragments and standard, widely understood abbreviations are acceptable only when they remain clear and professional; do not invent abbreviations or mangle grammar merely to shorten.',
    'Use headings only when they improve scanability. State each fact once; do not provide both a normal answer and a terse duplicate.',
    'Keep technical terms, code, commands, paths, identifiers, API names, numbers, units, and exact error messages unchanged.',
    'Never omit or alter negation, conditions, scope, exceptions, caveats, verification results, or blockers merely to shorten the response.',
    'Quote the shortest decisive exact error lines and summarize the rest accurately unless the full log is requested.',
    'Expand into clear, complete prose whenever compression could cause ambiguity, especially for security warnings, destructive or irreversible actions, ordered procedures, errors, blockers, limitations, recovery instructions, complex plans, tradeoffs, or clarification requests.',
    'Do not narrate ordinary tool calls or announce the next tool call. Before a tool call, write only what is needed to resolve ambiguity, explain a safety concern, or confirm an irreversible action.',
    "Reply in the user's language. Do not translate code, commands, identifiers, API names, or exact error strings unless requested.",
    'For documentation, comments, commits, issues, pull requests, tickets, and other durable artifacts, use clear conventional prose and preserve requested formats.',
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

export function formatOutputStyleSection(style: OutputStyle, instructions?: unknown): string {
  const body = style === 'custom'
    ? parseCustomInstructions(instructions)
    : STYLE_INSTRUCTIONS[style].map((instruction) => `- ${instruction}`).join('\n');
  return [
    '## Output Style',
    '',
    OUTPUT_STYLE_START,
    body,
    OUTPUT_STYLE_END,
  ].join('\n');
}

export function createOutputStyleExtension(
  value: unknown = DEFAULT_OUTPUT_STYLE,
  instructions?: unknown,
): FelanExtension {
  const style = parseOutputStyle(value);
  const section = formatOutputStyleSection(style, instructions);

  return (pi) => {
    pi.on('before_agent_start', (event) => {
      return { systemPrompt: `${event.systemPrompt}\n\n${section}` };
    });
  };
}

const outputStyleExtension: FelanExtension = ((pi: FelanExtensionAPI) => createOutputStyleExtension(
  pi.config?.style ?? DEFAULT_OUTPUT_STYLE,
  pi.config?.instructions,
)(pi));
associateExtensionConfig(outputStyleExtension, OUTPUT_STYLE_CONFIG);

export default outputStyleExtension;

function parseCustomInstructions(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error('outputStyle.instructions must be a non-empty string when outputStyle is custom');
  }
  return value.trim();
}
