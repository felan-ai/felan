import { beforeAll, expect, it, vi } from 'vitest';
import { KeybindingsManager, TUI_KEYBINDINGS, setKeybindings, stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui';
import type { AgentViewTranscript } from '../src/subagents/types.js';
import { AgentNavigator, type AgentNavigatorHost, type AgentNavigatorRecord } from '../src/subagents/agent-navigator.js';
import { AgentTranscript } from '../src/subagents/agent-transcript.js';
import { defaultClientTheme } from '../src/tui/theme.js';

beforeAll(() => { setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS)); });
const theme = defaultClientTheme();

function visible(component: { render(width: number): string[] }): string { return stripTerminalSequences(component.render(100).join('\n')); }
function projection(): AgentViewTranscript {
  return { agentId: 'agent', cwd: '/fixture', messages: [{ role: 'user', content: 'Inspect changes', timestamp: 1 }],
    pendingTools: [], settings: { hideThinking: false, showImages: false, imageWidthCells: 60, outputPad: 1, toolMode: 'grouped' } };
}
function record(value = projection()): AgentNavigatorRecord {
  return { id: 'agent', parent: 'root', label: 'reviewer', description: 'Check changes',
    state: 'running', createdAt: new Date(0).toISOString(), model: { provider: 'offline', id: 'fixture' }, activity: 'Checking changes…',
    usage: { input: 7, output: 3, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, cost: 0.025 }, projection: value };
}
function setup(initial = record(), toolPresentation?: AgentNavigatorHost['toolPresentation']) {
  let current = initial; const listeners = new Set<() => void>(); const unsubscribe = vi.fn();
  const host: AgentNavigatorHost = {
    listLocalSubagents: () => [current], getLocalSubagent: id => id === current.id ? current : undefined,
    cancel: vi.fn(async () => ({ ok: true, value: current })), steer: vi.fn(async () => ({ ok: true, value: current })),
    selectAgent: vi.fn(), subscribe: callback => { listeners.add(callback); return () => { listeners.delete(callback); unsubscribe(); }; },
    ...(toolPresentation ? { toolPresentation } : {}),
  };
  const tui = { terminal: { rows: 14, columns: 100 }, requestRender: vi.fn() };
  const view = new AgentNavigator(tui as never, host, theme, { matches: () => false } as never, vi.fn());
  return { view, host, tui, unsubscribe, update(value: AgentNavigatorRecord) { current = value; for (const listener of listeners) listener(); } };
}

it('renders a data-only agent with its real metadata and releases its subscription and selection', () => {
  const h = setup();
  try {
    const lines = h.view.render(100); const text = stripTerminalSequences(lines.join('\n'));
    expect(lines.join('\n')).toContain(theme.getBgAnsi('userMessageBg'));
    expect(lines.every(line => visibleWidth(line) === 100)).toBe(true);
    expect(text).toContain('Inspect changes'); expect(text).toContain('offline/fixture');
    expect(text).toContain('Checking changes'); expect(text).toContain('$0.025');
    expect(h.host.selectAgent).toHaveBeenCalledWith('agent');
  } finally { h.view.dispose(); }
  h.view.dispose();
  expect(h.unsubscribe).toHaveBeenCalledTimes(1);
  expect(h.host.selectAgent).toHaveBeenLastCalledWith(undefined);
  expect(h.host.selectAgent).toHaveBeenCalledTimes(2);
});

it('preserves the selected transcript scroll position when a live projection arrives', () => {
  const data = projection();
  data.messages = Array.from({ length: 35 }, (_, index) => ({ role: 'user', content: `line-${index}`, timestamp: index }));
  const h = setup(record(data));
  try {
    h.view.render(100); h.view.handleInput('\x1b[<64;20;5M');
    const before = h.view.render(100).slice(1, 8);
    const next = structuredClone(data); next.messages.push({ role: 'user', content: 'new tail', timestamp: 99 });
    h.update(record(next));
    expect(h.view.render(100).slice(1, 8)).toEqual(before);
    expect(h.host.selectAgent).toHaveBeenCalledTimes(1);
  } finally { h.view.dispose(); }
});

it('retains thinking toggles and live pending tools instead of inventing missing-result failures', () => {
  const data = projection();
  data.messages.push({ role: 'assistant', api: 'openai-completions', provider: 'offline', model: 'fixture', timestamp: 2,
    content: [{ type: 'thinking', thinking: 'Inspect the selected file.' }, { type: 'toolCall', id: 'call', name: 'read', arguments: { path: 'a.ts' } }],
    stopReason: 'toolUse', usage: { input: 7, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 10,
      cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 } } });
  data.pendingTools = ['call'];
  const transcript = new AgentTranscript({ requestRender: vi.fn() } as never,
    { matches: (input: string, action: string) => input === 'hide' && action === 'app.thinking.toggle' } as never);
  try {
    transcript.showProjection(data);
    expect(visible(transcript)).not.toContain('No retained tool result');
    expect(visible(transcript)).toContain('Reading');
    transcript.handleInput('hide');
    expect(transcript.getToggleHints().thinking).toContain('show thinking');
    transcript.showProjection(structuredClone(data));
    expect(transcript.getToggleHints().thinking).toContain('show thinking');
    expect(visible(transcript)).not.toContain('No retained tool result');
  } finally { transcript.dispose(); }
});

it('rejects a projection for a different agent without rendering its messages', () => {
  const data = projection(); data.agentId = 'other'; data.messages = [{ role: 'user', content: 'Wrong agent secret', timestamp: 0 }];
  const h = setup(record(data));
  try {
    const text = visible(h.view);
    expect(text).toContain('Transcript identity mismatch'); expect(text).not.toContain('Wrong agent secret');
  } finally { h.view.dispose(); }
});

it('does not duplicate a pending stop and shows a transport failure without an unhandled rejection', async () => {
  const h = setup(); let reject!: (reason: Error) => void;
  const pending = new Promise<Awaited<ReturnType<AgentNavigatorHost['cancel']>>>((_resolve, fail) => { reject = fail; });
  h.host.cancel = vi.fn(() => pending);
  try {
    h.view.handleInput('x'); h.view.handleInput('x');
    expect(h.host.cancel).toHaveBeenCalledTimes(1);
    expect(visible(h.view)).toContain('Stopping reviewer');
    reject(new Error('Transport disconnected'));
    await vi.waitFor(() => expect(visible(h.view)).toContain('Transport disconnected'));
  } finally { h.view.dispose(); }
});

it.each([
  ['full', 'apply_patch', true],
  ['grouped', 'read', false],
  ['grouped', 'ask_user', true],
] as const)('uses client tool renderers for %s/%s without replacing grouped activity', (mode, name, custom) => {
  const data = projection(); data.settings.toolMode = mode;
  data.messages.push({ role: 'assistant', api: 'openai-completions', provider: 'offline', model: 'fixture', timestamp: 2,
    content: [{ type: 'toolCall', id: 'call', name, arguments: { path: 'a.ts' } }], stopReason: 'toolUse',
    usage: { input: 7, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 10,
      cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 } } },
  { role: 'toolResult', toolCallId: 'call', toolName: name, content: [{ type: 'text', text: 'done' }], isError: false, timestamp: 3 });
  const renderCall = vi.fn(() => ({ render: () => ['Client call renderer'], invalidate() {} }));
  const renderResult = vi.fn(() => ({ render: () => ['Client result renderer'], invalidate() {} }));
  const present = vi.fn(() => ({ renderCall, renderResult }));
  const h = setup(record(data), present);
  try {
    h.tui.terminal.rows = 40;
    const output = visible(h.view);
    expect(present).toHaveBeenCalledWith(name);
    if (custom) {
      expect(output).toContain('Client call renderer'); expect(output).toContain('Client result renderer');
      expect(renderCall).toHaveBeenCalled(); expect(renderResult).toHaveBeenCalled();
    } else {
      expect(output).toContain('Read'); expect(output).not.toContain('Client call renderer');
      expect(renderCall).not.toHaveBeenCalled(); expect(renderResult).not.toHaveBeenCalled();
    }
  } finally { h.view.dispose(); }
});
