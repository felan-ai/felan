import { createHash, type Hash } from 'node:crypto';
import type { ExtensionContext } from '@felan-ai/agent-core';
import type { SessionCheckpoint } from './contracts.js';

export const MEMORY_CONTEXT_CUSTOM_TYPE = 'felan-memory-context';

type CheckpointSessionManager = Pick<
  ExtensionContext['sessionManager'],
  'getBranch' | 'getLeafId' | 'getSessionFile' | 'getSessionId'
>;

export function createSessionCheckpoint(
  sessionManager: CheckpointSessionManager,
): SessionCheckpoint | null {
  const sessionFile = sessionManager.getSessionFile();
  if (!sessionFile) return null;
  const leafId = sessionManager.getLeafId();
  const branch = removeMemoryContextEntries(sessionManager.getBranch(leafId ?? undefined));
  return {
    sessionId: sessionManager.getSessionId(),
    sessionFile,
    leafId,
    transcriptDigest: digestActiveBranch(branch),
  };
}

export function isMemoryContextEntry(value: unknown): boolean {
  return isRecord(value)
    && value.type === 'custom_message'
    && value.customType === MEMORY_CONTEXT_CUSTOM_TYPE;
}

export function removeMemoryContextEntries(
  entries: readonly unknown[],
): readonly Record<string, unknown>[] {
  const records = entries.filter(isRecord);
  const byId = new Map(
    records
      .filter((entry): entry is Record<string, unknown> & { id: string } => typeof entry.id === 'string')
      .map((entry) => [entry.id, entry]),
  );
  const memoryIds = new Set(
    records
      .filter((entry) => isMemoryContextEntry(entry) && typeof entry.id === 'string')
      .map((entry) => entry.id as string),
  );

  const resolveVisibleParent = (id: string): string | null => {
    let current: string | null = id;
    const seen = new Set<string>();
    while (current !== null && memoryIds.has(current)) {
      if (seen.has(current)) return null;
      seen.add(current);
      const parent: unknown = byId.get(current)?.parentId;
      current = typeof parent === 'string' ? parent : null;
    }
    return current;
  };

  return records
    .filter((entry) => !isMemoryContextEntry(entry))
    .map((entry) => {
      if (typeof entry.parentId !== 'string' || !memoryIds.has(entry.parentId)) return entry;
      return { ...entry, parentId: resolveVisibleParent(entry.parentId) };
    });
}

export function visibleMemoryContextLeafId(
  entries: readonly unknown[],
  leafId: string | null,
): string | null {
  if (leafId === null) return null;
  const byId = new Map(
    entries
      .filter(isRecord)
      .filter((entry): entry is Record<string, unknown> & { id: string } => typeof entry.id === 'string')
      .map((entry) => [entry.id, entry]),
  );
  let current: string | null = leafId;
  const seen = new Set<string>();
  while (current !== null && isMemoryContextEntry(byId.get(current))) {
    if (seen.has(current)) return null;
    seen.add(current);
    const parent: unknown = byId.get(current)?.parentId;
    current = typeof parent === 'string' ? parent : null;
  }
  return current;
}

export function digestActiveBranch(branch: readonly unknown[]): string {
  const digester = createActiveBranchDigester();
  for (const entry of branch) digester.update(entry);
  return digester.digest();
}

export interface ActiveBranchDigester {
  update(entry: unknown): void;
  digest(): string;
}

export function createActiveBranchDigester(): ActiveBranchDigester {
  const hash = createHash('sha256');
  let entries = 0;
  let finalized = false;
  hash.update('[');
  return {
    update(entry) {
      if (finalized) throw new Error('Active branch digest is already finalized');
      if (entries > 0) hash.update(',');
      updateCanonicalJson(hash, entry);
      entries += 1;
    },
    digest() {
      if (finalized) throw new Error('Active branch digest is already finalized');
      finalized = true;
      hash.update(']');
      return hash.digest('hex');
    },
  };
}

function updateCanonicalJson(hash: Hash, value: unknown): void {
  if (value === null || typeof value !== 'object') {
    hash.update(JSON.stringify(value) ?? 'null');
    return;
  }
  if (Array.isArray(value)) {
    hash.update('[');
    for (const [index, entry] of value.entries()) {
      if (index > 0) hash.update(',');
      updateCanonicalJson(hash, entry);
    }
    hash.update(']');
    return;
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  hash.update('{');
  for (const [index, [key, entry]] of entries.entries()) {
    if (index > 0) hash.update(',');
    hash.update(JSON.stringify(key));
    hash.update(':');
    updateCanonicalJson(hash, entry);
  }
  hash.update('}');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
