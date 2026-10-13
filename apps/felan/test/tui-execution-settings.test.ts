import { expect, it, vi } from 'vitest';
import { TerminalPreferences } from '../src/tui/preferences.js';
import type { TuiSessionController } from '../src/tui/controller.js';
import type { TuiDialogHost } from '../src/tui/dialogs.js';
import type { ClientThemes } from '../src/tui/theme-config.js';

it('renders and updates only the built-in extension map returned by the daemon', async () => {
  const perform = vi.fn(async (operation: string) => ({ outcome: 'accepted', result: operation === 'tui.preferences.get'
    ? { hideThinking: false, showImages: true, imageWidthCells: 60, outputPad: 1, toolDisplay: 'grouped', keybindings: {} }
    : operation === 'config.get' ? { values: { builtinExtensions: { remoteOnly: true, mcp: false } } } : {} }));
  const controller = { perform, setNotice: vi.fn(), notice: '' } as unknown as TuiSessionController;
  const themes = { load: async () => {}, value: 'fixture', theme: {}, names: ['fixture'] } as unknown as ClientThemes;
  const select = vi.fn().mockResolvedValueOnce('execution').mockResolvedValueOnce('builtin:remoteOnly')
    .mockResolvedValueOnce('save').mockResolvedValueOnce('cancel');
  const preferences = new TerminalPreferences(controller, {}, async () => {}, themes);
  try {
    await preferences.open({ select } as unknown as TuiDialogHost);
    expect(select.mock.calls[1]?.[1]).toEqual([
      { value: 'classifierModel', label: 'Classifier model: auto' },
      { value: 'builtin:remoteOnly', label: 'remoteOnly: enabled' },
      { value: 'builtin:mcp', label: 'mcp: disabled' },
      { value: 'save', label: 'Save execution defaults' }, { value: 'cancel', label: 'Back' },
    ]);
    expect(perform).toHaveBeenCalledWith('config.set', { scope: 'global', values: { builtinExtensions: { remoteOnly: false } } });
  } finally { preferences.dispose(); }
});
