import type { FelanExtensionAPI } from '@felan-ai/agent-core';

export type ThemeName = 'dark' | 'light' | 'nord' | 'tokyo-night' | 'rose-pine' | 'gruvbox';
export type FooterStyle = 'minimal' | 'powerline' | 'capsule';
export type Charset = 'unicode' | 'text';
export type ColorCompatibility = 'auto' | 'none' | 'ansi' | 'ansi256' | 'truecolor';
export type DirectoryStyle = 'full' | 'fish' | 'basename';
export type SessionDisplayType = 'cost' | 'tokens' | 'both' | 'breakdown';
export type ContextDisplayStyle = 'text' | 'bar' | 'blocks' | 'blocks-line' | 'dots';
export type SegmentAlignment = 'left' | 'right';
export type SegmentName = 'directory' | 'git' | 'model' | 'session' | 'context' | 'status';
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
  width?: number;
  warningThreshold?: number;
  criticalThreshold?: number;
}

export interface DisplayLineConfig {
  segments: Partial<Record<SegmentName, SegmentConfig>>;
}

export interface PowerlineConfig {
  theme: ThemeName;
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
          context: { enabled: true, displayStyle: 'bar' },
          status: { enabled: true, align: 'right' },
        },
      },
    ],
  },
};

const THEMES = new Set<ThemeName>(['dark', 'light', 'nord', 'tokyo-night', 'rose-pine', 'gruvbox']);
const STYLES = new Set<FooterStyle>(['minimal', 'powerline', 'capsule']);
const CHARSETS = new Set<Charset>(['unicode', 'text']);
const COLORS = new Set<ColorCompatibility>(['auto', 'none', 'ansi', 'ansi256', 'truecolor']);
const DIRECTORY_STYLES = new Set<DirectoryStyle>(['full', 'fish', 'basename']);
const SESSION_TYPES = new Set<SessionDisplayType>(['cost', 'tokens', 'both', 'breakdown']);
const CONTEXT_STYLES = new Set<ContextDisplayStyle>(['text', 'bar', 'blocks', 'blocks-line', 'dots']);

export function registerPowerlineFlags(pi: FelanExtensionAPI): void {
  pi.registerFlag(POWERLINE_FLAGS.theme, { type: 'string', default: DEFAULT_CONFIG.theme, description: 'Powerline color theme' });
  pi.registerFlag(POWERLINE_FLAGS.style, { type: 'string', default: DEFAULT_CONFIG.display.style, description: 'Powerline footer style' });
  pi.registerFlag(POWERLINE_FLAGS.charset, { type: 'string', default: DEFAULT_CONFIG.display.charset, description: 'Powerline footer charset' });
  pi.registerFlag(POWERLINE_FLAGS.color, { type: 'string', default: DEFAULT_CONFIG.display.colorCompatibility, description: 'Powerline ANSI color mode' });
  pi.registerFlag(POWERLINE_FLAGS.wrap, { type: 'boolean', default: DEFAULT_CONFIG.display.autoWrap, description: 'Wrap long powerline segments' });
  pi.registerFlag(POWERLINE_FLAGS.directoryStyle, { type: 'string', default: 'fish', description: 'Powerline directory display style' });
  pi.registerFlag(POWERLINE_FLAGS.sessionType, { type: 'string', default: 'tokens', description: 'Powerline session usage display' });
  pi.registerFlag(POWERLINE_FLAGS.contextStyle, { type: 'string', default: 'bar', description: 'Powerline context usage display' });
}

export function configFromFlags(pi: Pick<FelanExtensionAPI, 'getFlag'>): PowerlineConfig {
  const config = cloneConfig(DEFAULT_CONFIG);
  config.theme = enumFlag(pi, POWERLINE_FLAGS.theme, THEMES, config.theme);
  config.display.style = enumFlag(pi, POWERLINE_FLAGS.style, STYLES, config.display.style);
  config.display.charset = enumFlag(pi, POWERLINE_FLAGS.charset, CHARSETS, config.display.charset);
  config.display.colorCompatibility = enumFlag(pi, POWERLINE_FLAGS.color, COLORS, config.display.colorCompatibility);
  config.display.autoWrap = booleanFlag(pi, POWERLINE_FLAGS.wrap, config.display.autoWrap);

  const directory = config.display.lines[0]?.segments.directory;
  if (directory) directory.style = enumFlag(pi, POWERLINE_FLAGS.directoryStyle, DIRECTORY_STYLES, directory.style ?? 'fish');
  const session = config.display.lines[1]?.segments.session;
  if (session) session.type = enumFlag(pi, POWERLINE_FLAGS.sessionType, SESSION_TYPES, session.type ?? 'tokens');
  const context = config.display.lines[1]?.segments.context;
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
