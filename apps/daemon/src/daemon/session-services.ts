import { constants } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { SessionsServiceError, type SessionRef, type SessionsService } from '@felan-ai/agent-core';
import { createSessionHistoryBackend, type SessionHistorySource } from '../session-history.js';
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
  const history = createSessionHistoryBackend({
    current: identity,
    project,
    inventory: async ({ signal }) => {
      assertCurrent(); signal?.throwIfAborted();
      const rows: SessionHistorySource[] = [];
      for (const stored of registry.listed()) {
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
        rows.push({ key: stored.piPath, sessionId: stored.id, id: stored.id, root: stored.root,
          ...(stored.parent ? { parent: stored.parent } : {}), cwd: stored.cwd, title: stored.title,
          updatedAt, state: stored.state,
          ...(bytes === undefined ? {} : { bytes }), ...(diagnostic ? { diagnostic } : {}) });
      }
      return rows;
    },
    read: async (source, { maxBytes, signal }) => {
      assertCurrent(); signal?.throwIfAborted();
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
        check(); assertCurrent(); signal?.throwIfAborted();
        return buffer.subarray(0, offset);
      } finally { await file.close(); }
    },
  });
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
