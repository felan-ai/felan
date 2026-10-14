import type { GitDetails } from './git.js';
import type { RateWindow, SubscriptionProviderName, UsageErrorCode } from './subscription.js';
import type { SavingsUsageHostResult } from './savings.js';

export interface SessionUsageTotals { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number }
export interface SegmentValues {
  directory: { cwd: string };
  git: Omit<GitDetails, 'refreshedAt'>;
  model: { id: string; provider: string; reasoning: boolean; thinkingLevel?: string; providerCount: number };
  session: SessionUsageTotals;
  subscription: { loading: boolean; provider?: SubscriptionProviderName; windows: RateWindow[]; error?: { code: UsageErrorCode; httpStatus?: number } };
  savings: { loading: boolean; periodDays: number; result?: SavingsUsageHostResult };
  context: { tokens: number | null; percent: number | null; contextWindow: number };
  version: { version: string };
}
export type SegmentName = keyof SegmentValues;
export type ThemeColorKey = SegmentName | 'status' | 'warning' | 'critical' | 'muted' | 'extensionStatus1' | 'extensionStatus2' | 'extensionStatus3' | 'extensionStatus4';
export type PowerlineSegment = { [K in SegmentName]: { name: K; colorKey: ThemeColorKey; values: SegmentValues[K] } }[SegmentName];
export interface PowerlineData { segments: PowerlineSegment[] }

type Check = (value: unknown) => boolean;
const text: Check = value => typeof value === 'string' && new TextEncoder().encode(value).length <= 8192 && !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
const number: Check = value => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER;
const count: Check = value => number(value) && Number.isSafeInteger(value) && Number(value) >= 0;
const bool: Check = value => typeof value === 'boolean';
const optional = (check: Check): Check => value => value === undefined || check(value);
const nullable = (check: Check): Check => value => value === null || check(value);
const choice = (...values: string[]): Check => value => typeof value === 'string' && values.includes(value);
function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function shape(fields: Record<string, Check>): Check {
  return value => record(value) && Object.keys(value).every(key => Object.hasOwn(fields, key)) && Object.entries(fields).every(([key, check]) => check(value[key]));
}
const schemas: Record<SegmentName, Check> = {
  directory: shape({ cwd: text }),
  git: shape({ branch: optional(text), sha: optional(text), dirty: optional(bool), changedFiles: optional(count), tag: optional(text), timeSinceCommit: optional(text),
    stashCount: optional(count), upstream: optional(shape({ name: optional(text), ahead: count, behind: count })), repoName: optional(text) }),
  model: shape({ id: text, provider: text, reasoning: bool, thinkingLevel: optional(text), providerCount: count }),
  session: shape({ input: count, output: count, cacheRead: count, cacheWrite: count, cost: number }),
  subscription: shape({ loading: bool, provider: optional(choice('openai', 'codex', 'anthropic', 'xai')),
    windows: value => Array.isArray(value) && value.length <= 8 && value.every(shape({ label: text, usedPercent: number, resetDescription: optional(text), resetAt: optional(text) })),
    error: optional(shape({ code: choice('NO_CREDENTIALS', 'COMPANION_UNAVAILABLE', 'FETCH_FAILED', 'HTTP_ERROR'), httpStatus: optional(count) })) }),
  savings: shape({ loading: bool, periodDays: count, result: optional(shape({ savedCostUsd: number, hasUnpricedMeasurements: bool })) }),
  context: shape({ tokens: nullable(count), percent: nullable(number), contextWindow: count }),
  version: shape({ version: text }),
};
const colors = [...Object.keys(schemas), 'status', 'warning', 'critical', 'muted', 'extensionStatus1', 'extensionStatus2', 'extensionStatus3', 'extensionStatus4'];
export function parsePowerlineData(value: unknown): PowerlineData {
  if (!record(value) || Object.keys(value).some(key => key !== 'segments') || !Array.isArray(value.segments) || value.segments.length > 8
    || new TextEncoder().encode(JSON.stringify(value)).length > 65536) throw new Error('Invalid powerline data.');
  const names = new Set<string>();
  for (const segment of value.segments) {
    if (!record(segment) || Object.keys(segment).some(key => !['name', 'colorKey', 'values'].includes(key))
      || typeof segment.name !== 'string' || !Object.hasOwn(schemas, segment.name) || names.has(segment.name)
      || new TextEncoder().encode(JSON.stringify(segment.values)).length > 8192 || !colors.includes(String(segment.colorKey)) || !schemas[segment.name as SegmentName](segment.values)) throw new Error('Invalid powerline segment.');
    names.add(segment.name);
  }
  return structuredClone(value) as unknown as PowerlineData;
}
