import { INSIGHTS_REPORT_PRESENTER, parseInsightsReportRequest, parseInsightsReportResult } from '@felan-ai/ext-insights/view';
import type { Interaction } from '@felan-ai/session-protocol';
import type { InsightsReportPresentation } from '../insights.js';
import type { BrokerOutcome } from './broker.js';

export function createBrokerInsightsHost(options: {
  signal: AbortSignal;
  request(value: Interaction['request'], dialog: { signal: AbortSignal }, scope: Interaction['scope']): Promise<BrokerOutcome>;
  unsupported(surface: string): never;
}): InsightsReportPresentation {
  return { async openReport(path, callerSignal) {
    const signal = callerSignal ? AbortSignal.any([callerSignal, options.signal]) : options.signal;
    signal.throwIfAborted(); const request = parseInsightsReportRequest({ path });
    const result = await options.request({ kind: 'custom', presenter: INSIGHTS_REPORT_PRESENTER, data: { ...request } }, { signal }, { kind: 'host' });
    if (signal.aborted) return;
    if (result.state !== 'answered') {
      if (result.state === 'cancelled' && result.reason === 'unsupported') options.unsupported('insights report');
      return;
    }
    if (result.answer.kind !== 'custom') throw new Error('Invalid insights report answer.');
    parseInsightsReportResult(result.answer.data);
  } };
}
