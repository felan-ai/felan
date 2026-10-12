import { expect, it, vi } from 'vitest';
import type { TuiPreferences } from '@felan-ai/session-protocol';
import { TerminalPreferences, type ClientTuiPreferences } from '../src/tui/preferences.js';
import { createClientKeybindings } from '../src/tui/keybindings.js';
import type { TuiSessionController } from '../src/tui/controller.js';
import type { TuiDialogHost } from '../src/tui/dialogs.js';

const defaults: TuiPreferences = { hideThinking: true, showImages: false, imageWidthCells: 80, outputPad: 3,
  toolDisplay: 'full', keybindings: { 'app.model.select': 'alt+m', 'app.exit': 'alt+x' } };

function fixture(value: unknown = defaults, overrides: ConstructorParameters<typeof TerminalPreferences>[1] = {}) {
  const controller = { notice: '', setNotice(message: string) { this.notice = message; }, perform: vi.fn(async (op: string, _params: unknown) =>
    ({ outcome: 'accepted', result: op === 'tui.preferences.get' ? structuredClone(value) : {} })) };
  const keys = createClientKeybindings();
  const changed = vi.fn(async (_value: ClientTuiPreferences, bindings: Parameters<typeof keys.setUserBindings>[0]) => { keys.setUserBindings(bindings); });
  const preferences = new TerminalPreferences(controller as unknown as TuiSessionController, overrides, changed);
  return { controller, keys, changed, preferences };
}

function dialogs() {
  return { select: vi.fn<TuiDialogHost['select']>(async () => undefined), input: vi.fn<TuiDialogHost['input']>(async () => undefined),
    confirm: vi.fn<TuiDialogHost['confirm']>(async () => false) };
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

it('keeps edited fields after a rejected save and only submits changed fields on retry', async () => {
  const f = fixture(); await f.preferences.load(); const ui = dialogs();
  ui.select.mockResolvedValueOnce('showImages').mockResolvedValueOnce('save').mockResolvedValueOnce('save');
  f.controller.perform.mockImplementationOnce(async () => { f.controller.setNotice('Rejected: read-only'); return { outcome: 'rejected', result: {} }; });
  expect(await f.preferences.open(ui)).toBe(true);
  expect(ui.select.mock.calls[2]?.[0]).toContain('Rejected: read-only');
  expect(ui.select.mock.calls[2]?.[1]).toContainEqual({ value: 'showImages', label: 'Images: shown' });
  expect(f.controller.perform.mock.calls.slice(1)).toEqual([
    ['tui.preferences.set', { values: { showImages: true } }], ['tui.preferences.set', { values: { showImages: true } }],
  ]);
  expect(f.preferences.values).toEqual({ ...defaults, showImages: true, theme: 'felan-dark' });
});

it('retains invalid field input for correction and cancels without persisting', async () => {
  const f = fixture(); await f.preferences.load(); const ui = dialogs();
  ui.select.mockResolvedValueOnce('outputPad').mockResolvedValueOnce('cancel');
  ui.input.mockResolvedValueOnce('19').mockResolvedValueOnce('2');
  expect(await f.preferences.open(ui)).toBe(false);
  expect(ui.input.mock.calls[1]?.[1]).toBe('19');
  expect(ui.select.mock.calls[1]?.[1]).toContainEqual({ value: 'outputPad', label: 'Output padding: 2 cells' });
  expect(f.controller.perform).toHaveBeenCalledTimes(1); expect(f.preferences.values).toEqual({ ...defaults, theme: 'felan-dark' });
});

it('selects a local theme without sending a theme field or write to the daemon', async () => {
  const f = fixture(); await f.preferences.load(); const ui = dialogs();
  ui.select.mockResolvedValueOnce('theme').mockResolvedValueOnce('theme:felan-light').mockResolvedValueOnce('save');
  expect(await f.preferences.open(ui)).toBe(true);
  expect(f.preferences.values.theme).toBe('felan-light');
  expect(f.controller.perform).toHaveBeenCalledTimes(1);
  expect(f.changed.mock.lastCall?.[0].theme).toBe('felan-light');
});

it('does not apply a late preference reply after terminal disposal', async () => {
  const f = fixture(); let resolve!: (value: { outcome: string; result: TuiPreferences }) => void;
  let entered!: () => void; const entry = new Promise<void>(done => { entered = done; });
  f.controller.perform.mockImplementationOnce(() => new Promise(done => { resolve = done; entered(); }));
  const load = f.preferences.load(); await entry; f.preferences.dispose(); resolve({ outcome: 'accepted', result: defaults });
  expect(await load).toBe(false); expect(f.changed).not.toHaveBeenCalled();
});
