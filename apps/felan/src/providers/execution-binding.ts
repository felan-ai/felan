import type { AgentSession } from '@felan-ai/agent-core';
import { SESSION_EXECUTION_COMPLETION_MESSAGE_TYPE } from '../execution-completion.js';
import type { ExecutionCompletionNotice, ExecutionParentPort, SessionExecutionPort } from '@felan-ai/daemon/provider';

export function bindExecutionSession(options: {
  readonly port: Pick<SessionExecutionPort, 'attachExecutionParent'>;
  readonly session: AgentSession;
}): () => void {
  const port = createParentPort(options.session);
  let detach: () => void;
  try {
    detach = options.port.attachExecutionParent(port);
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
): ExecutionParentPort & { close(): void } {
  const sessionManager = session.sessionManager;
  const delivered = new Set(
    sessionManager.getEntries()
      .flatMap((entry) => entry.type === 'custom_message' && entry.customType === SESSION_EXECUTION_COMPLETION_MESSAGE_TYPE
        ? completionIds(entry.details)
        : []),
  );
  const pending = new Map<string, ExecutionCompletionNotice>();
  const queued = new Map<string, 'queued' | 'retry-when-idle'>();
  let wakeScheduled = false;
  let closed = false;

  const flushPending = () => {
    if (closed || pending.size === 0) return;
    const notices = [...pending.values()];
    pending.clear();
    for (const notice of notices) queued.set(notice.deliveryId, 'queued');
    const details = notices.length === 1
      ? { notice: notices[0] }
      : { notices };
    void Promise.resolve().then(() => session.sendCustomMessage(
      {
        customType: SESSION_EXECUTION_COMPLETION_MESSAGE_TYPE,
        content: formatCompletionNotices(notices),
        display: true,
        details,
      },
      {
        triggerTurn: true,
        deliverAs: 'steer',
      },
    )).catch(() => {
      for (const notice of notices) {
        queued.delete(notice.deliveryId);
        if (!delivered.has(notice.deliveryId)) pending.set(notice.deliveryId, notice);
      }
      if (!session.isStreaming) scheduleIdleWake();
    });
  };
  const scheduleIdleWake = () => {
    if (wakeScheduled || closed) return;
    wakeScheduled = true;
    queueMicrotask(() => {
      wakeScheduled = false;
      if (!session.isStreaming) flushPending();
    });
  };
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
    if (event.type === 'turn_end') {
      flushPending();
      return;
    }
    if (event.type === 'agent_settled') {
      for (const [id, state] of queued) {
        if (state === 'retry-when-idle') queued.delete(id);
      }
      scheduleIdleWake();
      return;
    }
    if (
      event.type !== 'message_end'
      || event.message.role !== 'custom'
      || event.message.customType !== SESSION_EXECUTION_COMPLETION_MESSAGE_TYPE
    ) return;
    const ids = completionIds(event.message.details);
    queueMicrotask(() => {
      const persisted = new Set(sessionManager.getEntries().flatMap((entry) => (
        entry.type === 'custom_message' && entry.customType === SESSION_EXECUTION_COMPLETION_MESSAGE_TYPE
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
      pending.clear();
      queued.clear();
      unsubscribe();
      if (session.clearQueue === observedClearQueue) session.clearQueue = originalClearQueue;
    },
    async deliverCompletion(notice) {
      if (closed) return 'unavailable';
      if (delivered.has(notice.deliveryId)) return 'delivered';
      if (pending.has(notice.deliveryId) || queued.has(notice.deliveryId)) return 'queued';

      pending.set(notice.deliveryId, notice);
      if (!session.isStreaming) scheduleIdleWake();
      return 'queued';
    },
    acknowledgeCompletion(deliveryId) {
      pending.delete(deliveryId);
    },
  };
}

function completionIds(data: unknown): string[] {
  if (typeof data !== 'object' || data === null) return [];
  const notice = Reflect.get(data, 'notice');
  const notices = Reflect.get(data, 'notices');
  const ids = typeof notice === 'object'
    && notice !== null
    && typeof Reflect.get(notice, 'deliveryId') === 'string'
    ? [Reflect.get(notice, 'deliveryId') as string]
    : [];
  if (!Array.isArray(notices)) return ids;
  for (const entry of notices) {
    if (
      typeof entry === 'object'
      && entry !== null
      && typeof Reflect.get(entry, 'deliveryId') === 'string'
    ) ids.push(Reflect.get(entry, 'deliveryId') as string);
  }
  return [...new Set(ids)];
}

function formatCompletionNotices(notices: readonly ExecutionCompletionNotice[]): string {
  if (notices.length === 1) return formatCompletionNotice(notices[0]!);
  return `Execution completions:\n${notices.map((notice) => `- ${formatCompletionNotice(notice)}`).join('\n')}`;
}

function formatCompletionNotice(notice: ExecutionCompletionNotice): string {
  const outcome = notice.summary ?? notice.error?.message ?? notice.status;
  return `Execution completion: ${notice.label} ${notice.executionId}: ${notice.status} — ${outcome}`;
}
