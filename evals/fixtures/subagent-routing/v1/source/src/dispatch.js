import { RETRY_DELAY_MS } from './constants.js';

export function dispatchBatch(items, queue) {
  return { items, queue, retryDelayMs: RETRY_DELAY_MS };
}
