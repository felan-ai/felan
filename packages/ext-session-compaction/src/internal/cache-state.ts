import type { Model, SessionEntry } from '@felan-ai/agent-core';

export interface PromptCacheState {
  readonly cached: boolean;
  readonly refreshedAt?: number;
  readonly lifetimeMs?: number;
  readonly lifetimeSource?: 'declared' | 'reported';
  readonly expiresAt?: number;
}

export function promptCacheState(model: Model<any> | undefined, entries: readonly SessionEntry[]): PromptCacheState {
  let refreshedAt: number | undefined;
  let reported: 'short' | 'long' | undefined;

  for (const value of entries) {
    const entry: unknown = value;
    if (!isRecord(entry)) continue;
    if (entry.type === 'compaction') {
      refreshedAt = undefined;
      reported = undefined;
    } else if (entry.type === 'message' && isRecord(entry.message) && entry.message.role === 'assistant') {
      const message = entry.message;
      if (!isRecord(message.usage) || typeof message.stopReason !== 'string' || !isFiniteNumber(message.timestamp)) continue;
      const { cacheRead, cacheWrite, cacheWrite1h } = message.usage;
      if (!isNonnegativeNumber(cacheRead) || !isNonnegativeNumber(cacheWrite)
        || (cacheWrite1h !== undefined && !isNonnegativeNumber(cacheWrite1h))) continue;
      if (cacheWrite > 0 && cacheWrite1h !== undefined) reported = cacheWrite1h > 0 ? 'long' : 'short';
      if (message.stopReason === 'error' || message.stopReason === 'aborted') continue;
      refreshedAt = cacheRead + cacheWrite > 0 ? message.timestamp : undefined;
    } else if (entry.type === 'usage' && entry.kind === 'cache_warm' && refreshedAt !== undefined
      && typeof entry.timestamp === 'string') {
      const timestamp = Date.parse(entry.timestamp);
      if (Number.isFinite(timestamp)) refreshedAt = Math.max(refreshedAt, timestamp);
    }
  }

  const declared = model?.promptCache?.[reported ?? 'short'];
  let lifetime: Pick<PromptCacheState, 'lifetimeMs' | 'lifetimeSource'> = {};
  if (isNonnegativeNumber(declared) && Number.isFinite(declared * 1_000)) {
    lifetime = { lifetimeMs: declared * 1_000, lifetimeSource: 'declared' };
  } else if (reported !== undefined) {
    lifetime = { lifetimeMs: reported === 'long' ? 3_600_000 : 300_000, lifetimeSource: 'reported' };
  }

  return {
    cached: refreshedAt !== undefined,
    ...(refreshedAt === undefined ? {} : { refreshedAt }),
    ...lifetime,
    ...(refreshedAt !== undefined && lifetime.lifetimeMs !== undefined
      ? { expiresAt: refreshedAt + lifetime.lifetimeMs }
      : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNonnegativeNumber(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0;
}
