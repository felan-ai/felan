import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FelanExtensionAPI } from '@felan-ai/agent-core';

export type ThemeName = 'dark' | 'light' | 'nord' | 'tokyo-night' | 'rose-pine' | 'gruvbox' | 'custom';
export type FooterStyle = 'minimal' | 'powerline' | 'capsule';
export type Charset = 'unicode' | 'text';
export type ColorCompatibility = 'auto' | 'none' | 'ansi' | 'ansi256' | 'truecolor';
export type DirectoryStyle = 'full' | 'fish' | 'basename';
export type SessionDisplayType = 'cost' | 'tokens' | 'both' | 'breakdown';
export type ContextDisplayStyle = 'text' | 'bar' | 'blocks' | 'blocks-line' | 'dots';
export type SegmentAlignment = 'left' | 'right';
export type SegmentName = 'directory' | 'git' | 'model' | 'session' | 'subscription' | 'context' | 'status';
export type ThemeColorKey = SegmentName | 'warning' | 'critical' | 'muted' | 'extensionStatus1' | 'extensionStatus2' | 'extensionStatus3' | 'extensionStatus4';

export interface SegmentConfig {
  enabled: boolean;
  align?: SegmentAlignment;
  style?: DirectoryStyle;
  showSha?: boolean;
  showWorkingTree?: boolean;
  showTag?: boolean;
  showTimeSinceCommit?: boolean;
  showStashCount?: boolean;
  showUpstream?: boolean;
  showRepoName?: boolean;
  type?: SessionDisplayType;
  displayStyle?: ContextDisplayStyle;
  showPercentageOnly?: boolean;
  showTokensOnly?: boolean;
  showProviderName?: boolean;
  showReset?: boolean;
  showPercentage?: boolean;
  maxWindows?: number;
  width?: number;
  warningThreshold?: number;
  criticalThreshold?: number;
}

export interface DisplayLineConfig {
  segments: Partial<Record<SegmentName, SegmentConfig>>;
}

export interface ThemeColorConfig {
  fg: string;
  bg: string;
}

export interface PowerlineConfig {
  theme: ThemeName;
  colors?: {
    custom?: Partial<Record<ThemeColorKey, ThemeColorConfig>>;
  };
  display: {
    style: FooterStyle;
    charset: Charset;
    colorCompatibility: ColorCompatibility;
    autoWrap: boolean;
    padding: number;
    lines: DisplayLineConfig[];
  };
}

export const POWERLINE_FLAGS = {
  theme: 'felan-powerline-theme',
  style: 'felan-powerline-style',
  charset: 'felan-powerline-charset',
  color: 'felan-powerline-color',
  wrap: 'felan-powerline-wrap',
  directoryStyle: 'felan-powerline-directory-style',
  sessionType: 'felan-powerline-session-type',
  contextStyle: 'felan-powerline-context-style',
} as const;

const DEFAULT_CONFIG: PowerlineConfig = {
  theme: 'dark',
  display: {
    style: 'powerline',
    charset: 'text',
    colorCompatibility: 'auto',
    autoWrap: true,
    padding: 1,
    lines: [
      {
        segments: {
          directory: { enabled: true, style: 'fish' },
          git: { enabled: true, showSha: true, showWorkingTree: true },
          model: { enabled: true, align: 'right' },
        },
      },
      {
        segments: {
          session: { enabled: true, type: 'tokens' },
          subscription: { enabled: true, showProviderName: true, showReset: true, showPercentage: true, maxWindows: 3 },
          context: { enabled: true, displayStyle: 'bar' },
          status: { enabled: true, align: 'right' },
        },
      },
    ],
  },
};

export const POWERLINE_CONFIG_FILENAME = 'powerline.json';

const THEMES = new Set<ThemeName>(['dark', 'light', 'nord', 'tokyo-night', 'rose-pine', 'gruvbox', 'custom']);
const STYLES = new Set<FooterStyle>(['minimal', 'powerline', 'capsule']);
const CHARSETS = new Set<Charset>(['unicode', 'text']);
const COLORS = new Set<ColorCompatibility>(['auto', 'none', 'ansi', 'ansi256', 'truecolor']);
const DIRECTORY_STYLES = new Set<DirectoryStyle>(['full', 'fish', 'basename']);
const SESSION_TYPES = new Set<SessionDisplayType>(['cost', 'tokens', 'both', 'breakdown']);
const CONTEXT_STYLES = new Set<ContextDisplayStyle>(['text', 'bar', 'blocks', 'blocks-line', 'dots']);
const ALIGNMENTS = new Set<SegmentAlignment>(['left', 'right']);
const SEGMENT_NAMES = new Set<SegmentName>(['directory', 'git', 'model', 'session', 'subscription', 'context', 'status']);
const THEME_COLOR_KEYS = new Set<ThemeColorKey>([
  ...SEGMENT_NAMES,
  'warning',
  'critical',
  'muted',
  'extensionStatus1',
  'extensionStatus2',
  'extensionStatus3',
  'extensionStatus4',
]);
const BOOLEAN_SEGMENT_FIELDS = [
  'showSha',
  'showWorkingTree',
  'showTag',
  'showTimeSinceCommit',
  'showStashCount',
  'showUpstream',
  'showRepoName',
  'showPercentageOnly',
  'showTokensOnly',
  'showProviderName',
  'showReset',
  'showPercentage',
] as const;
const NUMBER_SEGMENT_FIELDS = ['maxWindows', 'width', 'warningThreshold', 'criticalThreshold'] as const;

export interface LoadPowerlineConfigResult {
  readonly path: string;
  readonly config: PowerlineConfig;
  readonly warning?: string;
}

export function loadPowerlineConfig(agentDir: string): LoadPowerlineConfigResult {
  const path = join(agentDir, POWERLINE_CONFIG_FILENAME);
  try {
    return {
      path,
      config: parsePowerlineConfig(JSON.parse(readFileSync(path, 'utf8'))),
    };
  } catch (error) {
    const config = cloneConfig(DEFAULT_CONFIG);
    if (isNodeError(error) && error.code === 'ENOENT') return { path, config };
    return {
      path,
      config,
      warning: `Could not load powerline config ${path}: ${errorMessage(error)}`,
    };
  }
}

export function registerPowerlineFlags(
  pi: FelanExtensionAPI,
  defaults: PowerlineConfig = DEFAULT_CONFIG,
): void {
  pi.registerFlag(POWERLINE_FLAGS.theme, { type: 'string', default: defaults.theme, description: 'Powerline color theme' });
  pi.registerFlag(POWERLINE_FLAGS.style, { type: 'string', default: defaults.display.style, description: 'Powerline footer style' });
  pi.registerFlag(POWERLINE_FLAGS.charset, { type: 'string', default: defaults.display.charset, description: 'Powerline footer charset' });
  pi.registerFlag(POWERLINE_FLAGS.color, { type: 'string', default: defaults.display.colorCompatibility, description: 'Powerline ANSI color mode' });
  pi.registerFlag(POWERLINE_FLAGS.wrap, { type: 'boolean', default: defaults.display.autoWrap, description: 'Wrap long powerline segments' });
  pi.registerFlag(POWERLINE_FLAGS.directoryStyle, { type: 'string', default: findSegment(defaults, 'directory')?.style ?? 'fish', description: 'Powerline directory display style' });
  pi.registerFlag(POWERLINE_FLAGS.sessionType, { type: 'string', default: findSegment(defaults, 'session')?.type ?? 'tokens', description: 'Powerline session usage display' });
  pi.registerFlag(POWERLINE_FLAGS.contextStyle, { type: 'string', default: findSegment(defaults, 'context')?.displayStyle ?? 'bar', description: 'Powerline context usage display' });
}

export function configFromFlags(
  pi: Pick<FelanExtensionAPI, 'getFlag'>,
  defaults: PowerlineConfig = DEFAULT_CONFIG,
): PowerlineConfig {
  const config = cloneConfig(defaults);
  config.theme = enumFlag(pi, POWERLINE_FLAGS.theme, THEMES, config.theme);
  config.display.style = enumFlag(pi, POWERLINE_FLAGS.style, STYLES, config.display.style);
  config.display.charset = enumFlag(pi, POWERLINE_FLAGS.charset, CHARSETS, config.display.charset);
  config.display.colorCompatibility = enumFlag(pi, POWERLINE_FLAGS.color, COLORS, config.display.colorCompatibility);
  config.display.autoWrap = booleanFlag(pi, POWERLINE_FLAGS.wrap, config.display.autoWrap);

  const directory = findSegment(config, 'directory');
  if (directory) directory.style = enumFlag(pi, POWERLINE_FLAGS.directoryStyle, DIRECTORY_STYLES, directory.style ?? 'fish');
  const session = findSegment(config, 'session');
  if (session) session.type = enumFlag(pi, POWERLINE_FLAGS.sessionType, SESSION_TYPES, session.type ?? 'tokens');
  const context = findSegment(config, 'context');
  if (context) context.displayStyle = enumFlag(pi, POWERLINE_FLAGS.contextStyle, CONTEXT_STYLES, context.displayStyle ?? 'bar');
  return config;
}

function enumFlag<T extends string>(
  pi: Pick<FelanExtensionAPI, 'getFlag'>,
  name: string,
  values: ReadonlySet<T>,
  fallback: T,
): T {
  const value = pi.getFlag(name);
  return typeof value === 'string' && values.has(value as T) ? value as T : fallback;
}

function booleanFlag(pi: Pick<FelanExtensionAPI, 'getFlag'>, name: string, fallback: boolean): boolean {
  const value = pi.getFlag(name);
  return typeof value === 'boolean' ? value : fallback;
}

function cloneConfig(config: PowerlineConfig): PowerlineConfig {
  return {
    theme: config.theme,
    ...(config.colors?.custom === undefined
      ? {}
      : {
          colors: {
            custom: Object.fromEntries(
              Object.entries(config.colors.custom).map(([name, color]) => [name, color ? { ...color } : color]),
            ),
          },
        }),
    display: {
      ...config.display,
      lines: config.display.lines.map((line) => ({
        segments: Object.fromEntries(
          Object.entries(line.segments).map(([name, segment]) => [name, segment ? { ...segment } : segment]),
        ),
      })),
    },
  };
}

function parsePowerlineConfig(value: unknown): PowerlineConfig {
  if (!isRecord(value)) throw new Error('configuration root must be an object');
  const config = cloneConfig(DEFAULT_CONFIG);
  if (typeof value.theme === 'string' && THEMES.has(value.theme as ThemeName)) {
    config.theme = value.theme as ThemeName;
  }

  if (isRecord(value.colors) && isRecord(value.colors.custom)) {
    const custom = parseCustomColors(value.colors.custom);
    if (Object.keys(custom).length > 0) config.colors = { custom };
  }

  if (!isRecord(value.display)) return config;
  const display = value.display;
  if (typeof display.style === 'string' && STYLES.has(display.style as FooterStyle)) {
    config.display.style = display.style as FooterStyle;
  }
  if (typeof display.charset === 'string' && CHARSETS.has(display.charset as Charset)) {
    config.display.charset = display.charset as Charset;
  }
  if (typeof display.colorCompatibility === 'string' && COLORS.has(display.colorCompatibility as ColorCompatibility)) {
    config.display.colorCompatibility = display.colorCompatibility as ColorCompatibility;
  }
  if (typeof display.autoWrap === 'boolean') config.display.autoWrap = display.autoWrap;
  if (typeof display.padding === 'number' && Number.isFinite(display.padding) && display.padding >= 0) {
    config.display.padding = display.padding;
  }
  if (Array.isArray(display.lines)) config.display.lines = display.lines.map(parseDisplayLine);
  return config;
}

function parseDisplayLine(value: unknown): DisplayLineConfig {
  const segments: Partial<Record<SegmentName, SegmentConfig>> = {};
  if (!isRecord(value) || !isRecord(value.segments)) return { segments };
  for (const [name, segment] of Object.entries(value.segments)) {
    if (!SEGMENT_NAMES.has(name as SegmentName)) continue;
    const parsed = parseSegmentConfig(segment);
    if (parsed) segments[name as SegmentName] = parsed;
  }
  return { segments };
}

function parseSegmentConfig(value: unknown): SegmentConfig | undefined {
  if (!isRecord(value)) return undefined;
  const config: SegmentConfig = {
    enabled: typeof value.enabled === 'boolean' ? value.enabled : true,
  };
  if (typeof value.align === 'string' && ALIGNMENTS.has(value.align as SegmentAlignment)) {
    config.align = value.align as SegmentAlignment;
  }
  if (typeof value.style === 'string' && DIRECTORY_STYLES.has(value.style as DirectoryStyle)) {
    config.style = value.style as DirectoryStyle;
  }
  if (typeof value.type === 'string' && SESSION_TYPES.has(value.type as SessionDisplayType)) {
    config.type = value.type as SessionDisplayType;
  }
  if (typeof value.displayStyle === 'string' && CONTEXT_STYLES.has(value.displayStyle as ContextDisplayStyle)) {
    config.displayStyle = value.displayStyle as ContextDisplayStyle;
  }
  for (const field of BOOLEAN_SEGMENT_FIELDS) {
    if (typeof value[field] === 'boolean') config[field] = value[field];
  }
  for (const field of NUMBER_SEGMENT_FIELDS) {
    if (typeof value[field] === 'number' && Number.isFinite(value[field])) config[field] = value[field];
  }
  return config;
}

function parseCustomColors(value: Record<string, unknown>): Partial<Record<ThemeColorKey, ThemeColorConfig>> {
  const colors: Partial<Record<ThemeColorKey, ThemeColorConfig>> = {};
  for (const [name, pair] of Object.entries(value)) {
    if (!THEME_COLOR_KEYS.has(name as ThemeColorKey) || !isRecord(pair)) continue;
    if (!isHexColor(pair.fg) || !isHexColor(pair.bg)) continue;
    colors[name as ThemeColorKey] = { fg: pair.fg, bg: pair.bg };
  }
  return colors;
}

function findSegment(config: PowerlineConfig, name: SegmentName): SegmentConfig | undefined {
  for (const line of config.display.lines) {
    const segment = line.segments[name];
    if (segment) return segment;
  }
  return undefined;
}

function isHexColor(value: unknown): value is string {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
