import { expect, it, vi } from 'vitest';
import type { TuiPreferences } from '@felan-ai/session-protocol';
import { TerminalPreferences, type ClientTuiPreferences } from '../src/tui/preferences.js';
import { createClientKeybindings } from '../src/tui/keybindings.js';
import type { TuiSessionController } from '../src/tui/controller.js';
import type { SettingsEntry } from '../src/tui/settings-menu.js';

const defaults: TuiPreferences = { hideThinking: true, showImages: false, imageWidthCells: 80, outputPad: 3,
  toolDisplay: 'full', keybindings: { 'app.model.select': 'alt+m', 'app.exit': 'alt+x' } };

function fixture(value: unknown = defaults, overrides: ConstructorParameters<typeof TerminalPreferences>[1] = {}) {
  const controller = { notice: '', setNotice(message: string) { this.notice = message; }, perform: vi.fn(async (op: string, _params: unknown) =>
    ({ outcome: 'accepted', result: op === 'tui.preferences.get' ? structuredClone(value) : op === 'config.get' ? { values: {} } : {} })) };
  const keys = createClientKeybindings();
  const changed = vi.fn(async (_value: ClientTuiPreferences, bindings: Parameters<typeof keys.setUserBindings>[0]) => { keys.setUserBindings(bindings); });
  const preferences = new TerminalPreferences(controller as unknown as TuiSessionController, overrides, changed);
  return { controller, keys, changed, preferences };
}

it('loads negotiated display preferences and changes the existing keybinding manager', async () => {
  const f = fixture(); expect(await f.preferences.load()).toBe(true);
  expect(f.controller.perform).toHaveBeenCalledWith('tui.preferences.get', {});
  expect(f.preferences.settings).toEqual({ hideThinking: true, showImages: false, imageWidthCells: 80, outputPad: 3, toolMode: 'full' });
  expect(f.keys.matches('\x1bm', 'app.model.select')).toBe(true);
  expect(f.keys.matches('\x0c', 'app.model.select')).toBe(false);
  await f.preferences.load(); expect(f.controller.perform).toHaveBeenCalledTimes(1);
});

it('keeps caller theme and keybinding overrides while loading and saving daemon defaults', async () => {
  const f = fixture(defaults, { theme: 'dark', keybindings: { 'app.model.select': 'alt+z' } });
  await f.preferences.load(); await f.preferences.update({ theme: 'light', keybindings: { 'app.model.select': 'ctrl+l', 'app.exit': 'alt+e' } });
  expect(f.preferences.values.theme).toBe('light');
  expect(f.changed.mock.lastCall?.[0].theme).toBe('dark');
  expect(f.keys.matches('\x1bz', 'app.model.select')).toBe(true);
  expect(f.keys.matches('\x1be', 'app.exit')).toBe(true);
  expect(f.controller.perform).toHaveBeenLastCalledWith('tui.preferences.set', { values: { keybindings: { 'app.model.select': 'ctrl+l', 'app.exit': 'alt+e' } } });
});

it.each([{ ...defaults, outputPad: 17 }, { ...defaults, imageWidthCells: 0 }, { ...defaults, keybindings: { 'app.exit': 'contrl+d' } }])(
  'rejects invalid daemon preference data without replacing local defaults', async value => {
    const f = fixture(value); expect(await f.preferences.load()).toBe(false);
    expect(f.preferences.settings.outputPad).toBe(1); expect(f.changed).not.toHaveBeenCalled();
    expect(f.controller.notice).toContain('Client preferences:');
  },
);

it('validates updates before sending and retains loaded fields on request errors', async () => {
  const f = fixture(); await f.preferences.load();
  expect(await f.preferences.update({ imageWidthCells: 4097 })).toBe(false);
  expect(await f.preferences.update({ keybindings: { 'app.exit': 'ctrl+ctrl+d' } })).toBe(false);
  expect(f.controller.perform).toHaveBeenCalledTimes(1);
  f.controller.perform.mockRejectedValueOnce(new Error('connection lost'));
  expect(await f.preferences.update({ outputPad: 4 })).toBe(false);
  expect(f.preferences.values).toEqual({ ...defaults, theme: 'felan-dark' });
  expect(f.controller.notice).toContain('connection lost'); expect(f.changed).toHaveBeenCalledTimes(1);
});

it('applies display settings immediately and rejects invalid input without a write', async () => {
  const f = fixture();
  await f.preferences.open({ settings: async entries => {
    const general = entries.find(entry => entry.id === 'general')!.children!;
    await general.find(entry => entry.id === 'showImages')!.change!('true');
    expect(f.preferences.values.showImages).toBe(true);
    const padding = general.find(entry => entry.id === 'outputPad')!;
    await expect(padding.change!('19')).rejects.toThrow();
    await padding.change!('2');
    expect(f.preferences.values.outputPad).toBe(2);
    expect(general.some(entry => entry.id === 'save' || entry.id === 'cancel')).toBe(false);
  } });
  expect(f.controller.perform.mock.calls.filter(([op]) => op === 'tui.preferences.set')).toEqual([
    ['tui.preferences.set', { values: { showImages: true } }], ['tui.preferences.set', { values: { outputPad: 2 } }],
  ]);
});

it('selects a local theme without sending it to the daemon', async () => {
  const f = fixture();
  await f.preferences.open({ settings: async entries => {
    await entries.find(entry => entry.id === 'general')!.children!.find(entry => entry.id === 'theme')!.change!('felan-light');
  } });
  expect(f.preferences.values.theme).toBe('felan-light');
  expect(f.controller.perform.mock.calls.map(([op]) => op)).toEqual(['tui.preferences.get', 'config.get']);
  expect(f.changed.mock.lastCall?.[0].theme).toBe('felan-light');
});

it('restores terminal display controls and keeps image input defaults provider-owned', async () => {
  const f = fixture();
  await f.preferences.open({ settings: async entries => {
    const general = entries.find(entry => entry.id === 'general')!.children!;
    for (const [id, value] of Object.entries({ hardwareCursor: 'true', editorPadding: '2', autocompleteMaxVisible: '12', clearOnShrink: 'true', terminalProgress: 'true' })) {
      const entry = general.find(entry => entry.id === id)!;
      expect(entry.description).toContain('Display only');
      await entry.change!(value);
    }
    for (const id of ['imageAutoResize', 'blockImages']) {
      const entry = general.find(entry => entry.id === id)!;
      expect(entry.description).toContain('new sessions or /reload'); await entry.change!('true');
    }
    await expect(general.find(entry => entry.id === 'editorPadding')!.change!('4')).rejects.toThrow();
    await expect(general.find(entry => entry.id === 'autocompleteMaxVisible')!.change!('21')).rejects.toThrow();
  } });
  expect(f.preferences.values).toMatchObject({ hardwareCursor: true, editorPadding: 2, autocompleteMaxVisible: 12, clearOnShrink: true, terminalProgress: true });
  expect(f.controller.perform).toHaveBeenCalledWith('config.set', { scope: 'global', values: { imageAutoResize: true } });
  expect(f.controller.perform).toHaveBeenCalledWith('config.set', { scope: 'global', values: { blockImages: true } });
});

it('does not apply a late preference reply after terminal disposal', async () => {
  const f = fixture(); let resolve!: (value: { outcome: string; result: TuiPreferences }) => void;
  let entered!: () => void; const entry = new Promise<void>(done => { entered = done; });
  f.controller.perform.mockImplementationOnce(() => new Promise(done => { resolve = done; entered(); }));
  const load = f.preferences.load(); await entry; f.preferences.dispose(); resolve({ outcome: 'accepted', result: defaults });
  expect(await load).toBe(false); expect(f.changed).not.toHaveBeenCalled();
});

it('shows general settings and extension counts and writes execution defaults immediately', async () => {
  const f = fixture(); await f.preferences.load();
  f.controller.perform.mockResolvedValueOnce({ outcome: 'accepted', result: {
    values: { codemode: 'on', classifierModel: 'auto', extensionConfig: { custom: { active: false } } },
    extensions: [{ id: 'custom', title: 'Custom extension', fields: [{ id: 'active', label: 'Active', description: 'Toggle it', type: 'boolean' }] }],
  } });
  let items: SettingsEntry[] = [];
  await f.preferences.open({ settings: async entries => {
    items = entries;
    await entries.find(entry => entry.id === 'codemode')!.change!('only');
    await entries.find(entry => entry.id === 'classifierModel')!.change!('offline/classifier');
    await entries.find(entry => entry.id === 'custom')!.children![0]!.change!('true');
  } });
  expect(items.map(({ label, currentValue }) => [label, currentValue])).toEqual([
    ['General settings', 'open'], ['Code mode', 'on'], ['Classifier model', 'auto'], ['Custom extension', '1 setting'],
  ]);
  expect(items.at(-1)?.children?.[0]?.description).toContain('new sessions or /reload');
  expect(f.controller.perform).toHaveBeenLastCalledWith('config.set', { scope: 'global', values: { extensionConfig: { custom: { active: true } } } });
  expect(f.controller.notice).toContain('new sessions or use /reload');
});
