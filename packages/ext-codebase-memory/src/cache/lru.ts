import type { AgentRuntime } from '@felan-ai/agent-core';
import type { CbmClient } from '../cbm/client.js';
import type { CbmProject } from '../domain/project.js';
import { isRuntimePathUnderRoot, joinRuntimePath } from '../runtime-path.js';

export interface CacheTelemetry { readonly event: 'cache_size' | 'cache_eviction'; readonly [key: string]: unknown }

export function resolveCacheCap(kind: AgentRuntime['kind'], override: number | undefined): number {
  return override ?? (kind === 'host' ? 2_000_000_000 : 500_000_000);
}

export async function enforceCacheLimit(
  runtime: AgentRuntime,
  cbm: CbmClient,
  projects: readonly CbmProject[],
  cap: number,
  telemetry: (event: CacheTelemetry) => void = () => {},
): Promise<{ readonly sizeBytes: number | undefined; readonly evicted: readonly string[] }> {
  const storage = runtime.storage('agent');
  const cacheRoot = joinRuntimePath(storage.root, 'codebase-memory');
  if (storage.root === '/' || storage.root === '\\' || !isRuntimePathUnderRoot(cacheRoot, storage.root, runtime.cwd)) {
    throw new Error('Codebase Memory cache is not contained by the asserted agent storage root');
  }
  let sizeBytes = await measureCache(runtime, cacheRoot, cap, telemetry);
  if (sizeBytes === undefined) return { sizeBytes, evicted: [] };
  const evicted: string[] = [];
  const candidates = [...projects].sort((a, b) => accessTime(a) - accessTime(b));
  for (const project of candidates) {
    if (sizeBytes <= cap) break;
    const deletion = await cbm.callTool('delete_project', { project: project.name }, { allowError: true });
    if (!deletion.ok) break;
    evicted.push(project.name);
    telemetry({ event: 'cache_eviction', project: project.name, cap });
    const measured = await measureCache(runtime, cacheRoot, cap, telemetry);
    if (measured === undefined) return { sizeBytes: undefined, evicted };
    sizeBytes = measured;
  }
  return { sizeBytes, evicted };
}

async function measureCache(
  runtime: AgentRuntime,
  cacheRoot: string,
  cap: number,
  telemetry: (event: CacheTelemetry) => void,
): Promise<number | undefined> {
  try {
    const result = await runtime.exec('du', ['-sk', cacheRoot], {
      cwd: runtime.storage('agent').root,
      timeout: 10_000,
      maxOutputBytes: 64 * 1024,
    });
    const kibibytes = /^(\d+)\s/u.exec(result.stdout.trim())?.[1];
    if (result.code !== 0 || result.killed || result.truncated || kibibytes === undefined) {
      telemetry({ event: 'cache_size', measured: false, cap });
      return undefined;
    }
    const sizeBytes = Number(kibibytes) * 1024;
    if (!Number.isSafeInteger(sizeBytes)) {
      telemetry({ event: 'cache_size', measured: false, cap });
      return undefined;
    }
    telemetry({ event: 'cache_size', measured: true, sizeBytes, cap });
    return sizeBytes;
  } catch {
    telemetry({ event: 'cache_size', measured: false, cap });
    return undefined;
  }
}

function accessTime(project: CbmProject): number {
  if (typeof project.last_accessed === 'number') return project.last_accessed;
  if (typeof project.last_accessed === 'string') return Date.parse(project.last_accessed) || 0;
  return 0;
}
