import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';
import { colorForeground, colorPairText, type ColorMode, type ThemePalette } from './colors.js';
import type { PowerlineConfig } from './config.js';
import type { RenderedSegment } from './segments.js';
import type { PowerlineSymbols } from './symbols.js';

export function renderFooterLine(
  segments: RenderedSegment[],
  config: PowerlineConfig,
  palette: ThemePalette,
  mode: ColorMode,
  symbols: PowerlineSymbols,
  width: number,
): string[] {
  const left = segments.filter((segment) => segment.align === 'left');
  const right = segments.filter((segment) => segment.align === 'right');
  if (right.length > 0) return [renderAlignedLine(left, right, config, palette, mode, symbols, width)];
  if (!config.display.autoWrap) return [ensureWidth(renderStyledSegments(segments, config, palette, mode, symbols), width)];

  const lines: string[] = [];
  let current: RenderedSegment[] = [];
  for (const segment of segments) {
    const candidate = [...current, segment];
    if (current.length > 0 && visibleWidth(renderStyledSegments(candidate, config, palette, mode, symbols)) > width) {
      lines.push(ensureWidth(renderStyledSegments(current, config, palette, mode, symbols), width));
      current = [segment];
    } else {
      current = candidate;
    }
  }
  if (current.length > 0) lines.push(ensureWidth(renderStyledSegments(current, config, palette, mode, symbols), width));
  return lines;
}

export function renderStyledSegments(
  segments: RenderedSegment[],
  config: PowerlineConfig,
  palette: ThemePalette,
  mode: ColorMode,
  symbols: PowerlineSymbols,
): string {
  if (config.display.style === 'minimal') return renderMinimal(segments, config, palette, mode, symbols);
  if (config.display.style === 'capsule') return renderCapsule(segments, config, palette, mode, symbols);
  return renderPowerline(segments, config, palette, mode, symbols);
}

function renderAlignedLine(
  leftSegments: RenderedSegment[],
  rightSegments: RenderedSegment[],
  config: PowerlineConfig,
  palette: ThemePalette,
  mode: ColorMode,
  symbols: PowerlineSymbols,
  width: number,
): string {
  const right = ensureWidth(renderStyledSegments(rightSegments, config, palette, mode, symbols), width);
  const rightWidth = visibleWidth(right);
  const leftAvailable = Math.max(0, width - rightWidth - (leftSegments.length > 0 ? 1 : 0));
  const left = leftAvailable > 0
    ? ensureWidth(renderStyledSegments(leftSegments, config, palette, mode, symbols), leftAvailable)
    : '';
  if (!left) return ' '.repeat(Math.max(0, width - rightWidth)) + right;
  return ensureWidth(left + ' '.repeat(Math.max(1, width - visibleWidth(left) - rightWidth)) + right, width);
}

function renderMinimal(
  segments: RenderedSegment[],
  config: PowerlineConfig,
  palette: ThemePalette,
  mode: ColorMode,
  symbols: PowerlineSymbols,
): string {
  const separator = colorForeground(` ${symbols.separatorThin} `, palette.colors.muted.fg, mode);
  return segments
    .map((segment) => colorPairText(pad(segment.text, config.display.padding), palette.colors[segment.colorKey], mode))
    .join(separator);
}

function renderPowerline(
  segments: RenderedSegment[],
  config: PowerlineConfig,
  palette: ThemePalette,
  mode: ColorMode,
  symbols: PowerlineSymbols,
): string {
  let output = '';
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]!;
    const pair = palette.colors[segment.colorKey];
    output += colorPairText(pad(segment.text, config.display.padding), pair, mode);
    output += colorForeground(symbols.separator, pair.fg, mode);
  }
  return output;
}

function renderCapsule(
  segments: RenderedSegment[],
  config: PowerlineConfig,
  palette: ThemePalette,
  mode: ColorMode,
  symbols: PowerlineSymbols,
): string {
  return segments.map((segment) => {
    const pair = palette.colors[segment.colorKey];
    return colorForeground(symbols.capsuleLeft, pair.fg, mode)
      + colorPairText(pad(segment.text, config.display.padding), pair, mode)
      + colorForeground(symbols.capsuleRight, pair.fg, mode);
  }).join(' ');
}

function pad(text: string, padding: number): string {
  return padding > 0 ? `${' '.repeat(padding)}${text}${' '.repeat(padding)}` : text;
}

function ensureWidth(line: string, width: number): string {
  return visibleWidth(line) <= width ? line : truncateToWidth(line, width, '…');
}
