import {
  TuiAltScreen,
  TuiMainScreen,
  compositeTuiLine,
  visibleWidth,
} from '@earendil-works/pi-tui';

const KITTY_PREFIX = '\x1b_G';
const ITERM2_PREFIX = '\x1b]1337;File=';

export interface OverlayScreenRect {
  readonly row: number;
  readonly height: number;
}

export function isTerminalImageLine(line: string): boolean {
  return line.startsWith(KITTY_PREFIX)
    || line.startsWith(ITERM2_PREFIX)
    || line.includes(KITTY_PREFIX)
    || line.includes(ITERM2_PREFIX);
}

export function compositeOverlayLine(
  baseLine: string,
  overlayLine: string,
  startCol: number,
  overlayWidth: number,
  totalWidth: number,
): string {
  // Image protocol lines cannot be text-sliced; overlaying must replace the whole line.
  const base = isTerminalImageLine(baseLine) ? '' : baseLine;
  return compositeTuiLine(base, overlayLine, startCol, overlayWidth, totalWidth);
}

export function suppressImagesIntersectingOverlays(
  lines: readonly string[],
  overlays: readonly OverlayScreenRect[],
  terminalHeight: number,
  imageSource: readonly string[] = lines,
): string[] {
  const result = [...lines];
  if (overlays.length === 0 || result.length === 0 || imageSource.length === 0) return result;

  const height = Math.max(1, Math.floor(terminalHeight));
  const viewportStart = Math.max(0, result.length - height);
  const overlayRows = new Set<number>();
  for (const overlay of overlays) {
    const start = viewportStart + overlay.row;
    const end = start + overlay.height;
    for (let row = start; row < end; row += 1) overlayRows.add(row);
  }
  if (overlayRows.size === 0) return result;

  for (let index = 0; index < imageSource.length; index += 1) {
    const sourceLine = imageSource[index];
    if (sourceLine === undefined || !isTerminalImageLine(sourceLine)) continue;
    const reserved = terminalImageReservedRows(imageSource, index);
    for (let row = index; row < index + reserved; row += 1) {
      if (!overlayRows.has(row)) continue;
      result[index] = '';
      break;
    }
  }
  return result;
}

function terminalImageReservedRows(lines: readonly string[], index: number): number {
  const rows = kittyImageRows(lines[index] ?? '');
  if (rows <= 1) return 1;
  const maxRows = Math.min(rows, lines.length - index);
  let reserved = 1;
  while (reserved < maxRows) {
    const line = lines[index + reserved] ?? '';
    if (isTerminalImageLine(line) || visibleWidth(line) > 0) break;
    reserved += 1;
  }
  return reserved;
}

interface OverlayCompositor {
  compositeLineAt(
    baseLine: string,
    overlayLine: string,
    startCol: number,
    overlayWidth: number,
    totalWidth: number,
  ): string;
  compositeOverlays(lines: string[], termWidth: number, termHeight: number): string[];
  renderedOverlayLayouts?: readonly OverlayScreenRect[];
}

let overlayImageStackingInstalled = false;

export function installOverlayImageStacking(): void {
  if (overlayImageStackingInstalled) return;
  const proto = Object.getPrototypeOf(TuiAltScreen.prototype) as OverlayCompositor;
  const mainProto = Object.getPrototypeOf(TuiMainScreen.prototype) as OverlayCompositor;
  patchOverlayCompositor(proto);
  if (mainProto !== proto) patchOverlayCompositor(mainProto);
  overlayImageStackingInstalled = true;
}

function patchOverlayCompositor(proto: OverlayCompositor): void {
  const compositeOverlays = proto.compositeOverlays;
  if (typeof proto.compositeLineAt !== 'function' || typeof compositeOverlays !== 'function') return;

  proto.compositeLineAt = function compositeOverlayLineAt(
    this: OverlayCompositor,
    baseLine: string,
    overlayLine: string,
    startCol: number,
    overlayWidth: number,
    totalWidth: number,
  ): string {
    return compositeOverlayLine(baseLine, overlayLine, startCol, overlayWidth, totalWidth);
  };

  proto.compositeOverlays = function compositeOverlaysOverImages(
    this: OverlayCompositor,
    lines: string[],
    termWidth: number,
    termHeight: number,
  ): string[] {
    const result = compositeOverlays.call(this, lines, termWidth, termHeight);
    return suppressImagesIntersectingOverlays(
      result,
      this.renderedOverlayLayouts ?? [],
      termHeight,
      lines,
    );
  };
}

function kittyImageRows(line: string): number {
  const start = line.indexOf(KITTY_PREFIX);
  if (start === -1) return 1;
  const paramsStart = start + KITTY_PREFIX.length;
  const paramsEnd = line.indexOf(';', paramsStart);
  if (paramsEnd === -1) return 1;
  for (const param of line.slice(paramsStart, paramsEnd).split(',')) {
    const [key, value] = param.split('=', 2);
    if (key !== 'r' || value === undefined) continue;
    const rows = Number(value);
    if (Number.isInteger(rows) && rows > 0 && rows <= 0xffffffff) return rows;
  }
  return 1;
}
