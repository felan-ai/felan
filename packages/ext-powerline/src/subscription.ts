export type SubscriptionProviderName = 'codex' | 'anthropic' | 'xai';
export type UsageErrorCode = 'NO_CREDENTIALS' | 'FETCH_FAILED' | 'HTTP_ERROR';

export interface RateWindow {
  label: string;
  usedPercent: number;
  resetDescription?: string;
  resetAt?: string;
}

export interface UsageError {
  code: UsageErrorCode;
  message: string;
  httpStatus?: number;
}

export interface UsageSnapshot {
  provider: SubscriptionProviderName;
  displayName: string;
  windows: RateWindow[];
  extraUsageEnabled?: boolean;
  fiveHourUsage?: number;
  lastSuccessAt?: number;
  error?: UsageError;
}

export interface SubscriptionState {
  provider?: SubscriptionProviderName;
  usage?: UsageSnapshot;
  loading: boolean;
  lastRefreshAt?: number;
}

export interface SubscriptionUsageHostRequest {
  readonly provider: SubscriptionProviderName;
  readonly modelProvider: string;
  readonly signal: AbortSignal;
}

/** `REFRESH_DEFERRED` means another holder of the host's refresh lease updates the shared store. */
export type SubscriptionUsageHostErrorCode = UsageErrorCode | 'REFRESH_DEFERRED';

export type SubscriptionUsageHostResult =
  | { readonly ok: true; readonly data: unknown }
  | {
      readonly ok: false;
      readonly error: {
        readonly code: SubscriptionUsageHostErrorCode;
        readonly httpStatus?: number;
        readonly retryAfterMs?: number;
      };
    };

export interface SubscriptionUsageHost {
  fetchUsage(request: SubscriptionUsageHostRequest): Promise<SubscriptionUsageHostResult>;
  /** Gives up this host's right to refresh the provider so another process can take over. */
  releaseRefreshLease?(provider: SubscriptionProviderName): void;
}

export interface SubscriptionRefreshOptions {
  force?: boolean;
}

export interface SubscriptionUsageRecord {
  readonly snapshot?: UsageSnapshot;
  readonly error?: UsageError;
  readonly blockedUntil?: number;
  readonly rateLimitedCount: number;
}

/** Latest usage, error, and rate-limit backoff, shared across sessions and optionally persisted by the host. */
export interface SubscriptionUsageStore {
  get(provider: SubscriptionProviderName): SubscriptionUsageRecord | undefined;
  set(provider: SubscriptionProviderName, record: SubscriptionUsageRecord): void;
}

/** Host-owned raw storage; values read back are validated before use. */
export interface SubscriptionUsagePersistence {
  read(): unknown;
  write(value: unknown): void;
}

type SubscriptionUsageRecords = Partial<Record<SubscriptionProviderName, SubscriptionUsageRecord>>;

export function createSubscriptionUsageStore(
  persistence?: SubscriptionUsagePersistence,
): SubscriptionUsageStore {
  let records: SubscriptionUsageRecords = {};

  function load(): SubscriptionUsageRecords {
    if (!persistence) return records;
    try {
      records = parseUsageRecords(persistence.read());
    } catch {
      // Unreadable state falls back to the in-memory records.
    }
    return records;
  }

  return {
    get: (provider) => load()[provider],
    set(provider, record) {
      records = { ...load(), [provider]: record };
      try {
        persistence?.write({ version: 1, providers: records });
      } catch {
        // Persistence is best effort; the in-memory records stay current.
      }
    },
  };
}

export interface SubscriptionController {
  readonly state: SubscriptionState;
  refresh(
    model: { provider?: string; id?: string } | undefined,
    options?: SubscriptionRefreshOptions,
  ): Promise<void>;
  clear(): void;
}

interface CodexRateWindow {
  reset_at?: number;
  reset_after_seconds?: number;
  limit_window_seconds?: number;
  used_percent?: number;
}

interface CodexRateLimit {
  primary_window?: CodexRateWindow;
  secondary_window?: CodexRateWindow;
}

interface AnthropicUsageResponse {
  five_hour?: { utilization?: number; resets_at?: string };
  seven_day?: { utilization?: number; resets_at?: string };
  extra_usage?: {
    is_enabled?: boolean;
    used_credits?: number;
    monthly_limit?: number;
    utilization?: number;
  };
}

const API_TIMEOUT_MS = 5_000;
const MIN_REFRESH_INTERVAL_MS = 30_000;
const RATE_LIMIT_BASE_BACKOFF_MS = 60_000;
const RATE_LIMIT_MAX_BACKOFF_MS = 30 * 60_000;

const DISPLAY_NAMES: Record<SubscriptionProviderName, string> = {
  codex: 'Codex Plan',
  anthropic: 'Claude Plan',
  xai: 'Grok Plan',
};

export function createSubscriptionController(
  host: SubscriptionUsageHost,
  onUpdate?: () => void,
  store: SubscriptionUsageStore = createSubscriptionUsageStore(),
): SubscriptionController {
  const state: SubscriptionState = { loading: false };
  const latestRequestSequence: Partial<Record<SubscriptionProviderName, number>> = {};
  const lastAttemptAt: Partial<Record<SubscriptionProviderName, number>> = {};
  const missingCredentials = new Set<SubscriptionProviderName>();
  const activeRequests = new Set<AbortController>();
  let inFlightProvider: SubscriptionProviderName | undefined;
  let inFlight: Promise<void> | undefined;
  let inFlightSequence: number | undefined;
  let sequence = 0;

  function notify(): void {
    onUpdate?.();
  }

  function showStoredUsage(provider: SubscriptionProviderName): void {
    const usage = missingCredentials.has(provider)
      ? emptySnapshot(provider, usageError('NO_CREDENTIALS'))
      : usageFromRecord(provider, store.get(provider));
    if (usage) state.usage = usage;
    else delete state.usage;
  }

  function releaseLease(provider: SubscriptionProviderName): void {
    host.releaseRefreshLease?.(provider);
  }

  async function refresh(
    model: { provider?: string; id?: string } | undefined,
    options: SubscriptionRefreshOptions = {},
  ): Promise<void> {
    const provider = detectSubscriptionProvider(model);
    if (!provider) {
      if (state.provider) releaseLease(state.provider);
      sequence += 1;
      abortActiveRequests();
      delete latestRequestSequence.codex;
      delete latestRequestSequence.anthropic;
      delete latestRequestSequence.xai;
      delete state.provider;
      delete state.usage;
      state.loading = false;
      notify();
      return;
    }

    const previousProvider = state.provider;
    if (previousProvider && previousProvider !== provider) {
      abortActiveRequests();
      delete latestRequestSequence[previousProvider];
      releaseLease(previousProvider);
    }
    state.provider = provider;
    showStoredUsage(provider);
    if (inFlight && inFlightProvider === provider && inFlightSequence === sequence) {
      state.loading = true;
      notify();
      return inFlight;
    }

    const requestSequence = ++sequence;
    state.loading = !state.usage;
    notify();

    const now = Date.now();
    const previousAttempt = lastAttemptAt[provider];
    const throttled = !options.force
      && previousAttempt !== undefined
      && now - previousAttempt < MIN_REFRESH_INTERVAL_MS;
    const blockedUntil = store.get(provider)?.blockedUntil;
    if (throttled || (blockedUntil !== undefined && now < blockedUntil)) {
      state.loading = false;
      notify();
      return;
    }

    lastAttemptAt[provider] = now;
    latestRequestSequence[provider] = requestSequence;
    state.loading = true;
    notify();

    const controller = new AbortController();
    activeRequests.add(controller);
    const promise = fetchAndCommit(
      provider,
      model?.provider ?? '',
      requestSequence,
      controller,
    ).finally(() => {
      activeRequests.delete(controller);
      if (inFlight === promise) {
        inFlight = undefined;
        inFlightProvider = undefined;
        inFlightSequence = undefined;
      }
      if (state.provider === provider && sequence === requestSequence) {
        state.loading = false;
        notify();
      }
    });
    inFlight = promise;
    inFlightProvider = provider;
    inFlightSequence = requestSequence;
    return promise;
  }

  async function fetchAndCommit(
    provider: SubscriptionProviderName,
    modelProvider: string,
    requestSequence: number,
    controller: AbortController,
  ): Promise<void> {
    const result = await fetchHostUsage(host, provider, modelProvider, controller);
    const errorCode = result.ok ? undefined : result.error.code;
    if (errorCode === 'NO_CREDENTIALS') {
      missingCredentials.add(provider);
    } else if (errorCode !== 'REFRESH_DEFERRED') {
      missingCredentials.delete(provider);
      if (latestRequestSequence[provider] === requestSequence) {
        store.set(provider, nextUsageRecord(provider, store.get(provider), result));
      }
    }
    if (state.provider === provider && sequence === requestSequence) {
      showStoredUsage(provider);
      state.lastRefreshAt = Date.now();
      notify();
    }
  }

  function clear(): void {
    releaseLease('codex');
    releaseLease('anthropic');
    releaseLease('xai');
    sequence += 1;
    abortActiveRequests();
    delete state.provider;
    delete state.usage;
    state.loading = false;
    delete state.lastRefreshAt;
    delete latestRequestSequence.codex;
    delete latestRequestSequence.anthropic;
    delete latestRequestSequence.xai;
    delete lastAttemptAt.codex;
    delete lastAttemptAt.anthropic;
    delete lastAttemptAt.xai;
    missingCredentials.clear();
    inFlight = undefined;
    inFlightProvider = undefined;
    inFlightSequence = undefined;
    notify();
  }

  function abortActiveRequests(): void {
    for (const controller of activeRequests) controller.abort();
    inFlight = undefined;
    inFlightProvider = undefined;
    inFlightSequence = undefined;
  }

  return { state, refresh, clear };
}

export function detectSubscriptionProvider(
  model: { provider?: string; id?: string } | undefined,
): SubscriptionProviderName | undefined {
  if (!model) return undefined;
  const provider = model.provider?.toLowerCase() ?? '';
  const id = model.id?.toLowerCase() ?? '';
  if (
    provider.includes('openai-codex')
    || provider.includes('codex')
    || id.includes('openai-codex')
    || id.includes('codex')
  ) return 'codex';
  if (provider.includes('anthropic') || id.includes('claude')) return 'anthropic';
  if (provider.includes('xai')) return 'xai';
  return undefined;
}

export function parseUsageSnapshot(
  provider: SubscriptionProviderName,
  data: unknown,
): UsageSnapshot {
  if (provider === 'codex') return parseCodexUsage(data);
  if (provider === 'anthropic') return parseAnthropicUsage(data);
  return parseXaiUsage(data);
}

async function fetchHostUsage(
  host: SubscriptionUsageHost,
  provider: SubscriptionProviderName,
  modelProvider: string,
  controller: AbortController,
): Promise<SubscriptionUsageHostResult> {
  const timeoutId = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
  try {
    return await host.fetchUsage({ provider, modelProvider, signal: controller.signal });
  } catch {
    return { ok: false, error: { code: 'FETCH_FAILED' } };
  } finally {
    clearTimeout(timeoutId);
  }
}

function rateLimitBackoffMs(rateLimitedCount: number, retryAfterMs: number | undefined): number {
  const exponential = RATE_LIMIT_BASE_BACKOFF_MS * 2 ** Math.min(rateLimitedCount - 1, 5);
  const requested = retryAfterMs !== undefined && Number.isFinite(retryAfterMs) ? retryAfterMs : 0;
  return Math.min(RATE_LIMIT_MAX_BACKOFF_MS, Math.max(exponential, requested));
}

function parseUsageRecords(value: unknown): SubscriptionUsageRecords {
  const providers = isRecord(value) && value.version === 1 && isRecord(value.providers) ? value.providers : {};
  const records: SubscriptionUsageRecords = {};
  for (const provider of Object.keys(DISPLAY_NAMES) as SubscriptionProviderName[]) {
    const record = parseUsageRecord(provider, providers[provider]);
    if (record) records[provider] = record;
  }
  return records;
}

function parseUsageRecord(
  provider: SubscriptionProviderName,
  value: unknown,
): SubscriptionUsageRecord | undefined {
  if (!isRecord(value)) return undefined;
  const snapshotValue = parseStoredSnapshot(provider, value.snapshot);
  const error = parseStoredError(value.error);
  const blockedUntil = finiteNumber(value.blockedUntil);
  const rateLimitedCount = finiteNumber(value.rateLimitedCount);
  return {
    rateLimitedCount: rateLimitedCount === undefined ? 0 : Math.max(0, Math.floor(rateLimitedCount)),
    ...(snapshotValue ? { snapshot: snapshotValue } : {}),
    ...(error ? { error } : {}),
    ...(blockedUntil === undefined ? {} : { blockedUntil }),
  };
}

function parseStoredError(value: unknown): UsageError | undefined {
  if (!isRecord(value)) return undefined;
  if (value.code !== 'FETCH_FAILED' && value.code !== 'HTTP_ERROR') return undefined;
  const httpStatus = finiteNumber(value.httpStatus);
  return usageError(value.code, httpStatus === undefined ? undefined : Math.floor(httpStatus));
}

function parseStoredSnapshot(provider: SubscriptionProviderName, value: unknown): UsageSnapshot | undefined {
  if (!isRecord(value) || !Array.isArray(value.windows)) return undefined;
  const windows: RateWindow[] = [];
  for (const window of value.windows) {
    if (!isRecord(window)) continue;
    const label = getNonEmptyString(window.label);
    const usedPercent = finiteNumber(window.usedPercent);
    if (!label || usedPercent === undefined) continue;
    const resetDescription = getNonEmptyString(window.resetDescription);
    const resetAt = parseDate(getNonEmptyString(window.resetAt));
    windows.push({
      label,
      usedPercent: clampPercent(usedPercent),
      ...(resetDescription ? { resetDescription } : {}),
      ...(resetAt ? { resetAt: resetAt.toISOString() } : {}),
    });
  }
  if (!windows.length) return undefined;
  const fiveHourUsage = finiteNumber(value.fiveHourUsage);
  const lastSuccessAt = finiteNumber(value.lastSuccessAt);
  return snapshot(provider, {
    windows,
    ...(typeof value.extraUsageEnabled === 'boolean' ? { extraUsageEnabled: value.extraUsageEnabled } : {}),
    ...(fiveHourUsage === undefined ? {} : { fiveHourUsage }),
    ...(lastSuccessAt === undefined ? {} : { lastSuccessAt }),
  });
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function parseCodexUsage(data: unknown): UsageSnapshot {
  const root = isRecord(data) ? data : {};
  const windows: RateWindow[] = [];
  addCodexRateWindows(windows, asCodexRateLimit(root.rate_limit));
  if (Array.isArray(root.additional_rate_limits)) {
    for (const entry of root.additional_rate_limits) {
      if (!isRecord(entry)) continue;
      const prefix = getNonEmptyString(entry.limit_name)
        ?? getNonEmptyString(entry.metered_feature)
        ?? 'Additional';
      addCodexRateWindows(windows, asCodexRateLimit(entry.rate_limit), prefix);
    }
  }
  return snapshot('codex', { windows });
}

function parseAnthropicUsage(data: unknown): UsageSnapshot {
  const root = (isRecord(data) ? data : {}) as AnthropicUsageResponse;
  const windows: RateWindow[] = [];
  const fiveHourUsage = clampPercent(root.five_hour?.utilization ?? 0);

  if (typeof root.five_hour?.utilization === 'number') {
    const resetAt = parseDate(root.five_hour.resets_at);
    windows.push({
      label: '5h',
      usedPercent: fiveHourUsage,
      ...(resetAt ? { resetDescription: formatReset(resetAt), resetAt: resetAt.toISOString() } : {}),
    });
  }

  if (typeof root.seven_day?.utilization === 'number') {
    const resetAt = parseDate(root.seven_day.resets_at);
    windows.push({
      label: 'Week',
      usedPercent: clampPercent(root.seven_day.utilization),
      ...(resetAt ? { resetDescription: formatReset(resetAt), resetAt: resetAt.toISOString() } : {}),
    });
  }

  const extraUsageEnabled = root.extra_usage?.is_enabled === true;
  if (extraUsageEnabled) {
    const extra = root.extra_usage!;
    const status = fiveHourUsage >= 99 ? 'active' : 'on';
    windows.push({
      label: formatExtraUsageLabel(status, extra.used_credits, extra.monthly_limit),
      usedPercent: clampPercent(extra.utilization ?? 0),
      ...(status === 'active' ? { resetDescription: '__ACTIVE__' } : {}),
    });
  }

  return snapshot('anthropic', { windows, extraUsageEnabled, fiveHourUsage });
}

function parseXaiUsage(data: unknown): UsageSnapshot {
  const root = isRecord(data) ? data : {};
  const config = isRecord(root.config) ? root.config : {};
  const period = isRecord(config.currentPeriod) ? config.currentPeriod : {};
  const raw = config.creditUsagePercent;
  const usedPercent = typeof raw === 'number' && Number.isFinite(raw) ? clampPercent(raw) : 0;
  const end = getNonEmptyString(period.end) ?? getNonEmptyString(config.billingPeriodEnd);
  const resetAt = parseDate(end);
  return snapshot('xai', {
    windows: [{
      label: 'Week',
      usedPercent,
      ...(resetAt ? { resetDescription: formatReset(resetAt), resetAt: resetAt.toISOString() } : {}),
    }],
  });
}

function asCodexRateLimit(value: unknown): CodexRateLimit | undefined {
  if (!isRecord(value)) return undefined;
  return {
    ...(isRecord(value.primary_window) ? { primary_window: value.primary_window as CodexRateWindow } : {}),
    ...(isRecord(value.secondary_window) ? { secondary_window: value.secondary_window as CodexRateWindow } : {}),
  };
}

function addCodexRateWindows(
  windows: RateWindow[],
  rateLimit: CodexRateLimit | undefined,
  prefix?: string,
): void {
  pushCodexWindow(windows, prefix, rateLimit?.primary_window, 10_800);
  pushCodexWindow(windows, prefix, rateLimit?.secondary_window, 86_400);
}

function pushCodexWindow(
  windows: RateWindow[],
  prefix: string | undefined,
  window: CodexRateWindow | undefined,
  fallbackWindowSeconds: number,
): void {
  if (!window) return;
  const resetDate = getCodexResetDate(window);
  const label = getWindowLabel(window.limit_window_seconds, fallbackWindowSeconds);
  windows.push({
    label: prefix ? `${prefix} ${label}` : label,
    usedPercent: clampPercent(window.used_percent ?? 0),
    ...(resetDate ? { resetDescription: formatReset(resetDate), resetAt: resetDate.toISOString() } : {}),
  });
}

function getCodexResetDate(window: CodexRateWindow): Date | undefined {
  if (typeof window.reset_at === 'number' && Number.isFinite(window.reset_at) && window.reset_at > 0) {
    return new Date(window.reset_at * 1_000);
  }
  if (
    typeof window.reset_after_seconds === 'number'
    && Number.isFinite(window.reset_after_seconds)
    && window.reset_after_seconds > 0
  ) return new Date(Date.now() + window.reset_after_seconds * 1_000);
  return undefined;
}

function getWindowLabel(windowSeconds?: number, fallbackWindowSeconds?: number): string {
  const safeWindowSeconds = typeof windowSeconds === 'number' && windowSeconds > 0
    ? windowSeconds
    : typeof fallbackWindowSeconds === 'number' && fallbackWindowSeconds > 0
      ? fallbackWindowSeconds
      : 0;
  if (!safeWindowSeconds) return '0h';
  const hours = Math.round(safeWindowSeconds / 3_600);
  if (hours >= 144) return 'Week';
  if (hours >= 24) return 'Day';
  return `${hours}h`;
}

function formatExtraUsageLabel(
  status: 'on' | 'active',
  usedCredits?: number,
  monthlyLimit?: number,
): string {
  const label = `Extra [${status}]`;
  const used = typeof usedCredits === 'number' && Number.isFinite(usedCredits) ? usedCredits : undefined;
  const limit = typeof monthlyLimit === 'number' && Number.isFinite(monthlyLimit) && monthlyLimit > 0
    ? monthlyLimit
    : undefined;
  if (used === undefined) return label;
  if (limit) return `${label} ${formatCredits(used)}/${formatCredits(limit)}`;
  return `${label} ${formatCredits(used)}`;
}

function formatCredits(credits: number): string {
  return `$${(credits / 100).toFixed(2)}`;
}

function nextUsageRecord(
  provider: SubscriptionProviderName,
  current: SubscriptionUsageRecord | undefined,
  result: SubscriptionUsageHostResult,
): SubscriptionUsageRecord {
  if (result.ok) {
    return {
      rateLimitedCount: 0,
      snapshot: { ...parseUsageSnapshot(provider, result.data), lastSuccessAt: Date.now() },
    };
  }
  const { code, httpStatus, retryAfterMs } = result.error;
  if (code === 'REFRESH_DEFERRED') return current ?? { rateLimitedCount: 0 };
  const failed: SubscriptionUsageRecord = {
    rateLimitedCount: 0,
    ...current,
    error: usageError(code, httpStatus),
  };
  if (httpStatus !== 429) return failed;
  const rateLimitedCount = failed.rateLimitedCount + 1;
  return {
    ...failed,
    rateLimitedCount,
    blockedUntil: Date.now() + rateLimitBackoffMs(rateLimitedCount, retryAfterMs),
  };
}

function usageFromRecord(
  provider: SubscriptionProviderName,
  record: SubscriptionUsageRecord | undefined,
): UsageSnapshot | undefined {
  const now = Date.now();
  const windows = record?.snapshot?.windows.filter(
    (window) => !window.resetAt || Date.parse(window.resetAt) > now,
  ) ?? [];
  const usage = record?.snapshot ? { ...record.snapshot, windows } : undefined;
  if (!record?.error) return usage;
  return usage && windows.length ? { ...usage, error: record.error } : emptySnapshot(provider, record.error);
}

function snapshot(
  provider: SubscriptionProviderName,
  data: Partial<Omit<UsageSnapshot, 'provider' | 'displayName'>>,
): UsageSnapshot {
  return { provider, displayName: DISPLAY_NAMES[provider], windows: [], ...data };
}

function emptySnapshot(provider: SubscriptionProviderName, error: UsageError): UsageSnapshot {
  return snapshot(provider, { error });
}

function usageError(code: UsageErrorCode, httpStatus?: number): UsageError {
  if (code === 'NO_CREDENTIALS') return { code, message: 'No OAuth credentials found' };
  if (code === 'HTTP_ERROR') {
    return {
      code,
      message: httpStatus === undefined ? 'HTTP request failed' : `HTTP ${httpStatus}`,
      ...(httpStatus === undefined ? {} : { httpStatus }),
    };
  }
  return { code, message: 'Fetch failed' };
}

export function formatReset(date: Date): string {
  const diffMs = date.getTime() - Date.now();
  if (!Number.isFinite(diffMs) || diffMs < 0) return 'now';
  const diffMins = Math.floor(diffMs / 60_000);
  if (diffMins < 60) return `${diffMins}m`;
  const hours = Math.floor(diffMins / 60);
  const mins = diffMins % 60;
  if (hours < 24) return mins > 0 ? `${hours}h${mins}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return remHours > 0 ? `${days}d${remHours}h` : `${days}d`;
}

export function normalizeTokens(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
}

export function prioritizeWindowsForModel(
  windows: RateWindow[],
  model?: { id?: string } | null,
): RateWindow[] {
  if (!model?.id || windows.length <= 1) return windows;
  const modelTokens = normalizeTokens(model.id);
  if (modelTokens.length === 0) return windows;

  const matched: RateWindow[] = [];
  const rest: RateWindow[] = [];
  for (const window of windows) {
    const labelTokens = normalizeTokens(window.label);
    const isMatch = modelTokens.every((token) => labelTokens.includes(token))
      && modelTokens.length * 2 > labelTokens.length;
    if (isMatch) matched.push(window);
    else rest.push(window);
  }
  if (matched.length === 0 || matched.length === windows.length) return windows;
  return [...matched, ...rest];
}

function parseDate(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : undefined;
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

function getNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
