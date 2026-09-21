export function retrySchedule(attempts, baseDelayMs, maxDelayMs) {
  if (!Number.isInteger(attempts) || attempts < 0) throw new Error('attempts must be a non-negative integer');
  if (baseDelayMs <= 0 || maxDelayMs <= 0) throw new Error('delays must be positive');
  return Array.from({ length: attempts }, (_, index) => baseDelayMs * index);
}
