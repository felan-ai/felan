import { describe, expect, it } from 'vitest';
import { formatCost, formatDuration, formatInteger, formatNumber, formatPercent } from '../src/report-app/utils.js';

describe('report number formatting', () => {
  it('uses compact notation without exposing floating-point noise', () => {
    expect(formatNumber(106.40379728)).toBe('106.4');
    expect(formatNumber(15_300)).toBe('15.3K');
    expect(formatNumber(2_395_100_000)).toBe('2.4B');
    expect(formatNumber(Number.NaN)).toBe('—');
  });

  it('groups integer counts', () => {
    expect(formatInteger(12_345)).toBe('12,345');
  });

  it('formats USD values with grouping, precision, and negative values', () => {
    expect(formatCost(106.40379728)).toBe('$106.40');
    expect(formatCost(1_543.51)).toBe('$1,543.51');
    expect(formatCost(0.01234)).toBe('$0.012');
    expect(formatCost(-5.54854736)).toBe('−$5.55');
  });

  it('formats durations and percentages consistently', () => {
    expect(formatDuration(42.3333333)).toBe('42.33m');
    expect(formatDuration(3_768)).toBe('63h');
    expect(formatPercent(0.1234)).toBe('12.3%');
  });
});
