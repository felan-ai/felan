import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { defaultPresentationPreferences } from '../src/tui/preferences-schema.js';
import { ClientPreferencesStore } from '../src/tui/preferences-store.js';
import { serverFixture } from '../../daemon/test/fixtures/server.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture() {
  const f = await serverFixture({ now: Date.now }); cleanup.push(() => f.dispose());
  const preferences = new ClientPreferencesStore(f.owner.target.agentDir);
  const file = join(f.owner.target.agentDir, 'settings.json');
  const settings = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
  return { ...f, preferences, file, settings };
}

it('reads existing visual settings and legacy keybindings without changing their files', async () => {
  const f = await fixture(); const legacy = join(f.owner.target.agentDir, 'keybindings.json');
  const original = '{"app.model.select":"ctrl+m"}\n'; await writeFile(legacy, original);
  await writeFile(f.file, JSON.stringify({ ...f.settings, theme: 'felan-light', hideThinkingBlock: true, outputPad: 2,
    terminal: { showImages: false, imageWidthCells: 44 }, felanTui: { toolDisplay: 'full' } }));
  expect(await (f.preferences.load().then(() => f.preferences.values))).toMatchObject({ hideThinking: true, outputPad: 2,
    showImages: false, imageWidthCells: 44, toolDisplay: 'full', keybindings: { 'app.model.select': 'ctrl+m' } });
  expect(await readFile(legacy, 'utf8')).toBe(original);
});

it('merges concurrent field updates and preserves unrelated settings and onboarding', async () => {
  const f = await fixture();
  await writeFile(f.file, JSON.stringify({ ...f.settings, custom: { retained: true }, theme: 'felan-dark', terminal: { hyperlinks: false },
    felanTui: { onboarding: { schemaVersion: 1, extensions: {} } } }));
  await Promise.all([f.preferences.update({ outputPad: 3 }), f.preferences.update({ showImages: false }), f.preferences.update({ keybindings: { 'app.exit': [] } })]);
  const result = JSON.parse(await readFile(f.file, 'utf8'));
  expect(result.custom).toEqual({ retained: true }); expect(result.terminal).toEqual({ hyperlinks: false });
  expect(result.felanTui.onboarding).toEqual({ schemaVersion: 1, extensions: {} });
  expect(result.theme).toBe('felan-dark');
  expect(await (f.preferences.load().then(() => f.preferences.values))).toMatchObject({ outputPad: 3, showImages: false, keybindings: { 'app.exit': [] } });
});

it('rejects invalid updates before writing and skips unsafe legacy keybinding sources', async () => {
  const f = await fixture(); const before = await readFile(f.file, 'utf8');
  for (const value of [{ theme: 'invalid/name/parts' }, { token: 'not-a-preference' }, { outputPad: 100 }, { keybindings: { 'app.exit': '\u001b' } }]) {
    await expect(f.preferences.update(value as never)).rejects.toThrow();
  }
  expect(await readFile(f.file, 'utf8')).toBe(before);
  const target = join(f.directory, 'untrusted.json'); await writeFile(target, '{}');
  await symlink(target, join(f.owner.target.agentDir, 'keybindings.json'));
  await f.preferences.load();
  expect(f.preferences.values.keybindings).toEqual({});
  expect(f.preferences.warnings).toHaveLength(1);
});

it('persists terminal controls in client settings and reads them after reconstruction', async () => {
  const f = await fixture();
  const values = { hardwareCursor: true, editorPadding: 2, autocompleteMaxVisible: 12, clearOnShrink: true, terminalProgress: true };
  await f.preferences.update(values);
  const reopened = new ClientPreferencesStore(f.owner.target.agentDir);
  await reopened.load(); expect(reopened.values).toMatchObject(values);
  const saved = JSON.parse(await readFile(join(f.owner.target.agentDir, 'tui/settings.json'), 'utf8'));
  expect(saved).toMatchObject(values);
  expect(JSON.parse(await readFile(f.file, 'utf8'))).not.toHaveProperty('editorPaddingX');
  for (const update of [{ editorPadding: 4 }, { autocompleteMaxVisible: 2 }, { terminalProgress: 'true' }]) await expect(f.preferences.update(update as never)).rejects.toThrow();
});


it('carries every effective legacy preference on the first theme write, then stops reading legacy files', async () => {
  const f = await fixture();
  const legacy = { theme: 'felan-light', hideThinkingBlock: true, outputPad: 4, quietStartup: 'header',
    showHardwareCursor: true, editorPaddingX: 2, autocompleteMaxVisible: 12,
    fullscreenScrollbar: 'hidden', fullscreenCopyOnSelect: false, fullscreenWheelScrollLines: 5,
    markdown: { mermaid: 'final' }, terminal: { showImages: false, imageWidthCells: 90, clearOnShrink: true, showTerminalProgress: true },
    felanTui: { toolDisplay: 'full', keybindings: { 'app.exit': [] } } };
  const original = JSON.stringify(legacy); await writeFile(f.file, original);
  const keys = join(f.owner.target.agentDir, 'keybindings.json'); await writeFile(keys, '{"app.model.select":"alt+m"}');
  await f.preferences.update({ theme: 'felan-dark' });
  expect(await readFile(f.file, 'utf8')).toBe(original);
  const expected = { presentation: defaultPresentationPreferences, theme: 'felan-dark', hideThinking: true, outputPad: 4, quietStartup: 'header', hardwareCursor: true,
    editorPadding: 2, autocompleteMaxVisible: 12, fullscreenScrollbar: 'hidden', fullscreenCopyOnSelect: false, fullscreenWheelScrollLines: 5,
    mermaid: 'final', showImages: false, imageWidthCells: 90, clearOnShrink: true, terminalProgress: true, toolDisplay: 'full',
    keybindings: { 'app.model.select': 'alt+m', 'app.exit': [] } };
  expect(f.preferences.values).toEqual(expected);
  await writeFile(f.file, 'invalid'); await writeFile(keys, 'invalid');
  const reopened = new ClientPreferencesStore(f.owner.target.agentDir); await reopened.load();
  expect(reopened.values).toEqual(expected);
});

it('prefers each local value while filling absent values from legacy settings', async () => {
  const f = await fixture();
  await writeFile(f.file, JSON.stringify({ theme: 'felan-light', outputPad: 4, terminal: { showImages: false }, felanTui: { toolDisplay: 'full' } }));
  await writeFile(join(f.owner.target.agentDir, 'keybindings.json'), '{"app.exit":"alt+x"}');
  await mkdir(join(f.owner.target.agentDir, 'tui'));
  await writeFile(join(f.owner.target.agentDir, 'tui/settings.json'), JSON.stringify({ theme: 'felan-dark', outputPad: 0, keybindings: {} }));
  await f.preferences.load();
  expect(f.preferences.values).toMatchObject({ theme: 'felan-dark', outputPad: 0, keybindings: {}, showImages: false, toolDisplay: 'full' });
  await f.preferences.update({ hideThinking: true });
  expect(JSON.parse(await readFile(join(f.owner.target.agentDir, 'tui/settings.json'), 'utf8'))).toMatchObject({
    theme: 'felan-dark', outputPad: 0, keybindings: {}, showImages: false, toolDisplay: 'full', hideThinking: true,
  });
});

it('reads legacy extension display fields per field without writing host configuration', async () => {
  const f = await fixture();
  const original = JSON.stringify({ ...f.settings, extensionConfig: {
    askUser: { displayMode: 'overlay', singleSelectLayout: 'list', overlayToggleKey: '', commentToggleKey: 'off' },
    tasks: { displayMode: 'overlay' }, promptHistory: { displayMode: 'overlay' },
    powerline: { style: 'capsule', charset: 'unicode', autoWrap: false, padding: 2,
      lines: [{ segments: { git: { enabled: true, showWorkingTree: false, showStashCount: true }, savings: { enabled: true, periodDays: 14 } } }] },
  } });
  await writeFile(f.file, original);
  await mkdir(join(f.owner.target.agentDir, 'tui'));
  await writeFile(join(f.owner.target.agentDir, 'tui/settings.json'), JSON.stringify({ presentation: { askUser: { displayMode: 'inline' } } }));
  await f.preferences.load();
  expect(f.preferences.values.presentation).toMatchObject({
    askUser: { displayMode: 'inline', singleSelectLayout: 'list', overlayToggleKey: '', commentToggleKey: 'off' },
    tasks: { displayMode: 'overlay' }, promptHistory: { displayMode: 'overlay' },
    powerline: { style: 'capsule', charset: 'unicode', autoWrap: false, padding: 2,
      lines: [{ segments: { git: { enabled: true }, savings: { enabled: true } } }] },
  });
  await f.preferences.update({ outputPad: 2 });
  expect(await readFile(f.file, 'utf8')).toBe(original);
  await writeFile(f.file, 'invalid legacy JSON');
  const reopened = new ClientPreferencesStore(f.owner.target.agentDir); await reopened.load();
  expect(reopened.values.presentation).toEqual(f.preferences.values.presentation);
});

it.each(['context-view', 'contextView'])('reads %s display mode once and keeps the local value authoritative', async key => {
  const f = await fixture();
  const legacy = JSON.stringify({ extensionConfig: { [key]: { displayMode: 'overlay' } } });
  await writeFile(f.file, legacy);
  await f.preferences.load();
  expect(f.preferences.values.presentation?.contextView.displayMode).toBe('overlay');
  await f.preferences.update({ presentation: { ...f.preferences.values.presentation!, contextView: { displayMode: 'inline' } } });
  expect(await readFile(f.file, 'utf8')).toBe(legacy);
  const local = JSON.parse(await readFile(join(f.owner.target.agentDir, 'tui/settings.json'), 'utf8'));
  expect(local.presentation.contextView).toEqual({ displayMode: 'inline' });
  const reopened = new ClientPreferencesStore(f.owner.target.agentDir); await reopened.load();
  expect(reopened.values.presentation?.contextView.displayMode).toBe('inline');
});

it.each([
  ['invalid JSON', '{', { keybindings: { 'app.exit': 'ctrl+x' } }],
  ['wrong-typed sections', JSON.stringify({ theme: 'felan-light', terminal: [], markdown: false, felanTui: 7 }), { theme: 'felan-light', keybindings: { 'app.exit': 'ctrl+x' } }],
  ['out-of-range values', JSON.stringify({ theme: 'felan-light', editorPaddingX: 99, terminal: { showImages: false, imageWidthCells: 2.5 }, extensionConfig: { powerline: { padding: 4097 } } }), { theme: 'felan-light', showImages: false, editorPadding: 1, imageWidthCells: 60 }],
  ['invalid theme', JSON.stringify({ theme: 'bad/theme/name', hideThinkingBlock: true }), { theme: 'felan-dark', hideThinking: true }],
])('skips %s in legacy settings without blocking valid fields or later writes', async (_name, legacy, expected) => {
  const f = await fixture();
  await writeFile(f.file, legacy as string);
  await writeFile(join(f.owner.target.agentDir, 'keybindings.json'), JSON.stringify({ 'app.exit': 'ctrl+x', 'app.model.select': 'invalid-key', 'app.tools.expand': 12 }));
  await f.preferences.load();
  expect(f.preferences.values).toMatchObject(expected as object);
  expect(f.preferences.values.keybindings).toEqual({ 'app.exit': 'ctrl+x' });
  expect(f.preferences.warnings).toHaveLength(1);
  await f.preferences.update({ outputPad: 2 });
  expect(f.preferences.values).toMatchObject({ ...expected as object, outputPad: 2 });
  expect(await readFile(f.file, 'utf8')).toBe(legacy);
});

it('treats malformed client settings as fatal instead of falling back to legacy', async () => {
  const f = await fixture();
  await mkdir(join(f.owner.target.agentDir, 'tui'));
  const path = join(f.owner.target.agentDir, 'tui/settings.json');
  for (const value of ['{', '{"imageWidthCells":2.5}', '{"presentation":{"powerline":{"padding":4097}}}', '{"keybindings":{"app.exit":"invalid-key"}}']) {
    await writeFile(path, value);
    await expect(f.preferences.load()).rejects.toThrow();
    await expect(f.preferences.update({ outputPad: 2 })).rejects.toThrow();
    expect(await readFile(path, 'utf8')).toBe(value);
  }
});

it('skips malformed legacy keybinding JSON while retaining valid settings and inline bindings', async () => {
  const f = await fixture();
  await writeFile(f.file, JSON.stringify({ theme: 'felan-light', felanTui: { keybindings: { 'app.exit': 'ctrl+x' } } }));
  await writeFile(join(f.owner.target.agentDir, 'keybindings.json'), '{');
  await f.preferences.load();
  expect(f.preferences.values).toMatchObject({ theme: 'felan-light', keybindings: { 'app.exit': 'ctrl+x' } });
  expect(f.preferences.warnings).toHaveLength(1);
  await f.preferences.update({ hideThinking: true });
  expect(f.preferences.values.hideThinking).toBe(true);
});

it('merges independent stores and changed presentation fields immediately before writing', async () => {
  const f = await fixture();
  const other = new ClientPreferencesStore(f.owner.target.agentDir);
  await Promise.all([f.preferences.load(), other.load()]);
  await Promise.all([f.preferences.update({ outputPad: 3 }), other.update({ showImages: false })]);
  await Promise.all([f.preferences.load(), other.load()]);
  const first = f.preferences.values.presentation!;
  const second = other.values.presentation!;
  await Promise.all([
    f.preferences.update({ presentation: { ...first, powerline: { ...first.powerline, padding: 2 } } }),
    other.update({ presentation: { ...second, powerline: { ...second.powerline, charset: 'unicode' } } }),
  ]);
  await f.preferences.load();
  expect(f.preferences.values).toMatchObject({ outputPad: 3, showImages: false, presentation: { powerline: { padding: 2, charset: 'unicode' } } });
});
