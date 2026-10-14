import { readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { DaemonTuiPreferences } from '../src/providers/tui-preferences.js';
import { serverFixture } from '../../daemon/test/fixtures/server.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture() {
  const f = await serverFixture({ now: Date.now }); cleanup.push(() => f.dispose());
  const preferences = new DaemonTuiPreferences({ agentDir: f.owner.target.agentDir, assertCurrent: () => f.owner.assertCurrent() });
  const file = join(f.owner.target.agentDir, 'settings.json');
  const settings = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
  return { ...f, preferences, file, settings };
}

it('reads existing visual settings and legacy keybindings without changing their files', async () => {
  const f = await fixture(); const legacy = join(f.owner.target.agentDir, 'keybindings.json');
  const original = '{"app.model.select":"ctrl+m"}\n'; await writeFile(legacy, original);
  await writeFile(f.file, JSON.stringify({ ...f.settings, theme: 'felan-light', hideThinkingBlock: true, outputPad: 2,
    terminal: { showImages: false, imageWidthCells: 44 }, felanTui: { toolDisplay: 'full' } }));
  expect(await f.preferences.get()).toEqual({ hideThinking: true, outputPad: 2,
    showImages: false, imageWidthCells: 44, toolDisplay: 'full', keybindings: { 'app.model.select': 'ctrl+m' } });
  expect(await readFile(legacy, 'utf8')).toBe(original);
});

it('merges concurrent field updates and preserves unrelated settings and onboarding', async () => {
  const f = await fixture();
  await writeFile(f.file, JSON.stringify({ ...f.settings, custom: { retained: true }, theme: 'legacy-client-theme', terminal: { hyperlinks: false },
    felanTui: { onboarding: { schemaVersion: 1, extensions: {} } } }));
  await Promise.all([f.preferences.set({ outputPad: 3 }), f.preferences.set({ showImages: false }), f.preferences.set({ keybindings: { 'app.exit': [] } })]);
  const result = JSON.parse(await readFile(f.file, 'utf8'));
  expect(result.custom).toEqual({ retained: true }); expect(result.terminal).toEqual({ hyperlinks: false, showImages: false });
  expect(result.felanTui.onboarding).toEqual({ schemaVersion: 1, extensions: {} });
  expect(result.theme).toBe('legacy-client-theme');
  expect(await f.preferences.get()).toMatchObject({ outputPad: 3, showImages: false, keybindings: { 'app.exit': [] } });
});

it('rejects invalid updates before writing and refuses symlinked keybinding sources', async () => {
  const f = await fixture(); const before = await readFile(f.file, 'utf8');
  for (const value of [{}, { theme: 'client-owned' }, { token: 'not-a-preference' }, { outputPad: 100 }, { keybindings: { 'app.exit': '\u001b' } }]) {
    await expect(f.preferences.set(value as never)).rejects.toThrow();
  }
  expect(await readFile(f.file, 'utf8')).toBe(before);
  const target = join(f.directory, 'untrusted.json'); await writeFile(target, '{}');
  await symlink(target, join(f.owner.target.agentDir, 'keybindings.json'));
  await expect(f.preferences.get()).rejects.toThrow();
});

it('persists terminal controls in provider settings and reads them after reconstruction', async () => {
  const f = await fixture();
  const values = { hardwareCursor: true, editorPadding: 2, autocompleteMaxVisible: 12, clearOnShrink: true, terminalProgress: true };
  await f.preferences.set(values);
  const reopened = new DaemonTuiPreferences({ agentDir: f.owner.target.agentDir, assertCurrent: () => f.owner.assertCurrent() });
  expect(await reopened.get()).toMatchObject(values);
  const saved = JSON.parse(await readFile(f.file, 'utf8'));
  expect(saved).toMatchObject({ showHardwareCursor: true, editorPaddingX: 2, autocompleteMaxVisible: 12,
    terminal: { clearOnShrink: true, showTerminalProgress: true } });
  for (const update of [{ editorPadding: 4 }, { autocompleteMaxVisible: 2 }, { terminalProgress: 'true' }]) await expect(f.preferences.set(update as never)).rejects.toThrow();
});

