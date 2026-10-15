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

it.each(['edit', 'clear'] as const)('does not submit stale input after a queued command is %sed', async change => {
  const f = fixture();
  f.terminal.input('\x03'); f.terminal.input('/login'); f.terminal.input('\r');
  f.terminal.input(change === 'edit' ? ' changed' : '\x03');
  f.release(); await f.first;
  expect(f.login).not.toHaveBeenCalled(); expect(f.submit).toHaveBeenCalledTimes(1);
  expect(f.screen.editor.getExpandedText()).toBe(change === 'edit' ? ' changed' : '');
  expect(f.transport.requests).toHaveLength(0);
});

it('expires notifications without replaying them on refresh and shows changed notifications', () => {
  vi.useFakeTimers();
  const f = fixture(); const state = snapshot();
  state.presentation.push({ id: 'warning', kind: 'notification', level: 'warning', text: 'Memory processing disabled' });
  vi.spyOn(f.controller, 'snapshot', 'get').mockReturnValue(state);
  const render = () => { f.tui.renderNow(true); return stripTerminalSequences(f.tui.getScreenLines().join('\n')); };
  f.controller.setNotice('');
  expect(render()).toContain('Warning: Memory processing disabled');
  vi.advanceTimersByTime(4_000); f.controller.setNotice('');
  vi.advanceTimersByTime(1_000);
  expect(render()).not.toContain('Memory processing disabled');
  f.controller.setNotice('');
  expect(render()).not.toContain('Memory processing disabled');
  state.presentation[0] = { id: 'warning', kind: 'notification', level: 'warning', text: 'A new warning' };
  f.controller.setNotice('');
  expect(render()).toContain('Warning: A new warning');
  state.presentation.length = 0; f.controller.setNotice('');
  state.presentation.push({ id: 'warning', kind: 'notification', level: 'warning', text: 'A new warning' });
  f.controller.setNotice('');
  expect(render()).toContain('Warning: A new warning');
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
