import { randomUUID } from 'node:crypto';
import type { ExtensionUi, UiElementHandle } from '@felan-ai/agent-core';
const MEMORY_DOCUMENT_BYTES = 64 * 1024 * 1024;
import type { FelanExtensionAPI, UiActionRequest, UiAction, UiDocument, UiView } from '@felan-ai/agent-core';
import type { MemoryControlPresentationHost } from './control.js';
import type { MemoryContext } from './context.js';
import { listLocalSessionHistory, readMemoryHistorySnapshot } from './history.js';
import type { MemoryHistorySession } from './history.js';
export const MEMORY_HISTORY_HINT = Object.freeze({ id: 'felan.memory-history', version: '1' });

const close: UiAction = { id: 'close', label: 'Close', target: 'element', outcome: 'cancel' };
const pageSize = 40;

export function createMemoryPresentation(pi: FelanExtensionAPI, environment: MemoryContext): MemoryControlPresentationHost {
  let active = false;
  return {
    async openDirectory(directory, signal) {
      const result = await pi.ui.request({ title: 'Open memory directory',
        fallback: `Open ${directory} on this host?`, input: { fields: [] }, actions: [
          { id: 'open', label: 'Open directory', target: 'element', outcome: 'submit' }, close,
        ] }, { signal, audience: 'host' });
      if (result.state !== 'answered' || result.answer.actionId !== 'open') return;
      signal.throwIfAborted();
      const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer.exe' : 'xdg-open';
      const opened = await pi.runtime.exec(command, [directory]);
      if (opened.code !== 0) throw new Error('Memory directory could not be opened.');
    },
    async showHistory(ctx, agentDir, status, callerSignal) {
      if (active) { await pi.ui.notify({ text: 'A memory view is already open for this session.', level: 'warning' }); return; }
      active = true;
      const signal = callerSignal;
      let handle: UiElementHandle | undefined;
      try {
        const load = () => listLocalSessionHistory(environment, { cwd: ctx.cwd, agentDir, sessionDir: ctx.sessionManager.getSessionDir(), memoryOnly: true });
        let history = await load(); let query = ''; let page = 0;
        let detail: { title: string; pages: string[]; page: number } | undefined;
        while (!signal.aborted) {
          const selected = new Map<string, MemoryHistorySession>();
          const id = `memory-${randomUUID()}`;
          let element: UiView | UiDocument;
          if (detail) {
            const actions: UiAction[] = [{ id: 'back', label: 'Back to runs', target: 'element', outcome: 'submit' }];
            if (detail.page > 0) actions.push({ id: 'previous', label: 'Previous page', target: 'element', outcome: 'submit' });
            if (detail.page + 1 < detail.pages.length) actions.push({ id: 'next', label: 'Next page', target: 'element', outcome: 'submit' });
            element = { id, kind: 'document', revision: 1, title: detail.title, hint: MEMORY_HISTORY_HINT,
              markdown: `Page ${detail.page + 1} of ${detail.pages.length}\n\n${detail.pages[detail.page]}`, actions: [...actions, close], fallback: detail.title };
          } else {
            const rows = [...history.memorySessions.values()].filter(row => `${row.name ?? ''} ${row.id} ${row.cwd} ${row.firstMessage}`.toLowerCase().includes(query.toLowerCase()));
            page = Math.min(page, Math.max(0, Math.ceil(rows.length / pageSize) - 1));
            const actions: UiAction[] = [
              { id: 'inspect', label: 'Inspect run', target: 'item', outcome: 'submit' },
              { id: 'query', label: 'Search runs', target: 'element', outcome: 'submit', input: { fields: [
                { id: 'query', kind: 'string', label: 'Search', required: false, maxLength: 1024 },
              ], defaults: { query } } },
              { id: 'refresh', label: 'Refresh', target: 'element', outcome: 'submit' },
            ];
            if (page > 0) actions.push({ id: 'previous', label: 'Previous page', target: 'element', outcome: 'submit' });
            if ((page + 1) * pageSize < rows.length) actions.push({ id: 'next', label: 'Next page', target: 'element', outcome: 'submit' });
            element = { id, kind: 'view', revision: 1, title: 'Memory history', fallback: status || 'Memory history', hint: MEMORY_HISTORY_HINT,
              fields: [{ id: 'run', label: 'Run', valueKind: 'text' }, { id: 'project', label: 'Project', valueKind: 'text' },
                { id: 'updated', label: 'Updated', valueKind: 'date' }, { id: 'messages', label: 'Messages', valueKind: 'number' }],
              items: rows.slice(page * pageSize, (page + 1) * pageSize).map(row => {
                const key = randomUUID(); selected.set(key, row);
                const name = label(row.name || row.id);
                return { id: key, values: { run: name, project: label(row.cwd), updated: row.modified.toISOString(), messages: row.messageCount }, fallback: name };
              }), actions: [...actions, close], query: { actionId: 'query', values: { query } },
              ...(page > 0 || (page + 1) * pageSize < rows.length ? { paging: {
                ...(page > 0 ? { previousActionId: 'previous' } : {}), ...((page + 1) * pageSize < rows.length ? { nextActionId: 'next' } : {}),
              } } : {}) };
          }
          let answer!: (value: UiActionRequest | undefined) => void;
          const pending = new Promise<UiActionRequest | undefined>(resolve => { answer = resolve; });
          const abort = () => answer(undefined);
          signal.addEventListener('abort', abort, { once: true });
          let action: UiActionRequest | undefined;
          let failure: unknown;
          try {
            handle = await pi.ui.present(element, { signal, onAction: async value => {
              try {
                if (value.outcome !== 'cancel') {
                  if (detail) {
                    if (value.actionId === 'back') detail = undefined;
                    else detail.page += value.actionId === 'next' ? 1 : -1;
                  } else if (value.actionId === 'query') { query = typeof value.values.query === 'string' ? value.values.query : ''; page = 0; }
                  else if (value.actionId === 'refresh') history = await load();
                  else if (value.actionId === 'next') page++;
                  else if (value.actionId === 'previous') page--;
                  else {
                    const row = value.itemId ? selected.get(value.itemId) : undefined;
                    if (!row) throw new Error('The selected memory run is unavailable.');
                    const snapshot = await readMemoryHistorySnapshot(environment, row); signal.throwIfAborted();
                    const text = JSON.stringify({ metadata: snapshot.metadata, messages: snapshot.messages, diagnostics: snapshot.diagnostics }, null, 2);
                    if (Buffer.byteLength(text) > MEMORY_DOCUMENT_BYTES) throw new Error('Memory history exceeds the safe display limit. No retained files were changed.');
                    detail = { title: label(row.name || row.id), pages: textPages(text), page: 0 };
                  }
                }
                answer(value);
              } catch (error) { failure = error; answer(undefined); throw error; }
            } });
            if (signal.aborted) abort();
            action = await pending;
          } finally { signal.removeEventListener('abort', abort); await handle?.close(); handle = undefined; }
          if (failure !== undefined) throw failure;
          if (!action || action.outcome === 'cancel') return;
        }
      } finally { active = false; await handle?.close(); }
    },
  };
}

function label(value: string): string { return Array.from(value).slice(0, 250).join(''); }
function textPages(value: string): string[] {
  const pages: string[] = []; let page = ''; let bytes = 0;
  for (const character of value) {
    const safe = character === '<' ? '&lt;' : character === '>' ? '&gt;' : character === '&' ? '&amp;'
      : /[\\`*_{}\[\]()!#|]/u.test(character) ? `\\${character}` : character;
    const size = Buffer.byteLength(safe);
    if (bytes + size > 48 * 1024) { pages.push(page); page = ''; bytes = 0; }
    page += safe; bytes += size;
  }
  if (page || !pages.length) pages.push(page || 'No retained messages.');
  return pages;
}
