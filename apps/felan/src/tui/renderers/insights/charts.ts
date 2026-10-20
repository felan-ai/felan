const EIGHTHS = [' ', '▏', '▎', '▍', '▌', '▋', '▊', '▉', '█'];
const SPARKS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];
const SHADES = ['·', '░', '▒', '▓', '█'];

const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });
const integer = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

export function formatCount(value: number): string {
  return Math.abs(value) >= 1000 ? compact.format(value) : integer.format(value);
}

export function formatMoney(value: number): string {
  if (value === 0) return '$0.00';
  const digits = Math.abs(value) >= 1 ? 2 : Math.abs(value) >= 0.01 ? 3 : 6;
  return `${value < 0 ? '−' : ''}$${Math.abs(value).toFixed(digits)}`;
}

export function formatMinutes(minutes: number): string {
  const rounded = Math.round(minutes);
  if (rounded < 60) return `${rounded}m`;
  const hours = Math.floor(rounded / 60);
  const rest = rounded % 60;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}

export function formatPercent(ratio: number): string {
  return `${(Number.isFinite(ratio) ? ratio * 100 : 0).toFixed(1)}%`;
}

/** Horizontal bar with eighth-cell precision; always exactly `width` cells wide. */
export function bar(value: number, maximum: number, width: number): string {
  if (width <= 0) return '';
  if (!(maximum > 0) || !(value > 0)) return ' '.repeat(width);
  const eighths = Math.round(Math.min(1, value / maximum) * width * 8);
  const full = Math.floor(eighths / 8);
  const rest = eighths % 8;
  return `${'█'.repeat(full)}${rest ? EIGHTHS[rest] : ''}`.padEnd(width, ' ');
}

/** Samples long series by bucket maximum so spikes stay visible at narrow widths. */
export function resample(values: readonly number[], width: number): number[] {
  if (values.length <= width) return [...values];
  return Array.from({ length: width }, (_, index) => {
    const start = Math.floor((index * values.length) / width);
    const end = Math.max(start + 1, Math.floor(((index + 1) * values.length) / width));
    return Math.max(...values.slice(start, end));
  });
}

export function sparkline(values: readonly number[], width: number): string {
  const sampled = resample(values, width);
  const maximum = Math.max(0, ...sampled);
  return sampled.map(value => (maximum > 0 ? SPARKS[Math.min(7, Math.round((value / maximum) * 7))]! : SPARKS[0]!)).join('');
}

/** Session-count intensity, using the same thresholds as the HTML activity calendar. */
export function heatLevel(sessions: number): number {
  if (sessions <= 0) return 0;
  if (sessions <= 2) return 1;
  if (sessions <= 5) return 2;
  if (sessions <= 10) return 3;
  return 4;
}

export function shade(level: number): string {
  return SHADES[level] ?? SHADES[0]!;
}

export function hourLabels(width: number): string {
  const cells = Array.from({ length: width }, () => ' ');
  for (let hour = 0; hour < 24; hour += 6) {
    const label = String(hour).padStart(2, '0');
    const position = Math.round((hour / 24) * width);
    for (let index = 0; index < label.length && position + index < width; index++) cells[position + index] = label[index]!;
  }
  return cells.join('');
}
