import { describe, expect, it } from 'vitest';
import { renderReport } from '../src/report.js';
import { computeAnalytics } from '../src/analytics.js';
import type { Analytics, InsightsSavingsReport } from '../src/types.js';

describe('renderReport', () => {
  it('renders a branded, offline-safe report shell with escaped values', () => {
    const html = renderReport(computeAnalytics([]));
    expect(html).toContain('Felan Insights');
    expect(html).toContain('Activity Calendar');
    expect(html).toContain('Filter by project or date');
    expect(html).toContain('recharts');
    expect(html).toContain('255F44');
    expect(html).toContain('data:image/svg+xml;base64');
    expect(html).toContain('felan-insights-theme');
    expect(html).not.toContain('fonts.googleapis.com');
    expect(html).not.toContain('🤬');
  });

  it('labels reports as static snapshots and preserves generation time', () => {
    const analytics: Analytics = { ...computeAnalytics([]), export: { generatedAt: '2026-09-01T12:00:00.000Z', outputFormats: ['html'] } };
    const html = renderReport(analytics);
    expect(html).toContain('static snapshot; run /insights again to refresh');
    expect(html).toContain('2026-09-01T12:00:00.000Z');
  });

  it('includes the filterable savings dashboard when savings are available', () => {
    const savings: InsightsSavingsReport = {
      scope: 'all', calls: 2, baselineCostUsd: 4, actualCostUsd: 1, savedCostUsd: 3,
      hasUnpricedMeasurements: false, diagnostics: [], buckets: [{
        day: '2026-01-01', sessionId: 'session', projectKey: 'project', projectName: 'felan',
        producerId: 'prewalk', category: 'model-routing', operation: 'delegate', basis: 'estimated-baseline',
        calls: 2, baselineCostUsd: 4, actualCostUsd: 1, baselineModel: 'openai/planner', actualModel: 'openai/target', priceSource: 'model-catalog/model-catalog',
      }],
    };
    const analytics = { ...computeAnalytics([]), savings };
    const html = renderReport(analytics);
    expect(html).toContain('Savings');
    expect(html).toContain('Estimated avoided');
    expect(html).toContain('Measurement details');
    expect(html).toContain('Producer');
  });
});
