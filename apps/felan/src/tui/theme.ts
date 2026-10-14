import { lstatSync, fstatSync, openSync, closeSync, readSync, opendirSync, realpathSync, constants, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Theme, type ThemeBg, type ThemeColor } from '@earendil-works/pi-coding-agent';
import { getTerminalColorMode, parseColor, type MarkdownTheme, type SelectListTheme, type Terminal, type TerminalColors } from '@earendil-works/pi-tui';

export const THEME_BYTES = 128 * 1024;
export const FELAN_THEME_PATHS = ['felan-light', 'felan-dark'].map(name => fileURLToPath(new URL(`../themes/${name}.json`, import.meta.url)));
const foreground = ['accent', 'border', 'borderAccent', 'borderMuted', 'success', 'error', 'warning', 'muted', 'dim', 'text', 'thinkingText',
  'scrollbarTrack', 'scrollbarThumb', 'searchMatchText', 'userMessageText', 'customMessageText', 'customMessageLabel', 'toolTitle', 'toolOutput',
  'mdHeading', 'mdLink', 'mdLinkUrl', 'mdCode', 'mdCodeBlock', 'mdCodeBlockBorder', 'mdQuote', 'mdQuoteBorder', 'mdHr', 'mdListBullet',
  'toolDiffAdded', 'toolDiffRemoved', 'toolDiffContext', 'syntaxComment', 'syntaxKeyword', 'syntaxFunction', 'syntaxVariable', 'syntaxString',
  'syntaxNumber', 'syntaxType', 'syntaxOperator', 'syntaxPunctuation', 'thinkingOff', 'thinkingMinimal', 'thinkingLow', 'thinkingMedium',
  'thinkingHigh', 'thinkingXhigh', 'thinkingMax', 'bashMode'] as const satisfies readonly ThemeColor[];
const background = ['selectedBg', 'searchMatchBg', 'userMessageBg', 'customMessageBg', 'toolPendingBg', 'toolSuccessBg', 'toolErrorBg'] as const satisfies readonly ThemeBg[];
const optional = new Set(['scrollbarTrack', 'scrollbarThumb', 'thinkingMax', 'searchMatchText', 'searchMatchBg']);
const { generateSystemThemeColors }: {
  generateSystemThemeColors(input: TerminalColors & { appearanceHint: 'light' | 'dark' }): {
    colors: Record<ThemeColor | ThemeBg, string | number>; dim: ThemeColor[]; appearance?: 'light' | 'dark';
  };
} = await import(new URL('./modes/interactive/theme/system-theme.js', import.meta.resolve('@earendil-works/pi-coding-agent')).href);

export function themeName(value: unknown): string {
  if (typeof value !== 'string' || !value || Buffer.byteLength(value) > 128 || value === '.' || value === '..'
    || /[/\\\u0000-\u001f\u007f]/u.test(value) || value.trim() !== value) throw new Error('Invalid client theme name.');
  return value;
}

export function themeSetting(value: unknown): string {
  if (typeof value !== 'string' || Buffer.byteLength(value) > 257) throw new Error('Invalid client theme setting.');
  const names = value.split('/');
  if (names.length > 2) throw new Error('Use a theme name or a light/dark theme pair.');
  names.forEach(themeName); return value;
}

export function parseClientTheme(text: string, expectedName?: string): Theme {
  if (Buffer.byteLength(text) > THEME_BYTES) throw new Error('Client theme exceeds 128 KiB.');
  const data: unknown = JSON.parse(text);
  const record = (value: unknown): Record<string, unknown> => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid client theme object.');
    const result = value as Record<string, unknown>;
    if (Object.keys(result).some(key => ['__proto__', 'constructor', 'prototype'].includes(key))) throw new Error('Invalid client theme key.');
    return result;
  };
  const value = record(data); const name = themeName(value.name);
  if (expectedName !== undefined && name !== expectedName) throw new Error('Client theme name does not match its file.');
  const colors = record(value.colors); const vars = value.vars === undefined ? {} : record(value.vars);
  const resolve = (color: unknown, seen = new Set<string>()): string | number => {
    if (typeof color === 'number' && Number.isInteger(color) && color >= 0 && color <= 255) return color;
    if (typeof color !== 'string') throw new Error('Invalid client theme color.');
    if (Object.hasOwn(vars, color)) {
      if (seen.has(color) || seen.size >= 64) throw new Error('Cyclic client theme color.');
      seen.add(color); return resolve(vars[color], seen);
    }
    if (color !== '') parseColor(color);
    return color;
  };
  const fg: Record<string, string | number> = {}; const bg: Record<string, string | number> = {};
  for (const token of [...foreground, ...background]) {
    if (!Object.hasOwn(colors, token) && optional.has(token)) continue;
    (background.includes(token as ThemeBg) ? bg : fg)[token] = resolve(colors[token]);
  }
  if (Object.keys(colors).some(token => !foreground.includes(token as ThemeColor) && !background.includes(token as ThemeBg))) throw new Error('Unknown client theme token.');
  if (value.appearance !== undefined && value.appearance !== 'light' && value.appearance !== 'dark') throw new Error('Invalid client theme appearance.');
  if (value.dim !== undefined && (!Array.isArray(value.dim) || value.dim.length > foreground.length
    || value.dim.some(token => !foreground.includes(token as ThemeColor)))) throw new Error('Invalid client theme dim tokens.');
  return new Theme(fg as ConstructorParameters<typeof Theme>[0], bg as ConstructorParameters<typeof Theme>[1], getTerminalColorMode(), {
    name, ...(value.appearance === undefined ? {} : { appearance: value.appearance }),
    ...(value.dim === undefined ? {} : { dim: value.dim as ThemeColor[] }),
  });
}

export function systemClientTheme(colors: TerminalColors = {}, appearance: 'light' | 'dark' = 'dark'): Theme {
  const generated = generateSystemThemeColors({ ...colors, appearanceHint: appearance });
  const fg = Object.fromEntries(foreground.map(token => [token, generated.colors[token]])) as Record<ThemeColor, string | number>;
  const bg = Object.fromEntries(background.map(token => [token, generated.colors[token]])) as Record<ThemeBg, string | number>;
  return new Theme(fg, bg, getTerminalColorMode(), { name: 'system', ...(generated.appearance === undefined ? {} : { appearance: generated.appearance }), dim: generated.dim });
}

export function bundledClientThemes(): Map<string, Theme> {
  const themes = new Map<string, Theme>();
  for (const name of ['felan-dark', 'felan-light', 'dark', 'light']) {
    const file = name.startsWith('felan-') ? new URL(`../themes/${name}.json`, import.meta.url)
      : new URL(`./modes/interactive/theme/${name}.json`, import.meta.resolve('@earendil-works/pi-coding-agent'));
    const text = readFileSync(file, 'utf8'); themes.set(name, parseClientTheme(text, name));
  }
  themes.set('system', systemClientTheme());
  return themes;
}

export function defaultClientTheme(): Theme { return bundledClientThemes().get('felan-dark')!; }

export function themedClientTerminal(terminal: Terminal, theme: () => Theme): Terminal {
  return new Proxy(terminal, { get(target, property) {
    if (property === 'write') return (text: string) => {
      const current = theme(); target.write(current.bg('customMessageBg', current.fg('text', text)));
    };
    if (property === 'stop') return () => { try { target.stop(); } finally { target.write('\x1b[0m'); } };
    const value: unknown = Reflect.get(target, property, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
}

export function getLocalThemePaths(agentDir: string, packaged: readonly string[] = FELAN_THEME_PATHS): readonly string[] {
  const path = join(agentDir, 'themes');
  try {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o022)) return [...packaged];
    const root = realpathSync(path); const names = new Set<string>(); const directory = opendirSync(root);
    try {
      for (let count = 0; ; count++) {
        const entry = directory.readSync(); if (!entry) break;
        if (count >= 256) return [...packaged];
        if (!entry.name.endsWith('.json')) continue;
        let file: number | undefined;
        try {
          const name = themeName(entry.name.slice(0, -5));
          file = openSync(join(root, entry.name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
          const info = fstatSync(file);
          if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid?.() || info.size > THEME_BYTES) continue;
          const bytes = Buffer.alloc(THEME_BYTES + 1); let size = 0;
          while (size < bytes.length) { const read = readSync(file, bytes, size, bytes.length - size, size); if (!read) break; size += read; }
          if (size > THEME_BYTES) continue;
          parseClientTheme(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size)), name); names.add(name);
        } catch { continue; }
        finally { if (file !== undefined) closeSync(file); }
      }
    } finally { directory.closeSync(); }
    return [root, ...packaged.filter(file => !names.has(basename(file, '.json')))];
  } catch { return [...packaged]; }
}

export function clientSelectListTheme(theme: () => Theme): SelectListTheme {
  return { selectedPrefix: text => theme().fg('accent', text), selectedText: text => theme().fg('accent', text),
    description: text => theme().fg('muted', text), scrollInfo: text => theme().fg('dim', text), noMatch: text => theme().fg('warning', text) };
}

export function clientMarkdownTheme(theme: () => Theme): MarkdownTheme {
  return { heading: text => theme().fg('mdHeading', text), link: text => theme().fg('mdLink', text), linkUrl: text => theme().fg('mdLinkUrl', text),
    code: text => theme().fg('mdCode', text), codeBlock: text => theme().fg('mdCodeBlock', text), codeBlockBorder: text => theme().fg('mdCodeBlockBorder', text),
    quote: text => theme().fg('mdQuote', text), quoteBorder: text => theme().fg('mdQuoteBorder', text), hr: text => theme().fg('mdHr', text),
    listBullet: text => theme().fg('mdListBullet', text), bold: text => theme().bold(text), italic: text => theme().italic(text),
    strikethrough: text => theme().strikethrough(text), underline: text => theme().underline(text) };
}
