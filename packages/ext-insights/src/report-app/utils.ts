const compactNumber = new Intl.NumberFormat('en-US', {
  notation: 'compact',
  maximumFractionDigits: 1,
});

const regularNumber = new Intl.NumberFormat('en-US', {
  maximumFractionDigits: 2,
});

const integerNumber = new Intl.NumberFormat('en-US', {
  maximumFractionDigits: 0,
});

export const formatNumber = (n: number): string => {
  if (!Number.isFinite(n)) return '—';
  if (Math.abs(n) >= 1000) return compactNumber.format(n);
  return regularNumber.format(n);
};

export const formatInteger = (n: number): string => {
  if (!Number.isFinite(n)) return '—';
  return integerNumber.format(n);
};

export const formatDuration = (m: number): string => {
  if (!Number.isFinite(m)) return '—';
  if (m >= 60) return formatInteger(m / 60) + 'h';
  return formatNumber(m) + 'm';
};

export const formatCost = (c: number): string => {
  if (!Number.isFinite(c)) return '—';
  if (c === 0) return '$0.00';
  const absolute = Math.abs(c);
  const sign = c < 0 ? '−' : '';
  if (absolute < 0.000001) return `${sign}< $0.000001`;
  const digits = absolute >= 1 ? 2 : absolute >= 0.01 ? 3 : 6;
  return sign + '$' + new Intl.NumberFormat('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(absolute);
};

export const formatPercent = (ratio: number, maximumFractionDigits = 1): string => {
  if (!Number.isFinite(ratio)) return '—';
  return new Intl.NumberFormat('en-US', {
    style: 'percent',
    maximumFractionDigits,
  }).format(ratio);
};

export const COLORS = [
  'hsl(var(--chart-1))',
  'hsl(var(--chart-2))',
  'hsl(var(--chart-3))',
  'hsl(var(--chart-4))',
  'hsl(var(--chart-5))',
];
