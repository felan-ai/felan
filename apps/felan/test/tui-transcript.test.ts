import { expect, it, vi } from 'vitest';
import { initTheme } from '@earendil-works/pi-coding-agent';
import { Text, stripTerminalSequences, type TUI } from '@earendil-works/pi-tui';
import { readFileSync } from 'node:fs';
import type { AgentViewTranscript } from '../src/subagents/types.js';
import { AgentTranscript, type AgentToolPresentation } from '../src/subagents/agent-transcript.js';
import { createClientKeybindings } from '../src/tui/keybindings.js';
import { projectTuiTranscript } from '../src/tui/transcript.js';
import { snapshot } from './client-fixtures.js';
import { FELAN_THEME_PATHS, parseClientTheme } from '../src/tui/theme.js';
import { TranscriptTool } from '../src/subagents/transcript-components.js';
import { SubagentCompletionComponent } from '../src/subagents/completion-presentation.js';
import { BackgroundBashCompletionComponent } from '../src/tui/renderers/processes/completion-message.js';

const settings = { hideThinking: false, showImages: false, imageWidthCells: 60, outputPad: 1, toolMode: 'grouped' as const };
it('renders unavailable assistant metadata honestly and retains readable content', () => {
  const state = snapshot();
  const result = projectTuiTranscript(state, [{ id: 'message', entryId: 'entry', role: 'assistant', timestamp: 1,
    content: [{ type: 'text', text: 'actual text' }] }], settings);
  expect(result.messages).toEqual([]); expect(result.fallbacks?.[0]?.text).toContain('actual text');
  expect(JSON.stringify(result)).not.toContain('unknown-model');
});

function customTheme(name: string, color: string) {
  const data = JSON.parse(readFileSync(FELAN_THEME_PATHS[1]!, 'utf8'));
  data.name = name;
  for (const key of Object.keys(data.colors)) data.colors[key] = color;
  return parseClientTheme(JSON.stringify(data));
}

it('injects client palettes into messages, thinking and compaction independently of Pi global themes', () => {
  let theme = customTheme('first', '#123456');
  const transcript = new AgentTranscript({ requestRender: vi.fn() } as unknown as TUI, createClientKeybindings(), undefined, () => theme);
  const messages: AgentViewTranscript['messages'] = [
    { role: 'user', content: 'custom user', timestamp: 1 },
    { role: 'assistant', api: 'openai-completions', provider: 'offline', model: 'fixture', timestamp: 2,
      content: [{ type: 'thinking', thinking: 'custom thought' }, { type: 'text', text: '# custom answer' }], stopReason: 'stop',
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } },
    { role: 'compactionSummary', summary: 'custom summary', tokensBefore: 100, timestamp: 3 },
  ];
  try {
    transcript.showProjection({ agentId: 'root', cwd: '/fixture', pendingTools: [], settings, messages });
    initTheme('light', false);
    const first = transcript.render(80).join('\n');
    expect(first).toContain(theme.getFgAnsi('userMessageText')); expect(first).toContain(theme.getBgAnsi('customMessageBg'));
    expect(stripTerminalSequences(first)).toContain('custom answer');
    transcript.handleInput('\x0f'); expect(stripTerminalSequences(transcript.render(80).join('\n'))).toContain('custom summary');
    theme = customTheme('second', '#abcdef'); transcript.invalidate();
    expect(transcript.render(80).join('\n')).toContain(theme.getFgAnsi('mdHeading'));
  } finally { transcript.dispose(); }
});

it.each(['', '\n\nUse the skill on this input.'])('renders a skill invocation separately from trailing user text %j', suffix => {
  let theme = customTheme('skill', '#123456');
  const transcript = new AgentTranscript({ requestRender: vi.fn() } as unknown as TUI, createClientKeybindings(), undefined, () => theme);
  const content = '<skill name="example" location="/fixture/example/SKILL.md">\nReferences are relative to /fixture/example.\n\nSkill body details.\n</skill>';
  try {
    transcript.showProjection({ agentId: 'root', cwd: '/fixture', pendingTools: [], settings, messages: [
      { role: 'user', content: content + suffix, timestamp: 1 },
    ] });
    initTheme('light', false);
    const collapsed = transcript.render(80).join('\n');
    const text = stripTerminalSequences(collapsed);
    expect(text).toContain('[skill] example'); expect(text).toContain('to expand');
    expect(text).not.toContain('Skill body details.'); expect(text).not.toContain('<skill');
    expect(collapsed).toContain(theme.getBgAnsi('customMessageBg'));
    expect(collapsed).toContain(theme.getFgAnsi('customMessageLabel'));
    expect(collapsed).toContain(theme.getFgAnsi('customMessageText'));
    if (suffix) {
      expect(text).toContain('Use the skill on this input.');
      expect(collapsed).toContain(theme.getBgAnsi('userMessageBg'));
    }
    expect(transcript.handleInput('\x0f')).toBe(true);
    const expanded = stripTerminalSequences(transcript.render(80).join('\n'));
    expect(expanded).toContain('Skill body details.');
    expect(expanded).toContain('References are relative to /fixture/example.');
    if (suffix) expect(expanded).toContain('Use the skill on this input.');
    theme = customTheme('updated skill', '#abcdef'); transcript.invalidate();
    expect(transcript.render(80).join('\n')).toContain(theme.getBgAnsi('customMessageBg'));
    transcript.handleInput('\x0f');
    expect(stripTerminalSequences(transcript.render(80).join('\n'))).not.toContain('Skill body details.');
  } finally { transcript.dispose(); }
});

it('retains plain user message styling and literal formatting', () => {
  const theme = customTheme('plain user', '#123456');
  const transcript = new AgentTranscript({ requestRender: vi.fn() } as unknown as TUI, createClientKeybindings(), undefined, () => theme);
  try {
    transcript.showProjection({ agentId: 'root', cwd: '/fixture', pendingTools: [], settings, messages: [
      { role: 'user', content: '3. Plain user input with \\backslashes', timestamp: 1 },
    ] });
    const rendered = transcript.render(80).join('\n');
    expect(stripTerminalSequences(rendered)).toContain('3. Plain user input with \\backslashes');
    expect(rendered).toContain(theme.getFgAnsi('userMessageText'));
    expect(rendered).toContain(theme.getBgAnsi('userMessageBg'));
    expect(stripTerminalSequences(rendered)).not.toContain('[skill]');
    transcript.handleInput('\x0f'); expect(transcript.render(80).join('\n')).toBe(rendered);
  } finally { transcript.dispose(); }
});

it('preserves renderer state, partial results, self shells and expansion while supplying the client palette', () => {
  const theme = customTheme('tools', '#123456'); const tui = { requestRender: vi.fn() } as unknown as TUI;
  const call = vi.fn<NonNullable<AgentToolPresentation['renderCall']>>((_args, palette, context) => {
    context.state.visits = (context.state.visits ?? 0) + 1;
    return context.lastComponent ?? new Text(palette.fg('toolTitle', 'custom call'), 0, 0);
  });
  const result = vi.fn<NonNullable<AgentToolPresentation['renderResult']>>((_result, options, palette, context) => new Text(palette.fg('toolOutput', `${options.isPartial ? 'partial' : 'final'} ${context.expanded ? 'expanded' : 'collapsed'}`), 0, 0));
  const component = new TranscriptTool('custom', 'call', { path: 'x' }, { showImages: false, imageWidthCells: 60, outputPad: 2 },
    { renderShell: 'self', renderCall: call, renderResult: result }, tui, '/fixture', () => theme, () => 'Ctrl+O');
  try {
    component.markExecutionStarted(); component.setArgsComplete(); component.updateResult({ content: [{ type: 'text', text: 'stream' }], isError: false }, true);
    expect(component.render(80).join('\n')).toContain(theme.getFgAnsi('toolTitle'));
    component.updateResult({ content: [{ type: 'text', text: 'done' }], isError: false }); component.setExpanded(true);
    expect(stripTerminalSequences(component.render(80).join('\n'))).toContain('final expanded');
    expect(call.mock.lastCall?.[1]).toBe(theme); expect(call.mock.lastCall?.[2]).toMatchObject({ cwd: '/fixture', executionStarted: true, argsComplete: true });
    expect(call.mock.lastCall?.[2].state.visits).toBeGreaterThan(1);
  } finally { component.dispose(); }
});

it('keeps complete tool output recoverable after a custom renderer throws', () => {
  const theme = customTheme('fallback', '#123456');
  const component = new TranscriptTool('broken', 'call', {}, { showImages: false, imageWidthCells: 60, outputPad: 1 },
    { renderCall: () => { throw new Error('broken renderer'); }, renderResult: () => { throw new Error('broken renderer'); } },
    { requestRender: vi.fn() } as unknown as TUI, '/fixture', () => theme, () => 'Ctrl+O');
  try {
    component.updateResult({ content: [{ type: 'text', text: Array.from({ length: 12 }, (_, index) => `line-${index}`).join('\n') }], isError: true });
    expect(stripTerminalSequences(component.render(80).join('\n'))).toContain('more lines');
    component.setExpanded(true); expect(stripTerminalSequences(component.render(80).join('\n'))).toContain('line-11');
    expect(component.render(80).join('\n')).toContain(theme.getBgAnsi('toolErrorBg'));
  } finally { component.dispose(); }
});

it('does not discard other messages when one display payload is invalid', () => {
  const state = snapshot();
  const result = projectTuiTranscript(state, [{ id: 'message', entryId: 'entry', role: 'assistant', timestamp: 1,
    content: [{ type: 'text', text: 'retained' }], details: { felanMessage: { invalid: true } } },
  { id: 'user', entryId: 'user-entry', role: 'user', timestamp: 2, content: [{ type: 'text', text: 'next input' }] }], settings);
  expect(result.fallbacks?.[0]?.text).toContain('retained'); expect(result.messages.some(message => message.role === 'user')).toBe(true);
});

it('applies changed thinking and output padding preferences without resetting local toggles on unchanged refreshes', () => {
  initTheme('dark', false);
  const transcript = new AgentTranscript({ requestRender: vi.fn() } as unknown as TUI, createClientKeybindings());
  const data: AgentViewTranscript = { agentId: 'root', cwd: '/fixture', pendingTools: [], settings: { ...settings }, messages: [
    { role: 'user', content: 'user padding', timestamp: 1 },
    { role: 'assistant', api: 'openai-completions', provider: 'offline', model: 'fixture', timestamp: 2,
      content: [{ type: 'thinking', thinking: 'private thought' }, { type: 'text', text: 'assistant padding' }], stopReason: 'stop',
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } },
  ] };
  try {
    transcript.showProjection(data);
    expect(transcript.render(80).join('\n')).toContain('private thought');
    transcript.handleInput('\x14'); transcript.showProjection(structuredClone(data));
    expect(transcript.render(80).join('\n')).not.toContain('private thought');
    transcript.showProjection({ ...data, settings: { ...data.settings, hideThinking: true } });
    transcript.showProjection({ ...data, settings: { ...data.settings, outputPad: 4 } });
    const lines = transcript.render(80).map(stripTerminalSequences);
    expect(lines.join('\n')).toContain('private thought');
    expect(lines.find(line => line.includes('assistant padding'))).toMatch(/^ assistant padding/u);
    expect(lines.find(line => line.includes('user padding'))).toMatch(/^ user padding/u);
    transcript.showProjection({ ...data, settings: { ...data.settings, outputPad: 0 } });
    expect(transcript.render(80).map(stripTerminalSequences).find(line => line.includes('assistant padding'))).toMatch(/^assistant padding/u);
  } finally { transcript.dispose(); }
});

it.each(['felan-execution-completion', 'felan-background-bash-completion'] as const)('caches %s rendering until width, expansion or theme invalidation changes', customType => {
  const render = customType === 'felan-execution-completion'
    ? vi.spyOn(SubagentCompletionComponent.prototype, 'render') : vi.spyOn(BackgroundBashCompletionComponent.prototype, 'render');
  const transcript = new AgentTranscript({ requestRender: vi.fn() } as unknown as TUI, createClientKeybindings());
  try {
    transcript.showProjection({ agentId: 'root', cwd: '/fixture', pendingTools: [], settings, messages: [{
      role: 'custom', timestamp: 1, customType, display: true, content: 'Fallback details', details: customType === 'felan-execution-completion'
        ? { notice: { deliveryId: 'delivery', parentSessionId: 'parent', executionId: 'child', label: 'explore', status: 'completed', summary: 'Verified' } }
        : { job: { id: 'job', command: 'sleep 1', status: 'completed', exitCode: 0 } },
    }] });
    const first = transcript.render(80); expect(transcript.render(80)).toEqual(first); expect(render).toHaveBeenCalledTimes(1);
    transcript.render(60); transcript.render(60); expect(render).toHaveBeenCalledTimes(2);
    transcript.handleInput('\x0f'); transcript.render(60); transcript.render(60); expect(render).toHaveBeenCalledTimes(3);
    transcript.invalidate(); transcript.render(60); transcript.render(60); expect(render).toHaveBeenCalledTimes(4);
  } finally { transcript.dispose(); render.mockRestore(); }
});

it('caches note rendering until width or theme invalidation changes', () => {
  const render = vi.spyOn(Text.prototype, 'render');
  const transcript = new AgentTranscript({ requestRender: vi.fn() } as unknown as TUI, createClientKeybindings());
  try {
    transcript.showProjection({ agentId: 'root', cwd: '/fixture', pendingTools: [], settings, messages: [], notes: [{ before: 0, text: 'Cached note', level: 'info' }] });
    transcript.render(80); transcript.render(80); expect(render).toHaveBeenCalledTimes(1);
    transcript.render(60); transcript.render(60); expect(render).toHaveBeenCalledTimes(2);
    transcript.invalidate(); transcript.render(60); transcript.render(60); expect(render).toHaveBeenCalledTimes(3);
  } finally { transcript.dispose(); render.mockRestore(); }
});
