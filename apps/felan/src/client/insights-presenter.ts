import open from 'open';
import { INSIGHTS_REPORT_PRESENTER, parseInsightsReportRequest, type InsightsReportPresentation } from '@felan-ai/ext-insights/view';
import type { ClientInteractionPresenters, InteractionPresenterUi } from './presenters.js';

export function createLocalInsightsPresentation(): InsightsReportPresentation {
  return { async openReport(path, signal) {
    const request = parseInsightsReportRequest({ path }); signal?.throwIfAborted();
    await open(request.path);
  } };
}

export function registerInsightsPresenter(presenters: Pick<ClientInteractionPresenters, 'registerCustom'>,
  ui: Pick<InteractionPresenterUi, 'confirm'>, presentation: InsightsReportPresentation = createLocalInsightsPresentation()): () => void {
  const lifetime = new AbortController();
  const remove = presenters.registerCustom(INSIGHTS_REPORT_PRESENTER, async (value, callerSignal) => {
    const request = parseInsightsReportRequest(value); const signal = AbortSignal.any([callerSignal, lifetime.signal]);
    const confirmed = await ui.confirm('Open insights report?', request.path, { signal });
    if (signal.aborted) return undefined;
    if (!confirmed) return { opened: false };
    await presentation.openReport(request.path, signal);
    return signal.aborted ? undefined : { opened: true };
  });
  return () => { lifetime.abort(); remove(); };
}
