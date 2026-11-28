import type { AgentRuntimeStorage, InlineExtension, ModelRuntime } from '@felan-ai/agent-core';
import type { HostSubscriptions } from '@felan-ai/daemon/session-runtime';
import { createSubscriptionUsageStore, parseClaudeCodeUsageHeaders, parseUsageSnapshot, type RateWindow, type UsageSnapshot } from '@felan-ai/ext-powerline';
import type { SubscriptionUsage, SubscriptionUsageWindow } from '@felan-ai/session-protocol';
import { sharedSubscriptionUsage, type SubscriptionUsageCache } from './models-subscription.js';

/** Subscriptions whose usage the host fetches with a stored OAuth credential. */
const PLANS = [
  { provider: 'anthropic', modelProvider: 'anthropic' },
  { provider: 'codex', modelProvider: 'openai-codex' },
  { provider: 'xai', modelProvider: 'xai' },
] as const;
const CLAUDE_CODE_PROVIDER = 'claude-code';
const CLAUDE_CODE_USAGE_FILE = 'claude-code-usage.json';
const MAX_STORED_BYTES = 64 * 1024;
const MAX_LABEL_BYTES = 128;
const MAX_WINDOWS = 16;
const PERSIST_INTERVAL_MS = 30_000;

type UsageStorage = Pick<AgentRuntimeStorage, 'readFile' | 'writeFile'>;

/** The latest Claude Code plan usage seen in any session of this daemon, persisted across daemon restarts. */
export interface ClaudeCodeUsageRecorder {
  observe(headers: Record<string, string>): void;
  latest(): UsageSnapshot | undefined;
  /**
   * Loads the persisted usage unless a session already reported newer usage, then persists later reports: only when the
   * windows change, and at most once per 30 seconds.
   */
  restore(storage: UsageStorage): Promise<void>;
  /** Writes the latest usage now and waits for pending writes. */
  settle(): Promise<void>;
}

export function createClaudeCodeUsageRecorder(now: () => number = () => Date.now()): ClaudeCodeUsageRecorder {
  let stored: unknown;
  let observed = false;
  let storage: UsageStorage | undefined;
  let persistedJson: string | undefined;
  let persistedWindows: string | undefined;
  let lastWriteAt = Number.NEGATIVE_INFINITY;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let writing = Promise.resolve();
  // Values read back from disk or memory pass the Powerline record validation before use.
  const store = createSubscriptionUsageStore({ read: () => stored, write: value => { stored = value; schedule(); } });
  // The fetch time changes with every response; only a change in the windows is worth a write.
  const windowsKey = () => JSON.stringify(store.get('anthropic')?.snapshot?.windows
    .map(window => [window.label, window.usedPercent, window.resetAt ?? null]) ?? null);
  function write(): void {
    const target = storage; const json = JSON.stringify(stored);
    if (!target || json === persistedJson) return;
    persistedJson = json; persistedWindows = windowsKey(); lastWriteAt = now();
    writing = writing.then(() => target.writeFile(CLAUDE_CODE_USAGE_FILE, new TextEncoder().encode(json))).catch(() => {});
  }
  function schedule(): void {
    if (!storage || timer || windowsKey() === persistedWindows) return;
    const delay = lastWriteAt + PERSIST_INTERVAL_MS - now();
    if (delay <= 0) { write(); return; }
    timer = setTimeout(() => { timer = undefined; write(); }, delay);
    timer.unref?.();
  }
  return {
    observe(headers) {
      const usage = parseClaudeCodeUsageHeaders(headers);
      if (!usage?.windows.length) return;
      observed = true;
      store.set('anthropic', { rateLimitedCount: 0, snapshot: { ...usage, lastSuccessAt: now() } });
    },
    latest: () => store.get('anthropic')?.snapshot,
    async restore(target) {
      let persisted: unknown;
      try { persisted = JSON.parse(new TextDecoder().decode(await target.readFile(CLAUDE_CODE_USAGE_FILE, { maxBytes: MAX_STORED_BYTES }))); }
      catch { persisted = undefined; }
      storage = target;
      if (observed) { schedule(); return; }
      stored = persisted;
      persistedJson = JSON.stringify(stored); persistedWindows = windowsKey();
    },
    settle() {
      clearTimeout(timer); timer = undefined;
      write();
      return writing;
    },
  };
}

/** Records Claude Code usage from the rate-limit headers its provider bridge reports after each response. */
export function createClaudeCodeUsageExtension(recorder: Pick<ClaudeCodeUsageRecorder, 'observe'>): InlineExtension {
  return {
    name: '@felan-ai/felan/claude-code-usage',
    hidden: true,
    factory: pi => {
      pi.on('after_provider_response', (event, ctx) => {
        if (ctx.model?.provider === CLAUDE_CODE_PROVIDER) recorder.observe(event.headers);
      });
    },
  };
}

/**
 * Serves `host.subscriptions`: one entry per OAuth subscription the host model runtime is signed in to, plus Claude Code
 * usage when a session reported it. A failed fetch keeps the windows and time of the last successful fetch.
 */
export function createHostSubscriptions(options: {
  readonly models: ModelRuntime;
  readonly claudeCode?: Pick<ClaudeCodeUsageRecorder, 'latest'>;
  readonly usage?: Pick<SubscriptionUsageCache, 'read'>;
  readonly now?: () => number;
}): HostSubscriptions {
  const usage = options.usage ?? sharedSubscriptionUsage;
  const now = options.now ?? Date.now;
  return {
    async read() {
      const plans = PLANS.filter(plan => options.models.isUsingSubscription(plan.modelProvider));
      const subscriptions: SubscriptionUsage[] = await Promise.all(plans.map(async plan => {
        const { result, success } = await usage.read(options.models, { provider: plan.modelProvider, id: '' });
        const snapshot = parseUsageSnapshot(plan.provider, success?.data);
        return { provider: plan.provider, modelProvider: plan.modelProvider, label: snapshot.displayName,
          windows: success ? projectWindows(snapshot.windows, now()) : [],
          ...(success ? { updatedAt: success.at } : {}),
          ...(result.ok ? {} : { error: { code: result.error.code, ...(httpStatus(result.error.httpStatus) ?? {}) } }) };
      }));
      const claudeCode = options.claudeCode?.latest();
      if (claudeCode) {
        const updatedAt = claudeCode.lastSuccessAt;
        subscriptions.push({ provider: 'anthropic', modelProvider: CLAUDE_CODE_PROVIDER, label: claudeCode.displayName,
          windows: projectWindows(claudeCode.windows, now()),
          ...(updatedAt !== undefined && Number.isSafeInteger(updatedAt) && updatedAt >= 0 ? { updatedAt } : {}) });
      }
      return { subscriptions };
    },
  };
}

function httpStatus(value: number | undefined): { httpStatus: number } | undefined {
  return value !== undefined && Number.isInteger(value) && value >= 100 && value <= 599 ? { httpStatus: value } : undefined;
}

/** Drops windows whose reset time has passed, since their usage no longer applies. */
function projectWindows(windows: readonly RateWindow[], now: number): SubscriptionUsageWindow[] {
  const result: SubscriptionUsageWindow[] = [];
  for (const window of windows) {
    const label = boundedLabel(window.label);
    const reset = window.resetAt === undefined ? Number.NaN : Date.parse(window.resetAt);
    if (!label || (Number.isFinite(reset) && reset <= now)) continue;
    result.push({ label, usedPercent: Number.isFinite(window.usedPercent) ? Math.min(100, Math.max(0, window.usedPercent)) : 0,
      ...(Number.isFinite(reset) ? { resetAt: new Date(reset).toISOString() } : {}) });
    if (result.length === MAX_WINDOWS) break;
  }
  return result;
}

function boundedLabel(value: string): string {
  const label = (value as string & { toWellFormed(): string }).toWellFormed().replace(/[\u0000-\u001f\u007f-\u009f]/gu, ' ').trim();
  if (Buffer.byteLength(label) <= MAX_LABEL_BYTES) return label;
  let bounded = '';
  for (const character of label) {
    if (Buffer.byteLength(bounded + character) > MAX_LABEL_BYTES) break;
    bounded += character;
  }
  return bounded.trimEnd();
}
