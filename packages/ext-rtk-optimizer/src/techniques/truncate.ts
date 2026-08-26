export interface HeadTailTruncationOptions {
  readonly tailRatio?: number;
  readonly marker?: (omittedCharacters: number) => string;
}

export interface HeadTailTruncationResult {
  readonly text: string;
  readonly omittedCharacters: number;
}

const DEFAULT_TAIL_RATIO = 1 / 3;

export function truncateHeadTail(
  text: string,
  maxLength: number,
  options: HeadTailTruncationOptions = {},
): HeadTailTruncationResult {
  const limit = Math.max(0, Math.floor(maxLength));
  if (text.length <= limit) {
    return { text, omittedCharacters: 0 };
  }
  if (limit === 0) {
    return { text: '', omittedCharacters: text.length };
  }

  const markerFor = options.marker ?? (() => '...');
  const tailRatio = clampRatio(options.tailRatio ?? DEFAULT_TAIL_RATIO);
  let omittedCharacters = text.length;

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const marker = markerFor(omittedCharacters);
    if (marker.length >= limit) {
      return {
        text: safeSliceEnd(marker, limit),
        omittedCharacters: text.length,
      };
    }

    const available = limit - marker.length;
    const tailTarget = Math.floor(available * tailRatio);
    const headTarget = available - tailTarget;
    const headEnd = lineSafeHeadEnd(text, headTarget);
    const tailStart = lineSafeTailStart(text, text.length - tailTarget, headEnd);
    const nextOmitted = Math.max(0, tailStart - headEnd);
    const output = `${safeSliceEnd(text, headEnd)}${marker}${safeSliceStart(text, tailStart)}`;

    if (nextOmitted === omittedCharacters || attempt === 3) {
      return {
        text: output.length <= limit ? output : safeSliceEnd(output, limit),
        omittedCharacters: nextOmitted,
      };
    }
    omittedCharacters = nextOmitted;
  }

  return { text: safeSliceEnd(text, limit), omittedCharacters: text.length - limit };
}

export function truncate(text: string, maxLength: number): string {
  return truncateHeadTail(text, maxLength).text;
}

function clampRatio(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_TAIL_RATIO;
  return Math.min(0.9, Math.max(0.1, value));
}

function lineSafeHeadEnd(text: string, target: number): number {
  if (target <= 0) return 0;
  if (target >= text.length) return text.length;
  const newline = text.lastIndexOf('\n', target - 1);
  return newline >= Math.floor(target / 2) ? newline + 1 : target;
}

function lineSafeTailStart(text: string, target: number, minimum: number): number {
  if (target <= minimum) return minimum;
  if (target >= text.length) return text.length;
  const newline = text.indexOf('\n', target);
  const maximumSearch = target + Math.floor((text.length - target) / 2);
  return newline !== -1 && newline <= maximumSearch ? newline + 1 : target;
}

function safeSliceEnd(text: string, end: number): string {
  let safeEnd = Math.min(text.length, Math.max(0, end));
  if (safeEnd > 0 && isHighSurrogate(text.charCodeAt(safeEnd - 1))) safeEnd -= 1;
  return text.slice(0, safeEnd);
}

function safeSliceStart(text: string, start: number): string {
  let safeStart = Math.min(text.length, Math.max(0, start));
  if (safeStart < text.length && isLowSurrogate(text.charCodeAt(safeStart))) safeStart += 1;
  return text.slice(safeStart);
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}
