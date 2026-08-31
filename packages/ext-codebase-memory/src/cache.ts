import { createHash } from 'node:crypto';
import type { AgentRuntime } from '@felan-ai/agent-core';

const HOST_MAX_CACHE_BYTES = 2 * 1024 * 1024 * 1024;
const CLOUD_MAX_CACHE_BYTES = 500 * 1024 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const MAX_MANIFEST_BYTES = 1024 * 1024;
const cacheControls = new Map<string, Promise<void>>();

export type CodebaseMemoryTelemetry = (event: string, fields: Record<string, unknown>) => void;

interface CacheEntry { project: string; bytes: number; lastAccessedAt: number }
interface CacheManifest { version: 1; entries: CacheEntry[] }

export class CacheManager {
  readonly maxBytes: number;

  constructor(
    private readonly runtime: AgentRuntime,
    maxBytes = runtime.kind === 'host' ? HOST_MAX_CACHE_BYTES : CLOUD_MAX_CACHE_BYTES,
    private readonly telemetry: CodebaseMemoryTelemetry = () => {},
    private readonly onEvict: (project: string) => Promise<void> = async () => {},
    private readonly measureBytes?: () => Promise<number>,
  ) {
    this.maxBytes = maxBytes;
  }

  record(project: string, bytes: number, lastAccessedAt = Date.now()): Promise<void> {
    return this.#run(async () => {
      const manifest = await this.#readManifest();
      const entries = manifest.entries.filter((entry) => entry.project !== project);
      entries.push({ project, bytes: Math.max(0, bytes), lastAccessedAt });
      entries.sort((left, right) => left.lastAccessedAt - right.lastAccessedAt);
      let total = this.measureBytes
        ? await this.measureBytes()
        : entries.reduce((sum, entry) => sum + entry.bytes, 0);
      while (total > this.maxBytes && entries.length > 0) {
        const evicted = entries.shift();
        if (!evicted) break;
        await this.onEvict(evicted.project);
        await this.runtime.storage('agent').remove(
          `codebase-memory/cache/${projectStorageKey(evicted.project)}`,
          { recursive: true },
        ).catch(() => {});
        total = this.measureBytes ? await this.measureBytes() : total - evicted.bytes;
        this.telemetry('cache_eviction', {
          projectKey: projectStorageKey(evicted.project),
          bytes: evicted.bytes,
          maxBytes: this.maxBytes,
        });
      }
      await this.runtime.storage('agent').mkdir('codebase-memory', { recursive: true });
      if (entries.some((entry) => entry.project === project)) {
        const storageKey = projectStorageKey(project);
        await this.runtime.storage('agent').mkdir(`codebase-memory/cache/${storageKey}`, { recursive: true });
        await this.runtime.storage('agent').writeFile(
          `codebase-memory/cache/${storageKey}/.felan-lru`,
          encoder.encode(String(lastAccessedAt)),
        );
      }
      await this.runtime.storage('agent').writeFile('codebase-memory/lru.json', encoder.encode(JSON.stringify({ version: 1, entries })));
      this.telemetry('cache_size', { bytes: total, maxBytes: this.maxBytes, projects: entries.length });
    });
  }

  async #readManifest(): Promise<CacheManifest> {
    try {
      const parsed = JSON.parse(decoder.decode(await this.runtime.storage('agent').readFile(
        'codebase-memory/lru.json',
        { maxBytes: MAX_MANIFEST_BYTES },
      ))) as Record<string, unknown>;
      if (parsed.version !== 1 || !Array.isArray(parsed.entries)) return { version: 1, entries: [] };
      const entries = parsed.entries.filter((value): value is CacheEntry => {
        if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
        const entry = value as Record<string, unknown>;
        return typeof entry.project === 'string'
          && entry.project.length > 0
          && typeof entry.bytes === 'number'
          && Number.isSafeInteger(entry.bytes)
          && entry.bytes >= 0
          && typeof entry.lastAccessedAt === 'number'
          && Number.isSafeInteger(entry.lastAccessedAt)
          && entry.lastAccessedAt >= 0;
      });
      return { version: 1, entries };
    } catch {
      return { version: 1, entries: [] };
    }
  }

  async #run(operation: () => Promise<void>): Promise<void> {
    const key = this.runtime.storage('agent').root;
    const previous = cacheControls.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    cacheControls.set(key, current);
    await previous;
    try {
      await operation();
    } finally {
      release();
      if (cacheControls.get(key) === current) cacheControls.delete(key);
    }
  }
}

function projectStorageKey(project: string): string {
  return createHash('sha256').update(project).digest('hex');
}
