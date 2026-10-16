import { INSIGHTS_ACTIONS, readInsightsDashboard } from '@felan-ai/ext-insights/data';
import type { UiActionRequest, UiPresentation } from '@felan-ai/agent-core';
import type { InteractionPresenterUi } from '../../client/presenters.js';
import { InsightsPanel, type InsightsOutcome, type InsightsPanelState } from './insights/panel.js';

const panelStates = new Map<string, InsightsPanelState>();

export async function presentInsightsDocument(element: UiPresentation, ui: Pick<InteractionPresenterUi, 'custom' | 'input'>,
  signal: AbortSignal): Promise<UiActionRequest | undefined> {
  if (element.kind !== 'document') throw new Error('Expected an insights report document.');
  if (signal.aborted) return undefined;
  const dashboard = parseDashboard(element);
  const state = panelStates.get(element.id) ?? { tab: 'overview', scroll: {}, metric: 'sessions', sort: 'messages' };
  panelStates.set(element.id, state);
  let finish: (value: InsightsOutcome) => void = () => {};
  const abort = () => finish(undefined);
  signal.addEventListener('abort', abort, { once: true });
  try {
    const outcome = await ui.custom<InsightsOutcome>((tui, theme, _keys, done) => {
      finish = done;
      return new InsightsPanel(element, dashboard, state, theme, () => tui.terminal?.rows ?? 30, () => tui.requestRender(), done);
    }, { overlay: true, overlayOptions: { anchor: 'top-left', width: '100%', maxHeight: '100%', margin: 0 } });
    if (signal.aborted) return undefined;
    if (outcome === 'search') return searchRequest(element, dashboard?.sessions.query ?? '', ui, signal);
    if (outcome?.actionId === INSIGHTS_ACTIONS.close) panelStates.delete(element.id);
    return outcome;
  } finally { signal.removeEventListener('abort', abort); }
}

function parseDashboard(element: Extract<UiPresentation, { kind: 'document' }>) {
  if (!element.data) return undefined;
  try { return readInsightsDashboard(element.data); } catch { return undefined; }
}

async function searchRequest(element: Extract<UiPresentation, { kind: 'document' }>, query: string,
  ui: Pick<InteractionPresenterUi, 'input'>, signal: AbortSignal): Promise<UiActionRequest | undefined> {
  const action = element.actions.find(candidate => candidate.id === INSIGHTS_ACTIONS.search);
  if (!action) return undefined;
  const value = await ui.input('Search sessions', undefined, { signal, initialValue: query });
  if (value === undefined || signal.aborted) return undefined;
  return { elementId: element.id, revision: element.revision, actionId: action.id, outcome: action.outcome, values: { query: value } };
}
