import type { ColorCompatibility, PowerlineConfig, ThemeColorKey } from './config.js';

export type ColorMode = 'none' | 'ansi' | 'ansi256' | 'truecolor';

export interface ColorPair {
  fg: string;
  bg: string;
}

export interface ThemePalette {
  colors: Record<ThemeColorKey, ColorPair>;
}

const THEMES: Record<PowerlineConfig['theme'], ThemePalette> = {
  dark: makeTheme({
    directory: ['#f8fafc', '#2563eb'], git: ['#052e16', '#22c55e'], model: ['#ffffff', '#7c3aed'],
    session: ['#111827', '#f59e0b'], context: ['#ecfeff', '#0891b2'], status: ['#f8fafc', '#334155'],
    warning: ['#111827', '#fbbf24'], critical: ['#ffffff', '#dc2626'], muted: ['#cbd5e1', '#1f2937'],
    extensionStatus1: ['#cbd5e1', '#1f2937'], extensionStatus2: ['#bfdbfe', '#1e3a5f'],
    extensionStatus3: ['#ddd6fe', '#3b2f5f'], extensionStatus4: ['#99f6e4', '#134e4a'],
  }),
  light: makeTheme({
    directory: ['#ffffff', '#1d4ed8'], git: ['#052e16', '#86efac'], model: ['#ffffff', '#6d28d9'],
    session: ['#451a03', '#fcd34d'], context: ['#083344', '#67e8f9'], status: ['#111827', '#e5e7eb'],
    warning: ['#451a03', '#fde68a'], critical: ['#ffffff', '#ef4444'], muted: ['#374151', '#e5e7eb'],
    extensionStatus1: ['#374151', '#e5e7eb'], extensionStatus2: ['#1e3a8a', '#dbeafe'],
    extensionStatus3: ['#581c87', '#ede9fe'], extensionStatus4: ['#134e4a', '#ccfbf1'],
  }),
  nord: makeTheme({
    directory: ['#eceff4', '#5e81ac'], git: ['#2e3440', '#a3be8c'], model: ['#2e3440', '#b48ead'],
    session: ['#2e3440', '#ebcb8b'], context: ['#2e3440', '#88c0d0'], status: ['#d8dee9', '#434c5e'],
    warning: ['#2e3440', '#ebcb8b'], critical: ['#eceff4', '#bf616a'], muted: ['#d8dee9', '#3b4252'],
    extensionStatus1: ['#d8dee9', '#3b4252'], extensionStatus2: ['#d8dee9', '#434c5e'],
    extensionStatus3: ['#2e3440', '#8fbcbb'], extensionStatus4: ['#2e3440', '#81a1c1'],
  }),
  'tokyo-night': makeTheme({
    directory: ['#c0caf5', '#2f7dc8'], git: ['#1a1b26', '#9ece6a'], model: ['#c0caf5', '#7aa2f7'],
    session: ['#1a1b26', '#e0af68'], context: ['#1a1b26', '#7dcfff'], status: ['#c0caf5', '#24283b'],
    warning: ['#1a1b26', '#e0af68'], critical: ['#c0caf5', '#f7768e'], muted: ['#a9b1d6', '#1f2335'],
    extensionStatus1: ['#a9b1d6', '#1f2335'], extensionStatus2: ['#c0caf5', '#24283b'],
    extensionStatus3: ['#1a1b26', '#7aa2f7'], extensionStatus4: ['#1a1b26', '#73daca'],
  }),
  'rose-pine': makeTheme({
    directory: ['#e0def4', '#31748f'], git: ['#191724', '#9ccfd8'], model: ['#e0def4', '#c4a7e7'],
    session: ['#191724', '#f6c177'], context: ['#191724', '#ebbcba'], status: ['#e0def4', '#26233a'],
    warning: ['#191724', '#f6c177'], critical: ['#e0def4', '#eb6f92'], muted: ['#908caa', '#21202e'],
    extensionStatus1: ['#908caa', '#21202e'], extensionStatus2: ['#e0def4', '#26233a'],
    extensionStatus3: ['#191724', '#9ccfd8'], extensionStatus4: ['#191724', '#c4a7e7'],
  }),
  gruvbox: makeTheme({
    directory: ['#fbf1c7', '#458588'], git: ['#282828', '#98971a'], model: ['#fbf1c7', '#b16286'],
    session: ['#282828', '#d79921'], context: ['#282828', '#83a598'], status: ['#ebdbb2', '#3c3836'],
    warning: ['#282828', '#fabd2f'], critical: ['#fbf1c7', '#cc241d'], muted: ['#d5c4a1', '#3c3836'],
    extensionStatus1: ['#d5c4a1', '#3c3836'], extensionStatus2: ['#ebdbb2', '#504945'],
    extensionStatus3: ['#282828', '#83a598'], extensionStatus4: ['#282828', '#8ec07c'],
  }),
};

export function resolveColorMode(compatibility: ColorCompatibility): ColorMode {
  if (compatibility !== 'auto') return compatibility;
  if (process.env.NO_COLOR || process.env.TERM === 'dumb' || process.env.FORCE_COLOR === '0') return 'none';
  const colorTerm = (process.env.COLORTERM ?? '').toLowerCase();
  if (colorTerm.includes('truecolor') || colorTerm.includes('24bit')) return 'truecolor';
  if ((process.env.TERM ?? '').includes('256color')) return 'ansi256';
  return 'ansi';
}

export function getThemePalette(config: PowerlineConfig): ThemePalette {
  return THEMES[config.theme];
}

export function colorBlock(text: string, pair: ColorPair, mode: ColorMode): string {
  return applyAnsi(text, mode, pair.fg, pair.bg);
}

export function colorForeground(text: string, color: string, mode: ColorMode): string {
  return applyAnsi(text, mode, color);
}

export function colorPairText(text: string, pair: ColorPair, mode: ColorMode): string {
  return applyAnsi(text, mode, pair.fg);
}

function makeTheme(colors: Record<ThemeColorKey, [fg: string, bg: string]>): ThemePalette {
  return { colors: Object.fromEntries(Object.entries(colors).map(([key, [fg, bg]]) => [key, { fg, bg }])) as Record<ThemeColorKey, ColorPair> };
}

function applyAnsi(text: string, mode: ColorMode, fg?: string, bg?: string): string {
  if (mode === 'none') return text;
  const codes = [fg ? colorCode(fg, false, mode) : '', bg ? colorCode(bg, true, mode) : ''].filter(Boolean);
  return codes.length > 0 ? `\x1b[${codes.join(';')}m${text}\x1b[0m` : text;
}

function colorCode(hex: string, background: boolean, mode: Exclude<ColorMode, 'none'>): string {
  const rgb = hexToRgb(hex);
  if (mode === 'truecolor') return `${background ? 48 : 38};2;${rgb.r};${rgb.g};${rgb.b}`;
  if (mode === 'ansi256') return `${background ? 48 : 38};5;${rgbToAnsi256(rgb.r, rgb.g, rgb.b)}`;
  return String(nearestAnsi16(rgb.r, rgb.g, rgb.b, background));
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const value = hex.slice(1);
  return { r: Number.parseInt(value.slice(0, 2), 16), g: Number.parseInt(value.slice(2, 4), 16), b: Number.parseInt(value.slice(4, 6), 16) };
}

function rgbToAnsi256(r: number, g: number, b: number): number {
  if (r === g && g === b) {
    if (r < 8) return 16;
    if (r > 248) return 231;
    return Math.round(((r - 8) / 247) * 24) + 232;
  }
  return 16 + 36 * Math.round((r / 255) * 5) + 6 * Math.round((g / 255) * 5) + Math.round((b / 255) * 5);
}

const ANSI16_COLORS = [
  { rgb: [0, 0, 0], fg: 30, bg: 40 }, { rgb: [128, 0, 0], fg: 31, bg: 41 },
  { rgb: [0, 128, 0], fg: 32, bg: 42 }, { rgb: [128, 128, 0], fg: 33, bg: 43 },
  { rgb: [0, 0, 128], fg: 34, bg: 44 }, { rgb: [128, 0, 128], fg: 35, bg: 45 },
  { rgb: [0, 128, 128], fg: 36, bg: 46 }, { rgb: [192, 192, 192], fg: 37, bg: 47 },
  { rgb: [128, 128, 128], fg: 90, bg: 100 }, { rgb: [255, 0, 0], fg: 91, bg: 101 },
  { rgb: [0, 255, 0], fg: 92, bg: 102 }, { rgb: [255, 255, 0], fg: 93, bg: 103 },
  { rgb: [0, 0, 255], fg: 94, bg: 104 }, { rgb: [255, 0, 255], fg: 95, bg: 105 },
  { rgb: [0, 255, 255], fg: 96, bg: 106 }, { rgb: [255, 255, 255], fg: 97, bg: 107 },
] as const;

function nearestAnsi16(r: number, g: number, b: number, background: boolean): number {
  let best: { readonly rgb: readonly [number, number, number]; readonly fg: number; readonly bg: number } = ANSI16_COLORS[0];
  let distance = Number.POSITIVE_INFINITY;
  for (const candidate of ANSI16_COLORS) {
    const [red, green, blue] = candidate.rgb;
    const candidateDistance = (r - red) ** 2 + (g - green) ** 2 + (b - blue) ** 2;
    if (candidateDistance < distance) {
      best = candidate;
      distance = candidateDistance;
    }
  }
  return background ? best.bg : best.fg;
}
