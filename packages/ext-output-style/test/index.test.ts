import { FELAN_BASE_SYSTEM_PROMPT, type FelanExtensionAPI } from '@felan-ai/agent-core';
import { describe, expect, it } from 'vitest';
import outputStyleExtension, {
  createOutputStyleExtension,
  DEFAULT_OUTPUT_STYLE,
  formatOutputStyleSection,
  parseOutputStyle,
} from '../src/index.js';

type BeforeAgentStartHandler = (
  event: { readonly systemPrompt: string },
) => { readonly systemPrompt: string } | undefined;

describe('@felan-ai/ext-output-style', () => {
  it('uses the concise style by default', () => {
    expect(DEFAULT_OUTPUT_STYLE).toBe('concise');
    const systemPrompt = applyExtension(outputStyleExtension, FELAN_BASE_SYSTEM_PROMPT);

    expect(systemPrompt).toBe(`${FELAN_BASE_SYSTEM_PROMPT}\n\n${formatOutputStyleSection('concise')}`);
    expect(systemPrompt).toContain('Keep responses concise and direct');
    expect(systemPrompt).toContain('<output_style>');
    expect(systemPrompt).toContain('</output_style>');
  });

  it('changes the system prompt for the selected style', () => {
    const concise = applyExtension(createOutputStyleExtension('concise'), FELAN_BASE_SYSTEM_PROMPT);
    const explanatory = applyExtension(createOutputStyleExtension('explanatory'), FELAN_BASE_SYSTEM_PROMPT);
    const caveman = applyExtension(createOutputStyleExtension('caveman'), FELAN_BASE_SYSTEM_PROMPT);

    expect(explanatory).not.toBe(concise);
    expect(explanatory).toContain('Explain the reasoning and important tradeoffs');
    expect(explanatory).not.toContain('Keep responses concise and direct');
    expect(explanatory).not.toContain('Be concise and direct');
    expect(caveman).not.toBe(concise);
    expect(caveman).not.toBe(explanatory);
    expect(caveman).toContain('Use the fewest words that preserve correctness');
    expect(caveman).toContain('Expand enough to be clear for errors');
    expect(caveman).toContain('Keep code, commands, paths, identifiers, numbers, and error messages exact');
    expect(caveman).not.toContain('Be concise and direct');
  });

  it('validates style values before registering the extension', () => {
    expect(parseOutputStyle()).toBe('concise');
    expect(parseOutputStyle('explanatory')).toBe('explanatory');
    expect(parseOutputStyle('caveman')).toBe('caveman');
    expect(() => parseOutputStyle('verbose')).toThrow(
      'outputStyle must be one of: concise, explanatory, caveman',
    );
    expect(() => createOutputStyleExtension({ style: 'concise' })).toThrow(
      'outputStyle must be one of: concise, explanatory, caveman',
    );
  });
});

function applyExtension(extension: ReturnType<typeof createOutputStyleExtension>, base: string): string {
  let handler: BeforeAgentStartHandler | undefined;
  extension({
    on: ((event: string, registered: BeforeAgentStartHandler) => {
      if (event === 'before_agent_start') handler = registered;
    }) as FelanExtensionAPI['on'],
  } as FelanExtensionAPI);

  const result = handler?.({ systemPrompt: base });
  return result?.systemPrompt ?? base;
}
