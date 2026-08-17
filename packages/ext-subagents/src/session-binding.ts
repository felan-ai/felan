import type { AgentSession } from '@felan-ai/agent-core';
import type {
  SubagentCompletionNotice,
  SubagentHost,
  SubagentParentContextEntry,
  SubagentParentPort,
} from './contracts.js';

export const SUBAGENT_COMPLETION_MESSAGE_TYPE = 'felan-subagent-completion';
const encoder = new TextEncoder();

export function bindSubagentSession(options: {
  readonly host: SubagentHost;
  readonly session: AgentSession;
}): () => void {
  const port = createParentPort(options.session);
  let detach: () => void;
  try {
    detach = options.host.attachParent(port);
  } catch (error) {
    port.close();
    options.session.dispose();
    throw error;
  }

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    port.close();
    detach();
  };
  const dispose = options.session.dispose.bind(options.session);
  let disposed = false;
  options.session.dispose = () => {
    if (disposed) return;
    disposed = true;
    try {
      close();
    } finally {
      dispose();
    }
  };
  return close;
}

function createParentPort(
  session: AgentSession,
): SubagentParentPort & { close(): void } {
  const sessionManager = session.sessionManager;
  const delivered = new Set(
    sessionManager.getEntries()
      .flatMap((entry) => entry.type === 'custom_message' && entry.customType === SUBAGENT_COMPLETION_MESSAGE_TYPE
        ? completionIds(entry.details)
        : []),
  );
  const queued = new Map<string, 'queued' | 'retry-when-idle'>();
  let delivery = Promise.resolve<'delivered' | 'queued' | 'unavailable'>('delivered');
  let closed = false;
  const originalClearQueue = session.clearQueue;
  const clearQueue = originalClearQueue.bind(session);
  const observedClearQueue: AgentSession['clearQueue'] = () => {
    const result = clearQueue();
    for (const id of queued.keys()) queued.set(id, 'retry-when-idle');
    if (!session.isStreaming) queued.clear();
    return result;
  };
  session.clearQueue = observedClearQueue;
  const unsubscribe = session.subscribe((event) => {
    if (event.type === 'agent_settled') {
      for (const [id, state] of queued) {
        if (state === 'retry-when-idle') queued.delete(id);
      }
      return;
    }
    if (
      event.type !== 'message_end'
      || event.message.role !== 'custom'
      || event.message.customType !== SUBAGENT_COMPLETION_MESSAGE_TYPE
    ) return;
    const ids = completionIds(event.message.details);
    queueMicrotask(() => {
      const persisted = new Set(sessionManager.getEntries().flatMap((entry) => (
        entry.type === 'custom_message' && entry.customType === SUBAGENT_COMPLETION_MESSAGE_TYPE
          ? completionIds(entry.details)
          : []
      )));
      for (const id of ids.filter((id) => persisted.has(id))) {
        delivered.add(id);
        queued.delete(id);
      }
    });
  });

  return {
    close: () => {
      if (closed) return;
      closed = true;
      unsubscribe();
      if (session.clearQueue === observedClearQueue) session.clearQueue = originalClearQueue;
    },
    async snapshotContext({ maxBytes }) {
      const entries = contextEntries(sessionManager);
      const selected: SubagentParentContextEntry[] = [];
      let bytes = 0;

      for (let index = entries.length - 1; index >= 0; index -= 1) {
        const entry = entries[index]!;
        const size = encoder.encode(entry.text).byteLength;
        if (bytes + size > maxBytes) {
          break;
        }
        selected.unshift(entry);
        bytes += size;
      }

      return selected;
    },
    async deliverCompletion(notice) {
      const run = async (): Promise<'delivered' | 'queued' | 'unavailable'> => {
        if (closed) return 'unavailable';
        if (delivered.has(notice.deliveryId)) return 'delivered';
        if (queued.has(notice.deliveryId)) return 'queued';

        queued.set(notice.deliveryId, 'queued');
        try {
          await session.sendCustomMessage(
            {
              customType: SUBAGENT_COMPLETION_MESSAGE_TYPE,
              content: formatCompletionNotice(notice),
              display: true,
              details: { notice },
            },
            {
              triggerTurn: true,
              deliverAs: 'steer',
            },
          );
          if (session.isStreaming) return 'queued';
          delivered.add(notice.deliveryId);
          queued.delete(notice.deliveryId);
          return 'delivered';
        } catch {
          queued.delete(notice.deliveryId);
          return 'unavailable';
        }
      };
      delivery = delivery.then(run, run);
      return delivery;
    },
  };
}

function contextEntries(
  sessionManager: AgentSession['sessionManager'],
): SubagentParentContextEntry[] {
  const entries: SubagentParentContextEntry[] = [];
  for (const entry of sessionManager.buildContextEntries()) {
    if (entry.type === 'compaction' || entry.type === 'branch_summary') {
      entries.push({ role: 'summary', text: entry.summary });
      continue;
    }
    if (entry.type !== 'message') continue;
    const message = entry.message;
    if (message.role !== 'user' && message.role !== 'assistant') continue;
    const text = typeof message.content === 'string'
      ? message.content
      : message.content
          .filter((part) => part.type === 'text')
          .map((part) => part.text)
          .join('\n');
    if (text) entries.push({ role: message.role, text });
  }
  return entries;
}

function completionIds(data: unknown): string[] {
  if (typeof data !== 'object' || data === null) return [];
  const notice = Reflect.get(data, 'notice');
  return typeof notice === 'object'
    && notice !== null
    && typeof Reflect.get(notice, 'deliveryId') === 'string'
    ? [Reflect.get(notice, 'deliveryId') as string]
    : [];
}

function formatCompletionNotice(notice: SubagentCompletionNotice): string {
  const outcome = notice.summary ?? notice.error?.message ?? notice.status;
  return `Subagent completion: ${notice.type} ${notice.agentId}: ${notice.status} — ${outcome}`;
}
