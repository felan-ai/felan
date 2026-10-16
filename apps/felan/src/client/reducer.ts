import {
  LIMITS, classifyRevision, classifyTextDelta, codePointLength, parseSessionSnapshot, trimSnapshotLists, utf8Bytes,
  type KnownSessionChange, type SessionEvent, type SessionSnapshot, type TextStreamEvent,
} from '@felan-ai/session-protocol';

type Update = SessionEvent | TextStreamEvent;
/** Why the client discarded its live view and asked the daemon for a new snapshot. */
export type RecoveryCause = 'revision_gap' | 'stream_mismatch' | 'stream_gap' | 'stream_limit' | 'presentation_conflict'
  | 'state_size_limit' | 'buffer_overflow' | 'stale_snapshot' | 'daemon_resync';
export interface SessionState {
  readonly session: string;
  readonly snapshot?: SessionSnapshot;
  readonly status: 'awaiting_snapshot' | 'live' | 'recovering' | 'blocked' | 'disconnected';
  readonly buffered: readonly Update[];
  readonly bufferedBytes: number;
  readonly bufferGeneration: number;
  readonly discardedRevision: number;
  readonly recoveryAttempts: number;
  readonly recoveryCause?: RecoveryCause;
  readonly recoveredStreams: readonly string[];
}
export type SessionAction =
  | { type: 'snapshot'; snapshot: SessionSnapshot; bufferGeneration?: number }
  | { type: 'update'; update: Update }
  | { type: 'recovery_started' }
  | { type: 'resync'; cause: RecoveryCause }
  | { type: 'disconnected' };

export function createSessionState(session: string): SessionState {
  return { session, status: 'awaiting_snapshot', buffered: [], bufferedBytes: 0, bufferGeneration: 0, discardedRevision: 0, recoveryAttempts: 0, recoveredStreams: [] };
}

const MAX_RECOVERIES = 3;
const MAX_BUFFERED_EVENTS = 1024;
const upsert = <T>(items: T[], value: T, key: (item: T) => string): T[] => {
  const index = items.findIndex(item => key(item) === key(value));
  return index < 0 ? [...items, value] : items.map((item, i) => i === index ? value : item);
};

function buffer(state: SessionState, update: Update, cause?: RecoveryCause): SessionState {
  const bytes = utf8Bytes(JSON.stringify(update));
  if (state.buffered.length >= MAX_BUFFERED_EVENTS || state.bufferedBytes + bytes > LIMITS.unsentBytes) {
    const discardedRevision = state.buffered.reduce((revision, item) => 'rev' in item ? Math.max(revision, item.rev) : revision,
      'rev' in update ? Math.max(state.discardedRevision, update.rev) : state.discardedRevision);
    return { ...state, status: state.recoveryAttempts >= MAX_RECOVERIES ? 'blocked' : 'recovering', recoveryCause: 'buffer_overflow',
      buffered: [], bufferedBytes: 0, bufferGeneration: state.bufferGeneration + 1, discardedRevision };
  }
  return { ...state, status: state.status === 'awaiting_snapshot' ? state.status : 'recovering', ...(cause ? { recoveryCause: cause } : {}),
    buffered: [...state.buffered, update], bufferedBytes: state.bufferedBytes + bytes };
}

function completionOnly(snapshot: SessionSnapshot, stream: TextStreamEvent['stream'], reason: 'lost' | 'limit' = 'lost'): SessionSnapshot {
  return { ...snapshot, activeStreams: snapshot.activeStreams.filter(item => item.id !== stream.id),
    completionOnlyStreams: upsert(snapshot.completionOnlyStreams, { message: stream.message, id: stream.id, kind: stream.kind, reason }, item => item.id) };
}

function applyStream(state: SessionState, update: TextStreamEvent): SessionState {
  const snapshot = state.snapshot!;
  const { stream } = update;
  const ended = snapshot.history.entries.some(message => message.id === stream.message);
  const waiting = snapshot.completionOnlyStreams.some(item => item.id === stream.id);
  const prefix = snapshot.activeStreams.find(item => item.id === stream.id);
  const kind = classifyTextDelta(prefix, update, ended ? 'completed' : waiting ? 'completion_only' : 'active');
  if (kind === 'ignore' || kind === 'duplicate') return state;
  const openMessages = [...snapshot.activeStreams, ...snapshot.completionOnlyStreams].map(item => item.message);
  if (openMessages.some(message => message !== stream.message) ||
      (prefix && (prefix.message !== stream.message || prefix.kind !== stream.kind))) {
    return buffer(state, update, 'stream_mismatch');
  }
  if (kind === 'gap') {
    if (state.recoveredStreams.includes(stream.id)) return { ...state, snapshot: completionOnly(snapshot, stream) };
    return buffer({ ...state, recoveredStreams: [...state.recoveredStreams, stream.id] }, update, 'stream_gap');
  }
  const text = (kind === 'append' ? prefix!.text : '') + update.text;
  const active = upsert(snapshot.activeStreams, { ...stream, text, offset: stream.offset + codePointLength(update.text) }, item => item.id);
  if (active.length + snapshot.completionOnlyStreams.length > LIMITS.activeStreams || utf8Bytes(text) > LIMITS.activeStreamBytes ||
      active.reduce((sum, item) => sum + utf8Bytes(item.text), 0) > LIMITS.activeStreamsBytes) {
    return buffer(state, update, 'stream_limit');
  }
  return { ...state, snapshot: { ...snapshot, activeStreams: active } };
}

function applyEvent(state: SessionState, event: SessionEvent): SessionState {
  const snapshot = state.snapshot!;
  const order = classifyRevision(snapshot.revision, event.rev);
  if (order === 'duplicate') return state;
  if (order === 'gap') return buffer(state, event, 'revision_gap');
  let next = { ...snapshot, revision: event.rev, history: { ...snapshot.history, revision: event.rev } };
  const change = event.change as KnownSessionChange;
  switch (change.type) {
    case 'message.completed': {
      const entries = upsert(next.history.entries, change.message, item => item.id).slice(-LIMITS.pageEntries);
      next = { ...next, history: { ...next.history, entries },
        activeStreams: next.activeStreams.filter(item => item.message !== change.message.id),
        completionOnlyStreams: next.completionOnlyStreams.filter(item => item.message !== change.message.id) };
      break;
    }
    case 'tool.updated': next.tools = upsert(next.tools, change.tool, item => item.id); break;
    case 'run.updated': next.run = change.run; break;
    case 'queue.updated': next.queue = change.queue; break;
    case 'interaction.requested': next.interactions = upsert(next.interactions, change.interaction, item => item.id); break;
    case 'interaction.resolved': next.interactions = next.interactions.filter(item => item.id !== change.interaction.id); break;
    case 'metadata.updated': next = { ...next, title: change.title, state: change.state, residency: change.residency }; break;
    case 'model.updated': next = { ...next, model: change.model, thinking: change.thinking }; break;
    case 'branch.updated': next = { ...next, branch: change.branch, history: { ...change.history, revision: event.rev }, activeStreams: [], completionOnlyStreams: [] }; break;
    case 'policy.updated': next.policy = change.policy; break;
    case 'executions.changed': next.executionsGeneration = change.generation; break;
    case 'child.updated': next.children = upsert(next.children, change.child, item => item.session); break;
    // The daemon lists processes by last update, so trimming drops the same ones only if an update moves the process last.
    case 'process.updated': next.processes = [...next.processes.filter(item => item.id !== change.process.id), change.process]; break;
    case 'presentation.updated': {
      const presentation = change.presentation;
      const previous = next.presentation.find(item => item.id === presentation.id);
      if (previous && ['document', 'view', 'progress', 'status'].includes(presentation.kind) && (previous.kind !== presentation.kind
        || 'revision' in previous && 'revision' in presentation && presentation.revision <= previous.revision)) return buffer(state, event, 'presentation_conflict');
      next.presentation = upsert(next.presentation, presentation, item => item.id); break;
    }
    case 'presentation.removed': next.presentation = next.presentation.filter(item => item.id !== change.id); break;
    case 'catalog.updated': next.catalog = change.catalog; break;
    case 'stream.completion_only': next = completionOnly(next, { ...change.stream, offset: 0 }, change.stream.reason); break;
  }
  next = trimSnapshotLists(next);
  if (utf8Bytes(JSON.stringify(next)) > LIMITS.pageBytes) return buffer(state, event, 'state_size_limit');
  return { ...state, snapshot: next };
}

export function reduceSession(state: SessionState, action: SessionAction): SessionState {
  if (action.type === 'disconnected') return { ...state, status: 'disconnected', buffered: [], bufferedBytes: 0 };
  if (action.type === 'resync') return { ...state, status: state.recoveryAttempts >= MAX_RECOVERIES ? 'blocked' : 'recovering', recoveryCause: action.cause };
  if (action.type === 'recovery_started') return { ...state, recoveryAttempts: state.recoveryAttempts + 1,
    status: state.recoveryAttempts >= MAX_RECOVERIES ? 'blocked' : state.status };
  if (action.type === 'snapshot') {
    const snapshot = parseSessionSnapshot(action.snapshot);
    if (snapshot.session !== state.session) throw new Error('Snapshot session mismatch');
    if (state.snapshot && snapshot.revision < state.snapshot.revision) return reduceSession(state, { type: 'resync', cause: 'stale_snapshot' });
    let next: SessionState = { ...state, snapshot, status: 'live', buffered: [], bufferedBytes: 0 };
    for (const update of state.buffered) next = reduceSession(next, { type: 'update', update });
    // A snapshot requested before discarded updates cannot certify their cutover, especially unrevisioned text.
    if ((action.bufferGeneration ?? 0) !== next.bufferGeneration || next.snapshot!.revision < next.discardedRevision) return reduceSession(next, { type: 'resync', cause: 'stale_snapshot' });
    return next;
  }
  if (action.update.session !== state.session || state.status === 'blocked' || state.status === 'disconnected') return state;
  if (!state.snapshot || state.status !== 'live') return buffer(state, action.update);
  return 'rev' in action.update ? applyEvent(state, action.update) : applyStream(state, action.update);
}
