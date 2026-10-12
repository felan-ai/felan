import { randomUUID } from 'node:crypto';
import open from 'open';
import { MEMORY_VIEW_PRESENTER, encodeMemoryDocument, parseMemoryViewAction, parseMemoryViewRequest,
  type MemorySessionView, type MemoryViewDocument } from '@felan-ai/ext-memory/view';
import { JsonValueSchema, parseSchema, type Interaction, type Presentation } from '@felan-ai/session-protocol';
import type { MemoryControlPresentationHost } from '../memory/control.js';
import { listLocalSessionHistory, readMemoryHistorySnapshot, type MemoryHistorySession } from '../memory/history.js';
import type { BrokerOutcome } from './broker.js';

export function createBrokerMemoryHost(options: {
  signal: AbortSignal;
  canOpen(): boolean;
  present(value: Presentation | { id: string; remove: true }): void;
  request(value: Interaction['request'], dialog: { signal: AbortSignal }): Promise<BrokerOutcome>;
  unsupported(surface: string): never;
  openDirectory?(directory: string): Promise<void>;
}): MemoryControlPresentationHost {
  let active = false;
  return {
    isInteractive: () => !options.signal.aborted && options.canOpen(),
    async openDirectory(directory, callerSignal) {
      const signal = AbortSignal.any([callerSignal, options.signal]); signal.throwIfAborted();
      if (!options.canOpen()) options.unsupported('memory directory');
      if (options.openDirectory) await options.openDirectory(directory); else await open(directory);
    },
    async showHistory(ctx, agentDir, status, callerSignal) {
      if (active) { ctx.ui.notify('A memory view is already open for this session.', 'warning'); return; }
      if (!options.canOpen()) options.unsupported('memory history');
      active = true;
      const signal = AbortSignal.any([callerSignal, options.signal]);
      const viewId = randomUUID(); const presentationId = `memory:${viewId}`;
      let published = false;
      try {
        signal.throwIfAborted();
        const history = await listLocalSessionHistory({ cwd: ctx.cwd, agentDir, sessionDir: ctx.sessionManager.getSessionDir(), memoryOnly: true });
        signal.throwIfAborted();
        const sessions = new Map<string, MemoryHistorySession>();
        const rows: MemorySessionView[] = [];
        for (const session of history.memorySessions.values()) {
          const key = randomUUID(); sessions.set(key, session);
          rows.push({ key, id: session.id, path: session.path, cwd: session.cwd, created: session.created.getTime(), modified: session.modified.getTime(),
            messageCount: session.messageCount, firstMessage: session.firstMessage, allMessagesText: session.allMessagesText,
            ...(session.name === undefined ? {} : { name: session.name }),
            ...(session.parentSessionPath === undefined ? {} : { parentSessionPath: session.parentSessionPath }),
            project: session.memory.project, manifestPath: session.memory.manifestPath });
        }
        const current = new Set(history.currentSessions.map(session => session.path));
        const catalog: MemoryViewDocument = { kind: 'catalog', sessions: rows, current: rows.filter(row => current.has(row.path)).map(row => row.key) };
        let document: MemoryViewDocument = catalog;
        let encoded = encodeMemoryDocument(document); let documentId = randomUUID(); let index = 0; let sequence = 0;
        while (!signal.aborted) {
          const request = parseMemoryViewRequest({ viewId, sequence: ++sequence, documentId, kind: document.kind,
            index, chunks: encoded.chunks.length, bytes: encoded.bytes, status });
          options.present({ id: presentationId, kind: 'custom', presenter: MEMORY_VIEW_PRESENTER,
            data: { viewId, documentId, index, text: encoded.chunks[index]! } }); published = true;
          const result = await options.request({ kind: 'custom', presenter: MEMORY_VIEW_PRESENTER, data: parseSchema(JsonValueSchema, request) }, { signal });
          if (signal.aborted) return;
          if (result.state !== 'answered') {
            if (result.state === 'cancelled' && result.reason === 'unsupported') options.unsupported('memory history');
            return;
          }
          if (result.answer.kind !== 'custom') throw new Error('Invalid memory view answer.');
          const action = parseMemoryViewAction(result.answer.data, request);
          if (action.action === 'close') return;
          if (action.action === 'chunk') { index = action.index; continue; }
          if (action.action === 'back') document = catalog;
          else {
            const selected = sessions.get(action.key); const row = rows.find(item => item.key === action.key);
            if (!selected || !row) throw new Error('The selected memory run is unavailable.');
            const snapshot = await readMemoryHistorySnapshot(selected); signal.throwIfAborted();
            const metadata = snapshot.metadata;
            document = { kind: 'snapshot', session: row, messages: snapshot.messages, diagnostics: [...snapshot.diagnostics],
              ...(metadata === undefined ? {} : { metadata: { startedAt: metadata.startedAt, status: metadata.status, phase: metadata.phase,
                ...(metadata.finishedAt === undefined ? {} : { finishedAt: metadata.finishedAt }),
                ...(metadata.model === undefined ? {} : { model: { provider: metadata.model.provider, id: metadata.model.id } }),
                ...(metadata.error === undefined ? {} : { error: metadata.error }) } }) };
          }
          encoded = encodeMemoryDocument(document); documentId = randomUUID(); index = 0;
        }
      } finally {
        active = false;
        if (published && !options.signal.aborted) options.present({ id: presentationId, remove: true });
      }
    },
  };
}
