import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import { SessionsServiceError, type HostSessionsSelector, type SessionRef, type SessionsHistory, type SessionsService } from '@felan-ai/agent-core';
import { createSessionHistoryBackend, type SessionHistorySource } from '../session-history.js';
import type { ControlSessionMetadata } from './control-state.js';
import { guardOwnedPaths } from './persistence.js';
import type { SessionRegistry } from './registry.js';
import { createSessionExecutions, type SessionExecutionOperations } from './session-executions.js';

const titleRecord = 'sessions.set-title-outcome';
const executionPorts = new WeakMap<SessionRegistry, Map<string, SessionExecutionOperations>>();

export function registrySessionExecutions(registry: SessionRegistry, sessionId: string): SessionExecutionOperations {
  registry.assertDispatch(sessionId);
  return sessionExecutions(registry, sessionId);
}

function sessionExecutions(registry: SessionRegistry, sessionId: string): SessionExecutionOperations {
  let ports = executionPorts.get(registry);
  if (!ports) { ports = new Map(); executionPorts.set(registry, ports); }
  let operations = ports.get(sessionId);
  if (!operations) {
    const row = registry.options.store.sessionMetadata(sessionId);
    operations = createSessionExecutions(registry.executionHost(sessionId), { id: sessionId, root: row.root, ...(row.parent ? { parent: row.parent } : {}) });
    ports.set(sessionId, operations);
  }
  return operations;
}

export function createRegistrySessionsService(registry: SessionRegistry, current: SessionRef, project: string): SessionsService {
  const identity = Object.freeze({ ...current });
  const assertCurrent = () => {
    registry.assertServiceAccess(identity.id);
    const stored = registry.options.store.sessionMetadata(identity.id);
    if (stored.root !== identity.root || stored.parent !== identity.parent) throw new SessionsServiceError('inaccessible');
  };
  const execution = () => {
    assertCurrent();
    return sessionExecutions(registry, identity.id);
  };
  const history = createRegistrySessionsHistory(registry, identity, project, assertCurrent);
  return Object.freeze({
    ...history,
    async setTitleIfMissing(title, requestId, options) {
      assertCurrent(); options?.signal?.throwIfAborted();
      if (typeof title !== 'string' || !title.trim() || Buffer.byteLength(title) > 4096
        || typeof requestId !== 'string' || !requestId || Buffer.byteLength(requestId) > 128) throw new SessionsServiceError('invalid');
      const session = registry.binding(identity.id)!.runtime.session;
      const manager = session.sessionManager;
      const previous = manager.getEntries().find(entry => entry.type === 'custom' && entry.customType === titleRecord
        && entry.data && typeof entry.data === 'object' && 'requestId' in entry.data && entry.data.requestId === requestId);
      if (previous?.type === 'custom') {
        const data = previous.data as { title: string; applied: boolean };
        if (data.title !== title) throw new SessionsServiceError('invalid');
        return data.applied;
      }
      const applied = !manager.getSessionName()?.trim();
      if (applied) session.setSessionName(title);
      manager.appendCustomEntry(titleRecord, { requestId, title, applied });
      registry.projection(identity.id).refresh();
      return applied;
    },
    create: (...args) => execution().create(...args),
    executions: (...args) => execution().executions(...args),
    execution: (...args) => execution().execution(...args),
    steer: (...args) => execution().steer(...args),
    cancel: (...args) => execution().cancel(...args),
    subscribe(listener) {
      const stopExecutions = execution().subscribe(listener);
      const stopHistory = registry.subscribe(identity.id, () => listener({ kind: 'history', id: identity.id }));
      return () => { stopExecutions(); stopHistory(); };
    },
  } satisfies SessionsService);
}

export function createHostSessionsHistory(registry: SessionRegistry, selector: HostSessionsSelector,
  assertAccess = () => registry.assertAdmission()): SessionsHistory {
  if (!selector || selector.kind !== 'all' && (selector.kind !== 'project' || typeof selector.cwd !== 'string')) throw new SessionsServiceError('invalid');
  const selection = Object.freeze({ ...selector });
  const id = `host-${randomUUID()}`;
  const history = createRegistrySessionsHistory(registry, { id, root: id }, selection.kind === 'project' ? selection.cwd : '',
    assertAccess, selection);
  return Object.freeze({
    ...history,
    list: (filter, options) => history.list(filter && ['root', 'project', 'visible'].includes(filter.scope) ? { scope: 'visible' } : filter, options),
  } satisfies SessionsHistory);
}

function createRegistrySessionsHistory(registry: SessionRegistry, current: SessionRef, project: string, assertAccess: () => void,
  selector?: HostSessionsSelector): SessionsHistory {
  const assertHistoryAccess = () => {
    try { assertAccess(); }
    catch (error) {
      if (error instanceof SessionsServiceError) throw error;
      throw new SessionsServiceError('unavailable');
    }
  };
  const visible = (stored: ControlSessionMetadata) => selector?.kind !== 'project' || stored.cwd === selector.cwd;
  const sourceOf = async (stored: ControlSessionMetadata, signal?: AbortSignal): Promise<SessionHistorySource> => {
    signal?.throwIfAborted();
    let bytes: number | undefined;
    let diagnostic: 'inaccessible' | 'oversize' | undefined;
    let updatedAt = stored.updatedAt;
    try {
      const info = await stat(registry.options.owner.assertOwnsPath(stored.piPath));
      if (!info.isFile()) diagnostic = 'inaccessible';
      else {
        bytes = info.size; updatedAt = Math.max(updatedAt, Math.floor(info.mtimeMs));
        if (bytes > 64 * 1024 * 1024) diagnostic = 'oversize';
      }
    } catch { diagnostic = 'inaccessible'; }
    return { key: stored.piPath, sessionId: stored.id, id: stored.id, root: stored.root,
      ...(stored.parent ? { parent: stored.parent } : {}), cwd: stored.cwd, title: stored.title,
      updatedAt, state: stored.state,
      // Only this daemon appends to transcripts, and only while the session is loaded.
      ...(registry.binding(stored.id) !== undefined ? { growing: true } : {}),
      ...(bytes === undefined ? {} : { bytes }), ...(diagnostic ? { diagnostic } : {}) };
  };
  return createSessionHistoryBackend({
    current,
    project,
    // The backend calls this before each inventory, so it owns the access check.
    generation: () => {
      assertHistoryAccess();
      return JSON.stringify(registry.listed().filter(visible).map(stored => [stored.id, stored.revision, stored.piPath, registry.binding(stored.id) !== undefined]));
    },
    inventory: async ({ signal }) => {
      signal?.throwIfAborted();
      return mapConcurrent(registry.listed().filter(visible), stored => sourceOf(stored, signal));
    },
    // A single lookup avoids cloning every listed row; the filters mirror `registry.listed()`.
    refresh: async ({ key, sessionId }, { signal }) => {
      assertHistoryAccess(); signal?.throwIfAborted();
      let stored: ControlSessionMetadata;
      try { stored = registry.options.store.sessionMetadata(sessionId); } catch { return undefined; }
      return stored.deletedAt === undefined && !stored.draft && stored.piPath === key && visible(stored)
        ? sourceOf(stored, signal) : undefined;
    },
    read: async (source, { maxBytes, signal }) => {
      assertHistoryAccess(); signal?.throwIfAborted();
      const path = registry.options.owner.assertOwnsPath(source.key);
      const check = guardOwnedPaths(registry.options.owner, [path]);
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const before = await file.stat({ bigint: true });
        if (!before.isFile() || before.nlink !== 1n || before.uid !== BigInt(registry.options.owner.target.uid)) throw new SessionsServiceError('inaccessible');
        if (before.size > BigInt(maxBytes)) throw new SessionsServiceError('oversize');
        const buffer = Buffer.alloc(Number(before.size) + 1);
        let offset = 0;
        while (offset < buffer.length) {
          signal?.throwIfAborted();
          const { bytesRead } = await file.read(buffer, offset, Math.min(65_536, buffer.length - offset), offset);
          if (!bytesRead) break;
          offset += bytesRead;
        }
        const after = await file.stat({ bigint: true });
        if (offset !== Number(before.size) || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
          || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) throw new SessionsServiceError('stale');
        check(); assertHistoryAccess(); signal?.throwIfAborted();
        return buffer.subarray(0, offset);
      } finally { await file.close(); }
    },
  });
}

async function mapConcurrent<T, R>(items: readonly T[], work: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => { while (next < items.length) { const index = next++; results[index] = await work(items[index]!); } };
  await Promise.all(Array.from({ length: Math.min(availableParallelism(), items.length) }, worker));
  return results;
}
