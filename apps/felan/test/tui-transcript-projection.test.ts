import { expect, it, vi } from 'vitest';
import { Markdown, Text, stripTerminalSequences, type TUI } from '@earendil-works/pi-tui';
import { MESSAGE_DISPLAY_ID, type Message, type Process } from '@felan-ai/session-protocol';
import { AgentTranscript, type AgentToolPresentation } from '../src/subagents/agent-transcript.js';
import { projectTuiTranscript } from '../src/tui/transcript.js';
import { createClientKeybindings } from '../src/tui/keybindings.js';
import { defaultClientTheme } from '../src/tui/theme.js';
import { snapshot } from './client-fixtures.js';
import { createClientPowerlineFooter } from '../src/client/powerline-presenter.js';
import type { SessionClient } from '../src/client/client.js';
import { ShellExecution } from '../src/tui/shell-execution.js';
import { ToolActivityState } from '../src/tool-activity/state.js';
import type { AgentViewTranscript } from '../src/subagents/types.js';
import { TranscriptAssistant } from '../src/subagents/transcript-components.js';

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
    expect(rebuild).toHaveBeenCalledTimes(1);
  } finally { rebuild.mockRestore(); f.transcript.dispose(); }
});

const nativeAssistant = (timestamp: number, content: Extract<AgentViewTranscript['messages'][number], { role: 'assistant' }>['content'],
  stopReason: 'stop' | 'toolUse' | 'aborted' | 'error' = 'stop'): Extract<AgentViewTranscript['messages'][number], { role: 'assistant' }> => ({
  ...metadata, api: 'openai-completions', role: 'assistant', timestamp, content, stopReason,
});

it.each(['grouped', 'full'] as const)('appends and replaces streaming tails in %s mode exactly like fresh projections', toolMode => {
  vi.useFakeTimers();
  const create = () => new AgentTranscript({ requestRender: vi.fn() } as unknown as TUI, createClientKeybindings(), undefined, defaultClientTheme);
  const incremental = create();
  const detach = vi.spyOn(incremental, 'detach');
  const update = vi.spyOn(TranscriptAssistant.prototype, 'updateContent');
  let projection: AgentViewTranscript = { agentId: 'root', cwd: '/fixture', pendingTools: [], settings: { ...settings, toolMode }, messages: [] };
  const check = (patch: Partial<AgentViewTranscript>, append: AgentViewTranscript['messages'] = []) => {
    projection = { ...projection, ...patch, messages: [...projection.messages, ...append] };
    incremental.showProjection(projection);
    const fresh = create();
    try {
      fresh.showProjection(projection);
      for (const width of [40, 90, 160]) expect(incremental.render(width)).toEqual(fresh.render(width));
    } finally { fresh.dispose(); }
  };
  const tool = (id: string, state: 'running' | 'completed' | 'failed', output: string) => ({ id, state, output, truncated: false });
  const call = (id: string) => ({ type: 'toolCall' as const, id, name: 'probe', arguments: { target: id } });
  const result = (id: string, isError: boolean): AgentViewTranscript['messages'][number] => ({ role: 'toolResult', toolCallId: id,
    toolName: 'probe', timestamp: 20, isError, content: [{ type: 'text', text: `${id} final` }] });
  try {
    check({}, [{ role: 'user', timestamp: 0, content: 'Initial prompt' }]);
    check({ streaming: nativeAssistant(1, []) });
    check({ streaming: nativeAssistant(1, [{ type: 'thinking', thinking: 'Reason' }]) });
    check({ streaming: nativeAssistant(1, [{ type: 'thinking', thinking: 'Reason carefully' }, { type: 'text', text: 'Checking' }]),
      pendingTools: ['one', 'two'], tools: [tool('one', 'running', ''), tool('two', 'running', '')] });
    const final = nativeAssistant(1, [{ type: 'text', text: 'Checking' }, call('one'), call('two')], 'toolUse');
    check({ streaming: undefined }, [final]);
    expect(update.mock.calls.some(([message, streaming]) => message === final && streaming === false)).toBe(true);
    check({ tools: [tool('one', 'running', 'partial one'), tool('two', 'running', 'partial two')] });
    check({ pendingTools: ['two'], tools: [tool('one', 'completed', 'one final'), tool('two', 'running', 'partial two')] }, [result('one', false)]);
    check({ pendingTools: [], tools: [tool('one', 'completed', 'one final'), tool('two', 'failed', 'two final')] }, [result('two', true)]);
    check({}, [nativeAssistant(2, [call('three')], 'toolUse')]);
    check({}, [nativeAssistant(3, [call('four')], 'toolUse')]);
    for (const reason of ['aborted', 'error'] as const) {
      const id = reason;
      check({ pendingTools: [id], tools: [...(projection.tools ?? []), tool(id, 'running', 'pending')] }, [nativeAssistant(reason === 'aborted' ? 4 : 5, [call(id)], reason)]);
    }
    check({ pendingTools: [], tools: [] }, [result('aborted', true), result('error', true), { role: 'user', timestamp: 6, content: 'Next prompt' }]);
    check({}, [{ role: 'custom', customType: 'felan-execution-completion', display: true, timestamp: 7, content: 'child fallback',
      details: { notice: { deliveryId: 'delivery', parentSessionId: 'parent', executionId: 'child', label: 'explore', status: 'completed', summary: 'Verified' } } }]);
    check({}, [{ role: 'custom', customType: 'felan-background-bash-completion', display: true, timestamp: 8, content: 'bash fallback',
      details: { job: { id: 'job', command: 'sleep 1', status: 'completed', exitCode: 0 } } }]);
    check({ streaming: nativeAssistant(9, [{ type: 'text', text: 'Abandoned draft' }]) });
    check({ streaming: undefined });
    check({ streaming: nativeAssistant(10, [{ type: 'text', text: 'Wrong key draft' }]) });
    check({ streaming: undefined }, [nativeAssistant(11, [{ type: 'text', text: 'Different final key' }])]);
    check({ streaming: nativeAssistant(12, [{ type: 'text', text: 'Displaced draft' }]) });
    check({ streaming: undefined }, [{ role: 'user', timestamp: 13, content: 'Interrupt draft' }]);
    expect(detach).toHaveBeenCalledTimes(1);
  } finally { update.mockRestore(); incremental.dispose(); vi.useRealTimers(); }
}, 30_000);

it.each((['grouped', 'full'] as const).flatMap(mode => (['note', 'compaction', 'settings', 'shell', 'fallback', 'streamingContent', 'streaming tools'] as const)
  .map(change => ({ mode, change }))))('handles $change changes in $mode mode and preserves fresh-render equivalence', ({ mode, change }) => {
  const create = () => new AgentTranscript({ requestRender: vi.fn() } as unknown as TUI, createClientKeybindings(), undefined, defaultClientTheme);
  const incremental = create(); const fresh = create(); const detach = vi.spyOn(incremental, 'detach');
  const shell: AgentViewTranscript['messages'][number] = { role: 'bashExecution', command: 'echo live', output: 'live', timestamp: 2, cancelled: false, truncated: false };
  let projection: AgentViewTranscript = { agentId: 'root', cwd: '/fixture', pendingTools: [], settings: { ...settings, toolMode: mode }, messages: [{ role: 'user', timestamp: 1, content: 'Before' }] };
  if (change === 'shell') projection = { ...projection, messages: [...projection.messages, shell], runningShells: [1] };
  if (change === 'streaming tools') projection = { ...projection, streaming: nativeAssistant(2, [{ type: 'toolCall', id: 'call', name: 'probe', arguments: {} }]) };
  try {
    incremental.showProjection(projection); incremental.render(80);
    if (change === 'note') projection = { ...projection, notes: [{ before: 1, text: 'Note', level: 'warning' }] };
    if (change === 'compaction') projection = { ...projection, messages: [...projection.messages, { role: 'compactionSummary', timestamp: 3, summary: 'Summary', tokensBefore: 100 }], compactions: [{ message: 1, method: 'Summary' }] };
    if (change === 'settings') projection = { ...projection, settings: { ...projection.settings, outputPad: 0 } };
    if (change === 'shell') projection = { ...projection, messages: [projection.messages[0]!, { role: 'user', timestamp: 3, content: 'During shell' }, shell], runningShells: [2] };
    if (change === 'fallback') projection = { ...projection, fallbacks: [{ before: 1, text: 'Unavailable metadata' }] };
    if (change === 'streamingContent') projection = { ...projection, streamingContent: [{ type: 'text', text: 'Untyped stream' }] };
    if (change === 'streaming tools') projection = { ...projection, streaming: undefined, messages: [...projection.messages, nativeAssistant(2, [{ type: 'toolCall', id: 'call', name: 'probe', arguments: {} }], 'toolUse')] };
    incremental.showProjection(projection); fresh.showProjection(projection);
    for (const width of [40, 90, 160]) expect(incremental.render(width)).toEqual(fresh.render(width));
    expect(detach).toHaveBeenCalledTimes(change === 'shell' || change === 'streamingContent' ? 1 : 2);
  } finally { incremental.dispose(); fresh.dispose(); }
});

it('finalizes the streaming component by display metadata key rather than the history entry timestamp', () => {
  const f = fixture(); const update = vi.spyOn(TranscriptAssistant.prototype, 'updateContent'); const detach = vi.spyOn(f.transcript, 'detach');
  try {
    f.state.presentation = [{ id: MESSAGE_DISPLAY_ID, kind: 'message_display', data: { message: 'live', display: metadata } }];
    f.state.activeStreams = [{ id: 'live:0', message: 'live', kind: 'assistant', offset: 5, text: 'Draft' }];
    f.render();
    const streamingComponent = update.mock.contexts.at(-1);
    f.state.presentation = []; f.state.activeStreams = [];
    expect(stripTerminalSequences(f.render([{ id: 'live', entryId: 'entry', role: 'assistant', timestamp: 999,
      content: [{ type: 'text', text: 'Final answer' }], details: { felanMessage: metadata } }]))).toContain('Final answer');
    const index = update.mock.calls.findIndex(([message, streaming]) => message.content.some(part => part.type === 'text' && part.text === 'Final answer') && streaming === false);
    expect(index).toBeGreaterThanOrEqual(0); expect(update.mock.contexts[index]).toBe(streamingComponent); expect(detach).toHaveBeenCalledTimes(1);
  } finally { update.mockRestore(); f.transcript.dispose(); }
});

it('updates running tool output without rebuilding retained transcript components', () => {
  const transcript = new AgentTranscript({ requestRender: vi.fn() } as unknown as TUI, createClientKeybindings(), undefined, defaultClientTheme);
  const rebuild = vi.spyOn(ToolActivityState.prototype, 'showSnapshot');
  const state = snapshot();
  const history: Message[] = [{ id: 'assistant', entryId: 'assistant', role: 'assistant', timestamp: 1,
    content: [{ type: 'tool_call', id: 'call-1', name: 'probe', arguments: { target: 'fixture' } }],
    details: { felanMessage: { ...metadata, stopReason: 'toolUse' } } }];
  const render = (output: string, toolState: 'running' | 'completed' = 'running') => {
    state.tools = [{ id: 'call-1', name: 'probe', message: 'assistant', state: toolState, output, truncated: false }];
    transcript.showProjection(projectTuiTranscript(state, history, { ...settings, toolMode: 'full' }));
    return stripTerminalSequences(transcript.render(160).join('\n'));
  };
  try {
    expect(render('first chunk')).toContain('first chunk');
    expect(render('first chunk, second chunk')).toContain('second chunk');
    expect(render('finished output', 'completed')).toContain('finished output');
    expect(rebuild).toHaveBeenCalledTimes(1);
  } finally { rebuild.mockRestore(); transcript.dispose(); }
});

it.each(['grouped', 'full'] as const)('renders %s tool progress applied step by step like a fresh transcript of each state', toolMode => {
  vi.useFakeTimers();
  const create = () => new AgentTranscript({ requestRender: vi.fn() } as unknown as TUI, createClientKeybindings(), undefined, defaultClientTheme);
  const incremental = create();
  const state = snapshot();
  const history: Message[] = [{ id: 'assistant', entryId: 'assistant', role: 'assistant', timestamp: 1,
    content: [{ type: 'tool_call', id: 'call-1', name: 'probe', arguments: { target: 'one' } }, { type: 'tool_call', id: 'call-2', name: 'probe', arguments: { target: 'two' } }],
    details: { felanMessage: { ...metadata, stopReason: 'toolUse' } } }];
  const tool = (id: string, toolState: 'running' | 'completed' | 'failed', output: string) => ({ id, name: 'probe', message: 'assistant', state: toolState, output, truncated: false });
  const steps = [
    [tool('call-1', 'running', ''), tool('call-2', 'running', '')],
    [tool('call-1', 'running', 'partial one'), tool('call-2', 'running', '')],
    [tool('call-1', 'completed', 'done one'), tool('call-2', 'running', 'partial two')],
    [tool('call-1', 'completed', 'done one'), tool('call-2', 'failed', 'two failed')],
  ];
  const project = () => projectTuiTranscript(state, history, { ...settings, toolMode });
  const text = (transcript: AgentTranscript) => stripTerminalSequences(transcript.render(120).join('\n'));
  const rendered = new Set<string>();
  try {
    for (const tools of steps) {
      state.tools = tools; incremental.showProjection(project());
      const expected = create(); expected.showProjection(project());
      expect(text(incremental)).toBe(text(expected)); expected.dispose();
      rendered.add(text(incremental));
    }
    expect(rendered.size).toBeGreaterThan(2);
  } finally { incremental.dispose(); vi.useRealTimers(); }
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
  const client = { readAttachment: () => ({ state: { status: 'live', snapshot: state } }), subscribe: (fn: () => void) => { listeners.add(fn); return () => listeners.delete(fn); } };
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

function projectionSequence(toolMode: 'grouped' | 'full', presentation?: (name: string) => AgentToolPresentation | undefined) {
  const create = () => new AgentTranscript({ requestRender: vi.fn() } as unknown as TUI, createClientKeybindings(), presentation, defaultClientTheme);
  const transcript = create(); const detach = vi.spyOn(transcript, 'detach');
  let projection: AgentViewTranscript = { agentId: 'root', cwd: '/fixture', settings: { ...settings, toolMode }, pendingTools: [], messages: [] };
  let rebuilds = 0;
  let thinkingHidden = false;
  return {
    transcript, detach,
    toggleThinking() { expect(transcript.handleInput('\x14')).toBe(true); thinkingHidden = !thinkingHidden; },
    check(patch: Partial<AgentViewTranscript> = {}, append: AgentViewTranscript['messages'] = [], rebuild = false) {
      projection = { ...projection, ...patch, messages: patch.messages ?? [...projection.messages, ...append] };
      if (!rebuilds || rebuild) rebuilds++;
      transcript.showProjection(projection);
      const fresh = create();
      try {
        if (thinkingHidden) {
          fresh.showProjection({ ...projection, messages: [], streaming: undefined, streamingContent: undefined });
          expect(fresh.handleInput('\x14')).toBe(true);
        }
        fresh.showProjection(projection);
        if (transcript.toolsExpanded) fresh.handleInput('\x0f');
        for (const width of [40, 90, 160]) expect(transcript.render(width)).toEqual(fresh.render(width));
        expect(detach).toHaveBeenCalledTimes(rebuilds);
      } finally { fresh.dispose(); }
      return projection;
    },
  };
}

const nativeCall = (id: string) => ({ type: 'toolCall' as const, id, name: 'probe', arguments: { target: id } });
const nativeResult = (id: string): AgentViewTranscript['messages'][number] => ({ role: 'toolResult', toolCallId: id, toolName: 'probe',
  timestamp: 20, isError: false, content: [{ type: 'text', text: `Preview for ${id}` }] });

it.each((['grouped', 'full'] as const).flatMap(mode => [false, true].flatMap(streaming => ['note', 'fallback'].map(annotation => ({ mode, streaming, annotation })))))
('keeps trailing $annotation before appended history in $mode mode with streaming=$streaming', ({ mode, streaming, annotation }) => {
  const f = projectionSequence(mode);
  try {
    const annotations = annotation === 'note' ? { notes: [{ before: 1, text: 'Anchored note', level: 'info' as const }] }
      : { fallbacks: [{ before: 1, text: 'Anchored fallback' }] };
    f.check({ ...annotations, ...(streaming ? { streaming: nativeAssistant(10, [{ type: 'text', text: 'Draft' }]) } : {}) },
      [{ role: 'user', timestamp: 1, content: 'Before annotation' }]);
    f.check({}, [{ role: 'user', timestamp: 2, content: 'After annotation' }]);
    f.check({ streaming: undefined }, [{ role: 'compactionSummary', timestamp: 3, summary: 'Retained compacted content', tokensBefore: 100 }]);
    f.transcript.invalidate(); f.check();
  } finally { f.transcript.dispose(); }
});

it.each(['grouped', 'full'] as const)('moves every replaceable tail in place in %s mode', mode => {
  const f = projectionSequence(mode);
  const shell: AgentViewTranscript['messages'][number] = { role: 'bashExecution', command: 'echo live', output: 'first', timestamp: 4, cancelled: false, truncated: false };
  try {
    let current = f.check({}, [nativeAssistant(0, [nativeCall('before')]), nativeResult('before')]);
    f.check({ streamingContent: [{ type: 'thinking', thinking: 'Reason' }, { type: 'text', text: 'Draft' }] });
    f.check({ streamingContent: [{ type: 'thinking', thinking: 'Reason carefully' }, { type: 'text', text: 'Draft grows' }] });
    const update = vi.spyOn(TranscriptAssistant.prototype, 'updateContent');
    try {
      f.check({ streamingContent: undefined, streaming: nativeAssistant(2, [{ type: 'text', text: 'Typed draft' }]) });
      const streamingComponent = update.mock.contexts[0];
      const final = nativeAssistant(2, [{ type: 'text', text: 'Final' }]);
      current = f.check({ streaming: undefined }, [{ role: 'user', timestamp: 1, content: 'Intervening input' }, final]);
      const at = update.mock.calls.findIndex(([message, streaming]) => message === final && streaming === false);
      expect(at).toBeGreaterThanOrEqual(0); expect(update.mock.contexts[at]).toBe(streamingComponent);
    } finally { update.mockRestore(); }
    const history = current.messages;
    f.transcript.handleInput('\x0f');
    f.check({ messages: [...history, shell, { ...shell, command: 'second shell', timestamp: 6 }], runningShells: [history.length, history.length + 1] });
    f.check({ messages: [...history, shell], runningShells: [history.length] });
    f.check({ messages: [...history, { ...shell, output: 'first\nsecond' }], streamingContent: [{ type: 'text', text: 'Concurrent stream' }] });
    const appended = nativeAssistant(3, [nativeCall('during')]);
    f.check({ messages: [...history, appended, nativeResult('during'), shell], runningShells: [history.length + 2] });
    f.check({ messages: [...history, appended, nativeResult('during'), { ...shell, output: 'finished', exitCode: 0 }], runningShells: [],
      streamingContent: undefined, streaming: nativeAssistant(5, [{ type: 'text', text: 'After shell' }]) });
    f.check({ streaming: undefined }, [nativeAssistant(5, [nativeCall('after')]), nativeResult('after')]);
    f.transcript.invalidate(); f.check();
  } finally { f.transcript.dispose(); }
});

it.each(['grouped', 'full'] as const)('refreshes expanded groups and newly exposed image anchors in %s mode', mode => {
  const f = projectionSequence(mode);
  try {
    f.check({}, [nativeAssistant(1, [nativeCall('one'), nativeCall('two'), nativeCall('three')]), nativeResult('one'), nativeResult('three')]);
    expect(f.transcript.handleInput('\x0f')).toBe(true);
    f.check({}, [nativeAssistant(2, [nativeCall('four')]), nativeResult('four')]);
    expect(stripTerminalSequences(f.transcript.render(160).join('\n'))).toContain('Preview for four');
    f.check({}, [{ ...nativeResult('two'), content: [{ type: 'image', data: 'eA==', mimeType: 'image/png' }] }]);
    expect(stripTerminalSequences(f.transcript.render(160).join('\n'))).toContain('Preview for three');
    f.transcript.invalidate(); f.check();
  } finally { f.transcript.dispose(); }
});

it('keeps full tool renderer execution and partial context equivalent to fresh snapshots', () => {
  const presentation: AgentToolPresentation = {
    renderCall: (_args, _theme, context) => new Text(`call started=${context.executionStarted} partial=${context.isPartial}`, 0, 0),
    renderResult: (_result, options, _theme, context) => new Text(`result started=${context.executionStarted} partial=${options.isPartial}/${context.isPartial}`, 0, 0),
  };
  const f = projectionSequence('full', () => presentation);
  const tool = (state: 'running' | 'completed', output: string) => ({ id: 'one', state, output, truncated: false });
  try {
    f.check({}, [nativeAssistant(1, [nativeCall('one')])]);
    f.check({ pendingTools: ['one'], tools: [tool('running', 'Partial')] });
    f.check({ pendingTools: [] });
    f.check({ pendingTools: [], tools: [tool('completed', 'Final')] }, [nativeResult('one')]);
    f.check({ tools: [] });
    f.transcript.invalidate(); f.check();
  } finally { f.transcript.dispose(); }
});

it.each(['grouped', 'full'] as const)('rebuilds disappearing tools without retained results in %s mode', mode => {
  const f = projectionSequence(mode);
  try {
    f.check({ pendingTools: ['one'], tools: [{ id: 'one', state: 'running', output: 'Partial output', truncated: false }] }, [nativeAssistant(1, [nativeCall('one')])]);
    f.check({ pendingTools: [], tools: [] }, [], true);
    expect(stripTerminalSequences(f.transcript.render(160).join('\n'))).not.toContain('Partial output');
  } finally { f.transcript.dispose(); }
});

it('rebuilds when the snapshot state rejects a streaming tail replacement', () => {
  const f = projectionSequence('grouped');
  try {
    f.check({ streaming: nativeAssistant(1, []) });
    const extend = vi.spyOn(ToolActivityState.prototype, 'extendSnapshot').mockReturnValueOnce(false);
    try { f.check({ streaming: undefined }, [nativeAssistant(1, [{ type: 'text', text: 'Final' }])], true); }
    finally { extend.mockRestore(); }
  } finally { f.transcript.dispose(); }
});

it.each(['grouped', 'full'] as const)('replaces an untyped stream directly with retained history in %s mode', mode => {
  const f = projectionSequence(mode);
  try {
    f.check({}, [{ role: 'user', timestamp: 1, content: 'Before streaming' }]);
    f.check({ streamingContent: [{ type: 'thinking', thinking: 'Reasoning' }, { type: 'text', text: 'Draft without metadata' }] });
    f.check({ streamingContent: undefined }, [nativeAssistant(2, [{ type: 'text', text: 'Final without intermediate metadata' }])]);
    expect(stripTerminalSequences(f.transcript.render(160).join('\n'))).not.toContain('Draft without metadata');
  } finally { f.transcript.dispose(); }
});

it('rebuilds after a streaming assistant overwrites a history assistant with the same key', () => {
  const f = projectionSequence('grouped');
  try {
    const history = nativeAssistant(1, [{ type: 'text', text: 'Retained answer' }]);
    f.check({ streaming: nativeAssistant(1, [{ type: 'text', text: 'Abandoned draft' }]) }, [history]);
    expect(stripTerminalSequences(f.transcript.render(90).join('\n'))).toContain('Abandoned draft');
    f.check({ streaming: undefined }, [], true);
    const text = stripTerminalSequences(f.transcript.render(90).join('\n'));
    expect(text).toContain('Retained answer'); expect(text).not.toContain('Abandoned draft');
  } finally { f.transcript.dispose(); }
});

it.each(['untyped', 'typed'] as const)('preserves the local thinking toggle when replacing a %s tail', kind => {
  const f = projectionSequence('grouped');
  const content = (thinking: string) => [{ type: 'thinking' as const, thinking }, { type: 'text' as const, text: 'Visible answer' }];
  const patch = (thinking: string): Partial<AgentViewTranscript> => kind === 'typed'
    ? { streaming: nativeAssistant(2, content(thinking)) } : { streamingContent: content(thinking) };
  const update = vi.spyOn(TranscriptAssistant.prototype, 'updateContent');
  try {
    f.check(patch('Initial thought'), [{ role: 'user', timestamp: 1, content: 'Before thinking' }]);
    const component = kind === 'typed' ? update.mock.contexts[0] : undefined;
    f.toggleThinking(); update.mockClear();
    f.check(patch('Changed thought'));
    if (kind === 'typed') expect(update.mock.contexts[0]).toBe(component);
    f.check(patch('Final thought'), [{ role: 'user', timestamp: 3, content: 'During thinking' }]);
    for (const width of [40, 90, 160]) {
      const text = stripTerminalSequences(f.transcript.render(width).join('\n'));
      expect(text).toContain('Thinking...'); expect(text).toContain('Visible answer'); expect(text).not.toContain('Final thought');
    }
  } finally { update.mockRestore(); f.transcript.dispose(); }
});

it('rebuilds non-tail running shells with the correct running flags', () => {
  const f = projectionSequence('grouped');
  const shell: AgentViewTranscript['messages'][number] = { role: 'bashExecution', command: 'echo live', output: 'partial', timestamp: 2, cancelled: false, truncated: false };
  try {
    const first = f.check({}, [{ role: 'user', timestamp: 1, content: 'Before shell' }]);
    const messages = [...first.messages, shell, { role: 'user' as const, timestamp: 3, content: 'After shell' }];
    f.check({ messages, runningShells: [1] }, [], true);
    expect(stripTerminalSequences(f.transcript.render(90).join('\n')).match(/Running\.\.\./gu)).toHaveLength(1);
    f.check({ messages: [messages[0]!, { ...shell, output: 'finished', exitCode: 0 }, messages[2]!], runningShells: [] }, [], true);
    expect(stripTerminalSequences(f.transcript.render(90).join('\n'))).not.toContain('Running...');
  } finally { f.transcript.dispose(); }
});

it('expands only live shells after repeated tail replacements', () => {
  const f = projectionSequence('grouped'); const expand = vi.spyOn(ShellExecution.prototype, 'setExpanded');
  const shell: AgentViewTranscript['messages'][number] = { role: 'bashExecution', command: 'echo live', output: 'partial', timestamp: 2, cancelled: false, truncated: false };
  try {
    const first = f.check({}, [{ role: 'bashExecution', command: 'echo retained', output: 'retained', timestamp: 1, cancelled: false, truncated: false, exitCode: 0 }]);
    const retained = expand.mock.contexts[0];
    let current = retained;
    for (const output of ['first', 'second', 'third']) {
      expand.mockClear(); f.check({ messages: [...first.messages, { ...shell, output }], runningShells: [1] });
      current = expand.mock.contexts[0];
    }
    expand.mockClear(); expect(f.transcript.handleInput('\x0f')).toBe(true);
    expect(expand.mock.contexts[0]).toBe(retained); expect(expand.mock.contexts[1]).toBe(current);
    expect(expand.mock.calls).toEqual([[true], [true]]);
    f.check();
  } finally { expand.mockRestore(); f.transcript.dispose(); }
});

it.each(['streamingContent', 'shell'] as const)('keeps %s tail instances on identical projections and tool progress updates', kind => {
  const f = projectionSequence('full');
  const render = kind === 'shell' ? vi.spyOn(ShellExecution.prototype, 'render') : vi.spyOn(Markdown.prototype, 'render');
  const tool = (output: string) => ({ id: 'one', state: 'running' as const, output, truncated: false });
  try {
    const first = f.check({ pendingTools: ['one'], tools: [tool('First chunk')] }, [nativeAssistant(1, [nativeCall('one')])]);
    const patch: Partial<AgentViewTranscript> = kind === 'shell'
      ? { messages: [...first.messages, { role: 'bashExecution', command: 'echo live', output: 'partial', timestamp: 2, cancelled: false, truncated: false }], runningShells: [1] }
      : { streamingContent: [{ type: 'text', text: 'Streaming answer' }] };
    render.mockClear(); f.check(patch);
    const tail = render.mock.contexts[0]; expect(tail).toBeDefined();
    render.mockClear(); f.check(); expect(render.mock.contexts[0]).toBe(tail);
    render.mockClear(); f.check({ tools: [tool('Second chunk')] }); expect(render.mock.contexts[0]).toBe(tail);
    expect(stripTerminalSequences(f.transcript.render(90).join('\n'))).toContain('Second chunk');
  } finally { render.mockRestore(); f.transcript.dispose(); }
});
