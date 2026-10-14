import { beforeAll, expect, it, vi } from 'vitest';
import { initTheme } from '@earendil-works/pi-coding-agent';
import { KeybindingsManager, TUI_KEYBINDINGS, setKeybindings, stripTerminalSequences, type Component, type TUI } from '@earendil-works/pi-tui';
import { TuiDialogs } from '../src/tui/dialogs.js';
import { createClientKeybindings } from '../src/tui/keybindings.js';

beforeAll(() => { initTheme('dark', false); setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS)); });
function fixture() {
  let component!: Component; const hide = vi.fn();
  const tui = { requestRender: vi.fn(), showOverlay(value: Component) { component = value; return { hide }; } } as unknown as TUI;
  const dialogs = new TuiDialogs(tui);
  return { dialogs, hide, input(value: string) { component.handleInput!(value); }, render() { return component.render(80).join('\n'); } };
}

it('defaults destructive confirmation to no and never approves escape', async () => {
  const f = fixture(); const declined = f.dialogs.confirm('Close', 'Close the session?');
  f.input('\r'); expect(await declined).toBe(false);
  const escaped = f.dialogs.confirm('Close', 'Close the session?'); f.input('\x1b'); expect(await escaped).toBe(false);
  f.dialogs.dispose(); expect(f.hide).toHaveBeenCalledTimes(2);
});

it('returns stable choice values after filtering and cancels pending dialogs on disposal', async () => {
  const f = fixture(); const selected = f.dialogs.select('Models', [{ value: 'first-id', label: 'First' }, { value: 'second-id', label: 'Second' }]);
  f.input('S'); f.input('e'); f.input('\r'); expect(await selected).toBe('second-id');
  const cancelled = f.dialogs.input('Draft', 'retained text'); f.dialogs.dispose(); expect(await cancelled).toBeUndefined();
});

it.each([
  ['Thinking', 'hideThinking'], ['Save changes', 'save'], ['hid', 'hideThinking'],
])('filters settings by label or ID %s and returns the unchanged value', async (filter, expected) => {
  const f = fixture();
  const selected = f.dialogs.select('Settings', [
    { value: 'hideThinking', label: 'Thinking: visible' },
    { value: 'showImages', label: 'Images: shown' },
    { value: 'save', label: 'Save changes' },
  ]);
  f.input(filter); expect(f.render()).not.toContain('No matching commands');
  f.input('\r'); expect(await selected).toBe(expected); f.dialogs.dispose();
});

it('honors configured selection navigation, confirmation and cancellation keys', async () => {
  setKeybindings(createClientKeybindings({ 'tui.select.down': 'ctrl+n', 'tui.select.confirm': 'alt+s', 'tui.select.cancel': 'alt+x' }));
  const f = fixture();
  try {
    const selected = f.dialogs.select('Settings', [{ value: 'first', label: 'First' }, { value: 'second', label: 'Second' }]);
    f.input('\x0e'); f.input('\x1bs'); expect(await selected).toBe('second');
    const cancelled = f.dialogs.select('Settings', [{ value: 'first', label: 'First' }]);
    f.input('\x1bx'); expect(await cancelled).toBeUndefined();
  } finally { f.dialogs.dispose(); setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS)); }
});

it('masks secret input and clears it when the dialog completes', async () => {
  const f = fixture(); const result = f.dialogs.input('API key', '', { secret: true });
  f.input('private-test-key');
  expect(f.render()).not.toContain('private-test-key'); expect(f.render()).toContain('*'.repeat('private-test-key'.length));
  f.input('\r'); expect(await result).toBe('private-test-key');
  expect(f.render()).not.toContain('*'.repeat('private-test-key'.length));
  f.dialogs.dispose();
});

it('cancels and clears secret input when its prompt signal becomes stale', async () => {
  const f = fixture(); const abort = new AbortController();
  const result = f.dialogs.input('API key', '', { secret: true, signal: abort.signal });
  f.input('private-test-key'); abort.abort();
  expect(await result).toBeUndefined(); expect(f.hide).toHaveBeenCalledOnce();
  expect(f.render()).not.toContain('*'.repeat('private-test-key'.length)); f.dialogs.dispose();
});

it('shows an empty search prompt and wraps the selected description below generic choices', async () => {
  const f = fixture();
  const result = f.dialogs.select('Pick', [{ value: 'one', label: 'First', description: 'A long description '.repeat(12) },
    { value: 'two', label: 'Second', description: 'Second description' }]);
  const lines = f.render().split('\n').map(stripTerminalSequences);
  expect(lines.some(line => line.startsWith('> '))).toBe(true);
  expect(lines.join('\n')).not.toContain('Filter choices');
  expect(lines.find(line => line.includes('First'))).not.toContain('description');
  expect(lines.filter(line => line.includes('description')).length).toBeGreaterThan(1);
  f.input('\x1b[B'); expect(stripTerminalSequences(f.render())).toContain('Second description');
  f.input('\x1b'); expect(await result).toBeUndefined();
});

it('keeps settings search, values, position counter, description and delimiters', async () => {
  const f = fixture();
  const result = f.dialogs.settings(Array.from({ length: 18 }, (_, index) => ({ id: `extension-${index}`, label: index ? `Extension ${index}` : 'General settings',
    description: `Description for ${index}`, currentValue: index ? '4 settings' : 'open', children: [] })));
  const screen = stripTerminalSequences(f.render());
  expect(screen).toContain('General settings'); expect(screen).toContain('open'); expect(screen).toContain('4 settings');
  expect(screen).toContain('(1/18)'); expect(screen).toContain('Description for 0');
  expect(screen).toContain('Type to search · Enter/Space to change · Esc to cancel');
  expect(screen.split('\n')[0]).toBe('─'.repeat(80)); expect(screen.split('\n').at(-1)).toBe('─'.repeat(80));
  expect(screen).not.toContain('Filter choices');
  f.input('Extension 17'); expect(stripTerminalSequences(f.render())).toContain('Description for 17');
  f.input('\x1b'); await result;
});

it('preselects the current choice and applies custom values without save rows', async () => {
  const f = fixture(); const change = vi.fn(async () => {});
  const result = f.dialogs.settings([{ id: 'theme', label: 'Theme', description: 'Client display', currentValue: 'dark', edit: true,
    choices: [{ value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }], change }]);
  f.input('\r'); expect(stripTerminalSequences(f.render())).toContain('→ Dark');
  f.input('\x1b[B'); f.input('\r');
  f.input('\x0b'); f.input('light/dark'); f.input('\r');
  await vi.waitFor(() => expect(change).toHaveBeenCalledWith('light/dark'));
  await vi.waitFor(() => expect(stripTerminalSequences(f.render())).toContain('→ Theme'));
  expect(stripTerminalSequences(f.render())).toContain('light/dark');
  f.input('\x1b'); await result;
});

it('retains the saved value after a rejected toggle and allows retry', async () => {
  const f = fixture(); const change = vi.fn().mockRejectedValueOnce(new Error('Write rejected')).mockResolvedValueOnce(undefined);
  const result = f.dialogs.settings([{ id: 'toggle', label: 'Toggle', description: 'Example', currentValue: 'off', values: ['off', 'on'], change }]);
  f.input(' ');
  await vi.waitFor(() => expect(stripTerminalSequences(f.render())).toContain('Write rejected'));
  expect(stripTerminalSequences(f.render())).toMatch(/Toggle\s+off/u);
  f.input(' ');
  await vi.waitFor(() => expect(stripTerminalSequences(f.render())).toMatch(/Toggle\s+on/u));
  expect(change.mock.calls).toEqual([['on'], ['on']]);
  f.input('\x1b'); await result;
});
