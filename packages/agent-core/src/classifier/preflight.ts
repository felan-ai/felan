import type { Logger } from '../logger.js';
import { ClassifierError } from './error.js';

const WAIT_MS = 2_000;

export function createClassifierPreflight(logger: Logger) {
  const log = logger.child({ component: 'classifier-preflight' });
  let enabled = false;
  let turn: { controller: AbortController; timeout: ReturnType<typeof setTimeout>; started: number } | undefined;

  function clear(): void {
    if (!turn) return;
    clearTimeout(turn.timeout);
    turn.controller.abort();
    turn = undefined;
  }

  return {
    startNextTurn() {
      clear();
      enabled = true;
    },
    finishPreflight() {
      enabled = false;
      if (!turn) return;
      log.debug({ event: 'turn-start', elapsedMs: Math.round(performance.now() - turn.started) },
        'classifier preflight to turn start');
      clear();
    },
    dispose() {
      enabled = false;
      clear();
    },
    async run<T>(decision: string, work: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
      if (!enabled) return work(signal ?? new AbortController().signal);
      if (!turn) {
        const controller = new AbortController();
        turn = { controller, timeout: setTimeout(() => controller.abort(), WAIT_MS), started: performance.now() };
      }
      const current = turn;
      const started = performance.now();
      const combined = signal ? AbortSignal.any([current.controller.signal, signal]) : current.controller.signal;
      let onAbort!: () => void;
      const aborted = new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(new ClassifierError(signal?.aborted ? 'aborted' : 'timeout',
          signal?.aborted ? 'Classifier request was aborted' : 'Classifier preflight expired'));
        if (combined.aborted) onAbort();
        else combined.addEventListener('abort', onAbort, { once: true });
      });
      let outcome = 'completed';
      try {
        if (combined.aborted) return await aborted;
        return await Promise.race([work(combined), aborted]);
      } catch (error) {
        outcome = combined.aborted ? (signal?.aborted ? 'cancelled' : 'expired') : 'failed';
        throw error;
      } finally {
        combined.removeEventListener('abort', onAbort);
        log.debug({ event: 'decision', decision, outcome, elapsedMs: Math.round(performance.now() - started),
          preflightElapsedMs: Math.round(performance.now() - current.started) }, 'classifier preflight decision');
      }
    },
  };
}
