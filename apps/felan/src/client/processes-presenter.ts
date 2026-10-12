import { presentProcessView, type ProcessViewNavigation } from '@felan-ai/ext-background-bash/tui';
import { PROCESS_VIEW_PRESENTER, parseProcessViewRequest } from '@felan-ai/ext-background-bash/view';
import type { ClientInteractionPresenters, InteractionPresenterUi } from './presenters.js';

export function registerProcessesPresenter(presenters: Pick<ClientInteractionPresenters, 'registerCustom'>,
  ui: Pick<InteractionPresenterUi, 'custom'>): () => void {
  const lifetime = new AbortController();
  const navigation = new Map<string, ProcessViewNavigation>();
  const remove = presenters.registerCustom(PROCESS_VIEW_PRESENTER, async (data, signal) => {
    const request = parseProcessViewRequest(data);
    const result = await presentProcessView(ui, request, AbortSignal.any([signal, lifetime.signal]), navigation.get(request.viewId));
    if (!lifetime.signal.aborted) {
      navigation.delete(request.viewId);
      if (result.action?.action !== 'close' && result.navigation) navigation.set(request.viewId, result.navigation);
      if (navigation.size > 8) navigation.delete(navigation.keys().next().value!);
    }
    return result.action ? { ...result.action } : undefined;
  });
  return () => { lifetime.abort(); navigation.clear(); remove(); };
}
