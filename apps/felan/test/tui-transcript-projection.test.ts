import { expect, it, vi } from 'vitest';
import { stripTerminalSequences, type TUI } from '@earendil-works/pi-tui';
import { MESSAGE_DISPLAY_ID, type Message, type Process } from '@felan-ai/session-protocol';
import { AgentTranscript } from '../src/subagents/agent-transcript.js';
import { projectTuiTranscript } from '../src/tui/transcript.js';
import { createClientKeybindings } from '../src/tui/keybindings.js';
import { defaultClientTheme } from '../src/tui/theme.js';
import { snapshot } from './client-fixtures.js';
import { createClientPowerlineFooter } from '../src/client/powerline-presenter.js';
import type { SessionClient } from '../src/client/client.js';
import { ShellExecution } from '../src/tui/shell-execution.js';
import { ToolActivityState } from '../src/tool-activity/state.js';

const settings = { hideThinking: false, showImages: false, imageWidthCells: 60, outputPad: 1, toolMode: 'grouped' as const };
const metadata = { kind: 'assistant' as const, timestamp: 1, api: 'fixture', provider: 'fixture', model: 'fixture', stopReason: 'stop' as const,
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };

it('bounds collapsed shell output by visual rows even when one output line wraps', () => {
  const shell = new ShellExecution({ role: 'bashExecution', command: 'printf', output: 'x'.repeat(1000), exitCode: 0,
    timestamp: 0, cancelled: false, truncated: false }, false, 1, defaultClientTheme);
  expect(shell.render(30).map(stripTerminalSequences).filter(line => line.trim().startsWith('xxx'))).toHaveLength(20);
  shell.setExpanded(true);
  expect(shell.render(30).map(stripTerminalSequences).filter(line => line.trim().startsWith('xxx')).length).toBeGreaterThan(20);
});

function fixture() {
  const theme = defaultClientTheme();
  vi.spyOn(theme, 'italic').mockImplementation(text => `\x1b[3m${text}\x1b[23m`);
  const transcript = new AgentTranscript({ requestRender: vi.fn() } as unknown as TUI, createClientKeybindings(), undefined, () => theme);
  const state = snapshot();
  return { theme, transcript, state,
    render(history: Message[] = []) {
      transcript.showProjection(projectTuiTranscript(state, history, settings));
      return transcript.render(160).join('\n');
    },
  };
}

it('updates streaming content without rebuilding retained transcript components', () => {
  const f = fixture();
  const rebuild = vi.spyOn(ToolActivityState.prototype, 'showSnapshot');
  const history: Message[] = Array.from({ length: 100 }, (_, index) => ({ id: `user-${index}`, entryId: `user-${index}`,
    role: 'user', timestamp: index, content: [{ type: 'text', text: `Retained message ${index}` }] }));
  f.state.presentation = [{ id: MESSAGE_DISPLAY_ID, kind: 'message_display', data: { message: 'live', display: metadata } }];
  try {
    for (const text of ['First', 'First second', 'First second third']) {
      f.state.activeStreams = [{ id: 'live:0', message: 'live', kind: 'assistant', offset: text.length, text }];
      expect(stripTerminalSequences(f.render(history))).toContain(text);
    }
    expect(rebuild).toHaveBeenCalledTimes(1);
    expect(stripTerminalSequences(f.render(history))).toContain('Retained message 99');
    expect(rebuild).toHaveBeenCalledTimes(1);
    f.render([...history, { id: 'another', entryId: 'another', role: 'user', timestamp: 101, content: [{ type: 'text', text: 'New input' }] }]);
    expect(rebuild).toHaveBeenCalledTimes(2);
  } finally { rebuild.mockRestore(); f.transcript.dispose(); }
});

it('places client notes after their anchor entry so they scroll with later messages', () => {
  const f = fixture();
  const user = (id: string): Message => ({ id, entryId: id, role: 'user', timestamp: 1, content: [{ type: 'text', text: `Message ${id}` }] });
  try {
    f.transcript.showProjection(projectTuiTranscript(f.state, [user('one'), user('two')], settings, [
      { text: 'Before history', level: 'warning' }, { after: 'one', text: 'Model: fixture', level: 'info' }, { after: 'gone', text: 'Other branch', level: 'error' },
    ]));
    const frame = f.transcript.render(160).join('\n'); const plain = stripTerminalSequences(frame);
    const order = ['Warning: Before history', 'Message one', 'Model: fixture', 'Message two'].map(text => plain.indexOf(text));
    expect(order.every((at, index) => at >= 0 && (index === 0 || at > order[index - 1]!))).toBe(true);
    expect(plain).not.toContain('Other branch'); expect(frame).toContain(f.theme.fg('dim', 'Model: fixture'));
  } finally { f.transcript.dispose(); }
});

it.each(['absent', 'invalid', 'valid'] as const)('keeps thinking typed from the first partial frame with %s metadata', mode => {
  const f = fixture();
  try {
    if (mode !== 'absent') f.state.presentation = [{ id: MESSAGE_DISPLAY_ID, kind: 'message_display',
      data: mode === 'valid' ? { message: 'live', display: metadata } : {} as never }];
    for (const thought of ['Rea', 'Reason carefully.']) {
      f.state.activeStreams = [{ id: 'live:0', message: 'live', kind: 'thinking', offset: thought.length, text: thought }];
      const frame = f.render();
      expect(stripTerminalSequences(frame)).toContain('Thinking');
      expect(stripTerminalSequences(frame)).toContain(thought);
      expect(frame).toContain(f.theme.getFgAnsi('thinkingText'));
      expect(frame).toContain('\x1b[3m');
    }
    f.state.activeStreams.unshift({ id: 'live:1', message: 'live', kind: 'assistant', offset: 6, text: 'Answer' });
    const frame = stripTerminalSequences(f.render());
    expect(frame.indexOf('Reason carefully.')).toBeLessThan(frame.indexOf('Answer'));
    const hidden = projectTuiTranscript(f.state, [], { ...settings, hideThinking: true });
    f.transcript.showProjection(hidden);
    expect(stripTerminalSequences(f.transcript.render(160).join('\n'))).toContain('Thinking...');
    expect(stripTerminalSequences(f.transcript.render(160).join('\n'))).not.toContain('Reason carefully.');
  } finally { f.transcript.dispose(); }
});

it('renders retained shell commands, output, exit failure and context borders, with expandable output', () => {
  const f = fixture();
  const shell = (excluded: boolean): Message => ({ id: 'shell', entryId: 'shell', role: 'custom', customType: 'bashExecution', timestamp: 1,
    content: [{ type: 'text', text: Array.from({ length: 24 }, (_, i) => `output-${i}`).join('\n') }],
    details: { command: 'echo hi', exitCode: 7, cancelled: false, truncated: false, excludeFromContext: excluded } });
  try {
    for (const excluded of [false, true]) {
      const frame = f.render([shell(excluded)]); const plain = stripTerminalSequences(frame);
      expect(plain).toContain('$ echo hi'); expect(plain).toContain('output-23'); expect(plain).toContain('(exit 7)');
      expect(plain).toContain('4 more lines'); expect(plain).not.toContain('output-0 ');
      expect(frame).toContain(f.theme.fg(excluded ? 'dim' : 'bashMode', '─'.repeat(160)));
    }
    f.transcript.handleInput('\x0f');
    expect(stripTerminalSequences(f.transcript.render(160).join('\n'))).toContain('output-0 ');
  } finally { f.transcript.dispose(); }
});

it('renders live shell output before final history, then replaces it without duplication', () => {
  const f = fixture();
  try {
    f.state.presentation = [{ id: 'foreground:request', kind: 'document', revision: 1, title: 'Shell execution', actions: [],
      hint: { id: 'shell.execution', version: '1.0.0' }, fallback: 'Running', markdown: '```\n$ echo live\nfirst chunk\n```',
      data: { commandLength: 'echo live'.length, excludeFromContext: true } }];
    const live = f.render();
    expect(stripTerminalSequences(live)).toContain('$ echo live'); expect(stripTerminalSequences(live)).toContain('first chunk');
    expect(stripTerminalSequences(live)).toContain('Running...'); expect(live).toContain(f.theme.fg('dim', '─'.repeat(160)));
    f.state.presentation = [];
    const final = stripTerminalSequences(f.render([{ id: 'done', entryId: 'done', role: 'custom', customType: 'bashExecution', timestamp: 1,
      content: [{ type: 'text', text: 'first chunk\nlast chunk' }], details: { command: 'echo live', exitCode: 0, cancelled: false, truncated: false, excludeFromContext: true } }]));
    expect(final.match(/\$ echo live/gu)).toHaveLength(1); expect(final).not.toContain('Running...'); expect(final).toContain('last chunk');
  } finally { f.transcript.dispose(); }
});

it.each(['felan-execution-completion', 'felan-background-bash-completion'])('renders %s as a compact success notice with reachable details', customType => {
  const f = fixture();
  const background = customType === 'felan-background-bash-completion';
  try {
    const frame = f.render([{ id: 'notice', entryId: 'notice', role: 'custom', customType, timestamp: 1,
      content: [{ type: 'text', text: 'raw fallback text' }], details: background
        ? { job: { id: 'job-abcdef', command: 'sleep 1', status: 'completed', exitCode: 0 } }
        : { notice: { deliveryId: 'delivery', parentSessionId: 'parent', executionId: 'child-12345678', label: 'explore', status: 'completed', summary: 'Verified result' } } }]);
    const lines = stripTerminalSequences(frame).split('\n').filter(line => line.trim());
    expect(lines).toHaveLength(1); expect(lines[0]).toContain(background ? 'Background process completed' : 'Subagent explore completed');
    expect(lines[0]).toContain(background ? '/processes details' : 'Alt+A details'); expect(frame).toContain(f.theme.fg('success', '✓'));
    expect(lines[0]).not.toContain('raw fallback');
    f.transcript.handleInput('\x0f');
    expect(stripTerminalSequences(f.transcript.render(160).join('\n'))).toContain(background ? 'exit 0' : 'Verified result');
  } finally { f.transcript.dispose(); }
});

it('derives the process footer from authoritative running background state and clears it on completion', () => {
  const state = snapshot();
  state.presentation = [{ id: 'powerline', kind: 'view', revision: 1, title: 'Powerline', hint: { id: 'felan.powerline', version: '3.0.0' },
    fields: [], actions: [], fallback: 'Powerline', items: [] }];
  const listeners = new Set<() => void>();
  const client = { getAttachment: () => ({ state: { status: 'live', snapshot: state } }), subscribe: (fn: () => void) => { listeners.add(fn); return () => listeners.delete(fn); } };
  const footer = createClientPowerlineFooter(client as unknown as SessionClient, 'session', { theme: defaultClientTheme, requestRender() {} });
  const process = (id: string, kind: Process['kind'], status: Process['state']): Process => ({ id, session: 'session', root: 'session', kind, state: status,
    command: 'sleep', startedAt: 0, controllable: true, outputOffset: 0 });
  const render = () => { for (const notify of listeners) notify(); return stripTerminalSequences(footer.render(160).join('\n')); };
  try {
    state.processes = [process('one', 'detached', 'running'), process('shell', 'foreground', 'running'), process('done', 'pty', 'exited')];
    expect(render()).toContain('● 1 process');
    state.processes.push(process('two', 'pty', 'running')); expect(render()).toContain('● 2 processes');
    state.processes = state.processes.map(item => ({ ...item, state: 'exited' })); expect(render()).not.toContain('●');
  } finally { footer.dispose(); }
});
