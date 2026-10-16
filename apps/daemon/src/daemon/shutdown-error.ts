import { redact } from '../logger.js';

export type ShutdownStep = 'setup-drain' | 'broker-drain' | 'drain-wait' | 'server-commands' | 'providers-settle' | 'release'
  | 'ownership-lost' | 'idle-eviction' | 'settlement' | 'settlement-deadline' | 'begin-drain' | 'management-response'
  | 'session-cancel-views' | 'session-interactions' | 'session-host-shutdown' | 'session-abort' | 'session-cancel-foreground'
  | 'session-writers' | 'session-processes' | 'session-services' | 'session-runtime' | 'session-run' | 'session-dispose' | 'session-close'
  | 'registry-pending' | 'registry-fenced' | 'live-roots' | 'retained-services';

export class ShutdownError extends Error {
  constructor(readonly step: ShutdownStep, cause: unknown, readonly session?: string) {
    super(cause instanceof Error ? cause.message : 'Shutdown failed.', { cause });
    this.name = 'ShutdownError';
  }
}

export async function shutdownStep<T>(step: ShutdownStep, work: () => T | Promise<T>, session?: string): Promise<T> {
  try { return await work(); } catch (error) { throw new ShutdownError(step, error, session); }
}

export function shutdownDetail(error: unknown): ShutdownError | undefined {
  if (error instanceof ShutdownError) return error;
  if (error instanceof AggregateError) for (const nested of error.errors.slice(0, 4)) { const detail = shutdownDetail(nested); if (detail) return detail; }
  return undefined;
}

export function shutdownText(value: string, limit = 1000): string {
  const bytes = Buffer.from(redact(value).replace(/[\u0000-\u001f\u007f-\u009f]+/gu, ' ').trim());
  return bytes.length <= limit ? bytes.toString('utf8') : bytes.subarray(0, limit).toString('utf8').replace(/\uFFFD$/u, '');
}

export function shutdownMessage(error: unknown, depth = 0): string {
  if (error instanceof ShutdownError) return shutdownMessage(error.cause, depth);
  const message = error instanceof Error ? `${error.name}: ${error.message}` : 'Error: Shutdown failed.';
  const nested = error instanceof AggregateError && depth < 3 ? error.errors.slice(0, 3).map(value => shutdownMessage(value, depth + 1)) : [];
  return shutdownText([message, ...nested].join('; '));
}

export function shutdownStack(error: unknown, depth = 0): string {
  if (depth > 3) return '';
  if (error instanceof ShutdownError) return shutdownStack(error.cause, depth + 1);
  const stack = error instanceof Error ? error.stack?.split('\n').slice(1, 5).join(' ') ?? '' : '';
  const nested = error instanceof AggregateError ? error.errors.slice(0, 3).map(value => shutdownStack(value, depth + 1)) : [];
  return shutdownText([stack, ...nested].join(' '), 2000);
}
