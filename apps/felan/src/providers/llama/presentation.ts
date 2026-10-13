import { stripVTControlCharacters } from 'node:util';
import type { ExtensionContext } from '@felan-ai/agent-core';
import { LIMITS } from '@felan-ai/session-protocol';
import type { HuggingFaceModel, LlamaModelInfo, LlamaProgress } from './sdk.js';

export interface LlamaProgressOptions<T> {
  title: string;
  model: string;
  cancelTitle: string;
  run(signal: AbortSignal, update: (progress: LlamaProgress) => void): Promise<T>;
  cancel(): Promise<void>;
}
export interface LlamaPresentation {
  select(title: string, options: readonly string[]): Promise<string | undefined>;
  confirm(title: string, message: string): Promise<boolean>;
  models(server: string, models: readonly LlamaModelInfo[]): Promise<{ type: 'close' } | { type: 'download' } | { type: 'model'; model: LlamaModelInfo }>;
  search(search: (query: string, signal: AbortSignal) => Promise<HuggingFaceModel[]>): Promise<string | undefined>;
  status(title: string, detail?: string): void;
  progress<T>(options: LlamaProgressOptions<T>): Promise<{ cancelled: true } | { cancelled: false; value: T }>;
  dispose(): void;
}

function label(value: string): string {
  return Array.from(stripVTControlCharacters(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu, '')).slice(0, 700).join('');
}

export function createLlamaPresentation(ui: ExtensionContext['ui'], signal: AbortSignal): LlamaPresentation {
  const status = (title: string, detail?: string) => {
    signal.throwIfAborted();
    ui.setStatus('llama', label(detail ? `${title}: ${detail}` : title));
  };
  const select = async (title: string, options: readonly string[]) => {
    const pageSize = LIMITS.choices - 2;
    let start = 0;
    while (options.length > 0) {
      signal.throwIfAborted();
      const page = options.slice(start, start + pageSize).map((value, index) => `${start + index + 1}. ${label(value)}`);
      const choices = [...page, ...(start ? ['Previous page'] : []), ...(start + pageSize < options.length ? ['Next page'] : [])];
      const selected = await ui.select(label(title), choices, { signal });
      signal.throwIfAborted();
      if (selected === undefined) return undefined;
      if (selected === 'Previous page') { start -= pageSize; continue; }
      if (selected === 'Next page') { start += pageSize; continue; }
      const index = page.indexOf(selected);
      return index < 0 ? undefined : options[start + index];
    }
    return undefined;
  };
  return {
    select,
    confirm: async (title, message) => {
      signal.throwIfAborted();
      const result = await ui.confirm(label(title), label(message), { signal });
      signal.throwIfAborted(); return result;
    },
    async models(server, models) {
      const labels = models.map((model, index) => `${index + 1}: ${model.id} · ${model.status.value}${model.meta?.n_ctx ? ` · ${model.meta.n_ctx} context` : ''}`);
      const choice = await select(`llama.cpp · ${server}`, [...labels, 'Download model', 'Close']);
      if (choice === 'Download model') return { type: 'download' };
      const index = choice === undefined ? -1 : labels.indexOf(choice);
      return index < 0 ? { type: 'close' } : { type: 'model', model: models[index]! };
    },
    async search(search) {
      while (true) {
        signal.throwIfAborted();
        const query = (await ui.input('Search Hugging Face', 'Model name or owner/repository[:quant]', { signal }))?.trim();
        signal.throwIfAborted();
        if (!query) return undefined;
        if (query.length > 1024) { ui.notify('Model search is too long.', 'warning'); continue; }
        status('Searching Hugging Face', query);
        const results = await search(query, signal);
        signal.throwIfAborted();
        const names = results.map((model, index) => `${index + 1}: ${model.id} · ${model.downloads} downloads`);
        const direct = query.includes('/') ? `Use ${query}` : undefined;
        const selected = await select('Hugging Face models', [...names, ...(direct ? [direct] : []), 'Search again']);
        if (selected === undefined) return undefined;
        if (selected === 'Search again') continue;
        if (selected === direct) return query;
        const index = names.indexOf(selected);
        return index < 0 ? undefined : results[index]!.id;
      }
    },
    status,
    async progress(options) {
      const control = new AbortController();
      const workingSignal = AbortSignal.any([signal, control.signal]);
      let progress: LlamaProgress = { message: 'Starting…' };
      let settled = false;
      status(options.title, options.model);
      const work = Promise.resolve().then(() => {
        workingSignal.throwIfAborted();
        return options.run(workingSignal, value => {
          if (workingSignal.aborted) return;
          progress = value;
          status(options.title, `${options.model} · ${value.message}${value.ratio === undefined ? '' : ` · ${Math.round(value.ratio * 100)}%`}`);
        });
      }).then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }))
        .then(result => { settled = true; return result; });
      const duringWork = async <V>(prompt: (signal: AbortSignal) => Promise<V>) => {
        const dialog = new AbortController();
        const answer = Promise.resolve().then(() => prompt(AbortSignal.any([workingSignal, dialog.signal])))
          .then(value => ({ kind: 'answer' as const, value }), error => ({ kind: 'error' as const, error }));
        try { return await Promise.race([work.then(result => ({ kind: 'work' as const, result })), answer]); }
        finally { dialog.abort(); await answer; }
      };
      try {
        while (true) {
          const outcome = await duringWork(dialogSignal => ui.select(label(`${options.title}\n${options.model}\n${progress.message}`), ['Stop'], { signal: dialogSignal }));
          signal.throwIfAborted();
          if (outcome.kind === 'work') {
            if (!outcome.result.ok) throw outcome.result.error;
            return { cancelled: false, value: outcome.result.value };
          }
          if (outcome.kind === 'error') throw outcome.error;
          const confirmation = await duringWork(dialogSignal => ui.confirm(label(options.cancelTitle), label(options.model), { signal: dialogSignal }));
          signal.throwIfAborted();
          if (confirmation.kind === 'work') {
            if (!confirmation.result.ok) throw confirmation.result.error;
            return { cancelled: false, value: confirmation.result.value };
          }
          if (confirmation.kind === 'error') throw confirmation.error;
          if (!confirmation.value) continue;
          if (settled) {
            const result = await work;
            if (!result.ok) throw result.error;
            return { cancelled: false, value: result.value };
          }
          try { await options.cancel(); }
          finally { control.abort(); }
          await work;
          return { cancelled: true };
        }
      } finally {
        control.abort();
        await work;
        if (!signal.aborted) ui.setStatus('llama', undefined);
      }
    },
    dispose() { if (!signal.aborted) ui.setStatus('llama', undefined); },
  };
}
