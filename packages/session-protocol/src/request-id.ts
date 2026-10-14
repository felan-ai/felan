import { LIMITS, ProtocolValidationError } from './limits.js';

export const UUID_V7_PATTERN = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-7[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$';

export function requestTimestamp(id: string): number {
  if (!new RegExp(UUID_V7_PATTERN).test(id)) throw new ProtocolValidationError('invalid_request', 'Mutation request ID must be UUIDv7');
  return Number.parseInt(id.slice(0, 8) + id.slice(9, 13), 16);
}

export function requestRetainUntil(id: string, admittedAt: number): number {
  if (!Number.isSafeInteger(admittedAt) || admittedAt < 0) throw new ProtocolValidationError('invalid_request', 'Invalid admission time');
  return Math.max(admittedAt, requestTimestamp(id)) + LIMITS.requestRetentionMs;
}
