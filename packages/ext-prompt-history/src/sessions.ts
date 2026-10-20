import { SESSION_HISTORY_LIMITS, type SessionEntry, type SessionHistoryInfo, type SessionsHistory } from '@felan-ai/agent-core';
import type { PromptHistoryHost, PromptHistorySessionReference } from './contracts.js';

export function createSessionsPromptHistory(sessions: SessionsHistory, signal: AbortSignal): PromptHistoryHost {
  const visible = new WeakMap<PromptHistorySessionReference, SessionHistoryInfo>();
  const protect = async <T>(operation: () => Promise<T>): Promise<T> => {
    try { signal.throwIfAborted(); return await operation(); }
    catch { throw signal.aborted ? new DOMException('Prompt history cancelled.', 'AbortError') : new Error('Prompt history is unavailable.'); }
  };
  return {
    listSessions: () => protect(async () => {
      const references: PromptHistorySessionReference[] = [];
      const ids = new Set<string>();
      const cursors = new Set<string>();
      let cursor: string | undefined;
      do {
        signal.throwIfAborted();
        const page = await sessions.list({ scope: 'visible' }, { signal, limit: SESSION_HISTORY_LIMITS.pageEntries, ...(cursor === undefined ? {} : { cursor }) });
        signal.throwIfAborted();
        if (!Array.isArray(page.items) || page.items.length > SESSION_HISTORY_LIMITS.pageEntries) throw new Error('Invalid history page.');
        for (const info of page.items) {
          if (!info.id || ids.has(info.id) || info.diagnostic) throw new Error('Invalid history reference.');
          ids.add(info.id);
          const reference = { id: info.id, label: info.title || info.id, timestamp: info.updatedAt };
          visible.set(reference, { ...info });
          references.push(reference);
        }
        cursor = nextCursor(page.nextCursor, cursors);
      } while (cursor !== undefined);
      return references;
    }),
    readSession: reference => protect(async () => {
      const info = visible.get(reference);
      if (!info) throw new Error('Unknown history reference.');
      const checkpoint = await sessions.checkpoint(info.id, { signal });
      signal.throwIfAborted();
      if (checkpoint.sessionId !== info.id || typeof checkpoint.revision !== 'string' || !checkpoint.revision
        || checkpoint.branch !== null && (typeof checkpoint.branch !== 'string' || !checkpoint.branch)
        || !Number.isSafeInteger(checkpoint.byteLength) || checkpoint.byteLength < 0 || checkpoint.byteLength > SESSION_HISTORY_LIMITS.fileBytes) {
        throw new Error('Invalid history checkpoint.');
      }
      const at = { sessionId: info.id, revision: checkpoint.revision, branch: checkpoint.branch };
      const entries: SessionEntry[] = [];
      const ids = new Set<string>();
      const cursors = new Set<string>();
      let bytes = 0;
      let cursor: string | undefined;
      do {
        signal.throwIfAborted();
        const page = await sessions.history(info.id, { signal, limit: SESSION_HISTORY_LIMITS.pageEntries, at, ...(cursor === undefined ? {} : { cursor }) });
        signal.throwIfAborted();
        if (page.sessionId !== at.sessionId || page.revision !== at.revision || page.branch !== at.branch || !Array.isArray(page.entries)
          || page.entries.length > SESSION_HISTORY_LIMITS.pageEntries) throw new Error('History changed.');
        for (const entry of page.entries) {
          if (!entry || !entry.id || ids.has(entry.id)) throw new Error('Invalid history entry.');
          bytes += new TextEncoder().encode(JSON.stringify(entry)).byteLength + 1;
          if (bytes > SESSION_HISTORY_LIMITS.fileBytes) throw new Error('History exceeds the size limit.');
          ids.add(entry.id);
          entries.push(entry);
        }
        cursor = nextCursor(page.nextCursor, cursors);
      } while (cursor !== undefined);
      return { cwd: info.cwd, ...(info.title ? { name: info.title } : {}), entries };
    }),
  };
}

function nextCursor(value: string | undefined, seen: Set<string>): string | undefined {
  if (value !== undefined) {
    if (typeof value !== 'string' || !value || value.length > 4096 || seen.has(value)) throw new Error('Invalid history cursor.');
    seen.add(value);
  }
  return value;
}
