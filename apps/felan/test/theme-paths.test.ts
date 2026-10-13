import { mkdtemp, mkdir, readFile, rm, writeFile, symlink, link, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { colorToHex } from '@earendil-works/pi-tui';
import { ClientThemes } from '../src/tui/theme-config.js';
import { FELAN_THEME_PATHS, getLocalThemePaths, parseClientTheme } from '../src/tui/theme.js';
import { clientConfigurationRoot } from '../src/client-application.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function root() { const path = await mkdtemp(join(tmpdir(), 'felan-client-themes-')); roots.push(path); return path; }
async function palette(name = 'custom', accent = '#123456') {
  const theme = JSON.parse(await readFile(FELAN_THEME_PATHS[1]!, 'utf8'));
  theme.name = name; theme.colors.accent = accent; return JSON.stringify(theme);
}
async function install(path: string, name = 'custom', accent = '#123456') {
  await mkdir(join(path, 'themes'), { recursive: true });
  await writeFile(join(path, 'themes', `${name}.json`), await palette(name, accent));
}

it('keeps the production root explicit and isolated client configuration below daemon-runtime', () => {
  expect(clientConfigurationRoot({ agentDir: '/explicit-agent' })).toBe('/explicit-agent');
  expect(clientConfigurationRoot({ agentDir: '/host-agent', daemonRuntime: '/disposable' })).toBe('/disposable/client');
});

it('loads packaged client themes with their actual palettes', async () => {
  const themes = new ClientThemes(await root()); await themes.load();
  expect(themes.names).toEqual(expect.arrayContaining(['felan-dark', 'felan-light', 'dark', 'light']));
  expect(colorToHex(themes.theme.colors.accent)).toBe('#75a58a');
  expect(FELAN_THEME_PATHS.every(path => path.includes('/apps/felan/src/themes/'))).toBe(true);
});

it('loads legacy theme preferences without changing shared settings and writes only client-owned settings', async () => {
  const path = await root(); await install(path);
  const original = JSON.stringify({ theme: 'custom', unrelated: { preserved: true } });
  await writeFile(join(path, 'settings.json'), original);
  const themes = new ClientThemes(path); await themes.load();
  expect(themes.value).toBe('custom'); expect(colorToHex(themes.theme.colors.accent)).toBe('#123456');
  await themes.update('felan-light');
  expect(JSON.parse(await readFile(join(path, 'tui', 'settings.json'), 'utf8'))).toEqual({ theme: 'felan-light' });
  expect(await readFile(join(path, 'settings.json'), 'utf8')).toBe(original);
});

it('gives client-owned preferences precedence over legacy settings and preserves unrelated client keys', async () => {
  const path = await root(); await mkdir(join(path, 'tui'));
  await writeFile(join(path, 'settings.json'), JSON.stringify({ theme: 'light' }));
  await writeFile(join(path, 'tui', 'settings.json'), JSON.stringify({ theme: 'dark', otherClientField: true }));
  const themes = new ClientThemes(path); await themes.load(); await themes.update('felan-light');
  expect(JSON.parse(await readFile(join(path, 'tui', 'settings.json'), 'utf8'))).toEqual({ theme: 'felan-light', otherClientField: true });
});

it('uses valid user palettes over shipped palettes and keeps invalid overrides from hiding shipped themes', async () => {
  const path = await root(); await install(path, 'felan-dark', '#abcdef');
  await writeFile(join(path, 'themes', 'felan-light.json'), '{');
  const themes = new ClientThemes(path); await themes.load();
  expect(colorToHex(themes.theme.colors.accent)).toBe('#abcdef');
  expect(themes.warnings).toHaveLength(1);
  expect(getLocalThemePaths(path)).toEqual([join(await realpath(path), 'themes'), FELAN_THEME_PATHS[0]]);
});

it('selects both sides of a saved light/dark pair without rewriting its name', async () => {
  const path = await root(); await install(path, 'my-light', '#abcdef'); await install(path, 'my-dark', '#123456');
  await writeFile(join(path, 'settings.json'), JSON.stringify({ theme: 'my-light/my-dark' }));
  const themes = new ClientThemes(path, undefined, 'light'); await themes.load();
  expect(themes.theme.name).toBe('my-light'); themes.setAppearance('dark'); expect(themes.theme.name).toBe('my-dark');
  expect(themes.value).toBe('my-light/my-dark');
});

it('keeps launch overrides active without replacing the stored preference', async () => {
  const themes = new ClientThemes(await root(), 'light'); await themes.load(); await themes.update('felan-dark');
  expect(themes.value).toBe('felan-dark'); expect(themes.theme.name).toBe('light');
});

it('does not discover ambient Pi or project themes', async () => {
  const path = await root(); await mkdir(join(path, '.pi', 'themes'), { recursive: true });
  await writeFile(join(path, '.pi', 'themes', 'ambient.json'), await palette('ambient'));
  const themes = new ClientThemes(path); await themes.load(); expect(themes.names).not.toContain('ambient');
});

it('does not consult production client settings for an isolated configuration root', async () => {
  const host = await root(); const isolated = await root(); await install(host, 'host-only');
  await writeFile(join(host, 'settings.json'), JSON.stringify({ theme: 'host-only' }));
  const previous = process.env.FELAN_AGENT_DIR; process.env.FELAN_AGENT_DIR = host;
  try {
    const themes = new ClientThemes(clientConfigurationRoot({ daemonRuntime: isolated })); await themes.load();
    expect(themes.value).toBe('felan-dark'); expect(themes.names).not.toContain('host-only');
    await themes.update('felan-light');
    expect(JSON.parse(await readFile(join(host, 'settings.json'), 'utf8')).theme).toBe('host-only');
  } finally { if (previous === undefined) delete process.env.FELAN_AGENT_DIR; else process.env.FELAN_AGENT_DIR = previous; }
});

it('retains an unavailable saved name with an explicit diagnostic and rejects selecting unknown themes', async () => {
  const path = await root(); await writeFile(join(path, 'settings.json'), JSON.stringify({ theme: 'missing' }));
  const themes = new ClientThemes(path); await themes.load();
  expect(themes.value).toBe('missing'); expect(themes.warnings.join(' ')).toContain('unavailable');
  await expect(themes.update('also-missing')).rejects.toThrow('unavailable'); expect(themes.value).toBe('missing');
});

it.each(['../outside', '/absolute', 'x/y/z', '..', 'bad\\path'])('rejects traversal in theme setting %s', async name => {
  const themes = new ClientThemes(await root()); await expect(themes.update(name)).rejects.toThrow();
});

it('rejects theme-directory and settings symlinks without reading their targets', async () => {
  const path = await root(); const outside = await root(); await install(outside);
  await symlink(join(outside, 'themes'), join(path, 'themes'));
  await expect(new ClientThemes(path).load()).rejects.toThrow('Unsafe');
  const another = await root(); const sensitive = join(outside, 'settings.json');
  await writeFile(sensitive, JSON.stringify({ theme: 'light' })); await symlink(sensitive, join(another, 'settings.json'));
  await expect(new ClientThemes(another).load()).rejects.toThrow();
  expect(await readFile(sensitive, 'utf8')).toBe(JSON.stringify({ theme: 'light' }));
});

it('ignores symlinked, hardlinked, oversized, mismatched and cyclic theme files', async () => {
  const path = await root(); const outside = await root(); await mkdir(join(path, 'themes'));
  const external = join(outside, 'external.json'); await writeFile(external, await palette('external'));
  await symlink(external, join(path, 'themes', 'external.json')); await link(external, join(path, 'themes', 'linked.json'));
  await writeFile(join(path, 'themes', 'large.json'), ' '.repeat(128 * 1024 + 1));
  await writeFile(join(path, 'themes', 'wrong.json'), await palette('another'));
  const cyclic = JSON.parse(await palette('cycle')); cyclic.vars.loop = 'loop'; cyclic.colors.accent = 'loop';
  await writeFile(join(path, 'themes', 'cycle.json'), JSON.stringify(cyclic));
  const themes = new ClientThemes(path); await themes.load(); expect(themes.names).not.toContain('external');
  expect(themes.names).not.toContain('another'); expect(themes.warnings).toHaveLength(5);
});

it('rejects invalid colors, missing required tokens and oversized legacy settings', async () => {
  const invalid = JSON.parse(await palette()); invalid.colors.accent = '\u001b[31m';
  expect(() => parseClientTheme(JSON.stringify(invalid))).toThrow();
  delete invalid.colors.accent; expect(() => parseClientTheme(JSON.stringify(invalid))).toThrow();
  const path = await root(); await writeFile(join(path, 'settings.json'), ' '.repeat(256 * 1024 + 1));
  await expect(new ClientThemes(path).load()).rejects.toThrow('oversized');
});
