import { randomUUID } from 'node:crypto';
import { stripVTControlCharacters } from 'node:util';
import type { PromptHistoryPresentationHost, PromptHistorySearchState } from '@felan-ai/ext-prompt-history';
import { PROMPT_HISTORY_PRESENTER, parsePromptHistoryAction, parsePromptHistoryFrame, parsePromptHistoryRequest,
  splitPromptHistoryText, type PromptHistoryViewRequest } from '@felan-ai/ext-prompt-history/view';
import { JsonValueSchema, parseSchema, type Interaction, type Presentation } from '@felan-ai/session-protocol';
import type { BrokerOutcome } from './broker.js';

export function createBrokerPromptHistoryHost(options: {
  signal: AbortSignal;
  present(value: Presentation | { id: string; remove: true }): void;
  request(value: Interaction['request'], dialog: { signal: AbortSignal }): Promise<BrokerOutcome>;
  unsupported(surface: string): never;
}): PromptHistoryPresentationHost {
  let active = false;
  return { async show(_ui, search, displayMode, callerSignal) {
    if (active) throw new Error('A prompt history view is already open for this session.');
    active = true;
    const lifetime = new AbortController(); const signal = AbortSignal.any([options.signal, callerSignal, lifetime.signal]);
    const viewId = randomUUID(); const presentationId = `prompt-history:${viewId}`;
    const pending = new Set<Promise<void>>(); let generation = 0; let published = false;
    const present = (data: unknown) => {
      signal.throwIfAborted();
      options.present({ id: presentationId, kind: 'custom', presenter: PROMPT_HISTORY_PRESENTER, data: parseSchema(JsonValueSchema, data) }); published = true;
    };
    const ask = async (request: PromptHistoryViewRequest, currentSignal = signal) => {
      const result = await options.request({ kind: 'custom', presenter: PROMPT_HISTORY_PRESENTER, data: parseSchema(JsonValueSchema, request) }, { signal: currentSignal });
      if (signal.aborted) return;
      if (result.state !== 'answered') {
        if (result.state === 'cancelled' && result.reason === 'unsupported') options.unsupported('prompt history');
        return;
      }
      if (result.answer.kind !== 'custom') throw new Error('Invalid prompt history answer.');
      return parsePromptHistoryAction(result.answer.data, request);
    };
    const preview = (value: string, limit: number) => {
      let out = ''; let bytes = 0;
      for (const char of stripVTControlCharacters(value).replace(/[\u0000-\u001f\u007f-\u009f]/gu, '')) { const size = Buffer.byteLength(JSON.stringify(char)) - 2; if (bytes + size > limit - 3) return `${out}…`; out += char; bytes += size; }
      return out;
    };
    try {
      let scope: 'session' | 'project' | 'all' = 'session'; let query = '';
      while (!signal.aborted) {
        const request = parsePromptHistoryRequest({ viewId, generation: ++generation, kind: 'browse', scope, query, displayMode });
        const searchController = new AbortController(); const searchSignal = AbortSignal.any([signal, searchController.signal]);
        const ids = new Map<string, string>(); const selected = new Map<string, PromptHistorySearchState['items'][number]>(); let version = 0;
        let failure: unknown;
        const publish = (state: PromptHistorySearchState) => {
          if (searchSignal.aborted) return;
          const items = state.items.map(item => {
            const id = ids.get(item.id) ?? randomUUID(); ids.set(item.id, id); selected.delete(id); selected.set(id, item);
            return { id, text: preview(item.text.replace(/\s+/gu, ' '), 512),
              cwd: preview(item.cwd.split(/[\\/]/u).filter(Boolean).at(-1) ?? item.cwd, 128),
              sessionLabel: preview(item.sessionLabel, 128), timestamp: Math.max(0, item.timestamp),
              ...(item.sessionName === undefined ? {} : { sessionName: preview(item.sessionName, 128) }) };
          });
          while (selected.size > 100) {
            const oldest = selected.entries().next().value!; selected.delete(oldest[0]); ids.delete(oldest[1].id);
          }
          present(parsePromptHistoryFrame({ ...state, items, viewId, generation, version: ++version }));
        };
        publish({ items: [], loading: true, scanned: 0, complete: false });
        const work = search(scope, query, publish, () => !searchSignal.aborted)
          .then(publish).catch(error => { if (!searchSignal.aborted) { failure = error; searchController.abort(error); } });
        pending.add(work); void work.then(() => pending.delete(work));
        let action: Awaited<ReturnType<typeof ask>>;
        try { action = await ask(request, searchSignal); if (failure) throw failure; }
        finally { searchController.abort(); await work; }
        if (!action || action.action === 'close') return;
        if (action.action === 'search') { scope = action.scope; query = action.query; continue; }
        if (action.action !== 'choose') throw new Error('Invalid prompt history action.');
        const item = selected.get(action.id);
        if (!item) throw new Error('The selected prompt is no longer in the current results. Search again.');
        const encoded = splitPromptHistoryText(item.text); let index = 0;
        while (!signal.aborted) {
          const transfer = parsePromptHistoryRequest({ viewId, generation: ++generation, kind: 'text', index, chunks: encoded.chunks.length, bytes: encoded.bytes });
          present({ viewId, generation, index, text: encoded.chunks[index]! });
          const next = await ask(transfer);
          if (!next || next.action === 'close' || next.action === 'insert') return;
          if (next.action !== 'chunk') throw new Error('Invalid prompt transfer action.');
          index = next.index;
        }
      }
    } finally {
      lifetime.abort(); await Promise.all(pending); active = false;
      if (published && !options.signal.aborted) options.present({ id: presentationId, remove: true });
    }
  } };
}
