export interface SavingsUsageHostRequest {
  readonly periodDays: number;
  readonly signal: AbortSignal;
}

export interface SavingsUsageHostResult {
  readonly savedCostUsd: number;
  readonly hasUnpricedMeasurements: boolean;
}

export interface SavingsUsageHost {
  query(request: SavingsUsageHostRequest): Promise<SavingsUsageHostResult>;
}

export interface SavingsState {
  readonly loading: boolean;
  readonly result?: SavingsUsageHostResult;
}

export interface SavingsController {
  readonly state: SavingsState;
  refresh(periodDays: number): Promise<void>;
  clear(): void;
}

export function createSavingsController(host: SavingsUsageHost, onUpdate?: () => void): SavingsController {
  let state: SavingsState = { loading: false };
  let active: { controller: AbortController; promise: Promise<void> } | undefined;

  const controller: SavingsController = {
    get state() { return state; },
    refresh(periodDays) {
      if (active) return active.promise;
      const requestController = new AbortController();
      state = { ...state, loading: true };
      onUpdate?.();
      const promise = host.query({ periodDays, signal: requestController.signal })
        .then((result) => { state = { loading: false, result }; onUpdate?.(); })
        .catch(() => { if (!requestController.signal.aborted) { state = { ...state, loading: false }; onUpdate?.(); } })
        .finally(() => { if (active?.promise === promise) active = undefined; });
      active = { controller: requestController, promise };
      return promise;
    },
    clear() {
      active?.controller.abort();
      active = undefined;
      state = { loading: false };
    },
  };
  return controller;
}
