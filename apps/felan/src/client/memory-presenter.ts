import { MEMORY_VIEW_PRESENTER, decodeMemoryDocument, parseMemoryViewChunk, parseMemoryViewRequest,
  type MemorySessionView, type MemoryViewAction, type MemoryViewChoice, type MemoryViewDocument, type MemoryViewRequest } from '@felan-ai/ext-memory/view';
import type { Presentation } from '@felan-ai/session-protocol';
import { MemoryHistoryView, type MemoryDisplaySnapshot } from '../memory/history-renderer.js';
import type { LocalSessionHistory, MemoryHistorySession } from '../memory/history.js';
import type { SessionPickerNavigation } from '../session-picker.js';
import { interactionUpdates, type ClientInteractionPresenters, type InteractionPresenterUi, type PresentationUpdatesSource } from './presenters.js';

interface Updates { read(): readonly Presentation[]; subscribe(listener: () => void): () => void }
interface ViewState {
  documentId?: string; parts: string[]; bytes: number;
  catalog?: Extract<MemoryViewDocument, { kind: 'catalog' }>;
  navigation?: SessionPickerNavigation;
  restoreKey?: string;
}

function receive(updates: Updates, request: MemoryViewRequest, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false; let unsubscribe = () => {};
    const finish = (error?: unknown, text?: string) => {
      if (settled) return;
      settled = true; unsubscribe(); signal.removeEventListener('abort', aborted);
      if (error) reject(error); else resolve(text!);
    };
    const aborted = () => finish(signal.reason ?? new Error('Memory view closed.'));
    const check = () => {
      try {
        const item = updates.read().find(value => value.id === `memory:${request.viewId}`);
        if (!item || item.kind !== 'custom') return;
        if (item.presenter.id !== MEMORY_VIEW_PRESENTER.id || item.presenter.version !== MEMORY_VIEW_PRESENTER.version) throw new Error('Invalid memory presenter.');
        const chunk = parseMemoryViewChunk(item.data);
        if (chunk.viewId === request.viewId && chunk.documentId === request.documentId && chunk.index === request.index) finish(undefined, chunk.text);
      } catch (error) { finish(error); }
    };
    unsubscribe = updates.subscribe(check);
    if (settled) { unsubscribe(); return; }
    signal.addEventListener('abort', aborted, { once: true });
    if (signal.aborted) aborted(); else check();
  });
}

function session(row: MemorySessionView): MemoryHistorySession {
  return { id: row.id, path: row.path, cwd: row.cwd, created: new Date(row.created), modified: new Date(row.modified),
    messageCount: row.messageCount, firstMessage: row.firstMessage, allMessagesText: row.allMessagesText,
    ...(row.name === undefined ? {} : { name: row.name }),
    ...(row.parentSessionPath === undefined ? {} : { parentSessionPath: row.parentSessionPath }),
    memory: { project: row.project, manifestPath: row.manifestPath } };
}

export function registerMemoryPresenter(presenters: Pick<ClientInteractionPresenters, 'registerCustom'>,
  ui: Pick<InteractionPresenterUi, 'custom'>, updates: PresentationUpdatesSource): () => void {
  const lifetime = new AbortController(); const states = new Map<string, ViewState>();
  const remove = presenters.registerCustom(MEMORY_VIEW_PRESENTER, async (data, callerSignal, _document, interaction) => {
    const request = parseMemoryViewRequest(data); const signal = AbortSignal.any([callerSignal, lifetime.signal]);
    let state = states.get(request.viewId);
    if (!state) {
      if (states.size >= 8) throw new Error('Too many active memory views.');
      state = { parts: [], bytes: 0 }; states.set(request.viewId, state);
    }
    const action = (value: MemoryViewChoice): MemoryViewAction => ({ ...value, viewId: request.viewId, sequence: request.sequence });
    if (state.documentId !== request.documentId) { state.documentId = request.documentId; state.parts = []; state.bytes = 0; }
    if (request.index > state.parts.length) return { ...action({ action: 'chunk', index: state.parts.length }) };
    const text = await receive(interactionUpdates(updates, interaction), request, signal);
    if (state.parts[request.index] !== undefined && state.parts[request.index] !== text) throw new Error('Memory document changed during transfer.');
    if (state.parts[request.index] === undefined) { state.parts[request.index] = text; state.bytes += new TextEncoder().encode(text).length; }
    if (state.bytes > request.bytes) throw new Error('Memory document exceeds its declared size.');
    if (state.parts.length < request.chunks) return { ...action({ action: 'chunk', index: state.parts.length }) };
    if (state.bytes !== request.bytes) throw new Error('Memory document size mismatch.');
    const document = decodeMemoryDocument(state.parts.join(''), request.kind);
    if (document.kind === 'catalog') state.catalog = document;
    state.parts = []; state.bytes = 0;
    if (!state.catalog) {
      if (document.kind === 'snapshot') state.restoreKey = document.session.key;
      return { ...action({ action: 'back' }) };
    }
    if (document.kind === 'catalog' && state.restoreKey) {
      const key = state.restoreKey; delete state.restoreKey;
      if (document.sessions.some(row => row.key === key)) return { ...action({ action: 'inspect', key }) };
    }
    const current = new Set(state.catalog.current);
    const sessions = state.catalog.sessions.map(row => ({ row, session: session(row) }));
    const history: LocalSessionHistory = { currentSessions: sessions.filter(item => current.has(item.row.key)).map(item => item.session),
      allSessions: sessions.map(item => item.session), memorySessions: new Map(sessions.map(item => [item.session.path, item.session])) };
    const snapshot: MemoryDisplaySnapshot | undefined = document.kind === 'snapshot' ? {
      session: session(document.session), ...(document.metadata === undefined ? {} : { metadata: document.metadata }),
      messages: document.messages as MemoryDisplaySnapshot['messages'], diagnostics: document.diagnostics,
    } : undefined;
    let view: MemoryHistoryView | undefined; let abort = () => {};
    try {
      const result = await ui.custom<MemoryViewAction | undefined>((tui, theme, keybindings, done) => {
        const finish = (value: MemoryViewChoice) => done(action(value));
        view = new MemoryHistoryView(tui, history, () => finish({ action: 'close' }), {
          memoryOnly: true, status: request.status, keybindings, theme,
          ...(state!.navigation ? { navigation: state!.navigation } : {}), ...(snapshot ? { snapshot } : {}),
          onInspect(selected) {
            const row = sessions.find(item => item.session.path === selected.path)?.row;
            if (!row) throw new Error('The selected memory run is unavailable.');
            finish({ action: 'inspect', key: row.key });
          },
          onBack: () => finish({ action: 'back' }),
        });
        abort = () => done(undefined); signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
        return view;
      });
      if (view) state.navigation = view.getNavigation();
      if (!result || result.action === 'close') states.delete(request.viewId);
      return result ? { ...result } : undefined;
    } finally { signal.removeEventListener('abort', abort); view?.dispose(); }
  });
  return () => { lifetime.abort(); states.clear(); remove(); };
}
