import { describe, expect, it, vi } from 'vitest';
import { CacheManager } from '../src/cache.js';
import { CODEBASE_MEMORY_CONFIG } from '../src/config.js';
import { MemoryRuntime } from './test-runtime.js';

describe('Codebase Memory cache limits', () => {
  it('uses a numeric configuration sentinel without replacing per-runtime defaults', () => {
    expect(CODEBASE_MEMORY_CONFIG.fields.maxCacheBytes.default).toBe(0);
    expect(CODEBASE_MEMORY_CONFIG.fields.maxCacheBytes.validate?.(0)).toBeUndefined();
    expect(CODEBASE_MEMORY_CONFIG.fields.maxCacheBytes.validate?.(64 * 1024 * 1024)).toBeUndefined();
    expect(CODEBASE_MEMORY_CONFIG.fields.maxCacheBytes.validate?.(-1)).toBeTruthy();
  });

  it.each([
    ['host', 2 * 1024 * 1024 * 1024],
    ['docker', 500 * 1024 * 1024],
    ['daytona', 500 * 1024 * 1024],
  ] as const)('uses the runtime-kind default for %s', (kind, expected) => {
    expect(new CacheManager(new MemoryRuntime(kind)).maxBytes).toBe(expected);
  });

  it('evicts least-recently-used project caches and emits size/eviction telemetry', async () => {
    const runtime = new MemoryRuntime();
    const telemetry = vi.fn();
    const cache = new CacheManager(runtime, 9, telemetry);
    await cache.record('old', 6, 1);
    await cache.record('new', 6, 2);

    const manifest = JSON.parse(new TextDecoder().decode(runtime.files.get('codebase-memory/lru.json'))) as {
      entries: Array<{ project: string }>;
    };
    expect(manifest.entries).toEqual([expect.objectContaining({ project: 'new' })]);
    expect([...runtime.files.keys()].filter((path) => path.endsWith('/.felan-lru'))).toHaveLength(1);
    expect(telemetry).toHaveBeenCalledWith('cache_eviction', expect.objectContaining({
      projectKey: expect.stringMatching(/^[a-f0-9]{64}$/u),
    }));
    expect(telemetry).toHaveBeenCalledWith('cache_size', expect.objectContaining({ bytes: 6, maxBytes: 9 }));
  });

  it('enforces the cap when a single project is larger than the configured cache', async () => {
    const runtime = new MemoryRuntime();
    const onEvict = vi.fn(async () => {});
    const cache = new CacheManager(runtime, 5, undefined, onEvict);

    await cache.record('oversized', 6, 1);

    const manifest = JSON.parse(new TextDecoder().decode(runtime.files.get('codebase-memory/lru.json'))) as {
      entries: Array<{ project: string }>;
    };
    expect(manifest.entries).toEqual([]);
    expect(onEvict).toHaveBeenCalledWith('oversized');
  });

  it('remeasures the global cache after each LRU eviction without double-counting projects', async () => {
    const runtime = new MemoryRuntime();
    const onEvict = vi.fn(async () => {});
    const measureBytes = vi.fn()
      .mockResolvedValueOnce(6)
      .mockResolvedValueOnce(12)
      .mockResolvedValueOnce(6);
    const cache = new CacheManager(runtime, 9, undefined, onEvict, measureBytes);

    await cache.record('old', 0, 1);
    await cache.record('new', 0, 2);

    expect(onEvict).toHaveBeenCalledWith('old');
    expect(measureBytes).toHaveBeenCalledTimes(3);
  });

  it('never uses an upstream project name as a storage path', async () => {
    const runtime = new MemoryRuntime();
    const cache = new CacheManager(runtime, 100);

    await cache.record('../outside/project', 1);

    expect([...runtime.files.keys()]).not.toContainEqual(expect.stringContaining('../outside'));
    expect([...runtime.files.keys()]).toContainEqual(expect.stringMatching(/^codebase-memory\/cache\/[a-f0-9]{64}\/\.felan-lru$/u));
  });

  it('ignores malformed manifest entries at the storage boundary', async () => {
    const runtime = new MemoryRuntime();
    runtime.files.set('codebase-memory/lru.json', new TextEncoder().encode(JSON.stringify({
      version: 1,
      entries: [{ project: '../bad', bytes: 'many', lastAccessedAt: null }],
    })));

    await new CacheManager(runtime, 100).record('safe', 1, 1);

    const manifest = JSON.parse(new TextDecoder().decode(runtime.files.get('codebase-memory/lru.json'))) as {
      entries: Array<{ project: string }>;
    };
    expect(manifest.entries.map(({ project }) => project)).toEqual(['safe']);
  });
});
