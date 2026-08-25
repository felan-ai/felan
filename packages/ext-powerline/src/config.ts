import { configField, defineExtensionConfig } from '@felan-ai/agent-core';

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
    custom?: Record<string, ThemeColorConfig>;
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

export const DEFAULT_CONFIG: PowerlineConfig = {
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

const THEMES = new Set<ThemeName>(['dark', 'light', 'nord', 'tokyo-night', 'rose-pine', 'gruvbox', 'custom']);
const STYLES = new Set<FooterStyle>(['minimal', 'powerline', 'capsule']);
const CHARSETS = new Set<Charset>(['unicode', 'text']);
const COLORS = new Set<ColorCompatibility>(['auto', 'none', 'ansi', 'ansi256', 'truecolor']);
const DIRECTORY_STYLES = new Set<DirectoryStyle>(['full', 'fish', 'basename']);
const SESSION_TYPES = new Set<SessionDisplayType>(['cost', 'tokens', 'both', 'breakdown']);
const CONTEXT_STYLES = new Set<ContextDisplayStyle>(['text', 'bar', 'blocks', 'blocks-line', 'dots']);
const ALIGNMENTS = new Set<SegmentAlignment>(['left', 'right']);
const SEGMENT_NAMES = new Set<SegmentName>(['directory', 'git', 'model', 'session', 'subscription', 'context', 'status']);
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

export const POWERLINE_CONFIG = defineExtensionConfig({
  id: 'powerline',
  title: 'Powerline',
  fields: {
    theme: configField.enum(['dark', 'light', 'nord', 'tokyo-night', 'rose-pine', 'gruvbox', 'custom'], { default: DEFAULT_CONFIG.theme, description: 'Powerline color theme' }),
    style: configField.enum(['minimal', 'powerline', 'capsule'], { default: DEFAULT_CONFIG.display.style, description: 'Powerline footer style' }),
    charset: configField.enum(['text', 'unicode'], { default: DEFAULT_CONFIG.display.charset, description: 'Powerline footer charset' }),
    colorCompatibility: configField.enum(['auto', 'none', 'ansi', 'ansi256', 'truecolor'], { default: DEFAULT_CONFIG.display.colorCompatibility, description: 'Powerline ANSI color mode' }),
    autoWrap: configField.boolean({ default: DEFAULT_CONFIG.display.autoWrap, description: 'Wrap long powerline segments' }),
    padding: configField.number({ default: DEFAULT_CONFIG.display.padding, description: 'Horizontal segment padding', validate: validatePadding }),
    lines: configField.json({ default: DEFAULT_CONFIG.display.lines, description: 'Ordered powerline lines and segments', validate: validateLines }),
    colors: configField.json({ default: {}, description: 'Custom powerline colors', validate: validateColors }),
  },
});

export function powerlineConfigFromSettings(values: Readonly<Record<string, unknown>>): PowerlineConfig {
  const config = cloneConfig(DEFAULT_CONFIG);
  if (typeof values.theme === 'string' && THEMES.has(values.theme as ThemeName)) config.theme = values.theme as ThemeName;
  if (typeof values.style === 'string' && STYLES.has(values.style as FooterStyle)) config.display.style = values.style as FooterStyle;
  if (typeof values.charset === 'string' && CHARSETS.has(values.charset as Charset)) config.display.charset = values.charset as Charset;
  if (typeof values.colorCompatibility === 'string' && COLORS.has(values.colorCompatibility as ColorCompatibility)) config.display.colorCompatibility = values.colorCompatibility as ColorCompatibility;
  if (typeof values.autoWrap === 'boolean') config.display.autoWrap = values.autoWrap;
  if (typeof values.padding === 'number') config.display.padding = values.padding;
  if (values.lines !== undefined) config.display.lines = parseDisplayLines(values.lines);
  if (values.colors !== undefined) config.colors = { custom: parseCustomColors(values.colors) };
  return config;
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

function validatePadding(value: unknown): string | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? undefined
    : 'must be a finite non-negative number';
}

function validateLines(value: unknown): string | undefined {
  try {
    parseDisplayLines(value);
    return undefined;
  } catch (error) {
    return errorMessage(error);
  }
}

function validateColors(value: unknown): string | undefined {
  try {
    parseCustomColors(value);
    return undefined;
  } catch (error) {
    return errorMessage(error);
  }
}

function parseDisplayLines(value: unknown): DisplayLineConfig[] {
  if (!Array.isArray(value)) throw new Error('must be an array');
  return value.map((line, index) => parseDisplayLine(line, `lines[${index}]`));
}

function parseDisplayLine(value: unknown, source: string): DisplayLineConfig {
  const segments: Partial<Record<SegmentName, SegmentConfig>> = {};
  if (!isRecord(value)) throw new Error(`${source} must be an object`);
  if (!isRecord(value.segments)) throw new Error(`${source}.segments must be an object`);
  for (const [name, segment] of Object.entries(value.segments)) {
    if (!SEGMENT_NAMES.has(name as SegmentName)) throw new Error(`${source}.segments contains unknown segment: ${name}`);
    const parsed = parseSegmentConfig(segment, `${source}.segments.${name}`);
    segments[name as SegmentName] = parsed;
  }
  return { segments };
}

function parseSegmentConfig(value: unknown, source: string): SegmentConfig {
  if (!isRecord(value)) throw new Error(`${source} must be an object`);
  const allowed = new Set(['enabled', 'align', 'style', 'type', 'displayStyle', ...BOOLEAN_SEGMENT_FIELDS, ...NUMBER_SEGMENT_FIELDS]);
  for (const field of Object.keys(value)) {
    if (!allowed.has(field)) throw new Error(`${source} contains unknown field: ${field}`);
  }
  const config: SegmentConfig = {
    enabled: value.enabled === undefined ? true : value.enabled as boolean,
  };
  if (typeof config.enabled !== 'boolean') throw new Error(`${source}.enabled must be a boolean`);
  if (typeof value.align === 'string' && ALIGNMENTS.has(value.align as SegmentAlignment)) {
    config.align = value.align as SegmentAlignment;
  } else if (value.align !== undefined) throw new Error(`${source}.align is invalid`);
  if (typeof value.style === 'string' && DIRECTORY_STYLES.has(value.style as DirectoryStyle)) {
    config.style = value.style as DirectoryStyle;
  } else if (value.style !== undefined) throw new Error(`${source}.style is invalid`);
  if (typeof value.type === 'string' && SESSION_TYPES.has(value.type as SessionDisplayType)) {
    config.type = value.type as SessionDisplayType;
  } else if (value.type !== undefined) throw new Error(`${source}.type is invalid`);
  if (typeof value.displayStyle === 'string' && CONTEXT_STYLES.has(value.displayStyle as ContextDisplayStyle)) {
    config.displayStyle = value.displayStyle as ContextDisplayStyle;
  } else if (value.displayStyle !== undefined) throw new Error(`${source}.displayStyle is invalid`);
  for (const field of BOOLEAN_SEGMENT_FIELDS) {
    if (value[field] !== undefined && typeof value[field] !== 'boolean') throw new Error(`${source}.${field} must be a boolean`);
    if (typeof value[field] === 'boolean') config[field] = value[field];
  }
  for (const field of NUMBER_SEGMENT_FIELDS) {
    if (value[field] !== undefined && (typeof value[field] !== 'number' || !Number.isFinite(value[field]))) throw new Error(`${source}.${field} must be a finite number`);
    if (typeof value[field] === 'number') config[field] = value[field];
  }
  return config;
}

function parseCustomColors(value: unknown): Record<string, ThemeColorConfig> {
  if (!isRecord(value)) throw new Error('must be an object');
  const colors: Record<string, ThemeColorConfig> = {};
  for (const [name, pair] of Object.entries(value)) {
    if (!isRecord(pair)) throw new Error(`${name} must be an object`);
    if (!isHexColor(pair.fg) || !isHexColor(pair.bg)) throw new Error(`${name}.fg and ${name}.bg must be #RRGGBB colors`);
    colors[name] = { fg: pair.fg, bg: pair.bg };
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
