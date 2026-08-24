import { describe, expect, it, vi } from 'vitest';
import type { SessionInfo } from '@earendil-works/pi-coding-agent';
import { Key, type Component, type TUI } from '@earendil-works/pi-tui';
import { LocalSessionPicker, selectLocalSession } from '../src/session-picker.js';

describe('local session picker', () => {
  it('shows current sessions and identifying metadata without mutation actions', () => {
    const picker = createPicker([
      session('current', { name: 'Current task', messageCount: 4 }),
    ], [
      session('current', { name: 'Current task', messageCount: 4 }),
      session('other', { cwd: '/other/project' }),
    ]);

    const output = picker.render(200).join('\n');

    expect(output).toContain('Resume Session (Current Folder)');
    expect(output).toContain('Current task');
    expect(output).toContain('4 messages');
    expect(output).not.toMatch(/delete|rename/i);
    expect(output).not.toContain('/other/project');
  });

  it('switches scope, sort, named filtering, and path display', () => {
    const named = session('named', { name: 'Named session', cwd: '/other/project' });
    const unnamed = session('unnamed', { firstMessage: 'Unsorted work', path: '/sessions/unnamed.jsonl' });
    const picker = createPicker([], [unnamed, named]);

    picker.handleInput(keyData(Key.tab));
    expect(picker.render(200).join('\n')).toContain('/other/project');

    picker.handleInput(keyData(Key.ctrl('n')));
    expect(picker.render(200).join('\n')).toContain('Named session');
    expect(picker.render(200).join('\n')).not.toContain('Unsorted work');

    picker.handleInput(keyData(Key.ctrl('p')));
    expect(picker.render(200).join('\n')).toContain('/sessions/named.jsonl');

    picker.handleInput(keyData(Key.ctrl('s')));
    expect(picker.render(200)[0]).toContain('Sort: Recent');
  });

  it('searches session id, name, messages, and cwd', () => {
    const candidates = [
      session('id-match'),
      session('named', { name: 'Release work' }),
      session('message', { allMessagesText: 'Investigate database timeout' }),
      session('cwd', { cwd: '/projects/observability' }),
    ];

    for (const [query, expected] of [
      ['id-match', 'id-match'],
      ['release', 'named'],
      ['database', 'message'],
      ['observability', 'cwd'],
    ]) {
      const picker = createPicker(candidates, candidates);
      picker.handleInput(query);
      const output = picker.render(200).join('\n');
      expect(output).toContain(expected);
    }
  });

  it('renders threaded sessions and selects the highlighted exact path', () => {
    const selected: string[] = [];
    const root = session('root');
    const child = session('child', { parentSessionPath: root.path });
    const picker = new LocalSessionPicker([root, child], [root, child], (path) => selected.push(path), () => {});

    expect(picker.render(200).join('\n')).toContain('└─ child');
    picker.handleInput(keyData(Key.down));
    picker.handleInput(keyData(Key.enter));

    expect(selected).toEqual([child.path]);
  });

  it('explains an empty current scope and cancels cleanly', () => {
    let cancelled = false;
    const picker = new LocalSessionPicker([], [session('other')], () => {}, () => {
      cancelled = true;
    });

    expect(picker.render(100).join('\n')).toContain('Press Tab to view all');
    picker.handleInput(keyData(Key.escape));
    expect(cancelled).toBe(true);
  });

  it('does not start a TUI when no local sessions exist', async () => {
    const createTui = vi.fn();

    await expect(selectLocalSession({
      currentSessions: [],
      allSessions: [],
      agentDir: '/agent',
      createTui,
    })).resolves.toBeUndefined();
    expect(createTui).not.toHaveBeenCalled();
  });

  it('stops the picker TUI after selection', async () => {
    const tui = fakeTui();
    const result = selectLocalSession({
      currentSessions: [session('selected')],
      allSessions: [session('selected')],
      agentDir: '/agent',
      createTui: () => tui,
    });

    (tui.children[0] as LocalSessionPicker).handleInput(keyData(Key.enter));

    await expect(result).resolves.toBe('/sessions/selected.jsonl');
    expect(tui.stop).toHaveBeenCalledOnce();
  });
});

function createPicker(current: SessionInfo[], all: SessionInfo[]): LocalSessionPicker {
  return new LocalSessionPicker(current, all, () => {}, () => {});
}

function session(id: string, overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    path: `/sessions/${id}.jsonl`,
    id,
    cwd: '/current/project',
    name: undefined,
    parentSessionPath: undefined,
    firstMessage: id,
    allMessagesText: '',
    messageCount: 1,
    created: new Date('2026-08-24T10:00:00Z'),
    modified: new Date('2026-08-24T11:00:00Z'),
    ...overrides,
  };
}

function keyData(key: string): string {
  const map: Record<string, string> = {
    tab: '\t',
    enter: '\r',
    escape: '\x1b',
    down: '\x1b[B',
    'ctrl+n': '\x0e',
    'ctrl+p': '\x10',
    'ctrl+s': '\x13',
  };
  const data = map[key];
  if (!data) throw new Error(`Missing test key data for ${key}`);
  return data;
}

function fakeTui(): TUI {
  const children: Component[] = [];
  return {
    mode: 'regular',
    children,
    terminal: {} as TUI['terminal'],
    fullRedraws: 0,
    addChild: (child) => children.push(child),
    removeChild: () => {},
    clear: () => {},
    getShowHardwareCursor: () => false,
    setShowHardwareCursor: () => {},
    getClearOnShrink: () => true,
    setClearOnShrink: () => {},
    setFocus: (component) => {
      if (component && 'focused' in component) (component as Component & { focused: boolean }).focused = true;
    },
    showOverlay: () => { throw new Error('not used'); },
    hideOverlay: () => {},
    hasOverlay: () => false,
    start: vi.fn(),
    stop: vi.fn(),
    renderNow: () => {},
    requestRender: () => {},
    addInputListener: () => () => {},
    removeInputListener: () => {},
    onTerminalColorSchemeChange: () => () => {},
    setTerminalColorSchemeNotifications: () => {},
    queryTerminalBackgroundColor: async () => undefined,
    queryTerminalColorScheme: async () => undefined,
    invalidate: () => {},
    render: () => [],
  };
}
