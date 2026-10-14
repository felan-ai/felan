export type FooterStyle = 'minimal' | 'powerline' | 'capsule';
export type Charset = 'unicode' | 'text';
export type DirectoryStyle = 'full' | 'fish' | 'basename';
export type SessionDisplayType = 'cost' | 'tokens' | 'both' | 'breakdown';
export type ContextDisplayStyle = 'text' | 'bar' | 'blocks' | 'blocks-line' | 'dots';
export type SegmentAlignment = 'left' | 'right';
export type SegmentName = 'directory' | 'git' | 'model' | 'session' | 'subscription' | 'savings' | 'context' | 'status' | 'version';
export type ThemeColorKey = SegmentName | 'warning' | 'critical' | 'muted' | 'extensionStatus1' | 'extensionStatus2' | 'extensionStatus3' | 'extensionStatus4';

export interface SegmentConfig {
  enabled: boolean;
  align?: SegmentAlignment;
  colorKey?: ThemeColorKey;
  style?: DirectoryStyle;
  showSha?: boolean;
  showTag?: boolean;
  showTimeSinceCommit?: boolean;
  showUpstream?: boolean;
  showRepoName?: boolean;
  type?: SessionDisplayType;
  displayStyle?: ContextDisplayStyle;
  showPercentageOnly?: boolean;
  showTokensOnly?: boolean;
  showProviderName?: boolean;
  showReset?: boolean;
  showPercentage?: boolean;
  width?: number;
  warningThreshold?: number;
  criticalThreshold?: number;
}

export interface DisplayLineConfig {
  segments: Partial<Record<SegmentName, SegmentConfig>>;
}

export interface PowerlineConfig {
  display: {
    style: FooterStyle;
    charset: Charset;
    autoWrap: boolean;
    padding: number;
    lines: DisplayLineConfig[];
  };
}

export const DEFAULT_CONFIG: PowerlineConfig = {
  display: {
    style: 'minimal',
    charset: 'text',
    autoWrap: true,
    padding: 1,
    lines: [
      {
        segments: {
          directory: { enabled: true, style: 'fish' },
          git: { enabled: true, showSha: false },
          savings: { enabled: true, align: 'right' },
        },
      },
      {
        segments: {
          context: { enabled: true, displayStyle: 'text', showTokensOnly: true },
          session: { enabled: true, type: 'cost' },
          subscription: { enabled: true, showProviderName: false, showReset: true },
          model: { enabled: true, align: 'right' },
        },
      },
      {
        segments: {
          status: { enabled: true },
        },
      },
    ],
  },
};

const DIRECTORY_STYLES = new Set<DirectoryStyle>(['full', 'fish', 'basename']);
const SESSION_TYPES = new Set<SessionDisplayType>(['cost', 'tokens', 'both', 'breakdown']);
const CONTEXT_STYLES = new Set<ContextDisplayStyle>(['text', 'bar', 'blocks', 'blocks-line', 'dots']);
const ALIGNMENTS = new Set<SegmentAlignment>(['left', 'right']);
const SEGMENT_NAMES = new Set<SegmentName>(['directory', 'git', 'model', 'session', 'subscription', 'savings', 'context', 'status', 'version']);
const BOOLEAN_SEGMENT_FIELDS = [
  'showSha',
  'showTag',
  'showTimeSinceCommit',
  'showUpstream',
  'showRepoName',
  'showPercentageOnly',
  'showTokensOnly',
  'showProviderName',
  'showReset',
  'showPercentage',
] as const;
const NUMBER_SEGMENT_FIELDS = ['width', 'warningThreshold', 'criticalThreshold'] as const;

export function parseDisplayLines(value: unknown): DisplayLineConfig[] {
  if (!Array.isArray(value) || value.length > 32) throw new Error('must be an array of at most 32 lines');
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
  const allowed = new Set(['enabled', 'align', 'colorKey', 'style', 'type', 'displayStyle', ...BOOLEAN_SEGMENT_FIELDS, ...NUMBER_SEGMENT_FIELDS]);
  for (const field of Object.keys(value)) {
    if (!allowed.has(field)) throw new Error(`${source} contains unknown field: ${field}`);
  }
  if (value.colorKey !== undefined && !['directory', 'git', 'model', 'session', 'subscription', 'savings', 'context', 'status', 'version', 'warning', 'critical', 'muted', 'extensionStatus1', 'extensionStatus2', 'extensionStatus3', 'extensionStatus4'].includes(String(value.colorKey))) throw new Error(`${source}.colorKey is invalid`);
  const config: SegmentConfig = {
    ...(value.colorKey === undefined ? {} : { colorKey: value.colorKey as ThemeColorKey }),
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
  if (config.width !== undefined && (config.width < 0 || config.width > 4096)) throw new Error(`${source}.width must be from 0 to 4096`);
  return config;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

