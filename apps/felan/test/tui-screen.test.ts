import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initTheme } from '@earendil-works/pi-coding-agent';
import { TuiAltScreen, setKeybindings, stripTerminalSequences, Text, type ProgramStatus, type Terminal } from '@earendil-works/pi-tui';
import { afterEach, expect, it, vi } from 'vitest';
import { SessionClient } from '../src/client/client.js';
import { TuiSessionController } from '../src/tui/controller.js';
import { createClientKeybindings } from '../src/tui/keybindings.js';
import { DaemonTuiScreen } from '../src/tui/screen.js';
import { FakeTransport, snapshot } from './client-fixtures.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });

function fixture() {
  initTheme('dark', false); setKeybindings(createClientKeybindings());
  const transport = new FakeTransport();
  const client = new SessionClient({ target: { kind: 'isolated', directory: '/unused', namespaceId: 'screen-test' },
    kind: 'tui', clientVersion: 'fixture', connector: transport.connector, retries: 0 });
  const controller = new TuiSessionController(client);
  const terminal = new TestTerminal(); const tui = new TuiAltScreen(terminal);
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const preferences = vi.fn(async () => { await waiting; return false; });
  const login = vi.fn(async () => false);
  const screen = new DaemonTuiScreen(controller, tui, { cwd: '/unused', exit: vi.fn(), preferences, login });
  const submit = vi.spyOn(screen, 'submit');
  tui.setLayoutRoot(screen.component); screen.focus(); tui.start();
  cleanups.push(async () => { release(); await screen.dispose(); tui.stop(); await controller.dispose(); });
  terminal.input('/settings'); terminal.input('\r');
  expect(preferences).toHaveBeenCalledOnce();
  const first = submit.mock.results[0]!.value as Promise<void>;
  return { terminal, screen, submit, login, release, first, transport, controller, tui };
}

it('retains an explicit submission while the previous local action settles', async () => {
  const f = fixture();
  f.terminal.input('\x03'); f.terminal.input('/login'); f.terminal.input('\r');
  expect(f.login).not.toHaveBeenCalled(); expect(f.submit).toHaveBeenCalledTimes(1);
  f.release(); await f.first;
  await vi.waitFor(() => expect(f.login).toHaveBeenCalledOnce());
  expect(f.submit).toHaveBeenCalledTimes(2);
  expect(f.screen.editor.getExpandedText()).toBe('');
  expect(f.transport.requests).toHaveLength(0);
});

it('completes a later-line file path through the editor Tab and selection keys', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'tui-editor-autocomplete-'));
  await writeFile(join(cwd, 'example.ts'), 'export {};\n');
  const transport = new FakeTransport();
  const client = new SessionClient({ target: { kind: 'isolated', directory: '/unused', namespaceId: 'autocomplete-screen-test' },
    kind: 'tui', clientVersion: 'fixture', connector: transport.connector, retries: 0 });
  const controller = new TuiSessionController(client);
  vi.spyOn(controller, 'snapshot', 'get').mockReturnValue({ ...snapshot(), cwd });
  const terminal = new TestTerminal(); const tui = new TuiAltScreen(terminal);
  const screen = new DaemonTuiScreen(controller, tui, { cwd, exit: vi.fn() });
  tui.setLayoutRoot(screen.component); screen.focus(); tui.start();
  cleanups.push(async () => { await screen.dispose(); tui.stop(); await controller.dispose(); await rm(cwd, { recursive: true, force: true }); });

  screen.editor.setText('Review this file:\nexa'); terminal.input('\t');
  await vi.waitFor(() => {
    tui.renderNow(true);
    expect(stripTerminalSequences(tui.getScreenLines().join('\n'))).toContain('example.ts');
  });
  expect(screen.editor.getExpandedText()).toBe('Review this file:\nexample.ts');
  terminal.input('\x1b');
  expect(tui.hasOverlay()).toBe(false);
});

it.each(['edit', 'clear'] as const)('does not submit stale input after a queued command is %sed', async change => {
  const f = fixture();
  f.terminal.input('\x03'); f.terminal.input('/login'); f.terminal.input('\r');
  f.terminal.input(change === 'edit' ? ' changed' : '\x03');
  f.release(); await f.first;
  expect(f.login).not.toHaveBeenCalled(); expect(f.submit).toHaveBeenCalledTimes(1);
  expect(f.screen.editor.getExpandedText()).toBe(change === 'edit' ? ' changed' : '');
  expect(f.transport.requests).toHaveLength(0);
});

it('shows notices and notifications once as transcript lines instead of pinning them', () => {
  const f = fixture(); const state = snapshot();
  state.presentation.push({ id: 'warning', kind: 'notification', level: 'warning', text: 'Memory processing disabled' });
  vi.spyOn(f.controller, 'snapshot', 'get').mockReturnValue(state);
  const render = () => { f.tui.renderNow(true); return stripTerminalSequences(f.tui.getScreenLines().join('\n')); };
  const count = (text: string) => render().split(text).length - 1;
  f.controller.setNotice(''); f.controller.setNotice('Model: first');
  expect(render()).toContain('Warning: Memory processing disabled'); expect(render()).toContain('Model: first');
  f.controller.setNotice('Model: second'); f.controller.setNotice('');
  expect(render()).not.toContain('Model: first'); expect(count('Model: second')).toBe(1);
  expect(count('Memory processing disabled')).toBe(1);
  state.presentation[0] = { id: 'warning', kind: 'notification', level: 'warning', text: 'A new warning' };
  f.controller.setNotice('');
  expect(count('Memory processing disabled')).toBe(1); expect(count('Warning: A new warning')).toBe(1);
  expect(f.screen.transcript.render(100).map(stripTerminalSequences).join('\n')).toContain('Warning: A new warning');
  state.presentation.length = 0; f.controller.setNotice('');
  state.presentation.push({ id: 'warning', kind: 'notification', level: 'warning', text: 'A new warning' });
  f.controller.setNotice('');
  expect(count('Warning: A new warning')).toBe(1);
});

it('uses the activity slot for reconnecting and retains the editor while the session snapshot stays visible', () => {
  const f = fixture();
  const state = { status: 'live', snapshot: { ...snapshot(), run: { state: 'running' as const } } } as const;
  vi.spyOn(f.controller, 'state', 'get').mockReturnValue(state as never);
  const connection = vi.spyOn(f.controller.client, 'status', 'get').mockReturnValue('ready');
  const retry = vi.spyOn(f.controller.client, 'reconnection', 'get').mockReturnValue(undefined);
  f.controller.setNotice('');
  const render = () => { f.tui.renderNow(true); return stripTerminalSequences(f.tui.getScreenLines().join('\n')); };
  expect(render()).toContain('Working');
  f.screen.editor.setText('draft');
  connection.mockReturnValue('disconnected');
  retry.mockReturnValue({ attempt: 1, retryAt: Date.now() + 1_000 });
  f.controller.setNotice('');
  expect(render()).toContain('Reconnecting…');
  expect(render()).not.toContain('Daemon disconnected');
  expect(f.screen.editor.getExpandedText()).toBe('draft');
  retry.mockReturnValue(undefined);
  f.controller.setNotice('');
  expect(render()).toContain('Use /reconnect to retry');
  expect(render()).not.toContain('Reconnecting…');
  connection.mockReturnValue('ready');
  f.controller.setNotice('');
  expect(render()).toContain('Working');
  expect(render()).not.toContain('Reconnecting…');
});

it('places the active subagent rail below the status footer while retaining keyboard navigation', () => {
  const f = fixture();
  f.screen.setFooter(new Text('Status footer'));
  f.screen.setExecutions([{ id: 'child', session: 'child', parent: 'session', root: 'session', label: 'general',
    state: 'running', kind: 'child', createdAt: new Date().toISOString(), description: 'Subagent task' }]);
  const lines = stripTerminalSequences(f.screen.component.render(100).join('\n'));
  expect(lines).toContain('general');
  expect(lines.indexOf('Status footer')).toBeLessThan(lines.indexOf('general'));
  f.terminal.input('\x1b[B');
  expect(f.screen.editor.isRailFocused()).toBe(true);
  f.terminal.input('\x1b[A');
  expect(f.screen.editor.isRailFocused()).toBe(false);
});

class TestTerminal implements Terminal {
  columns = 100; rows = 24; kittyProtocolActive = false;
  input: (data: string) => void = () => {};
  start(input: (data: string) => void): void { this.input = input; }
  stop(): void {}
  async drainInput(): Promise<void> {}
  write(_data: string): void {}
  moveBy(_lines: number): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(_title: string): void {}
  setProgress(_active: boolean): void {}
  setProgramStatus(_status: ProgramStatus): void {}
}
