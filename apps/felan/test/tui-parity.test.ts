import { afterEach, expect, it, vi } from 'vitest';
import { setKeybindings, stripTerminalSequences, TuiAltScreen, type ProgramStatus, type Terminal } from '@earendil-works/pi-tui';
import type { Message, SessionSnapshot, UiView } from '@felan-ai/session-protocol';
import { createClientPowerlineFooter, isPowerlinePresentation } from '../src/client/powerline-presenter.js';
import type { SessionClient } from '../src/client/client.js';
import { TuiSessionController } from '../src/tui/controller.js';
import { createClientKeybindings } from '../src/tui/keybindings.js';
import { DaemonTuiScreen } from '../src/tui/screen.js';
import { defaultClientTheme } from '../src/tui/theme.js';
import { createPresentationUi } from '../src/tui/presentation-ui.js';
import { presentTasksElement } from '../src/tui/renderers/tasks.js';
import { FELAN_VERSION } from '../src/version.js';
import { snapshot } from './client-fixtures.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.useRealTimers(); });

function powerline(): UiView {
  return { id: 'powerline', kind: 'view', revision: 1, title: 'Powerline', hint: { id: 'felan.powerline', version: '3.0.0' },
    fields: ['segment', 'data', 'color'].map(id => ({ id, label: id, valueKind: 'text' as const })),
    actions: [], fallback: 'Powerline data', items: [
      { id: 'directory', values: { segment: 'directory', data: JSON.stringify({ cwd: '/fixture' }), color: 'directory' }, fallback: 'Directory' },
      { id: 'model', values: { segment: 'model', data: JSON.stringify({ id: 'fixture', provider: 'fixture', reasoning: true, thinkingLevel: 'xhigh', providerCount: 2 }), color: 'model' }, fallback: 'Model' },
    ] };
}

function fixture() {
  const keys = createClientKeybindings(); setKeybindings(keys);
  let current: SessionSnapshot = { ...snapshot(), thinking: 'xhigh', presentation: [powerline(),
    { id: 'memory', kind: 'status', key: 'memory', value: { kind: 'text', text: 'Memory: disabled' }, fallback: 'Memory disabled' },
  ] };
  const listeners = new Set<() => void>();
  const client = { status: 'ready', reconnection: undefined as { attempt: number; retryAt: number } | undefined, capabilities: { daemonVersion: '0.1.0' },
    readAttachment: () => ({ state: { status: 'live', snapshot: current } }),
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; } };
  const controller = { client, get snapshot() { return current; }, get state() { return client.readAttachment().state; },
    sessionId: 'session', history: [] as Message[], busy: false, notice: '', subscribe: client.subscribe,
    notes: [{ text: 'Memory processing disabled for this project.', level: 'warning' as const }],
    cancel: vi.fn(async () => ({})), submit: vi.fn(async () => true), perform: vi.fn(async () => ({ outcome: 'accepted' })),
    setNotice(text: string) { this.notice = text; for (const listener of listeners) listener(); },
  };
  const terminal = new TestTerminal(); const tui = new TuiAltScreen(terminal); const theme = defaultClientTheme();
  const exit = vi.fn(); const preferences = vi.fn(async () => false);
  const agents = vi.fn(async (_id?: string) => {});
  const screen = new DaemonTuiScreen(controller as unknown as TuiSessionController, tui, {
    cwd: '/fixture', exit, preferences, agents, theme: () => theme, hasRenderer: isPowerlinePresentation,
  });
  const footer = createClientPowerlineFooter(client as unknown as SessionClient, 'session', { theme: () => theme, requestRender: () => tui.requestRender() });
  screen.setFooter(footer); tui.setLayoutRoot(screen.component); screen.focus(); tui.start();
  cleanups.push(async () => { footer.dispose(); await screen.dispose(); tui.stop(); });
  const raw = () => { tui.renderNow(true); return tui.getScreenLines(); };
  return { screen, tui, terminal, theme, keys, client, controller, exit, preferences, agents,
    raw, lines: () => raw().map(line => stripTerminalSequences(line).trimEnd()),
    change(values: Partial<SessionSnapshot>) { current = { ...current, ...values }; for (const listener of listeners) listener(); },
  };
}

it('matches the released header, accented editor and three-line footer without debug rows', () => {
  const f = fixture();
  expect(f.lines().slice(0, 6).map(line => line.replaceAll(FELAN_VERSION, '<version>'))).toMatchInlineSnapshot(`
    [
      "",
      " ◉  Felan Code v<version>",
      "    get the job done · waste less",
      "",
      " escape interrupt · ctrl+c/ctrl+d clear/exit · / commands · ! bash · ctrl+o more",
      "",
    ]
  `);
  const lines = f.lines();
  expect(lines.slice(-3)).toEqual([
    ' /fixture',
    ' '.repeat(100 - ' (fixture) fixture • xhigh '.length) + ' (fixture) fixture • xhigh',
    ' Memory: disabled',
  ]);
  expect(lines.join('\n')).not.toMatch(/live · idle|Enter send|Shift\+Enter|daemon 0\.2\.0|session ·|UI surfaces/u);
  expect(f.screen.editor.render(100)[0]).toContain(f.theme.getThinkingBorderColor('xhigh')('─'.repeat(100)));
  expect(f.raw().find(line => line.includes('Warning: Memory'))).toContain(f.theme.getFgAnsi('warning'));
  expect(lines.findIndex(line => line.includes('Warning: Memory'))).toBeLessThan(lines.findIndex(line => line.includes('─')));
});

it('places every extension status in the footer, not above the editor or in a UI-surface counter', () => {
  const f = fixture();
  f.change({ presentation: [...f.controller.snapshot.presentation,
    { id: 'codebase-memory', kind: 'status', key: 'codebase-memory', value: { kind: 'text', text: 'Index: ready' }, fallback: 'Index ready' },
  ] });
  const lines = f.lines();
  expect(lines.at(-1)).toContain('Index: ready');
  expect(lines.at(-1)).toContain('Memory: disabled');
  expect(lines.at(-1)).not.toContain(`Felan ${FELAN_VERSION}`);
  expect(lines.slice(0, -1).join('\n')).not.toMatch(/Index: ready|Memory: disabled|UI surfaces/u);
});

it('renders a running execution in the subagent rail and its canonical completion in the transcript', () => {
  const f = fixture();
  f.screen.setExecutions([{ id: 'child', label: 'Build worker', description: 'Compile the project', state: 'running',
    model: { provider: 'fixture', id: 'fixture' } }]);
  expect(f.lines().at(-1)).toContain('● Build worker');
  expect(f.lines().at(-1)).toContain('fixture');
  expect(f.lines().at(-2)).toContain('Memory: disabled');
  f.terminal.input('\x1b[B'); f.terminal.input('\r');
  expect(f.agents).toHaveBeenCalledWith('child');
  f.terminal.input('\x1b'); expect(f.screen.editor.isRailFocused()).toBe(false);
  f.screen.setExecutions([{ id: 'child', label: 'Build worker', state: 'completed' }]);
  f.controller.history.push({ id: 'completion', entryId: 'completion', role: 'custom', timestamp: 1,
    customType: 'felan-execution-completion', content: [{ type: 'text', text: 'Subagent Build worker completed: build passed.' }] });
  f.change({});
  expect(f.lines().join('\n')).not.toContain('● Build worker');
  expect(f.lines().join('\n')).toContain('Subagent Build worker completed: build passed.');
});

it('preserves the editor borders, scrolling and footer padding below a full transcript', () => {
  const f = fixture();
  f.controller.history.push({ id: 'long-answer', entryId: 'long-answer', role: 'assistant', timestamp: 1,
    content: [{ type: 'text', text: Array.from({ length: 80 }, (_, index) => `Transcript row ${index}`).join('\n') }] });
  f.change({});
  const footer = f.lines().slice(-3);
  expect(footer[0]).toBe(' /fixture');
  expect(footer[2]).toBe(' Memory: disabled');
  for (const rows of [30, 20]) {
    f.terminal.rows = rows;
    for (const draft of ['Short draft', Array.from({ length: 30 }, (_, index) => `Draft row ${index}`).join('\n')]) {
      f.screen.editor.setText(draft);
      const editor = f.screen.editor.render(100).map(line => stripTerminalSequences(line).trimEnd());
      const lines = f.lines();
      expect(lines.slice(-3)).toEqual(footer);
      expect(lines.slice(-3 - editor.length, -3)).toEqual(editor);
      expect(lines.at(-4)).toBe('─'.repeat(100));
      expect(lines).toContain(draft === 'Short draft' ? ' Short draft' : ' Draft row 29');
      expect(lines).toContain(' Transcript row 79');
    }
  }
  expect(f.lines().join('\n')).not.toContain('Draft row 0\n');
  f.screen.editor.setText('Draft start\nDraft end');
  expect(f.lines()).toContain(' Draft start');
  expect(f.lines()).toContain(' Draft end');
  f.change({ run: { id: 'run', state: 'running' } });
  const lines = f.lines();
  const working = lines.findIndex(line => line.includes('Working'));
  expect(working).toBeGreaterThan(0);
  expect(lines[working + 1]).toBe('─'.repeat(100));
  expect(lines.at(-4)).toBe('─'.repeat(100));
  expect(lines.slice(-3)).toEqual(footer);
});

it('applies session updates that arrive between frames once, when the next frame renders', () => {
  vi.useFakeTimers();
  const f = fixture(); f.lines();
  const projection = vi.spyOn(f.screen.transcript, 'showProjection');
  for (const title of ['first', 'second', 'third']) f.change({ title, run: { id: 'run', state: 'running' } });
  expect(projection).not.toHaveBeenCalled();
  expect(f.lines().join('\n')).toContain('Working');
  expect(projection).toHaveBeenCalledOnce();
  f.lines(); vi.advanceTimersByTime(1_000);
  expect(projection).toHaveBeenCalledOnce();
});

it('shows a failed update instead of stopping the terminal, and recovers on the next update', () => {
  const f = fixture(); f.lines();
  let failing = true;
  vi.spyOn(f.screen.transcript, 'toolsExpanded', 'get').mockImplementation(() => { if (failing) throw new Error('status unavailable'); return false; });
  f.change({ title: 'failing' });
  expect(f.lines().join('\n')).toContain('Cannot update the screen: status unavailable');
  failing = false; f.change({ title: 'recovered' });
  expect(f.lines().join('\n')).not.toContain('Cannot update the screen');
});

it('shows working state only during a run and reconnecting in the activity slot', () => {
  vi.useFakeTimers();
  const f = fixture();
  expect(f.lines().join('\n')).not.toContain('Working');
  f.change({ run: { id: 'run', state: 'running' } });
  const frames = ['⠐◉ ', '⠈◉ ', ' ◉⠁', ' ◉⠂', ' ◉⠄', '⠠◉ '];
  for (const frame of frames) {
    const lines = f.lines();
    const row = lines.findIndex(line => line.includes('Working'));
    expect(lines[row]).toBe(` ${frame} Working`);
    expect(lines[row + 1]).toContain('─');
    expect(f.raw()[row]).toContain(f.theme.fg('accent', frame));
    expect(f.raw()[row]).toContain(f.theme.getThinkingBorderColor('xhigh')('Working'));
    vi.advanceTimersByTime(120);
  }
  f.terminal.input('\x1b'); expect(f.controller.cancel).toHaveBeenCalledOnce();
  f.change({ run: { state: 'idle' } });
  expect(f.lines().join('\n')).not.toContain('Working');
  f.client.status = 'disconnected'; f.change({});
  expect(f.lines().join('\n')).toContain('Daemon disconnected. Use /reconnect to retry.');
  f.client.reconnection = { attempt: 3, retryAt: Date.now() + 4_000 }; f.change({});
  expect(f.lines().join('\n')).toContain('Reconnecting…');
  expect(f.lines().join('\n')).not.toContain('Daemon disconnected');
  const projection = vi.spyOn(f.screen.transcript, 'showProjection');
  vi.advanceTimersByTime(1_000);
  expect(f.lines().join('\n')).toContain('Reconnecting…'); expect(projection).not.toHaveBeenCalled();
  f.client.reconnection = undefined; f.client.status = 'ready'; f.change({});
  expect(f.lines().join('\n')).not.toContain('Daemon disconnected');
});

it('uses extension working messages only in the active loader, including updates and reset', () => {
  const f = fixture();
  const presentation = [...f.controller.snapshot.presentation,
    { id: 'working', kind: 'status' as const, key: 'working', value: { kind: 'text' as const, text: 'Planning the work' }, fallback: 'Planning' },
  ];
  f.change({ presentation });
  expect(f.lines().join('\n')).not.toContain('Planning the work');
  f.change({ run: { id: 'run', state: 'running' } });
  expect(f.lines().filter(line => line.includes('Planning the work'))).toHaveLength(1);
  expect(f.lines().slice(-3).join('\n')).not.toContain('Planning the work');
  f.change({ presentation: presentation.filter(item => item.id !== 'working') });
  expect(f.lines().join('\n')).toContain('Working');
  expect(f.lines().join('\n')).not.toContain('Planning the work');
  f.change({ run: { state: 'interrupted' }, presentation });
  expect(f.lines().join('\n')).not.toMatch(/Planning the work|Working/u);
});

it('renders slash completions without a leading slash and with command and skill descriptions', async () => {
  const f = fixture();
  f.change({ catalog: { ...f.controller.snapshot.catalog, commands: [
    { name: 'skill:alpha', description: 'Alpha skill instructions', source: '/skills/alpha/SKILL.md', kind: 'skill' },
    { name: 'skill:beta', description: 'Beta skill instructions', source: '/skills/beta/SKILL.md', kind: 'skill' },
  ] } });
  f.terminal.input('/');
  await vi.waitFor(() => expect(f.lines().join('\n')).toContain('Open settings menu'));
  expect(f.lines().find(line => line.includes('Open settings menu'))).not.toContain('/settings');
  f.terminal.input('skill:');
  await vi.waitFor(() => expect(f.lines().join('\n')).toContain('Alpha skill instructions'));
  const lines = f.lines().filter(line => /skill instructions/u.test(line));
  expect(lines).toHaveLength(2);
  expect(lines[0]).toContain('skill:alpha'); expect(lines[1]).toContain('skill:beta');
  expect(lines.join('\n')).not.toContain('/skill:');
  f.terminal.input('\t');
  expect(f.screen.editor.getText()).toBe('/skill:alpha ');
});

it('mounts tasks inline with themed borders, preserves the draft and restores editor focus', async () => {
  const f = fixture(); f.screen.editor.setText('retained draft');
  const ui = createPresentationUi(f.tui, f.screen.dialogs, f.theme, f.keys, () => {});
  const source: UiView = { id: 'tasks', kind: 'view', revision: 1, title: 'Tasks — current', fallback: 'One task',
    fields: [{ id: 'title', label: 'Title', valueKind: 'text' }],
    items: [{ id: 'T-ABC123', values: { title: 'Restore visual parity' }, fallback: 'Pending' }],
    actions: [{ id: 'close', label: 'Close', target: 'element', outcome: 'cancel' }],
  };
  const result = presentTasksElement(source, ui, new AbortController().signal, async () => undefined);
  expect(f.tui.hasOverlay()).toBe(false);
  expect(f.lines().join('\n')).toContain('Restore visual parity');
  expect(f.lines().join('\n')).not.toContain('retained draft');
  expect(f.raw().some(line => line.includes(f.theme.getFgAnsi('border')) && line.includes('─'))).toBe(true);
  f.terminal.input('\x1b'); await result;
  expect(f.screen.editor.getText()).toBe('retained draft');
  expect(f.lines().join('\n')).toContain('retained draft');
  f.terminal.input(' edited'); expect(f.screen.editor.getText()).toBe('retained draft edited');
});

it('keeps explicit overlays as overlays', async () => {
  const f = fixture();
  const overlay = f.screen.dialogs.custom(done => ({ render: () => ['Overlay'], invalidate() {}, handleInput: () => done(undefined) }), { overlay: true });
  expect(f.tui.hasOverlay()).toBe(true); f.terminal.input('\x1b'); await overlay;
  expect(f.tui.hasOverlay()).toBe(false);
});

it('clears submitted commands and prompts immediately and retains history after cancellation', async () => {
  const f = fixture();
  for (const text of ['/settings', '! echo parity', 'ordinary prompt']) {
    f.screen.editor.setText(text); const submitted = f.screen.submit(text);
    expect(f.screen.editor.getText()).toBe(''); await submitted;
    f.terminal.input('\x1b[A'); expect(f.screen.editor.getText()).toBe(text); f.screen.editor.setText('');
  }
  expect(f.preferences).toHaveBeenCalledOnce();
  expect(f.controller.submit).toHaveBeenCalledWith('ordinary prompt');
  f.terminal.input('\x03'); f.terminal.input('\x03'); expect(f.exit).toHaveBeenCalledOnce();
});

it('shows a static UI wait instead of an active-work spinner and clears it on idle', () => {
  const f = fixture();
  f.change({ run: { id: 'view-command', state: 'waiting' } });
  expect(f.lines().join('\n')).toContain('Waiting for UI');
  expect(f.lines().join('\n')).not.toContain('Working');
  f.change({ run: { id: 'view-command', state: 'idle' } });
  expect(f.lines().join('\n')).not.toContain('Waiting for UI');
});

class TestTerminal implements Terminal {
  columns = 100; rows = 30; kittyProtocolActive = false;
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


it('shows process activity without Powerline and removes it on completion', () => {
  const f = fixture();
  const process = { id: 'process', kind: 'background' as const, owner: 'session', state: 'running' as const, startedAt: 0 };
  f.change({ presentation: [], processes: [process] });
  expect(f.lines().join('\n')).toContain('● 1 process');
  f.change({ processes: [process, { ...process, id: 'second' }] });
  expect(f.lines().join('\n')).toContain('● 2 processes');
  f.change({ processes: [{ ...process, state: 'completed' }] });
  expect(f.lines().join('\n')).not.toContain('● 1 process');
});
