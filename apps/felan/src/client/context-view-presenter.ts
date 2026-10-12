import { createTuiContextViewHost } from '@felan-ai/ext-context-view/tui';
import { CONTEXT_VIEW_PRESENTER, parseContextViewRequest } from '@felan-ai/ext-context-view/view';
import type { ClientInteractionPresenters, InteractionPresenterUi } from './presenters.js';

export function registerContextViewPresenter(presenters: Pick<ClientInteractionPresenters, 'registerCustom'>,
  ui: Pick<InteractionPresenterUi, 'custom'>): () => void {
  const lifetime = new AbortController();
  const host = createTuiContextViewHost();
  const remove = presenters.registerCustom(CONTEXT_VIEW_PRESENTER, async (value, callerSignal) => {
    const request = parseContextViewRequest(value);
    const signal = AbortSignal.any([lifetime.signal, callerSignal]);
    await host.show(ui, request.report, request.displayMode, signal);
    return signal.aborted ? undefined : { closed: true };
  });
  return () => { lifetime.abort(); remove(); };
}
