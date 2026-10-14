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

function fixture() {
  initTheme('dark', false); setKeybindings(createClientKeybindings());
  let listener = () => {};
  const state = snapshot();
  state.catalog.commands = [{ name: 'prompt-history', description: 'Search prompt history', source: 'inline', kind: 'extension', scope: 'temporary' },
    { name: 'savings', description: 'Show estimated API-equivalent savings', source: 'inline', kind: 'extension', scope: 'temporary' }];
  const controller = { snapshot: state, history, sessionId: state.session, state: { status: 'live' }, client: { status: 'ready' }, notice: '', busy: false,
    subscribe: (callback: () => void) => { listener = callback; return () => {}; },
    setNotice: vi.fn((text: string) => { controller.notice = text; listener(); }),
    perform: vi.fn(async () => ({ outcome: 'accepted' })),
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
  return { controller, screen, input: (data: string) => input(data), text: () => stripTerminalSequences((tui.hasOverlay() ? overlays.mock.calls.at(-1)![0] : screen.component).render(120).join('\n')) };
}

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
  expect(help).toContain('/tools — [t] Inspect tool calls and results'); expect(help).toContain('/savings — [t] Show estimated');
});

it('advertises local actions and uses explicit provenance rather than guessing paths', async () => {
  const f = fixture(); f.controller.snapshot.catalog.commands.push(
    { name: 'skill:project', description: 'Project skill', source: '/home/looks-like-user', kind: 'skill', scope: 'project' },
    { name: 'skill:user', description: 'User skill', source: '/workspace/looks-like-project', kind: 'skill', scope: 'user' });
  const provider = createCommandAutocomplete(f.controller as unknown as TuiSessionController);
  const result = await provider.getSuggestions(['/'], 0, 1, { signal: new AbortController().signal });
  expect(result?.items.map(item => item.value)).toEqual(expect.arrayContaining(['savings', 'tools', 'agents']));
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
