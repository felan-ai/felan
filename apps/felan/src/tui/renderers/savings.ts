import type { UiActionRequest, UiPresentation } from '@felan-ai/agent-core';
import type { InteractionPresenterUi } from '../../client/presenters.js';
import { SAVINGS_ACTIONS, SAVINGS_DEFAULT_RANGE, readSavingsDashboard, type SavingsDashboard } from '../../savings/data.js';
import { SavingsPanel, type SavingsOutcome, type SavingsPanelState } from './savings/panel.js';

export { SAVINGS_DASHBOARD_HINT } from '../../savings/data.js';

/** Tab, range and scroll survive the re-presentation that follows a refresh. */
const panelStates = new Map<string, SavingsPanelState>();

export async function presentSavingsDocument(element: UiPresentation, ui: Pick<InteractionPresenterUi, 'custom'>,
  signal: AbortSignal): Promise<UiActionRequest | undefined> {
  if (element.kind !== 'document') throw new Error('Expected a savings dashboard document.');
  if (signal.aborted) return undefined;
  const dashboard = parseDashboard(element);
  const state = panelStates.get(element.id)
    ?? { tab: dashboard?.initialTab ?? 'overview', range: dashboard?.initialRange ?? SAVINGS_DEFAULT_RANGE, scroll: {}, selected: 0 };
  panelStates.set(element.id, state);
  let finish: (value: SavingsOutcome) => void = () => {};
  const abort = () => finish(undefined);
  signal.addEventListener('abort', abort, { once: true });
  try {
    const outcome = await ui.custom<SavingsOutcome>((tui, theme, _keys, done) => {
      finish = done;
      return new SavingsPanel(element, dashboard, state, theme, () => tui.terminal?.rows ?? 30, () => tui.requestRender(), done);
    }, { overlay: true, overlayOptions: { anchor: 'top-left', width: '100%', maxHeight: '100%', margin: 0 } });
    if (signal.aborted) return undefined;
    if (outcome === undefined || outcome.actionId === SAVINGS_ACTIONS.close) panelStates.delete(element.id);
    return outcome;
  } finally { signal.removeEventListener('abort', abort); }
}

function parseDashboard(element: Extract<UiPresentation, { kind: 'document' }>): SavingsDashboard | undefined {
  if (!element.data) return undefined;
  try { return readSavingsDashboard(element.data); } catch { return undefined; }
}
