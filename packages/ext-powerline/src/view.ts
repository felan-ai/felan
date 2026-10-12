import type { PowerlineConfig, ThemeColorKey, SegmentName } from './config.js';
import type { RenderedSegment } from './segments.js';

export const POWERLINE_PRESENTER = Object.freeze({ id: 'felan.powerline', version: '1.0.0' });
export interface PowerlineData {
  style: PowerlineConfig['display']['style'];
  charset: PowerlineConfig['display']['charset'];
  autoWrap: boolean;
  padding: number;
  lines: RenderedSegment[][];
}

const NAMES: readonly SegmentName[] = ['directory', 'git', 'model', 'session', 'subscription', 'savings', 'context', 'status', 'version'];
const COLORS: readonly ThemeColorKey[] = [...NAMES, 'warning', 'critical', 'muted', 'extensionStatus1', 'extensionStatus2', 'extensionStatus3', 'extensionStatus4'];
const controls = /[\u0000-\u001f\u007f-\u009f]/u;
const bytes = (text: string) => new TextEncoder().encode(text).byteLength;
function object(value: unknown, keys: string[]): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.keys(value).every(key => keys.includes(key));
}

export function parsePowerlineData(value: unknown): PowerlineData {
  if (!object(value, ['style', 'charset', 'autoWrap', 'padding', 'lines'])
    || !['minimal', 'powerline', 'capsule'].includes(value.style as string)
    || !['unicode', 'text'].includes(value.charset as string) || typeof value.autoWrap !== 'boolean'
    || typeof value.padding !== 'number' || !Number.isFinite(value.padding) || value.padding < 0 || value.padding > 4096
    || !Array.isArray(value.lines) || value.lines.length > 32) throw new Error('Invalid powerline presentation.');
  let segments = 0;
  const lines = value.lines.map((line: unknown) => {
    if (!Array.isArray(line)) throw new Error('Invalid powerline line.');
    segments += line.length;
    if (segments > 256) throw new Error('Powerline segment capacity exceeded.');
    return line.map((segment: unknown): RenderedSegment => {
      if (!object(segment, ['name', 'colorKey', 'align', 'text']) || !NAMES.includes(segment.name as SegmentName)
        || !COLORS.includes(segment.colorKey as ThemeColorKey) || (segment.align !== 'left' && segment.align !== 'right')
        || typeof segment.text !== 'string' || bytes(segment.text) > 8192 || controls.test(segment.text)) throw new Error('Invalid powerline segment.');
      return { name: segment.name as SegmentName, colorKey: segment.colorKey as ThemeColorKey, align: segment.align, text: segment.text };
    });
  });
  const result: PowerlineData = { style: value.style as PowerlineData['style'], charset: value.charset as PowerlineData['charset'],
    autoWrap: value.autoWrap, padding: value.padding, lines };
  if (bytes(JSON.stringify(result)) > 65_536) throw new Error('Powerline presentation capacity exceeded.');
  return result;
}

export function powerlineData(config: PowerlineConfig, lines: RenderedSegment[][]): PowerlineData {
  return parsePowerlineData({ style: config.display.style, charset: config.display.charset, autoWrap: config.display.autoWrap,
    padding: config.display.padding, lines });
}
