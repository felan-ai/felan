export type SubscriptionProviderName = 'codex' | 'anthropic';
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

export type SubscriptionUsageHostResult =
  | { readonly ok: true; readonly data: unknown }
  | {
      readonly ok: false;
      readonly error: {
        readonly code: UsageErrorCode;
        readonly httpStatus?: number;
      };
    };

export interface SubscriptionUsageHost {
  fetchUsage(request: SubscriptionUsageHostRequest): Promise<SubscriptionUsageHostResult>;
}

export interface SubscriptionRefreshOptions {
  force?: boolean;
  allowStaleCache?: boolean;
  resetProvider?: boolean;
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
const MIN_REFRESH_INTERVAL_MS = 10_000;

const DISPLAY_NAMES: Record<SubscriptionProviderName, string> = {
  codex: 'Codex Plan',
  anthropic: 'Claude Plan',
};

export function createSubscriptionController(
  host: SubscriptionUsageHost,
  onUpdate?: () => void,
): SubscriptionController {
  const state: SubscriptionState = { loading: false };
  const cache: Partial<Record<SubscriptionProviderName, UsageSnapshot>> = {};
  const lastAttemptAt: Partial<Record<SubscriptionProviderName, number>> = {};
  const latestRequestSequence: Partial<Record<SubscriptionProviderName, number>> = {};
  const activeRequests = new Set<AbortController>();
  let inFlightProvider: SubscriptionProviderName | undefined;
  let inFlight: Promise<void> | undefined;
  let inFlightSequence: number | undefined;
  let sequence = 0;

  function notify(): void {
    onUpdate?.();
  }

  function setCurrentProvider(
    provider: SubscriptionProviderName,
    options: SubscriptionRefreshOptions,
  ): void {
    const providerChanged = state.provider !== provider;
    state.provider = provider;
    if (providerChanged || options.resetProvider) {
      const stale = options.allowStaleCache ? cache[provider] : undefined;
      if (stale) state.usage = stale;
      else delete state.usage;
    } else if (!state.usage && cache[provider]) {
      state.usage = cache[provider];
    }
  }

  async function refresh(
    model: { provider?: string; id?: string } | undefined,
    options: SubscriptionRefreshOptions = {},
  ): Promise<void> {
    const provider = detectSubscriptionProvider(model);
    if (!provider) {
      sequence += 1;
      abortActiveRequests();
      delete latestRequestSequence.codex;
      delete latestRequestSequence.anthropic;
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
    }
    setCurrentProvider(provider, options);
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
    if (!options.force && previousAttempt && now - previousAttempt < MIN_REFRESH_INTERVAL_MS) {
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
    const fetched = result.ok
      ? parseUsageSnapshot(provider, result.data)
      : emptySnapshot(provider, usageError(result.error.code, result.error.httpStatus));
    const displaySnapshot = withFallbackForFetchFailure(fetched, cache[provider]);
    if (!fetched.error && latestRequestSequence[provider] === requestSequence) {
      cache[provider] = displaySnapshot;
    }
    if (state.provider === provider && sequence === requestSequence) {
      state.usage = displaySnapshot;
      state.lastRefreshAt = Date.now();
      notify();
    }
  }

  function clear(): void {
    sequence += 1;
    abortActiveRequests();
    delete state.provider;
    delete state.usage;
    state.loading = false;
    delete state.lastRefreshAt;
    delete cache.codex;
    delete cache.anthropic;
    delete lastAttemptAt.codex;
    delete lastAttemptAt.anthropic;
    delete latestRequestSequence.codex;
    delete latestRequestSequence.anthropic;
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
  return undefined;
}

export function parseUsageSnapshot(
  provider: SubscriptionProviderName,
  data: unknown,
): UsageSnapshot {
  return provider === 'codex' ? parseCodexUsage(data) : parseAnthropicUsage(data);
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

function withFallbackForFetchFailure(
  fetched: UsageSnapshot,
  fallback: UsageSnapshot | undefined,
): UsageSnapshot {
  const now = Date.now();
  if (!fetched.error) return { ...fetched, lastSuccessAt: now };
  if (fetched.error.code !== 'NO_CREDENTIALS' && fallback?.windows.length) {
    return { ...fallback, error: fetched.error };
  }
  return fetched;
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
