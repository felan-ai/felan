import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { TerminalPreferences, type ClientTuiPreferences } from '../src/tui/preferences.js';
import { ClientThemes } from '../src/tui/theme-config.js';
import { createClientKeybindings } from '../src/tui/keybindings.js';
import type { TuiSessionController } from '../src/tui/controller.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const defaults = { hideThinking: true, showImages: false, imageWidthCells: 80, outputPad: 3,
  toolDisplay: 'full', keybindings: { 'app.model.select': 'alt+m', 'app.exit': 'alt+x' } };

async function fixture(value: unknown = defaults, overrides: ConstructorParameters<typeof TerminalPreferences>[1] = {}) {
  const root = await mkdtemp(join(tmpdir(), 'tui-preferences-')); roots.push(root);
  await mkdir(join(root, 'tui')); await writeFile(join(root, 'tui/settings.json'), JSON.stringify(value));
  const controller = { notice: '', setNotice(message: string) { this.notice = message; }, perform: vi.fn(async (op: string, _params: unknown) =>
    ({ outcome: 'accepted', result: op === 'config.get' ? { writable: true, values: {} } : {} })) };
  const keys = createClientKeybindings();
  const changed = vi.fn(async (_value: ClientTuiPreferences, bindings: Parameters<typeof keys.setUserBindings>[0]) => { keys.setUserBindings(bindings); });
  const preferences = new TerminalPreferences(controller as unknown as TuiSessionController, overrides, changed, new ClientThemes(root, overrides.theme));
  return { root, controller, keys, changed, preferences };
}

it('loads display settings locally without a daemon operation', async () => {
  const f = await fixture(); expect(await f.preferences.load()).toBe(true);
  expect(f.controller.perform).not.toHaveBeenCalled();
  expect(f.preferences.settings).toMatchObject({ hideThinking: true, showImages: false, imageWidthCells: 80, outputPad: 1, toolMode: 'full' });
  expect(f.keys.matches('\x1bm', 'app.model.select')).toBe(true);
  expect(f.keys.matches('\x0c', 'app.model.select')).toBe(false);
  await f.preferences.load(); expect(f.changed).toHaveBeenCalledTimes(1);
});

it('keeps launch overrides active while saving client defaults', async () => {
  const f = await fixture(defaults, { theme: 'dark', keybindings: { 'app.model.select': 'alt+z' } });
  await f.preferences.load(); await f.preferences.update({ theme: 'light', keybindings: { 'app.model.select': 'ctrl+l', 'app.exit': 'alt+e' } });
  expect(f.preferences.values.theme).toBe('light'); expect(f.changed.mock.lastCall?.[0].theme).toBe('dark');
  expect(f.keys.matches('\x1bz', 'app.model.select')).toBe(true); expect(f.keys.matches('\x1be', 'app.exit')).toBe(true);
  expect(f.controller.perform).not.toHaveBeenCalled();
  expect(JSON.parse(await readFile(join(f.root, 'tui/settings.json'), 'utf8'))).toMatchObject({ theme: 'light', keybindings: { 'app.exit': 'alt+e' } });
});

it.each([{ ...defaults, outputPad: 17 }, { ...defaults, imageWidthCells: 0 }, { ...defaults, keybindings: { 'app.exit': 'contrl+d' } }])(
  'rejects invalid local data without applying it', async value => {
    const f = await fixture(value); expect(await f.preferences.load()).toBe(false);
    expect(f.preferences.settings.outputPad).toBe(1); expect(f.changed).not.toHaveBeenCalled();
    expect(f.controller.notice).toContain('Client preferences:');
  },
);

it('rejects invalid updates before writing', async () => {
  const f = await fixture(); await f.preferences.load();
  const before = await readFile(join(f.root, 'tui/settings.json'), 'utf8');
  expect(await f.preferences.update({ imageWidthCells: 4097 })).toBe(false);
  expect(await f.preferences.update({ keybindings: { 'app.exit': 'ctrl+ctrl+d' } })).toBe(false);
  expect(await readFile(join(f.root, 'tui/settings.json'), 'utf8')).toBe(before);
});

it('updates display locally and execution settings through the daemon', async () => {
  const f = await fixture();
  await f.preferences.open({ settings: async entries => {
    const general = entries.find(entry => entry.id === 'general')!.children!;
    await general.find(entry => entry.id === 'showImages')!.change!('true');
    await general.find(entry => entry.id === 'theme')!.change!('felan-light');
    await general.find(entry => entry.id === 'editorPadding')!.change!('2');
    await expect(general.find(entry => entry.id === 'outputPad')!.change!('19')).rejects.toThrow();
    await general.find(entry => entry.id === 'imageAutoResize')!.change!('true');
  } });
  expect(f.preferences.values).toMatchObject({ theme: 'felan-light', showImages: true, editorPadding: 2 });
  expect(f.controller.perform.mock.calls).toEqual([['config.get', { scope: 'global' }], ['config.set', { scope: 'global', values: { imageAutoResize: true } }]]);
});

it('leaves local display editable while showing host configuration read-only', async () => {
  const f = await fixture();
  f.controller.perform.mockResolvedValueOnce({ outcome: 'accepted', result: { writable: false, values: {} } });
  await f.preferences.open({ settings: async entries => {
    const general = entries.find(entry => entry.id === 'general')!.children!;
    const execution = general.find(entry => entry.id === 'autoCompact')!;
    expect(execution.change).toBeUndefined(); expect(execution.values).toBeUndefined();
    expect(execution.description).toContain('Read-only');
    expect(entries.find(entry => entry.id === 'codemode')!.change).toBeUndefined();
    await general.find(entry => entry.id === 'showImages')!.change!('true');
    await entries.find(entry => entry.id === 'presentation-tasks')!.children![0]!.change!('overlay');
  } });
  expect(f.preferences.values.showImages).toBe(true);
  expect(f.preferences.presentation.tasks.displayMode).toBe('overlay');
  expect(f.controller.perform).toHaveBeenCalledTimes(1);
});

it('keeps launch presentation overrides local and does not persist them', async () => {
  const f = await fixture(defaults, { presentation: { tasks: { displayMode: 'overlay' } } });
  await f.preferences.load();
  expect(f.preferences.presentation.tasks.displayMode).toBe('overlay');
  await f.preferences.update({ presentation: { ...f.preferences.values.presentation!, tasks: { displayMode: 'inline' } } });
  expect(f.preferences.presentation.tasks.displayMode).toBe('overlay');
  expect(f.preferences.values.presentation!.tasks.displayMode).toBe('inline');
  expect(f.controller.perform).not.toHaveBeenCalled();
});

it('shows generic extension settings and writes only extensionConfig', async () => {
  const f = await fixture();
  f.controller.perform.mockResolvedValueOnce({ outcome: 'accepted', result: { writable: true,
    values: { extensionConfig: { custom: { active: false } } },
    extensions: [{ id: 'custom', title: 'Custom extension', fields: [{ id: 'active', label: 'Active', description: 'Toggle it', type: 'boolean' }] }],
  } });
  await f.preferences.open({ settings: async entries => { await entries.find(entry => entry.id === 'custom')!.children![0]!.change!('true'); } });
  expect(f.controller.perform).toHaveBeenLastCalledWith('config.set', { scope: 'global', values: { extensionConfig: { custom: { active: true } } } });
});

it('does not apply a late file read after disposal', async () => {
  const f = await fixture(); const loading = f.preferences.load(); f.preferences.dispose();
  expect(await loading).toBe(false); expect(f.changed).not.toHaveBeenCalled();
});

it('keeps local preferences available when host configuration cannot be queried', async () => {
  const f = await fixture(); f.controller.perform.mockRejectedValueOnce(new Error('Unavailable'));
  expect(await f.preferences.open({ settings: async entries => {
    const general = entries.find(entry => entry.id === 'general')!.children!;
    expect(general.find(entry => entry.id === 'autoCompact')!.change).toBeUndefined();
    await general.find(entry => entry.id === 'showImages')!.change!('true');
  } })).toBe(true);
  expect(f.preferences.values.showImages).toBe(true);
});

it.each([0, 1, 3, 16])('renders outputPad %s with the released zero-or-one semantics', async outputPad => {
  const f = await fixture({ outputPad });
  await f.preferences.load();
  expect(f.preferences.values.outputPad).toBe(outputPad);
  expect(f.preferences.settings.outputPad).toBe(outputPad === 0 ? 0 : 1);
  expect(f.preferences.values.editorPadding).toBe(1);
});
