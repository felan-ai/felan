export const DEFAULT_QUERY_TIMEOUT_MS = 60_000;
export const DEFAULT_INDEX_TIMEOUT_MS = 20 * 60_000;
export const MAX_OUTPUT_BYTES = 5 * 1024 * 1024;

export function queryTimeoutMs(value: unknown): number {
  return boundedTimeout(value, DEFAULT_QUERY_TIMEOUT_MS, 10 * 60_000);
}

export function indexTimeoutMs(value: unknown): number {
  return boundedTimeout(value, DEFAULT_INDEX_TIMEOUT_MS, DEFAULT_INDEX_TIMEOUT_MS);
}

function boundedTimeout(value: unknown, fallback: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(1_000, Math.min(Math.floor(value), max));
}
