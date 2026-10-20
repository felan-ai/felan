import { createRequire } from 'node:module';
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join, resolve } from 'node:path';

export const ROOT = fileURLToPath(new URL('../', import.meta.url));
export const HERE = fileURLToPath(new URL('./', import.meta.url));
export const now = () => performance.timeOrigin + performance.now();
export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export const built = path => import(pathToFileURL(join(ROOT, path)).href);
export class Skip extends Error {}
export const skip = message => { throw new Skip(message); };
export function isolatedRuntime() {
  const runtime = process.env.PROBE_RUNTIME;
  if (!runtime || !/^\/tmp\/fpb-[^/]+\/rt$/.test(runtime) || process.env.HOME !== resolve(runtime, '..')) {
    throw new Error('Use node perf/run.mjs; a fresh isolated runtime is required.');
  }
  return runtime;
}
export async function dependency(specifier) {
  // Resolve from declared consumers, not pnpm's versioned store layout.
  const queue = ['packages/session-protocol', 'apps/daemon', 'apps/felan', 'packages/agent-core', '.'].map(base => join(ROOT, base, 'package.json'));
  const visited = new Set();
  while (queue.length && visited.size < 1000) {
    const manifest = queue.shift();
    if (visited.has(manifest)) continue;
    visited.add(manifest);
    const require = createRequire(manifest);
    try { return await import(require.resolve(specifier)); } catch (error) {
      if (!['MODULE_NOT_FOUND', 'ERR_MODULE_NOT_FOUND', 'ERR_PACKAGE_PATH_NOT_EXPORTED'].includes(error.code)) throw error;
    }
    const pkg = JSON.parse(readFileSync(manifest, 'utf8'));
    for (const name of Object.keys(pkg.dependencies || {})) {
      for (const base of require.resolve.paths(name) || []) {
        try { queue.push(realpathSync(join(base, name, 'package.json'))); break; } catch {}
      }
    }
  }
  skip(`Optional dependency ${specifier} unavailable; run pnpm install.`);
}
export function quantiles(values) {
  if (!values.length || values.some(v => !Number.isFinite(v))) throw new Error('No finite measurement samples');
  const sorted = [...values].sort((a, b) => a - b);
  const at = p => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
  return { n: sorted.length, p50: at(0.5), p90: at(0.9), p99: at(0.99), max: sorted.at(-1) };
}
export function context(quick, results) {
  return {
    quick,
    async case(name, fn) {
      try { await fn(); } catch (error) {
        const status = error instanceof Skip || ['ERR_MODULE_NOT_FOUND', 'MODULE_NOT_FOUND'].includes(error.code) ? 'skip' : 'fail';
        results.push({ name, status, reason: error.message });
      }
    },
    value(name, value, unit = 'ms', details = {}) {
      if (!Number.isFinite(value)) throw new Error(`${name}: nonfinite measurement`);
      results.push({ name, status: 'ok', value, unit, ...details });
    },
    samples(name, values, unit = 'ms', details = {}) {
      const distribution = quantiles(values);
      results.push({ name, status: 'ok', value: distribution.p50, unit, ...details, ...distribution });
    },
    bench(name, fn, options = {}) {
      const { iterations, minMs = quick ? 40 : 300 } = options;
      for (let i = 0; i < 3; i++) fn(i);
      let n = 0;
      const start = performance.now();
      do { fn(n++); } while (iterations ? n < iterations : performance.now() - start < minMs);
      const elapsed = performance.now() - start;
      results.push({ name, status: 'ok', value: elapsed / n, unit: 'ms', n, elapsed });
    },
  };
}
