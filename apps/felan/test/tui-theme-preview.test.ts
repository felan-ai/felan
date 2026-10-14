import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { setKeybindings, stripTerminalSequences, type Component, type TUI } from '@earendil-works/pi-tui';
import { ClientThemes } from '../src/tui/theme-config.js';
import { TerminalPreferences } from '../src/tui/preferences.js';
import { TuiDialogs } from '../src/tui/dialogs.js';
import { createClientKeybindings } from '../src/tui/keybindings.js';
import type { TuiSessionController } from '../src/tui/controller.js';

const roots: string[] = [];
beforeEach(() => setKeybindings(createClientKeybindings()));
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'felan-theme-preview-')); roots.push(root);
  const themes = new ClientThemes(root);
  const controller = { setNotice: vi.fn(), perform: vi.fn(async (op: string) => ({ outcome: 'accepted', result: op === 'config.get' ? { values: {} }
    : { hideThinking: false, showImages: true, imageWidthCells: 60, outputPad: 1, toolDisplay: 'grouped', keybindings: {} } })) };
  let activeTheme = themes.theme;
  const preferences = new TerminalPreferences(controller as unknown as TuiSessionController, {}, async (_values, _keys, next) => { activeTheme = next; }, themes);
  let component: Component | undefined;
  const dialogs = new TuiDialogs({ requestRender() {}, showOverlay(value: Component) { component = value; return { hide() {} }; } } as unknown as TUI, () => activeTheme);
  const input = (data: string) => component?.handleInput?.(data);
  const render = () => stripTerminalSequences(component?.render(90).join('\n') ?? '');
  const opened = preferences.open(dialogs);
  await vi.waitFor(() => expect(render()).toContain('General settings'));
  input('\r'); input('\r');
  expect(render()).toContain('→ ✓ felan-dark');
  expect(render()).toContain('enter select');
  expect(render()).toContain('escape/ctrl+c back');
  return { root, themes, preferences, dialogs, opened, input, render, active: () => activeTheme };
}

it('previews the highlighted theme live and restores the saved theme on cancel', async () => {
  const f = await fixture(); f.input('\x1b[B');
  expect(f.active().name).toBe('felan-light'); expect(f.themes.value).toBe('felan-dark');
  expect(f.render()).toContain('✓ felan-dark'); expect(f.render()).toContain('→ felan-light');
  await expect(readFile(join(f.root, 'tui/settings.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  f.input('\x1b'); expect(f.active().name).toBe('felan-dark');
  f.dialogs.dispose(); await f.opened;
});

it('persists only the confirmed theme and restores previews on disposal', async () => {
  const f = await fixture(); f.input('\x1b[B'); f.input('\r');
  await vi.waitFor(() => expect(f.themes.value).toBe('felan-light'));
  expect(JSON.parse(await readFile(join(f.root, 'tui/settings.json'), 'utf8'))).toEqual({ theme: 'felan-light' });
  const reopened = new ClientThemes(f.root); await reopened.load(); expect(reopened.theme.name).toBe('felan-light');
  await vi.waitFor(() => expect(f.render()).toContain('Editor padding'));
  f.input('\r'); f.input('\x1b[A'); expect(f.active().name).toBe('felan-dark');
  f.dialogs.dispose(); await f.opened; expect(f.active().name).toBe('felan-light');
});

it('offers a terminal-derived system palette independently of automatic light/dark themes', async () => {
  const themes = new ClientThemes(); await themes.load(); expect(themes.names).toContain('system');
  await themes.update('system'); const initial = themes.theme.getFgAnsi('accent');
  const palette = Array.from({ length: 16 }, () => ({ r: 255, g: 0, b: 0 }));
  themes.setTerminalColors({ foreground: { r: 0, g: 0, b: 0 }, background: { r: 255, g: 255, b: 255 }, palette });
  expect(themes.theme.name).toBe('system'); expect(themes.theme.getFgAnsi('accent')).not.toBe(initial);
  themes.setAppearance('light'); expect(themes.theme.appearance).toBe('light');
  await themes.update('felan-light/felan-dark'); expect(themes.theme.name).toBe('felan-light');
  themes.setAppearance('dark'); expect(themes.theme.name).toBe('felan-dark');
});
