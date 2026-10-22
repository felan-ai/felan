import { initTheme } from '@earendil-works/pi-coding-agent';
import { TuiAltScreen, getKeybindings, setKeybindings, stripTerminalSequences, type Terminal } from '@earendil-works/pi-tui';
import type { Message } from '@felan-ai/session-protocol';
import { afterEach, expect, it, vi } from 'vitest';
import { snapshot } from './client-fixtures.js';
import { createClientKeybindings } from '../src/tui/keybindings.js';
import { DaemonTuiScreen } from '../src/tui/screen.js';
import type { TuiSessionController } from '../src/tui/controller.js';
import { commandHelp } from '../src/tui/command-help.js';
import { createCommandAutocomplete, tuiCommands } from '../src/tui/commands.js';
import { inspectTools, ToolInspector } from '../src/tui/tool-inspector.js';
import { startupHeader } from '../src/tui/startup-header.js';
import { defaultClientTheme } from '../src/tui/theme.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
const history: Message[] = [
  { id: 'assistant', role: 'assistant', timestamp: 0, content: [{ type: 'tool_call', id: 'call-1', name: 'read', arguments: { path: 'AGENTS.md' } }] },
  { id: 'result', role: 'tool', timestamp: 1, content: [{ type: 'tool_result', id: 'call-1', text: 'Project instructions', isError: false }] },
];

function fixture(bindings: Parameters<typeof createClientKeybindings>[0] = {}) {
  initTheme('dark', false); setKeybindings(createClientKeybindings(bindings));
  let listener = () => {};
  const state = snapshot();
  state.catalog.commands = [{ name: 'prompt-history', description: 'Search prompt history', source: 'inline', kind: 'extension', scope: 'temporary' },
    { name: 'savings', description: 'Show estimated API-equivalent savings', source: 'inline', kind: 'extension', scope: 'temporary' }];
  const controller = { snapshot: state, history, sessionId: state.session, state: { status: 'live' },
    client: { status: 'ready', capabilities: { operations: ['queue.clear'] } }, notice: '', busy: false,
    subscribe: (callback: () => void) => { listener = callback; return () => {}; },
    setNotice: vi.fn((text: string) => { controller.notice = text; listener(); }),
    perform: vi.fn(async (..._args: unknown[]): Promise<unknown> => ({ outcome: 'accepted' })),
    submit: vi.fn(async (text: string, kind = 'auto'): Promise<boolean> => {
      const response = await controller.perform(kind, { text }, state.session) as { outcome: string };
      return response.outcome === 'accepted';
    }),
    cancel: vi.fn(async () => ({ outcome: 'accepted' })),
  };
  let input = (_data: string) => {};
  const terminal = { columns: 120, rows: 40, kittyProtocolActive: false, start: (callback: (data: string) => void) => { input = callback; },
    stop() {}, async drainInput() {}, write() {}, moveBy() {}, hideCursor() {}, showCursor() {}, clearLine() {}, clearFromCursor() {}, clearScreen() {}, setTitle() {}, setProgress() {}, setProgramStatus() {},
  } as Terminal;
  const tui = new TuiAltScreen(terminal);
  const overlays = vi.spyOn(tui, 'showOverlay');
  const screen = new DaemonTuiScreen(controller as unknown as TuiSessionController, tui, { cwd: '/fixture', exit() {} });
  tui.setLayoutRoot(screen.component); screen.focus(); tui.start();
  cleanups.push(async () => { await screen.dispose(); tui.stop(); });
  const rawText = () => (tui.hasOverlay() ? overlays.mock.calls.at(-1)![0] : screen.component).render(120).join('\n');
  return { controller, screen, input: (data: string) => input(data), rawText, text: () => stripTerminalSequences(rawText()) };
}

function queuedFixture(bindings: Parameters<typeof createClientKeybindings>[0] = {}) {
  const f = fixture(bindings);
  f.controller.snapshot.queue = [
    { id: 'steering', kind: 'steer', prompt: { text: 'First\n  direction' } },
    { id: 'follow-up', kind: 'follow_up', prompt: { text: 'Next task' } },
  ];
  f.controller.perform.mockImplementation(async () => {
    const steering = f.controller.snapshot.queue.filter(item => item.kind === 'steer').map(item => item.prompt.text);
    const followUp = f.controller.snapshot.queue.filter(item => item.kind === 'follow_up').map(item => item.prompt.text);
    f.controller.snapshot.queue = []; f.controller.setNotice('');
    return { outcome: 'accepted', result: { steering, followUp } };
  });
  f.controller.setNotice('');
  return f;
}

it('renders dim queued messages above the editor with attachment labels and the restore hint', () => {
  const f = queuedFixture(); const theme = defaultClientTheme();
  f.controller.snapshot.queue[0]!.prompt.attachments = [
    { type: 'text', text: 'attached text' }, { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
    { type: 'resource', uri: 'file:///notes.txt', name: 'notes.txt' },
  ];
  f.screen.editor.setText('Current draft');
  const text = f.text();
  expect(f.rawText()).toContain(theme.fg('dim', 'Steering: First direction attached text [image] notes.txt'));
  expect(f.rawText()).toContain(theme.fg('dim', 'Follow-up: Next task'));
  expect(f.rawText()).toContain(theme.fg('dim', '↳ Alt+Up to edit all queued messages'));
  expect(text.indexOf('Follow-up: Next task')).toBeLessThan(text.indexOf('Current draft'));
  expect(text).not.toContain('2 queued');
});

it('truncates queued lines and strips terminal control sequences', () => {
  const f = queuedFixture();
  f.controller.snapshot.queue[0]!.prompt.text = `\x1b[31m${'word '.repeat(60)}\x1b[0m`;
  f.controller.setNotice('');
  const line = f.text().split('\n').find(line => line.includes('Steering:'))!;
  expect(line).toContain('...'); expect(line.length).toBeLessThanOrEqual(120);
  expect(f.rawText()).not.toContain('\x1b[31m');
});

it('keeps queued messages visible without advertising or invoking unsupported queue clearing', () => {
  const f = queuedFixture(); f.controller.client.capabilities.operations = []; f.controller.setNotice('');
  expect(f.text()).toContain('Steering: First direction');
  expect(f.text()).not.toContain('to edit all queued messages');
  f.input('\x1b[1;3A'); expect(f.controller.perform).not.toHaveBeenCalled();
});

it('uses the configured dequeue shortcut and hides the hint when it is unbound', async () => {
  const f = queuedFixture({ 'app.message.dequeue': 'alt+u' });
  expect(f.text()).toContain('↳ Alt+U to edit all queued messages');
  f.input('\x1bu');
  await vi.waitFor(() => expect(f.controller.notice).toBe('Restored 2 queued messages to editor'));
  const unbound = queuedFixture({ 'app.message.dequeue': [] });
  expect(unbound.text()).not.toContain('to edit all queued messages');
});

it.each(['\x1b[1;3A', '\x1bp'])('restores all queued text with Alt+Up (%j) without changing models', async data => {
  const f = queuedFixture();
  f.controller.snapshot.catalog.models = ['fixture', 'next', 'previous'].map(id => ({ provider: 'fixture', id, label: id, thinking: [] }));
  f.screen.editor.setText('Current draft'); f.input(data);
  await vi.waitFor(() => expect(f.controller.notice).toBe('Restored 2 queued messages to editor'));
  expect(f.controller.perform).toHaveBeenCalledExactlyOnceWith('queue.clear', {}, 'session');
  expect(f.screen.editor.getText()).toBe('First\n  direction\n\nNext task\n\nCurrent draft');
  expect(f.controller.snapshot.queue).toEqual([]); expect(f.text()).not.toContain('Steering:');
});

it('cycles the model backward with Ctrl+Shift+P without clearing queued messages', async () => {
  const f = queuedFixture();
  f.controller.snapshot.catalog.models = ['fixture', 'next', 'previous'].map(id => ({ provider: 'fixture', id, label: id, thinking: [] }));
  f.controller.perform.mockResolvedValue({ outcome: 'accepted' });
  f.screen.editor.setText('Current draft'); f.input('\x1b[112;6u');
  await vi.waitFor(() => expect(f.controller.notice).toBe('Model: previous'));
  expect(f.controller.perform).toHaveBeenCalledExactlyOnceWith('set_model', { provider: 'fixture', id: 'previous' }, 'session');
  expect(f.controller.snapshot.queue).toHaveLength(2); expect(f.screen.editor.getText()).toBe('Current draft');
});

it('does not request clearing an empty queue', async () => {
  const f = fixture(); f.screen.editor.setText('Keep draft'); f.input('\x1b[1;3A');
  await vi.waitFor(() => expect(f.controller.notice).toBe('No queued messages to restore'));
  expect(f.controller.perform).not.toHaveBeenCalled(); expect(f.screen.editor.getText()).toBe('Keep draft');
});

it.each(['rejected', 'error'])('leaves the editor unchanged when clearing the queue returns %s', async outcome => {
  const f = queuedFixture(); f.screen.editor.setText('Keep draft');
  f.controller.perform.mockImplementation(async () => {
    if (outcome === 'error') throw new Error('Queue unavailable');
    f.controller.setNotice('Rejected: Queue unavailable');
    return { outcome: 'rejected', error: { code: 'unavailable', message: 'Queue unavailable' } };
  });
  f.input('\x1b[1;3A');
  await vi.waitFor(() => expect(f.screen.editor.disableSubmit).toBe(false));
  expect(f.screen.editor.getText()).toBe('Keep draft'); expect(f.controller.notice).toContain('Queue unavailable');
  expect(f.controller.snapshot.queue).toHaveLength(2);
});

it('keeps edits made during queue clearing and prevents duplicate clears or submissions', async () => {
  const f = queuedFixture();
  let release!: () => void; const pending = new Promise<void>(resolve => { release = resolve; });
  f.controller.perform.mockImplementation(async () => {
    await pending; f.controller.snapshot.queue = [];
    return { outcome: 'accepted', result: { steering: ['Restored'], followUp: [] } };
  });
  f.screen.editor.setText('Draft'); f.input('\x1b[1;3A');
  f.input(' edited'); f.input('\r'); f.input('\x1b\r'); f.input('\x1b[1;3A');
  expect(f.controller.perform).toHaveBeenCalledTimes(1); expect(f.screen.editor.getText()).toBe('Draft edited');
  release();
  await vi.waitFor(() => expect(f.controller.notice).toBe('Restored 1 queued message to editor'));
  expect(f.screen.editor.getText()).toBe('Restored\n\nDraft edited');
});

it.each(['', 'New draft'])('retains a deferred submission and later draft (%j) while waiting to clear', async draft => {
  const f = queuedFixture();
  let release!: () => void; const pending = new Promise<void>(resolve => { release = resolve; });
  f.controller.perform.mockImplementationOnce(async () => { await pending; return { outcome: 'accepted' }; });
  f.input('\x12'); f.screen.editor.setText('Deferred draft'); f.input('\r'); f.screen.editor.setText(draft); f.input('\x1b[1;3A');
  expect(f.controller.perform).toHaveBeenCalledTimes(1);
  release();
  await vi.waitFor(() => expect(f.controller.notice).toBe('Restored 2 queued messages to editor'));
  expect(f.controller.perform).toHaveBeenLastCalledWith('queue.clear', {}, 'session');
  expect(f.screen.editor.getText()).toBe(`First\n  direction\n\nNext task\n\nDeferred draft${draft ? `\n\n${draft}` : ''}`);
});

it('keeps the draft unchanged if the queue empties before the clear response', async () => {
  const f = queuedFixture(); f.screen.editor.setText('  ');
  f.controller.perform.mockResolvedValue({ outcome: 'accepted', result: { steering: [], followUp: [] } });
  f.input('\x1b[1;3A');
  await vi.waitFor(() => expect(f.controller.notice).toBe('No queued messages to restore'));
  expect(f.screen.editor.getText()).toBe('  ');
});

it('restores queued messages before cancelling a running turn with Escape', async () => {
  const f = queuedFixture(); f.controller.snapshot.run.state = 'running'; f.screen.editor.setText('Draft');
  let release!: () => void; const pending = new Promise<void>(resolve => { release = resolve; });
  f.controller.perform.mockImplementation(async () => {
    await pending; f.controller.snapshot.queue = [];
    return { outcome: 'accepted', result: { steering: ['Restored'], followUp: [] } };
  });
  f.input('\x1b'); expect(f.controller.perform).toHaveBeenCalledWith('queue.clear', {}, 'session');
  expect(f.controller.cancel).not.toHaveBeenCalled(); release();
  await vi.waitFor(() => expect(f.controller.cancel).toHaveBeenCalledOnce());
  expect(f.screen.editor.getText()).toBe('Restored\n\nDraft');
  expect(f.controller.perform.mock.invocationCallOrder[0]).toBeLessThan(f.controller.cancel.mock.invocationCallOrder[0]!);
});

it('waits for a pending follow-up before restoring and cancelling even when the snapshot queue starts empty', async () => {
  const f = queuedFixture(); f.controller.snapshot.run.state = 'running'; f.controller.snapshot.queue = [];
  let release!: () => void; const pending = new Promise<void>(resolve => { release = resolve; });
  f.controller.perform.mockImplementationOnce(async () => {
    await pending;
    f.controller.snapshot.queue = [{ id: 'follow-up', kind: 'follow_up', prompt: { text: 'In flight' } }];
    return { outcome: 'accepted' };
  });
  f.screen.editor.setText('/follow-up In flight'); f.input('\r'); f.input('\x1b');
  expect(f.controller.cancel).not.toHaveBeenCalled(); expect(f.controller.perform).toHaveBeenCalledTimes(1);
  release();
  await vi.waitFor(() => expect(f.controller.cancel).toHaveBeenCalledOnce());
  expect(f.controller.perform).toHaveBeenLastCalledWith('queue.clear', {}, 'session');
  expect(f.screen.editor.getText()).toBe('In flight');
});

it.each(['rejected', 'error', 'unsupported'])('still cancels with Escape when queue restoration is %s', async outcome => {
  const f = queuedFixture(); f.controller.snapshot.run.state = 'running'; f.screen.editor.setText('Draft');
  if (outcome === 'unsupported') f.controller.client.capabilities.operations = [];
  f.controller.perform.mockImplementation(async () => {
    if (outcome === 'error') throw new Error('Queue unavailable');
    return { outcome: 'rejected', error: { code: 'unavailable', message: 'Queue unavailable' } };
  });
  f.input('\x1b');
  await vi.waitFor(() => expect(f.controller.cancel).toHaveBeenCalledOnce());
  expect(f.screen.editor.getText()).toBe('Draft');
  if (outcome === 'unsupported') expect(f.controller.perform).not.toHaveBeenCalled();
});

it.each(['isRailFocused', 'isShowingAutocomplete'] as const)('does not dequeue while %s', method => {
  const f = queuedFixture(); vi.spyOn(f.screen.editor, method).mockReturnValue(true);
  f.input('\x1b[1;3A'); expect(f.controller.perform).not.toHaveBeenCalled();
});

it('does not dequeue while an inline dialog is open and hides queued lines until it closes', async () => {
  const f = queuedFixture(); const pending = f.screen.dialogs.input('Input');
  expect(f.text()).not.toContain('Steering:'); f.input('\x1b[1;3A');
  expect(f.controller.perform).not.toHaveBeenCalled(); f.input('\x1b'); await pending;
  expect(f.text()).toContain('Steering:');
});

it('routes Ctrl+R to the semantic history command without changing the draft', async () => {
  const f = fixture(); f.screen.editor.setText('keep this draft'); f.input('\x12');
  await vi.waitFor(() => expect(f.controller.perform).toHaveBeenCalledWith('command.invoke', { name: 'prompt-history', arguments: '' }, 'session'));
  expect(f.screen.editor.getText()).toBe('keep this draft');
});

it('opens and reopens the client-owned tool inspector using Alt+T and /tools', async () => {
  const f = fixture(); f.input('\x1bt');
  expect(f.text()).toContain('Tool Activity'); expect(f.text()).toContain('call-1');
  expect(f.text()).toContain('AGENTS.md'); expect(f.text()).toContain('Project instructions');
  f.input('\x1b'); await Promise.resolve(); await Promise.resolve();
  const opened = f.screen.submit('/tools'); expect(f.text()).toContain('Tool Activity');
  f.input('\x1b'); await opened;
  expect(f.controller.perform).not.toHaveBeenCalled();
});

it('reports truthful Ctrl+O state and the full-details shortcut', () => {
  const f = fixture(); f.input('\x0f');
  expect(f.controller.notice).toBe('Tool output: expanded · Alt+T full details');
  expect(stripTerminalSequences(startupHeader(defaultClientTheme(), createClientKeybindings(), f.screen.transcript.toolsExpanded))).toContain('collapse tools');
  f.input('\x0f'); expect(f.controller.notice).toBe('Tool output: collapsed · Alt+T full details');
});

it.each(['/help', '/hotkeys'])('opens %s locally with effective shortcuts and described commands', async command => {
  const f = fixture(); const pending = f.screen.submit(command);
  expect(f.text()).toContain('Keyboard Shortcuts');
  f.input('\x1b'); await pending; expect(f.controller.perform).not.toHaveBeenCalled();
  const help = commandHelp(createClientKeybindings({ 'app.history.search': 'alt+h' }), tuiCommands(f.controller as unknown as TuiSessionController));
  expect(help).toMatch(/Option\+H\s+│ Search prompt history/); expect(help).not.toContain('Ctrl+R / Cmd+R');
  expect(help).toMatch(/Option\+A\s+│ Open the subagent navigator/);
  expect(help).toMatch(/Option\+↑\s+│ Restore queued messages to the editor/);
  expect(help).toContain('/tools — [t] Inspect tool calls and results'); expect(help).toContain('/savings — [t] Show estimated');
});

it('advertises local actions and uses explicit provenance rather than guessing paths', async () => {
  const f = fixture(); f.controller.snapshot.catalog.commands.push(
    { name: 'skill:project', description: 'Project skill', source: '/home/looks-like-user', kind: 'skill', scope: 'project' },
    { name: 'skill:user', description: 'User skill', source: '/workspace/looks-like-project', kind: 'skill', scope: 'user' });
  const provider = createCommandAutocomplete(f.controller as unknown as TuiSessionController);
  const result = await provider.getSuggestions(['/'], 0, 1, { signal: new AbortController().signal });
  expect(result?.items.map(item => item.value)).toEqual(expect.arrayContaining(['savings', 'tools', 'agents']));
  expect(result?.items.map(item => item.value)).not.toContain('queue');
  expect(result?.items.find(item => item.value === 'agents')?.description).toMatch(/^\[t\]/);
  expect(result?.items.find(item => item.value === 'tools')?.description).toMatch(/^\[t\]/);
  expect(result?.items.find(item => item.value === 'skill:project')?.description).toBe('[p] Project skill');
  expect(result?.items.find(item => item.value === 'skill:user')?.description).toBe('[u] User skill');
});

it('joins tool results by identity and displays authoritative partial output and empty state', () => {
  const state = snapshot(); state.tools = [{ id: 'call-1', name: 'read', message: 'assistant', state: 'running', output: 'partial output', truncated: true }];
  const tools = inspectTools(history, state);
  expect(tools).toEqual([{ id: 'call-1', name: 'read', arguments: { path: 'AGENTS.md' }, state: 'running', result: 'partial output\n[Tool output truncated]' }]);
  const panel = new ToolInspector(() => [], () => defaultClientTheme(), () => {}, () => {});
  expect(stripTerminalSequences(panel.render(80).join('\n'))).toContain('No tool calls');
});


it('keeps retained full results instead of replacing them with truncated preview output', () => {
  const state = snapshot(); state.tools = [{ id: 'call-1', name: 'read', message: 'assistant', state: 'completed', output: 'Project', truncated: true }];
  expect(inspectTools(history, state)[0]?.result).toBe('Project instructions');
});

it('pages help through the fullscreen input path and returns to its first page', async () => {
  const f = fixture(); const work = f.screen.submit('/help');
  const first = f.text();
  f.input('\x1b[6~'); expect(f.text()).not.toBe(first);
  f.input('\x1b[5~'); expect(f.text()).toBe(first);
  f.input('\x1b'); await work;
});


it('separates conflicting shortcuts by context and installs the client key manager', () => {
  const keys = createClientKeybindings(); setKeybindings(keys);
  expect(getKeybindings()).toBe(keys);
  const help = commandHelp(keys, []);
  const global = help.split('Global / editor\n')[1]!.split('\nSession navigator')[0]!;
  const sessions = help.split('Session navigator\n')[1]!.split('\nTree navigator')[0]!;
  expect(global).toContain('Search prompt history');
  expect(global).not.toContain('Rename the selected session');
  expect(global).not.toContain('Set the default model');
  expect(sessions).toMatch(/Ctrl\+R\s+│ Rename the selected session/);
  expect(sessions).toMatch(/Ctrl\+S\s+│ Change session sort order/);
  expect(help).toMatch(/Model picker\nCtrl\+S\s+│ Set the default model/);
  expect(help).toMatch(/Thinking picker\nCtrl\+S\s+│ Set the default thinking level/);
});
