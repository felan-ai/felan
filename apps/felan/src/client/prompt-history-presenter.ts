import { PromptHistoryPicker, promptHistoryOverlay, type PromptHistoryNavigation } from '@felan-ai/ext-prompt-history/tui';
import type { PromptHistorySearch, PromptHistorySearchState } from '@felan-ai/ext-prompt-history';
import { PROMPT_HISTORY_PRESENTER, parsePromptHistoryFrame, parsePromptHistoryRequest, parsePromptHistoryText,
  type PromptHistoryViewChoice, type PromptHistoryViewRequest } from '@felan-ai/ext-prompt-history/view';
import type { Presentation } from '@felan-ai/session-protocol';
import { interactionUpdates, type ClientInteractionPresenters, type InteractionPresenterUi, type PresentationUpdatesSource } from './presenters.js';

interface Updates { read(): readonly Presentation[]; subscribe(listener: () => void): () => void }
function watch(updates: Updates, request: PromptHistoryViewRequest, receive: (data: unknown) => void, fail: (error: unknown) => void): () => void {
  const check = () => {
    try {
      const item = updates.read().find(value => value.id === `prompt-history:${request.viewId}`);
      if (!item) return;
      if (item.kind !== 'custom' || item.presenter.id !== PROMPT_HISTORY_PRESENTER.id || item.presenter.version !== PROMPT_HISTORY_PRESENTER.version) throw new Error('Invalid prompt history presenter.');
      const data = item.data;
      if (data && typeof data === 'object' && !Array.isArray(data) && data.viewId === request.viewId && data.generation === request.generation) receive(data);
    } catch (error) { fail(error); }
  };
  const remove = updates.subscribe(check); check(); return remove;
}

export function registerPromptHistoryPresenter(presenters: Pick<ClientInteractionPresenters, 'registerCustom'>,
  ui: Pick<InteractionPresenterUi, 'custom'> & { setEditorText(text: string): void }, source: PresentationUpdatesSource): () => void {
  const lifetime = new AbortController();
  const navigation = new Map<string, PromptHistoryNavigation>();
  const transfers = new Map<string, { parts: string[]; bytes: number; total: number }>();
  const remove = presenters.registerCustom(PROMPT_HISTORY_PRESENTER, async (data, callerSignal, _document, interaction) => {
    const updates = interactionUpdates(source, interaction);
    const request = parsePromptHistoryRequest(data); const control = new AbortController();
    const signal = AbortSignal.any([lifetime.signal, callerSignal, control.signal]);
    const action = (choice: PromptHistoryViewChoice) => ({ ...choice, viewId: request.viewId, generation: request.generation });
    if (request.kind === 'text') {
      let transfer = transfers.get(request.viewId);
      if (!transfer) {
        if (transfers.size >= 8) throw new Error('Too many prompt history transfers.');
        transfer = { parts: [], bytes: 0, total: request.bytes }; transfers.set(request.viewId, transfer);
      }
      if (request.bytes !== transfer.total) throw new Error('Prompt history transfer changed.');
      if (request.index > transfer.parts.length) return action({ action: 'chunk', index: transfer.parts.length });
      const text = await new Promise<string>((resolve, reject) => {
        let stop = () => {}; let settled = false;
        const finish = (error?: unknown, value?: string) => {
          if (settled) return; settled = true; stop(); signal.removeEventListener('abort', aborted);
          if (error) reject(error); else resolve(value!);
        };
        const aborted = () => finish(signal.reason ?? new Error('Prompt history transfer closed.'));
        stop = watch(updates, request, value => { const chunk = parsePromptHistoryText(value); if (chunk.index === request.index) finish(undefined, chunk.text); }, error => finish(error));
        if (settled) stop(); else { signal.addEventListener('abort', aborted, { once: true }); if (signal.aborted) aborted(); }
      });
      if (transfer.parts[request.index] !== undefined && transfer.parts[request.index] !== text) throw new Error('Prompt history chunk changed.');
      if (transfer.parts[request.index] === undefined) { transfer.parts.push(text); transfer.bytes += new TextEncoder().encode(text).length; }
      if (transfer.bytes > request.bytes) throw new Error('Prompt history transfer exceeds its declared size.');
      if (transfer.parts.length < request.chunks) return action({ action: 'chunk', index: transfer.parts.length });
      if (transfer.bytes !== request.bytes) throw new Error('Prompt history transfer size mismatch.');
      if (request.index !== request.chunks - 1) return action({ action: 'chunk', index: request.chunks - 1 });
      signal.throwIfAborted(); ui.setEditorText(transfer.parts.join('')); transfers.delete(request.viewId); navigation.delete(request.viewId);
      return action({ action: 'insert' });
    }
    let picker: PromptHistoryPicker | undefined; let finish = (_choice: PromptHistoryViewChoice | undefined) => {};
    let latest: ReturnType<typeof parsePromptHistoryFrame> | undefined; let apply = (_state: PromptHistorySearchState) => {};
    let releaseSearch = () => {}; let failure: unknown;
    const stop = watch(updates, request, value => {
      const frame = parsePromptHistoryFrame(value); if (latest && frame.version <= latest.version) return;
      latest = frame; apply(frame);
    }, error => { failure = error; control.abort(error); });
    const empty = (): PromptHistorySearchState => ({ items: [], loading: false, scanned: 0, complete: false });
    const search: PromptHistorySearch = (scope, query, progress, current) => {
      if (scope !== request.scope || query !== request.query) { finish({ action: 'search', scope, query }); return Promise.resolve(empty()); }
      return new Promise(resolve => {
        releaseSearch = () => resolve(empty());
        apply = state => { if (current()) progress(state); if (!state.loading) resolve(state); };
        if (latest) apply(latest);
      });
    };
    const aborted = () => finish(undefined);
    try {
      const previous = navigation.get(request.viewId);
      const result = await ui.custom<PromptHistoryViewChoice | undefined>((tui, theme, _keys, done) => {
        finish = done;
        picker = new PromptHistoryPicker(search, theme, () => tui.requestRender(), result => done(result ? { action: 'choose', id: result.id } : { action: 'close' }),
          request.displayMode, { scope: request.scope, query: request.query, selectedIndex: previous?.selectedIndex ?? 0 });
        signal.addEventListener('abort', aborted, { once: true }); if (signal.aborted) aborted();
        return picker;
      }, request.displayMode === 'overlay' ? promptHistoryOverlay : undefined);
      if (failure) throw failure;
      if (picker) navigation.set(request.viewId, picker.getNavigation());
      if (navigation.size > 8) navigation.delete(navigation.keys().next().value!);
      if (!result || result.action === 'close') navigation.delete(request.viewId);
      return result ? action(result) : undefined;
    } finally { stop(); signal.removeEventListener('abort', aborted); picker?.dispose(); releaseSearch(); }
  });
  return () => { lifetime.abort(); navigation.clear(); transfers.clear(); remove(); };
}
