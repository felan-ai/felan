import { SESSION_HISTORY_LIMITS, type SessionEntry, type SessionsHistory } from '@felan-ai/agent-core';
import { digestActiveBranch, removeMemoryContextEntries } from './checkpoint.js';
import type { SessionCheckpoint } from './contracts.js';
import {
  materializeMemoryInputDelta,
  type MemoryInputMaterializationResult,
} from './input-materializer.js';

/**
 * Builds the checkpoint a live session would record: the same active-branch digest as
 * createSessionCheckpoint, computed from the complete history at one pinned revision.
 */
export async function readMemorySessionCheckpoint(
  sessions: Pick<SessionsHistory, 'history'>,
  sessionId: string,
  signal?: AbortSignal,
): Promise<SessionCheckpoint> {
  const first = await sessions.history(sessionId, { limit: SESSION_HISTORY_LIMITS.pageEntries, ...(signal ? { signal } : {}) });
  const at = { sessionId: first.sessionId, revision: first.revision, branch: first.branch };
  const entries: SessionEntry[] = [...first.entries];
  const cursors = new Set<string>();
  let cursor = first.nextCursor;
  while (cursor !== undefined) {
    signal?.throwIfAborted();
    if (typeof cursor !== 'string' || cursor.length === 0 || cursors.has(cursor)) throw new Error('Memory history cursor is invalid');
    cursors.add(cursor);
    const page = await sessions.history(sessionId, { at, cursor, limit: SESSION_HISTORY_LIMITS.pageEntries, ...(signal ? { signal } : {}) });
    if (page.sessionId !== at.sessionId || page.revision !== at.revision || page.branch !== at.branch) {
      throw new Error('Memory history revision changed');
    }
    entries.push(...page.entries);
    cursor = page.nextCursor;
  }
  const byId = new Map(entries.map(entry => [entry.id, entry]));
  const branch: SessionEntry[] = [];
  for (let id = first.branch; id !== null; ) {
    const entry = byId.get(id);
    if (!entry) throw new Error('Memory history branch is incomplete');
    branch.push(entry);
    id = entry.parentId;
  }
  branch.reverse();
  return { sessionId, sessionFile: sessionId, leafId: first.branch, transcriptDigest: digestActiveBranch(removeMemoryContextEntries(branch)) };
}

export interface MaterializeMemorySessionCheckpointOptions {
  readonly sessions: Pick<SessionsHistory, 'checkpoint' | 'history'>;
  readonly checkpoint: SessionCheckpoint;
  readonly previousCheckpoint?: SessionCheckpoint;
  readonly maxOutputBytes?: number;
  readonly signal?: AbortSignal;
}

/** The provider must resolve legacy session IDs to their original journals; paths remain unchanged. */
export function materializeMemorySessionCheckpoint(
  options: MaterializeMemorySessionCheckpointOptions,
): Promise<MemoryInputMaterializationResult> {
  const checkpoint = { ...options.checkpoint };
  const previousCheckpoint = options.previousCheckpoint === undefined ? undefined : { ...options.previousCheckpoint };
  let pin: ReturnType<SessionsHistory['checkpoint']> | undefined;
  return materializeMemoryInputDelta({
    checkpoint,
    ...(previousCheckpoint === undefined ? {} : { previousCheckpoint }),
    ...(options.maxOutputBytes === undefined ? {} : { maxOutputBytes: options.maxOutputBytes }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    lines: async function* () {
      pin ??= options.sessions.checkpoint(checkpoint.sessionId, {
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      const snapshot = await pin;
      if (snapshot.sessionId !== checkpoint.sessionId
        || typeof snapshot.revision !== 'string' || snapshot.revision.length === 0
        || snapshot.branch !== null && (typeof snapshot.branch !== 'string' || snapshot.branch.length === 0)) {
        throw new Error('Memory history checkpoint is unavailable');
      }
      yield JSON.stringify({ type: 'session', id: snapshot.sessionId });
      const cursors = new Set<string>();
      let foundCurrentLeaf = snapshot.branch === null;
      let cursor: string | undefined;
      do {
        options.signal?.throwIfAborted();
        const page = await options.sessions.history(snapshot.sessionId, {
          at: { sessionId: snapshot.sessionId, revision: snapshot.revision, branch: snapshot.branch },
          limit: 256,
          ...(cursor === undefined ? {} : { cursor }),
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        });
        if (page.sessionId !== snapshot.sessionId || page.revision !== snapshot.revision || page.branch !== snapshot.branch || !Array.isArray(page.entries)) {
          throw new Error('Memory history revision changed');
        }
        for (const entry of page.entries) {
          if (entry.id === snapshot.branch) foundCurrentLeaf = true;
          yield JSON.stringify(entry);
        }
        cursor = page.nextCursor;
        if (cursor !== undefined) {
          if (typeof cursor !== 'string' || cursor.length === 0 || cursors.has(cursor)) {
            throw new Error('Memory history cursor is invalid');
          }
          cursors.add(cursor);
        }
      } while (cursor !== undefined);
      if (!foundCurrentLeaf) throw new Error('Memory history is incomplete');
    },
  });
}
