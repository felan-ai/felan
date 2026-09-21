import { retrySchedule } from './retry-schedule.js';

export function planRetries(policy) {
  return retrySchedule(policy.attempts, policy.baseDelayMs, policy.maxDelayMs);
}
