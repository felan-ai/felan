import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DaemonOwnership } from './ownership.js';
import type { LegacySummary } from './legacy-sessions.js';
import { assertPathIdentity, assertPrivateStat, pinPathAncestry } from './target.js';

type Owner = Pick<DaemonOwnership, 'target'> & Partial<Pick<DaemonOwnership, 'assertCurrent' | 'assertOwnsPath'>>;
interface Entry { key: string; version: string; id: string; summary: LegacySummary }
const MAX_ENTRIES = 2048;
const MAX_BYTES = 2 * 1024 * 1024;
const keyOf = (path: string): string => createHash('sha256').update(path).digest('hex');

/** Disposable, bounded hints; transcript headers and file versions remain authoritative. */
export class LegacySummaryCache {
  private readonly entries = new Map<string, Entry>();
  private loaded = false;
  private dirty = false;
  private readonly path: string;

  constructor(private readonly owner: Owner) {
    this.path = join(owner.target.agentDir, 'legacy-session-summaries.json');
  }

  get(path: string, version: string, id: string): LegacySummary | undefined {
    this.load();
    const entry = this.entries.get(keyOf(path));
    return entry?.version === version && entry.id === id ? entry.summary : undefined;
  }

  set(path: string, version: string, id: string, summary: LegacySummary): void {
    this.load();
    const key = keyOf(path);
    this.entries.delete(key);
    this.entries.set(key, { key, version, id, summary });
    if (this.entries.size > MAX_ENTRIES) this.entries.delete(this.entries.keys().next().value!);
    this.dirty = true;
  }

  /** One atomic write after a completed warm-up, never one rewrite per transcript. */
  save(signal: AbortSignal): void {
    signal.throwIfAborted();
    if (!this.dirty) return;
    let temporary: string | undefined;
    try {
      const check = this.guard();
      if (!check) return;
      const data = JSON.stringify({ format: 1, namespace: this.owner.target.namespaceId, agentDir: this.owner.target.agentDir, entries: [...this.entries.values()] });
      if (Buffer.byteLength(data) > MAX_BYTES) return;
      temporary = `${this.path}.${randomUUID()}.tmp`;
      check(); signal.throwIfAborted();
      const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { writeFileSync(fd, data); } finally { closeSync(fd); }
      check(); signal.throwIfAborted();
      renameSync(temporary, this.path);
      temporary = undefined;
      this.dirty = false;
    } catch { signal.throwIfAborted(); }
    finally {
      if (temporary) {
        try { const check = this.guard(); if (check) { check(); unlinkSync(temporary); } } catch { /* Ownership loss forbids cleanup writes too. */ }
      }
    }
  }

  private guard(): (() => void) | undefined {
    const { owner } = this;
    // Lightweight discovery-only callers have no authority to read or write persistent hints.
    if (!owner.assertCurrent || !owner.assertOwnsPath) return undefined;
    owner.assertCurrent();
    if (owner.assertOwnsPath(this.path) !== this.path) throw new Error('Redirected legacy summary cache');
    const pins = pinPathAncestry(owner.target.agentDir);
    return () => {
      owner.assertCurrent!();
      for (const pin of pins) assertPathIdentity(pin);
      if (owner.assertOwnsPath!(this.path) !== this.path) throw new Error('Redirected legacy summary cache');
    };
  }

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const check = this.guard();
      if (!check) return;
      const fd = openSync(this.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      let value: unknown;
      try {
        const info = fstatSync(fd, { bigint: true });
        assertPrivateStat(info, this.owner.target.uid, false);
        if (info.size > BigInt(MAX_BYTES)) return;
        const data = Buffer.alloc(Number(info.size) + 1);
        let length = 0;
        while (length < data.length) {
          const count = readSync(fd, data, length, data.length - length, length);
          if (!count) break;
          length += count;
        }
        check();
        if (length > MAX_BYTES) return;
        value = JSON.parse(data.toString('utf8', 0, length));
      } finally { closeSync(fd); }
      if (!value || typeof value !== 'object') return;
      const cache = value as Record<string, unknown>;
      if (cache.format !== 1 || cache.namespace !== this.owner.target.namespaceId || cache.agentDir !== this.owner.target.agentDir
        || !Array.isArray(cache.entries) || cache.entries.length > MAX_ENTRIES || !cache.entries.every(validEntry)) return;
      for (const entry of cache.entries) this.entries.set(entry.key, entry);
    } catch { /* A cache is optional; missing, foreign or malformed hints are rebuilt. */ }
  }
}

function validEntry(value: unknown): value is Entry {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Entry;
  return typeof entry.key === 'string' && /^[a-f0-9]{64}$/u.test(entry.key)
    && typeof entry.version === 'string' && entry.version.length <= 200 && /^[0-9.:]+$/u.test(entry.version)
    && typeof entry.id === 'string' && entry.id.length <= 128 && /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/u.test(entry.id)
    && !!entry.summary && validSnippet(entry.summary.title) && validSnippet(entry.summary.preview);
}

function validSnippet(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 240 && [...value].length <= 120 && !/[\p{Cc}\p{Cf}]/u.test(value);
}
