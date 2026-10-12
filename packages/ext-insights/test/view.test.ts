import { expect, it } from 'vitest';
import { parseInsightsReportRequest, parseInsightsReportResult } from '../src/view.js';

it('accepts only a bounded absolute generated report path, never URLs or traversal', () => {
  expect(parseInsightsReportRequest({ path: '/private/agent/insights-reports/felan-insights.html' }).path).toContain('felan-insights.html');
  for (const path of ['relative/insights-reports/felan-insights.html', 'file:///tmp/insights-reports/felan-insights.html', 'https://example.com/insights-reports/felan-insights.html', '/tmp/../insights-reports/felan-insights.html', '//other/insights-reports/felan-insights.html', '/tmp/insights-reports/secret.html', '/tmp\u0000/insights-reports/felan-insights.html']) {
    expect(() => parseInsightsReportRequest({ path })).toThrow();
  }
  expect(() => parseInsightsReportRequest({ path: '/tmp/insights-reports/felan-insights.html', open: true })).toThrow();
  expect(parseInsightsReportResult({ opened: false })).toEqual({ opened: false });
  expect(() => parseInsightsReportResult({ opened: true, path: '/tmp' })).toThrow();
});
