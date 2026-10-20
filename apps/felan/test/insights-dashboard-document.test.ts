import { describe, expect, it } from 'vitest';
import { parseUiPresentation } from '@felan-ai/session-protocol';
import {
  buildInsightsDashboard, encodeInsightsDashboard, generateDashboardMarkdown, INSIGHTS_DOCUMENT_HINT, parseSessionTranscript,
} from '@felan-ai/ext-insights';

describe('insights dashboard document', () => {
  it('passes the protocol document validator with hostile names and no raw HTML or links', () => {
    const hostile = '<img src=x onerror=alert(1)>[x](javascript:alert(1))|pipe\u0007`*';
    const transcript = [
      JSON.stringify({ type: 'session', id: 'root', cwd: `/workspace/${hostile}`, timestamp: '2026-01-05T10:00:00Z' }),
      JSON.stringify({ type: 'message', timestamp: '2026-01-05T10:00:00Z', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } }),
    ].join('\n');
    const session = parseSessionTranscript(transcript, 'root')!;
    const dashboard = buildInsightsDashboard({
      path: '/reports/felan-insights.html', generatedAt: new Date('2026-01-10T12:00:00Z'), initialRange: '30d',
      loaded: [{ rootId: 'root', session }],
    }, { range: 'all', query: '', page: 0 });
    const data = encodeInsightsDashboard(dashboard);
    expect(data).toBeDefined();
    expect(() => parseUiPresentation({
      id: 'insights-report', kind: 'document', revision: 1, fallback: 'Session insights', title: 'Session insights',
      markdown: generateDashboardMarkdown(dashboard), data, hint: INSIGHTS_DOCUMENT_HINT,
      actions: [{ id: 'close', label: 'Close', target: 'element', outcome: 'cancel' }],
    })).not.toThrow();
  });
});
