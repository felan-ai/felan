import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import type { AgentSession } from '@earendil-works/pi-coding-agent';
import { Markdown, MouseRegion, stripTerminalSequences, type TuiMouseEvent } from '@earendil-works/pi-tui';
import { TranscriptAssistant } from '../src/subagents/transcript-components.js';
import { clientMarkdownTheme, FELAN_THEME_PATHS, parseClientTheme } from '../src/tui/theme.js';
import type { MermaidMode } from '../src/tui/markdown.js';

type AssistantMessage = Extract<AgentSession['messages'][number], { role: 'assistant' }>;
const theme = parseClientTheme(readFileSync(FELAN_THEME_PATHS[1]!, 'utf8'));
const markdown = clientMarkdownTheme(() => theme);
const text = (value: string): AssistantMessage['content'][number] => ({ type: 'text', text: value });
const thinking = (value: string): AssistantMessage['content'][number] => ({ type: 'thinking', thinking: value });
const tool: AssistantMessage['content'][number] = { type: 'toolCall', id: 'call', name: 'read', arguments: {} };
const longThinking = Array.from({ length: 80 }, (_, index) => `- Step ${index}: **inspect** the input and compare [31mresults[0m.`).join('\n');

function message(content: AssistantMessage['content'], options: Partial<AssistantMessage> = {}): AssistantMessage {
  return { role: 'assistant', api: 'openai-completions', provider: 'offline', model: 'fixture', timestamp: 1,
    content, stopReason: 'stop', usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, ...options };
}

function create(value: AssistantMessage, hidden = false, streaming = true, mode: MermaidMode = 'streaming'): TranscriptAssistant {
  return new TranscriptAssistant(value, hidden, markdown, 1, () => theme, mode, streaming);
}

function expectFresh(component: TranscriptAssistant, value: AssistantMessage, hidden = false, streaming = true, mode: MermaidMode = 'streaming'): void {
  const fresh = create(value, hidden, streaming, mode);
  for (const width of [18, 48, 100]) expect(component.render(width)).toEqual(fresh.render(width));
}

function click(component: TranscriptAssistant, label: string): void {
  const lines = component.render(48).map(stripTerminalSequences); const y = lines.findIndex(line => line.includes(label));
  expect(y).toBeGreaterThanOrEqual(0);
  const event: TuiMouseEvent = { type: 'click', button: 'left', x: 1, y, screenX: 1, screenY: y,
    width: 48, height: lines.length, shift: false, alt: false, ctrl: false };
  expect(component.handleMouse(event)).toMatchObject({ handled: true });
}

it('retains long thinking and unchanged trimmed text while streaming text grows', () => {
  let value = message([thinking(longThinking), text('First')]); const component = create(value);
  expectFresh(component, value);
  const region = component.children.find(child => child instanceof MouseRegion)!;
  const originalText = component.children.find(child => child instanceof Markdown)!;
  value = message([thinking(longThinking), text('  First\n')]); component.updateContent(value);
  expect(component.children).toContain(originalText); expectFresh(component, value);
  for (const answer of ['First answer', 'First answer\n\n## More details\n\nA longer paragraph with `code` and **emphasis**.']) {
    value = message([thinking(longThinking), text(answer)]); component.updateContent(value);
    expect(component.children).toContain(region); expect(component.children).not.toContain(originalText);
    expectFresh(component, value);
  }
  const finalText = component.children.find(child => child instanceof Markdown)!;
  component.updateContent(value, false);
  expect(component.children).toContain(region); expect(component.children).not.toContain(finalText);
  expectFresh(component, value, false, false);
});

it('replaces a growing joined thinking run without replacing unchanged text', () => {
  let value = message([thinking('First thought'), thinking(''), text('Stable answer')]); const component = create(value);
  const originalRegion = component.children.find(child => child instanceof MouseRegion)!;
  const originalText = component.children.find(child => child instanceof Markdown)!;
  value = message([thinking('First thought'), thinking(' \n'), thinking('Second thought\n\n- detail'), text('Stable answer')]);
  component.updateContent(value);
  expect(component.children).not.toContain(originalRegion); expect(component.children).toContain(originalText);
  expectFresh(component, value);
  const joinedRegion = component.children.find(child => child instanceof MouseRegion)!;
  value = message([thinking('First thought\n\nSecond thought\n\n- detail'), text('Stable answer')]); component.updateContent(value);
  expect(component.children).toContain(joinedRegion); expectFresh(component, value);
});

it('retains independent components across multiple text and thinking runs and discards removed parts', () => {
  const initial = [text('Before'), thinking('Run one'), thinking('continued'), tool, text('Between'), thinking('Run two'), text('After')];
  let value = message(initial); const component = create(value); expectFresh(component, value);
  const regions = component.children.filter(child => child instanceof MouseRegion);
  const texts = component.children.filter(child => child instanceof Markdown);
  value = message([...initial.slice(0, -1), text('After with more text'), thinking('Run three'), text('Final')]); component.updateContent(value);
  expectFresh(component, value);
  for (const region of regions) expect(component.children).toContain(region);
  expect(component.children).toContain(texts[0]); expect(component.children).toContain(texts[1]);
  expect(component.children).not.toContain(texts[2]);
  value = message([text(''), thinking(' \n'), tool]); component.updateContent(value); expectFresh(component, value);
  expect(component.children).toHaveLength(0);
  value = message(initial); component.updateContent(value); expectFresh(component, value);
  for (const region of regions) expect(component.children).not.toContain(region);
});

it.each<MermaidMode>(['off', 'final', 'streaming'])('recreates text transforms but retains thinking on finalization in %s mode', mode => {
  const value = message([thinking('## Plan\n\nInspect the graph.'), text('```mermaid\ngraph TD\n  A --> B\n```')]);
  const component = create(value, false, true, mode); expectFresh(component, value, false, true, mode);
  const region = component.children.find(child => child instanceof MouseRegion)!;
  const originalText = component.children.find(child => child instanceof Markdown)!;
  component.updateContent(value, false);
  expect(component.children).toContain(region); expect(component.children).not.toContain(originalText);
  expectFresh(component, value, false, false, mode);
  const finalText = component.children.find(child => child instanceof Markdown)!;
  component.updateContent(structuredClone(value));
  expect(component.children).toContain(finalText); expectFresh(component, value, false, false, mode);
});

it.each([
  { stopReason: 'aborted', error: 'Interrupted', hasTools: false },
  { stopReason: 'error', error: 'Error: failed', hasTools: false, errorMessage: '\u001b[31mfailed\u001b[0m' },
  { stopReason: 'error', error: 'Error: Unknown error', hasTools: false },
  { stopReason: 'length', error: 'Response was truncated before completion.', hasTools: false },
  { stopReason: 'aborted', error: undefined, hasTools: true },
  { stopReason: 'error', error: undefined, hasTools: true },
  { stopReason: 'length', error: 'Response was truncated before completion.', hasTools: true },
] as const)('preserves $stopReason output with tools=$hasTools and error=$error', ({ stopReason, error, hasTools, ...options }) => {
  let value = message([thinking('Plan'), text('Answer'), ...(hasTools ? [tool] : [])]); const component = create(value);
  const region = component.children.find(child => child instanceof MouseRegion)!;
  value = { ...value, stopReason, ...options }; component.updateContent(value, false);
  expect(component.children).toContain(region); expectFresh(component, value, false, false);
  const rendered = stripTerminalSequences(component.render(80).join('\n'));
  if (error) expect(rendered).toContain(error);
  else expect(rendered).not.toMatch(/Interrupted|Error:|truncated/u);
  value = { ...value, stopReason: 'stop' }; component.updateContent(value);
  expectFresh(component, value, false, false); expect(component.render(80).join('\n')).not.toContain(error ?? 'Error:');
});

it('applies global thinking visibility changes while retaining text and streaming behavior', () => {
  const value = message([thinking('Run one'), text('Between'), thinking('Run two'), text('After')]); const component = create(value);
  const texts = component.children.filter(child => child instanceof Markdown);
  for (const hidden of [true, true, false, true, false]) {
    component.setHideThinkingBlock(hidden); expectFresh(component, value, hidden);
    for (const child of texts) expect(component.children).toContain(child);
    const rendered = component.render(80).join('\n');
    expect(rendered.includes('Run one')).toBe(!hidden); expect(rendered.includes('Run two')).toBe(!hidden);
  }
});

it('keeps click toggles attached to the correct current thinking run after reuse and finalization', () => {
  let value = message([thinking('Run one'), text('Between'), thinking('Run two'), text('After')]); const component = create(value);
  const regions = component.children.filter(child => child instanceof MouseRegion);
  value = message([thinking('Run one'), text('Between with more text'), thinking('Run two'), text('After streaming')]);
  component.updateContent(value); component.updateContent(value, false);
  expect(component.children.filter(child => child instanceof MouseRegion)).toEqual(regions);
  click(component, 'Run two');
  const fresh = create(value, false, false); click(fresh, 'Run two');
  for (const width of [18, 48, 100]) expect(component.render(width)).toEqual(fresh.render(width));
  const hiddenRegion = component.children.filter(child => child instanceof MouseRegion)[1];
  component.updateContent(structuredClone(value));
  expect(component.children.filter(child => child instanceof MouseRegion)[1]).toBe(hiddenRegion);
  click(component, 'Thinking...'); expectFresh(component, value, false, false);
  click(component, 'Run one'); component.setHideThinkingBlock(false); expectFresh(component, value, false, false);
});

it.each([false, true])('invalidates themed text, thinking and errors with thinking hidden=%s', hidden => {
  let currentTheme = theme; const currentMarkdown = clientMarkdownTheme(() => currentTheme);
  const value = message([thinking('Thought'), text('# Answer\n\n`code`')], { stopReason: 'error', errorMessage: 'Failed' });
  const build = () => new TranscriptAssistant(value, hidden, currentMarkdown, 1, () => currentTheme, 'streaming', false);
  const component = build(); const previous = component.render(80); const children = [...component.children];
  const data = JSON.parse(readFileSync(FELAN_THEME_PATHS[1]!, 'utf8'));
  data.name = 'changed'; for (const key of Object.keys(data.colors)) data.colors[key] = '#abcdef';
  currentTheme = parseClientTheme(JSON.stringify(data)); component.invalidate();
  const fresh = build();
  for (const width of [18, 48, 100]) expect(component.render(width)).toEqual(fresh.render(width));
  expect(component.render(80)).not.toEqual(previous);
  for (const child of children) expect(component.children).not.toContain(child);
});

it('refreshes captured theme transforms and hidden labels when the theme changes during an update', () => {
  let currentTheme = theme; const currentMarkdown = clientMarkdownTheme(() => currentTheme);
  const value = message([thinking('Thought'), text('# Answer')]);
  const build = () => new TranscriptAssistant(value, true, currentMarkdown, 1, () => currentTheme);
  const component = build(); const previous = component.render(80);
  currentTheme = parseClientTheme(readFileSync(FELAN_THEME_PATHS[0]!, 'utf8')); component.updateContent(value);
  expect(component.render(80)).toEqual(build().render(80)); expect(component.render(80)).not.toEqual(previous);
});
