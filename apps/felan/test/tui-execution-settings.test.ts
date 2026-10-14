import { expect, it, vi } from 'vitest';
import { TerminalPreferences } from '../src/tui/preferences.js';
import type { TuiSessionController } from '../src/tui/controller.js';
import type { TuiDialogs } from '../src/tui/dialogs.js';
import { ClientThemes } from '../src/tui/theme-config.js';

it('renders and updates only the built-in extension map returned by the daemon', async () => {
  const perform = vi.fn(async (operation: string) => ({ outcome: 'accepted', result: operation === 'config.get' ? { writable: true, values: { builtinExtensions: { remoteOnly: true, mcp: false } } } : {} }));
  const controller = { perform, setNotice: vi.fn(), notice: '' } as unknown as TuiSessionController;
  const themes = new ClientThemes();
  const preview = vi.spyOn(themes, 'preview');
  const settings = vi.fn<TuiDialogs['settings']>(async entries => {
    const builtins = entries.find(entry => entry.id === 'general')!.children!.find(entry => entry.id === 'builtins')!.children!;
    expect(builtins.map(({ id, currentValue }) => [id, currentValue])).toEqual([['remoteOnly', 'true'], ['mcp', 'false']]);
    await builtins[0]!.change!('false');
  });
  const preferences = new TerminalPreferences(controller, {}, async () => {}, themes);
  try {
    await preferences.open({ settings });
    expect(perform).toHaveBeenCalledWith('config.set', { scope: 'global', values: { builtinExtensions: { remoteOnly: false } } });
    expect(preview).toHaveBeenCalledExactlyOnceWith(undefined);
  } finally { preferences.dispose(); }
});
