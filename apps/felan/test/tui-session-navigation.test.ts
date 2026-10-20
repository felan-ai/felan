import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CURSOR_MARKER, setKeybindings, stripTerminalSequences, visibleWidth, TuiAltScreen, type Component, type Terminal, type ProgramStatus } from '@earendil-works/pi-tui';
import type { OperationResult } from '@felan-ai/session-protocol';
import { SessionNavigator, type NavigationDialogs, type SessionRow } from '../src/tui/session-navigator.js';
import { TreeNavigator } from '../src/tui/tree-navigator.js';
import { createClientKeybindings } from '../src/tui/keybindings.js';
import { defaultClientTheme } from '../src/tui/theme.js';
import { submitTuiInput } from '../src/tui/commands.js';
import type { TuiSessionController } from '../src/tui/controller.js';
import { DaemonTuiScreen } from '../src/tui/screen.js';
import { snapshot } from './client-fixtures.js';

beforeEach(() => setKeybindings(createClientKeybindings()));
const clean = (component: Component, width = 180) => component.render(width).map(stripTerminalSequences).join('\n');
const row = (session: string, overrides: Partial<SessionRow> = {}): SessionRow => ({
  session, root: session, cwd: '/fixture', title: '', revision: 3, state: 'open', residency: 'warm', lastActivity: 1,
  run: { state: 'idle' }, policy: { effective: 'host-default', generation: 0 }, ...overrides,
});
const tree = (): OperationResult<'session.tree'> => ({ revision: 9, branch: 'reply', entries: [
  { id: 'model', kind: 'model_change', title: 'model: fixture', summary: '', timestamp: 1 },
  { id: 'prompt', parent: 'model', kind: 'message', role: 'user', summary: 'say hi', timestamp: 2 },
  { id: 'reply', parent: 'prompt', kind: 'message', role: 'assistant', summary: 'Hello', stopReason: 'stop', timestamp: 3 },
  { id: 'alternate', parent: 'prompt', kind: 'message', role: 'assistant', summary: 'Other branch', stopReason: 'stop', timestamp: 4, label: 'Alternative' },
  { id: 'tool', parent: 'alternate', kind: 'message', role: 'toolResult', title: 'read: a.ts', summary: 'done', timestamp: 5 },
] });

describe('session navigator (R17)', () => {
  const minutesAgo = (minutes: number) => Date.now() - minutes * 60_000;

  it('adds later pages once each, keeps the selection, and reports loading until the last page', async () => {
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    async function* pages() {
      yield [row('current', { title: 'Current', lastActivity: minutesAgo(5) })];
      await gate;
      yield [row('current', { title: 'Current', lastActivity: minutesAgo(5) }), row('elsewhere', { cwd: '/other', title: 'Elsewhere', lastActivity: minutesAgo(90) })];
    }
    const render = vi.fn();
    const picker = new SessionNavigator([row('current', { title: 'Current', lastActivity: minutesAgo(5) })], '/fixture', undefined, () => {}, undefined, true, () => 22);
    picker.follow(pages(), render);
    expect(clean(picker)).toContain('(1/1, loading)');
    release();
    await vi.waitFor(() => expect(clean(picker)).not.toContain('loading'));
    expect(clean(picker)).toContain('(1/1)'); expect(clean(picker)).not.toContain('Elsewhere');
    expect(clean(picker)).toContain('› Current');
    picker.handleInput('\t');
    expect(clean(picker)).toContain('Elsewhere'); expect(clean(picker)).toContain('(1/2)');
    for (const character of 'elsewhere') picker.handleInput(character);
    expect(clean(picker)).toContain('Elsewhere'); expect(clean(picker)).not.toContain('› Current');
    expect(render).toHaveBeenCalled();
  });

  it('shows a loading notice instead of an empty result until the first rows arrive', async () => {
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    async function* pages() { await gate; yield [row('late', { title: 'Late' })]; }
    const picker = new SessionNavigator([], '/fixture', undefined, () => {}, undefined, true, () => 22);
    picker.follow(pages(), () => {});
    expect(clean(picker)).toContain('Loading sessions…'); expect(clean(picker)).not.toContain('No sessions');
    release();
    await vi.waitFor(() => expect(clean(picker)).toContain('Late'));
  });

  it('stops reading later pages once the picker is closed', async () => {
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    const resumed = vi.fn();
    async function* pages() { yield [row('one', { title: 'One' })]; await gate; resumed(); yield [row('two', { title: 'Two' })]; }
    const picker = new SessionNavigator([], '/fixture', undefined, () => {}, undefined, true, () => 22);
    picker.follow(pages(), () => {});
    await vi.waitFor(() => expect(clean(picker)).toContain('One'));
    picker.dispose(); release();
    await vi.waitFor(() => expect(resumed).toHaveBeenCalled());
    expect(clean(picker)).not.toContain('Two');
  });

  it('shows names, current folder, selected session and All scope with folders only in All', () => {
    const done = vi.fn(); const theme = defaultClientTheme();
    const picker = new SessionNavigator([row('current', { title: 'Current task', lastActivity: minutesAgo(5) }), row('other', { cwd: '/elsewhere', title: 'Elsewhere' })], '/fixture', 'current', done, () => theme);
    const output = clean(picker);
    expect(output).toContain('Resume Session (Current Folder)'); expect(output).toContain('◉ Current Folder | ○ All  Name: All  Sort: Recent');
    expect(output).toMatch(/› Current task +5m\n/u);
    expect(output).not.toContain('/fixture'); expect(output).not.toContain('Elsewhere');
    expect(picker.render(180).join('\n')).toContain(theme.getFgAnsi('accent'));
    picker.handleInput('\t'); expect(clean(picker)).toContain('Resume Session (All)'); expect(clean(picker)).toMatch(/Elsewhere +\/elsewhere 56y/u);
    picker.handleInput('\x1b[B'); picker.handleInput('\r'); expect(done).toHaveBeenCalledWith({ action: 'resume', session: 'other' });
  });

  it('labels unnamed sessions by their first user message, then their ID, with age and only actionable state', () => {
    const picker = new SessionNavigator([
      row('preview', { preview: 'Fix the\nflaky test', lastActivity: minutesAgo(3 * 60), residency: 'evicted' }),
      row('019a-empty', { lastActivity: minutesAgo(2 * 24 * 60) }),
      row('busy', { title: 'Busy', run: { state: 'running' }, lastActivity: minutesAgo(1) }),
      row('asking', { preview: 'Asking', run: { state: 'waiting' }, lastActivity: minutesAgo(2) }),
    ], '/fixture', undefined, () => {});
    const output = clean(picker);
    expect(output).toMatch(/Fix the flaky test +3h/u); expect(output).toMatch(/019a-empty +2d/u);
    expect(output).toMatch(/Busy +running 1m/u); expect(output).toMatch(/Asking +waiting for input 2m/u);
    for (const internal of ['idle', 'warm', 'evicted', ' · ']) expect(output.split('\n').slice(8).join('\n')).not.toContain(internal);
  });

  it('keeps a stable viewport, scrolls only past an edge and always shows the counter', () => {
    const rows = Array.from({ length: 10 }, (_, index) => row(`s${index}`, { title: `Session ${index}`, lastActivity: 100 - index }));
    const listed = (picker: SessionNavigator) => clean(picker).split('\n').filter(line => /Session \d/u.test(line)).map(line => line.trim().replace(/^› /u, '').split(/ {2,}/u)[0]);
    const full = new SessionNavigator(rows, '/fixture', undefined, () => {}, undefined, true, () => 22);
    for (let step = 0; step < 9; step++) full.handleInput('\x1b[B');
    expect(listed(full)).toHaveLength(10); expect(clean(full)).toContain('(10/10)');
    let height = 17; const picker = new SessionNavigator(rows, '/fixture', undefined, () => {}, undefined, true, () => height);
    const lines = () => picker.render(120);
    expect(lines()).toHaveLength(17); expect(listed(picker)).toEqual(['Session 0', 'Session 1', 'Session 2', 'Session 3', 'Session 4']);
    for (let step = 0; step < 4; step++) picker.handleInput('\x1b[B');
    expect(listed(picker)[0]).toBe('Session 0'); expect(lines()).toHaveLength(17);
    picker.handleInput('\x1b[B'); expect(listed(picker)).toEqual(['Session 1', 'Session 2', 'Session 3', 'Session 4', 'Session 5']);
    picker.handleInput('\x1b[6~'); picker.handleInput('\x1b[6~'); expect(listed(picker).at(-1)).toBe('Session 9');
    expect(lines()).toHaveLength(17); expect(clean(picker)).toContain('(10/10)');
    for (let step = 0; step < 4; step++) picker.handleInput('\x1b[A');
    expect(listed(picker)[0]).toBe('Session 5'); picker.handleInput('\x1b[A'); expect(listed(picker)[0]).toBe('Session 4');
    height = 13; expect(lines()).toHaveLength(13); expect(listed(picker)).toEqual(['Session 4']); expect(clean(picker)).toContain('(5/10)');
  });

  it('searches fuzzy names, previews, IDs, folders and active state, with exact phrases and no-match recovery', () => {
    const rows = [row('abc-123', { title: 'Release planning', cwd: '/fixture/backend', run: { state: 'waiting' } }), row('def', { title: 'Other' }),
      row('ghi', { preview: 'deploy the docs', cwd: '/fixture/backend' })];
    for (const query of ['rlspln', 'abc-123', 'waiting', '"release planning"']) {
      const picker = new SessionNavigator(rows, '/fixture/backend', undefined, () => {});
      picker.handleInput(query); expect(clean(picker)).toContain('Release planning'); expect(clean(picker)).not.toContain('Other');
    }
    const preview = new SessionNavigator(rows, '/fixture/backend', undefined, () => {});
    preview.handleInput('"deploy"'); expect(clean(preview)).toContain('deploy the docs'); expect(clean(preview)).not.toContain('Release planning');
    const picker = new SessionNavigator(rows, '/fixture/backend', undefined, () => {});
    picker.handleInput('"no match"'); expect(clean(picker)).toContain('No matching sessions.');
    picker.handleInput('\x15'); expect(clean(picker)).toContain('Release planning');
  });

  it('offers sort, name filtering, identity display, current rename and inline-confirmed delete', () => {
    const done = vi.fn(); const picker = new SessionNavigator([row('current', { title: 'Named' }), row('unnamed', { preview: 'Unnamed prompt' })], '/fixture', 'current', done);
    expect(clean(picker)).toContain('ctrl+s sort · ctrl+n named · ctrl+d delete · ctrl+p path (off) · ctrl+r rename');
    picker.handleInput('\x13'); expect(clean(picker)).toContain('Sort: Name');
    picker.handleInput('\x0e'); expect(clean(picker)).not.toContain('Unnamed prompt'); expect(clean(picker)).toContain('Name: Named');
    picker.handleInput('\x10'); expect(clean(picker)).toMatch(/Named +current 56y/u); expect(clean(picker)).toContain('path (on)');
    picker.handleInput('\x04'); expect(done).not.toHaveBeenCalled(); expect(clean(picker)).toContain('Cannot delete the currently active session.');
    picker.handleInput('\x12'); expect(done).toHaveBeenCalledWith({ action: 'rename', session: 'current' });
    const open = new SessionNavigator([row('open', { title: 'Open' })], '/fixture', undefined, done);
    open.handleInput('\x04'); expect(clean(open)).toContain('Delete session? enter confirm · escape/ctrl+c cancel');
    open.handleInput('x'); open.handleInput('\x1b'); expect(done).toHaveBeenCalledTimes(1); expect(clean(open)).not.toContain('Delete session?');
    open.handleInput('\x04'); open.handleInput('\r'); expect(done).toHaveBeenLastCalledWith({ action: 'delete', session: 'open' });
  });

  it('keeps startup selection read-only, handles empty scopes, cancellation, sanitization and narrow widths', () => {
    const done = vi.fn(); const picker = new SessionNavigator([row('elsewhere', { cwd: '/other', title: '\x1b[31mUnsafe\nname' })], '/fixture', undefined, done, undefined, false);
    expect(clean(picker)).toContain('No sessions in current folder. Press Tab to view all.');
    picker.handleInput('\t'); expect(clean(picker)).toContain('Unsafe name'); expect(clean(picker)).not.toContain('delete'); expect(clean(picker)).not.toContain('rename');
    for (const width of [40, 80, 120]) expect(picker.render(width).every(line => visibleWidth(line) <= width)).toBe(true);
    picker.handleInput('\x1b'); expect(done).toHaveBeenCalledWith(undefined);
  });
});

describe('tree navigator (R18)', () => {
  it('renders roles, hierarchy and current leaf, hiding bookkeeping by default', () => {
    const done = vi.fn(); const picker = new TreeNavigator(tree(), done);
    const output = clean(picker);
    expect(output).toContain('user: say hi'); expect(output).toContain('› ├─ • assistant: Hello');
    expect(output).toContain('└⊟ [Alternative] assistant: Other branch'); expect(output).toContain('[read: a.ts]');
    expect(output).not.toContain('[model: fixture]');
    picker.handleInput('\r'); expect(done).toHaveBeenCalledWith({ action: 'select', entryId: 'reply' });
    for (const width of [40, 80, 120]) expect(picker.render(width).every(line => visibleWidth(line) <= width)).toBe(true);
  });

  it('filters user, tools, labels and all nodes, searches and restores the current selection', () => {
    const done = vi.fn(); const picker = new TreeNavigator(tree(), done);
    picker.handleInput('\x15'); expect(clean(picker)).toContain('user: say hi'); expect(clean(picker)).not.toContain('assistant:');
    picker.handleInput('\x01'); expect(clean(picker)).toContain('[model: fixture]');
    picker.handleInput('\x14'); expect(clean(picker)).not.toContain('[read: a.ts]');
    picker.handleInput('\x0c'); expect(clean(picker)).toContain('[Alternative]'); expect(clean(picker)).not.toContain('say hi');
    picker.handleInput('\x04'); picker.handleInput('\r'); expect(done).toHaveBeenLastCalledWith({ action: 'select', entryId: 'alternate' });
    picker.handleInput('Other'); expect(clean(picker)).toContain('Other branch'); expect(clean(picker)).not.toContain('assistant: Hello');
  });

  it('folds and unfolds branches, navigates to parents, supports labels and copies the projected preview', async () => {
    const done = vi.fn(); const copy = vi.fn(async () => {}); const picker = new TreeNavigator(tree(), done, undefined, 'prompt', copy);
    picker.handleInput('\x1b[1;3D'); expect(clean(picker)).not.toContain('Hello');
    picker.handleInput('\x1b[1;3C'); expect(clean(picker)).toContain('Hello');
    picker.handleInput('\x1b[1;3C'); picker.handleInput('\x18'); await vi.waitFor(() => expect(clean(picker)).toContain('Text preview copied.'));
    expect(copy).toHaveBeenCalledWith('Hello');
    picker.handleInput('L');
    expect(picker.render(100).join('\n').split(CURSOR_MARKER)).toHaveLength(2);
    picker.handleInput('Bookmark'); picker.handleInput('\r');
    expect(done).toHaveBeenCalledWith({ action: 'label', entryId: 'reply', label: 'Bookmark', view: expect.any(Object) });
  });

  it('uses effective keys, handles empty filtered trees and cancels label editing without mutation', () => {
    setKeybindings(createClientKeybindings({ 'app.tree.filter.userOnly': 'ctrl+g' }));
    const done = vi.fn(); const picker = new TreeNavigator(tree(), done);
    picker.handleInput('\x07'); expect(clean(picker)).not.toContain('assistant:');
    picker.handleInput('\x04'); picker.handleInput('L'); picker.handleInput('No save'); picker.handleInput('\x1b'); expect(done).not.toHaveBeenCalled();
    picker.handleInput('not found'); expect(clean(picker)).toContain('No entries found'); picker.handleInput('\r'); expect(done).not.toHaveBeenCalled();
    picker.handleInput('\x1b'); expect(done).not.toHaveBeenCalled(); picker.handleInput('\x1b'); expect(done).toHaveBeenCalledWith(undefined);
    expect(clean(new TreeNavigator({ entries: [], branch: 'empty', revision: 0 }, () => {}))).toContain('No entries found');
  });

  it('returns view state with a label edit so the reopened tree keeps filter, search and label times', () => {
    const done = vi.fn(); const picker = new TreeNavigator(tree(), done);
    picker.handleInput('\x15'); picker.handleInput('T'); picker.handleInput('L'); picker.handleInput('Mark'); picker.handleInput('\r');
    const view = done.mock.calls[0]![0].view;
    expect(view).toEqual({ filter: 'userOnly', query: '', folded: [], showLabelTimestamps: true });
    const reopened = clean(new TreeNavigator(tree(), vi.fn(), undefined, 'prompt', undefined, undefined, undefined, view));
    expect(reopened).toContain('[user]'); expect(reopened).toContain('[+label time]'); expect(reopened).not.toContain('assistant:');
  });

  it('shows clipboard failure without dismissing the tree or changing selection', async () => {
    const done = vi.fn(); const render = vi.fn(); const picker = new TreeNavigator(tree(), done, undefined, undefined,
      async () => { throw new Error('Unavailable'); }, render);
    picker.handleInput('\x18'); await vi.waitFor(() => expect(clean(picker)).toContain('Clipboard unavailable.'));
    expect(render).toHaveBeenCalledOnce(); expect(done).not.toHaveBeenCalled();
    picker.handleInput('\r'); expect(done).toHaveBeenCalledWith({ action: 'select', entryId: 'reply' });
  });
});

const listing = (first: SessionRow[]) => ({ first, more: (async function* () {})() });
function commandFixture(inputs: string[][] = []) {
  const current = snapshot();
  const controller = { snapshot: current, sessionId: current.session, history: [], notice: '',
    setNotice(message: string) { this.notice = message; },
    create: vi.fn(async () => {}), attach: vi.fn(async () => {}), loadHistory: vi.fn(async () => {}),
    sessionListing: vi.fn(async () => ({ first: [row(current.session, { title: 'Current' }), row('other', { title: 'Other', lastActivity: 0 })], more: (async function* () {})() })),
    tree: vi.fn(async () => tree()), perform: vi.fn(async () => ({ outcome: 'accepted', result: {} })),
  };
  const dialogs: NavigationDialogs = { input: vi.fn(async () => 'Renamed'), confirm: vi.fn(async () => true), select: vi.fn(async () => 'no'),
    custom: async factory => new Promise((resolve, reject) => { void Promise.resolve(factory(resolve)).then(component => {
      component.render(180); for (const input of inputs.shift() ?? ['\x1b']) component.handleInput?.(input);
    }).catch(reject); }),
  };
  const submit = (text: string) => submitTuiInput(controller as unknown as TuiSessionController, dialogs, text, { cwd: '/fixture', exit() {} });
  return { controller, dialogs, submit };
}

describe('session commands (R17–R19)', () => {
  it('reports an empty session without opening an empty tree', async () => {
    const f = commandFixture(); f.controller.tree.mockResolvedValueOnce({ revision: 1, branch: 'none', entries: [] });
    expect(await f.submit('/tree')).toBe(true); expect(f.controller.notice).toBe('No entries in session'); expect(f.controller.perform).not.toHaveBeenCalled();
  });

  it('sets new and rename success notices only after authoritative success', async () => {
    const f = commandFixture();
    expect(await f.submit('/new')).toBe(true); expect(f.controller.notice).toBe('✓ New session started');
    expect(await f.submit('/rename parity')).toBe(true); expect(f.controller.notice).toBe('Session name set: parity');
    f.controller.create.mockRejectedValueOnce(new Error('denied'));
    await expect(f.submit('/new')).rejects.toThrow('denied'); expect(f.controller.notice).toBe('');
    f.controller.perform.mockResolvedValueOnce({ outcome: 'rejected', result: {} });
    expect(await f.submit('/rename denied')).toBe(false); expect(f.controller.notice).not.toContain('Session name set');
  });

  it('resumes by stable identity and renames the current selection', async () => {
    const f = commandFixture([['\x1b[B', '\r'], ['\x12']]);
    expect(await f.submit('/sessions')).toBe(true); expect(f.controller.attach).toHaveBeenCalledWith('other');
    expect(await f.submit('/resume')).toBe(true);
    expect(f.controller.perform).toHaveBeenCalledWith('session.rename', { name: 'Renamed' }, 'session');
    expect(f.controller.notice).toBe('Session name set: Renamed');
  });

  it('deletes an open session after the inline confirmation without another dialog', async () => {
    const f = commandFixture([['\x04', '\r']]);
    f.controller.sessionListing.mockResolvedValueOnce(listing([row('open', { revision: 17 })]));
    expect(await f.submit('/sessions')).toBe(true);
    expect(f.dialogs.confirm).not.toHaveBeenCalled();
    expect(f.controller.perform).toHaveBeenCalledWith('session.delete', {}, 'open');
  });

  it('does not mutate for the current leaf; sends the explicit summary choice for navigation', async () => {
    const f = commandFixture([['\r'], ['\x1b[B', '\r']]);
    expect(await f.submit('/tree')).toBe(true); expect(f.controller.notice).toBe('Already at this point'); expect(f.controller.perform).not.toHaveBeenCalled();
    expect(await f.submit('/tree')).toBe(true);
    expect(f.controller.perform).toHaveBeenCalledWith('session.branch.select', { entryId: 'alternate', summarize: false }, 'session');
    expect(f.controller.loadHistory).toHaveBeenCalledOnce();
  });

  it('saves labels and reopens the tree; rejected navigation does not load history', async () => {
    const f = commandFixture([['L', 'Saved', '\r'], ['\x1b'], ['\x1b[B', '\r']]);
    expect(await f.submit('/tree')).toBe(false);
    expect(f.controller.perform).toHaveBeenCalledWith('session.entry.label', { entryId: 'reply', label: 'Saved' }, 'session');
    expect(f.controller.tree).toHaveBeenCalledTimes(2);
    f.controller.perform.mockResolvedValueOnce({ outcome: 'rejected', result: {} });
    expect(await f.submit('/tree')).toBe(false); expect(f.controller.loadHistory).not.toHaveBeenCalled();
  });

  it('does not delete on cancelled confirmation and returns to the same tree selection on cancelled summary', async () => {
    const deletion = commandFixture([['\x04', '\x1b', '\x1b']]);
    deletion.controller.sessionListing.mockResolvedValueOnce(listing([row('open')]));
    expect(await deletion.submit('/sessions')).toBe(false); expect(deletion.controller.perform).not.toHaveBeenCalled();
    const navigation = commandFixture([['\x1b[B', '\r'], ['\r']]);
    vi.mocked(navigation.dialogs.select).mockResolvedValueOnce(undefined).mockResolvedValueOnce('yes');
    expect(await navigation.submit('/tree')).toBe(true);
    expect(navigation.controller.perform).toHaveBeenCalledExactlyOnceWith('session.branch.select', { entryId: 'alternate', summarize: true }, 'session');
  });
});

it('keeps tree and picker headings, current selection and draft usable in an 80×24 inline screen', async () => {
  const f = commandFixture(); const terminal = new TestTerminal(); const tui = new TuiAltScreen(terminal);
  const controller = Object.assign(f.controller, { client: { status: 'ready' }, busy: false, subscribe: () => () => {} });
  const screen = new DaemonTuiScreen(controller as unknown as TuiSessionController, tui, { cwd: '/fixture', exit() {} });
  screen.setFooter({ render: () => ['Footer one', 'Footer two', 'Footer three'], invalidate() {} });
  tui.setLayoutRoot(screen.component); screen.focus(); tui.start();
  const lines = () => { tui.renderNow(true); return tui.getScreenLines().map(stripTerminalSequences).join('\n'); };
  try {
    screen.editor.setText('retained draft');
    f.controller.tree.mockResolvedValueOnce({ ...tree(), entries: [...tree().entries,
      ...Array.from({ length: 25 }, (_, index) => ({ id: `extra-${index}`, parent: 'alternate', kind: 'message', role: 'user', summary: `Extra ${index}`, timestamp: 6 + index })),
    ] });
    const treeView = screen.submit('/tree', true);
    await vi.waitFor(() => expect(lines()).toContain('Session Tree'));
    expect(lines()).toContain('├─ • assistant: Hello'); expect(lines()).toContain('Footer three');
    terminal.input('\x1b'); await treeView; expect(screen.editor.getText()).toBe('retained draft');
    f.controller.sessionListing.mockResolvedValueOnce(listing([row('session', { title: 'Current' }), ...Array.from({ length: 25 }, (_, index) => row(`extra-${index}`))]));
    const picker = screen.submit('/sessions', true);
    await vi.waitFor(() => expect(lines()).toContain('Resume Session (Current'));
    expect(lines()).toMatch(/› Current +56y\n {2}\(26\/26\)\n\n─+\nFooter one/u); terminal.input('\x10');
    expect(lines()).toMatch(/› Current +session 56y\n {2}\(26\/26\)\n/u); expect(lines()).toContain('Footer three');
    for (let step = 0; step < 8; step++) terminal.input('\x1b[A');
    expect(lines()).toContain('(18/26)'); expect(lines().split('\n').filter(line => / 56y\s*$/u.test(line))).toHaveLength(9);
    terminal.input('\x1b'); await picker;
    expect(screen.editor.getText()).toBe('retained draft'); terminal.input(' typed'); expect(screen.editor.getText()).toBe('retained draft typed');
  } finally { await screen.dispose(); tui.stop(); }
});

class TestTerminal implements Terminal {
  columns = 80; rows = 24; kittyProtocolActive = false;
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

it('wraps tree arrows at both boundaries without wrapping page navigation', () => {
  const source = tree(); source.entries = source.entries.filter(entry => ['model', 'prompt', 'reply'].includes(entry.id));
  const picker = new TreeNavigator(source, vi.fn());
  expect(clean(picker)).toContain('(2/2)');
  picker.handleInput('\x1b[B'); expect(clean(picker)).toContain('(1/2)');
  picker.handleInput('\x1b[A'); expect(clean(picker)).toContain('(2/2)');
  picker.handleInput('\x1b[6~'); expect(clean(picker)).toContain('(2/2)');
  const empty = new TreeNavigator({ ...source, entries: [] }, vi.fn());
  empty.handleInput('\x1b[B'); expect(clean(empty)).toContain('No entries found');
});
