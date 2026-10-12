import { LIMITS, ProtocolValidationError } from './limits.js';

export const UUID_V7_PATTERN = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-7[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$';

export function requestTimestamp(id: string): number {
  if (!new RegExp(UUID_V7_PATTERN).test(id)) throw new ProtocolValidationError('invalid_request', 'Mutation request ID must be UUIDv7');
  return Number.parseInt(id.slice(0, 8) + id.slice(9, 13), 16);
}

export function validateRequestId(id: string, now = Date.now()): number {
  const timestamp = requestTimestamp(id);
  if (!Number.isSafeInteger(now) || now < 0) throw new ProtocolValidationError('invalid_request', 'Invalid admission time');
  if (timestamp < now - LIMITS.requestRetentionMs) throw new ProtocolValidationError('stale_request', 'Request ID is outside the retry lifetime');
  if (timestamp > now + LIMITS.requestFutureSkewMs) throw new ProtocolValidationError('invalid_request', 'Request ID is too far in the future');
  return timestamp;
}

export function requestRetainUntil(id: string, admittedAt: number): number {
  if (!Number.isSafeInteger(admittedAt) || admittedAt < 0) throw new ProtocolValidationError('invalid_request', 'Invalid admission time');
  return Math.max(admittedAt, requestTimestamp(id)) + LIMITS.requestRetentionMs;
}
