export interface RetryOptions {
  baseMs?: number;
  capMs?: number;
  random?: () => number;
}

export function retryDelay(attempt: number, options: RetryOptions = {}): number {
  const base = options.baseMs ?? 1_000;
  const cap = options.capMs ?? 60_000;
  const ceiling = Math.min(cap, base * 2 ** Math.min(Math.max(0, attempt), 30));
  const random = Math.min(1, Math.max(0, (options.random ?? Math.random)()));
  return Math.ceil(ceiling * (0.5 + random * 0.5));
}

export interface TimerHandle { unref?(): unknown }
export interface RemoteClock {
  now(): number;
  setTimeout(callback: () => void, delay: number): TimerHandle;
  clearTimeout(timer: TimerHandle): void;
}

export const systemClock: RemoteClock = {
  now: () => Date.now(),
  setTimeout: (callback, delay) => setTimeout(callback, delay),
  clearTimeout: timer => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

export function schedule(clock: RemoteClock, callback: () => void, delay: number): TimerHandle {
  const timer = clock.setTimeout(callback, Math.max(0, delay));
  timer.unref?.();
  return timer;
}
