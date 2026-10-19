import { hostname } from 'node:os';
import {
  PROTOCOL_VERSION, ROW_SCHEMA_VERSION, parseHostTokenRequest, parseHostTokenResponse, parseSchema,
  HostTokenErrorSchema, type HostTokenError, type HostTokenResponse,
} from '@felan-ai/session-protocol';
import { redact } from '../logger.js';
import { retryDelay, schedule, systemClock, type RemoteClock, type RetryOptions, type TimerHandle } from './backoff.js';

export type HostTokenFailureKind = 'invalid_pat' | 'not_a_member' | 'host_revoked' | 'unsupported_schema' | 'unavailable' | 'retry';
export class HostTokenExchangeError extends Error {
  readonly retryable: boolean;
  constructor(
    readonly kind: HostTokenFailureKind,
    message: string,
    readonly supported?: HostTokenError['supported'],
    readonly retryAfterMs?: number,
    readonly rateLimited = false,
  ) {
    super(redact(message));
    this.name = 'HostTokenExchangeError';
    this.retryable = !['invalid_pat', 'not_a_member', 'host_revoked', 'unsupported_schema'].includes(kind);
  }
}

export type HostTokenInfo = Omit<HostTokenResponse, 'token'>;
export interface HostTokenProvider {
  token(): Promise<string>;
  cachedToken(): string | null;
  current(): HostTokenInfo | undefined;
  onChange(listener: (token: string, info: HostTokenInfo) => void): () => void;
}
export interface HostTokenSourceOptions extends RetryOptions {
  apiUrl: string;
  pat: string;
  installId: string;
  daemonVersion: string;
  name?: string;
  fetch?: typeof fetch;
  clock?: RemoteClock;
  requestTimeoutMs?: number;
}

function endpoint(value: string): string {
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
    if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname)) throw new Error();
    return url.toString().replace(/\/$/u, '');
  } catch {
    throw new HostTokenExchangeError('unavailable', 'Remote API URL must use HTTPS (HTTP is allowed only on loopback).');
  }
}

function hostName(value: string): string {
  let result = '';
  let bytes = 0;
  for (const point of value) {
    const size = Buffer.byteLength(point);
    if (bytes + size > 128) break;
    result += point;
    bytes += size;
  }
  return result;
}

function retryAfter(value: string | null, now: number, cap: number): number | undefined {
  if (!value) return undefined;
  const seconds = /^\d+(?:\.\d+)?$/u.test(value.trim()) ? Number(value) : NaN;
  const delay = Number.isFinite(seconds) ? seconds * 1_000 : Date.parse(value) - now;
  return Number.isFinite(delay) ? Math.min(cap, Math.max(0, delay)) : undefined;
}

export class HostTokenSource implements HostTokenProvider {
  #options: HostTokenSourceOptions;
  #url: string;
  #clock: RemoteClock;
  #response: HostTokenResponse | undefined;
  #inflight: Promise<string> | undefined;
  #abort: AbortController | undefined;
  #timer: TimerHandle | undefined;
  #deadline: TimerHandle | undefined;
  #listeners = new Set<(token: string, info: HostTokenInfo) => void>();
  #failure: HostTokenExchangeError | undefined;
  #retryAt = 0;
  #attempt = 0;
  #generation = 0;
  #stopped = false;

  constructor(options: HostTokenSourceOptions) {
    this.#options = options;
    this.#url = endpoint(options.apiUrl);
    this.#clock = options.clock ?? systemClock;
  }

  current(): HostTokenInfo | undefined {
    if (!this.#response) return undefined;
    const { token: _, ...info } = this.#response;
    return structuredClone(info);
  }

  cachedToken(): string | null {
    if (this.#stopped || (this.#failure && !this.#failure.retryable)) return null;
    return this.#response && this.#clock.now() < this.#response.expiresAt ? this.#response.token : null;
  }

  onChange(listener: (token: string, info: HostTokenInfo) => void): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }

  async token(): Promise<string> {
    if (this.#stopped) throw new HostTokenExchangeError('unavailable', 'Host token source is stopped.');
    if (this.#failure && !this.#failure.retryable) throw this.#failure;
    if (this.#response && this.#clock.now() < this.#response.refreshAt) return this.#response.token;
    if (this.#clock.now() < this.#retryAt && this.#failure) {
      const cached = this.cachedToken();
      if (cached) return cached;
      throw this.#failure;
    }
    if (this.#inflight) return this.#inflight;
    const generation = this.#generation;
    const pending = this.#exchange(generation);
    this.#inflight = pending;
    try { return await pending; }
    finally { if (this.#inflight === pending) this.#inflight = undefined; }
  }

  invalidate(): void {
    this.#generation++;
    this.#abort?.abort();
    this.#abort = undefined;
    if (this.#deadline) this.#clock.clearTimeout(this.#deadline);
    this.#deadline = undefined;
    this.#inflight = undefined;
    this.#response = undefined;
    this.#failure = undefined;
    this.#retryAt = 0;
    this.#attempt = 0;
    this.#clearTimer();
  }

  stop(): void {
    this.#stopped = true;
    this.invalidate();
    this.#listeners.clear();
  }

  #clearTimer(): void {
    if (this.#timer) this.#clock.clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  #renewAt(at: number): void {
    this.#clearTimer();
    if (!this.#stopped) this.#timer = schedule(this.#clock, () => {
      this.#timer = undefined;
      void this.token().catch(() => {});
    }, Math.max(1, at - this.#clock.now()));
  }

  async #exchange(generation: number): Promise<string> {
    const controller = new AbortController();
    this.#abort = controller;
    const timeout = schedule(this.#clock, () => controller.abort(), this.#options.requestTimeoutMs ?? 15_000);
    this.#deadline = timeout;
    try {
      let request;
      try {
        request = parseHostTokenRequest({
          installId: this.#options.installId, name: hostName(this.#options.name ?? hostname()),
          daemonVersion: this.#options.daemonVersion, protocol: PROTOCOL_VERSION, rowSchemaVersion: ROW_SCHEMA_VERSION,
        });
      } catch { throw new HostTokenExchangeError('unavailable', 'Invalid host token request.'); }
      const response = await (this.#options.fetch ?? fetch)(`${this.#url}/api/v1/hosts/token`, {
        method: 'POST', headers: { Authorization: `Bearer ${this.#options.pat}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(request), signal: controller.signal, redirect: 'error',
      });
      const body: unknown = await response.json().catch(() => undefined);
      if (response.status !== 200) throw this.#httpError(response, body);
      let parsed: HostTokenResponse;
      try {
        parsed = parseHostTokenResponse(body);
        endpoint(parsed.supabase.url);
        if (parsed.expiresAt <= this.#clock.now()) throw new Error();
      } catch { throw new HostTokenExchangeError('unavailable', 'Invalid host token response.'); }
      if (generation !== this.#generation || this.#stopped) throw new HostTokenExchangeError('unavailable', 'Host token exchange was cancelled.');
      this.#response = parsed;
      this.#failure = undefined;
      this.#attempt = 0;
      this.#retryAt = 0;
      this.#renewAt(parsed.refreshAt);
      const info = this.current()!;
      for (const listener of this.#listeners) {
        try { listener(parsed.token, info); } catch { /* observers cannot invalidate a successful exchange */ }
      }
      return parsed.token;
    } catch (error) {
      const failure = error instanceof HostTokenExchangeError ? error : new HostTokenExchangeError('retry', 'Host token exchange is temporarily unavailable.');
      if (generation !== this.#generation || this.#stopped) throw new HostTokenExchangeError('unavailable', 'Host token exchange was cancelled.');
      this.#failure = failure;
      if (failure.retryable) {
        this.#retryAt = this.#clock.now() + Math.max(retryDelay(this.#attempt++, this.#options), failure.retryAfterMs ?? 0);
        this.#renewAt(this.#retryAt);
        const cached = this.cachedToken();
        if (cached) return cached;
      } else this.#clearTimer();
      throw failure;
    } finally {
      this.#clock.clearTimeout(timeout);
      if (this.#deadline === timeout) this.#deadline = undefined;
      if (this.#abort === controller) this.#abort = undefined;
    }
  }

  #httpError(response: Response, body: unknown): HostTokenExchangeError {
    let parsed: HostTokenError | undefined;
    try { parsed = parseSchema(HostTokenErrorSchema, body); } catch { /* error bodies are not a trusted diagnostic source */ }
    if (response.status === 401) return new HostTokenExchangeError('invalid_pat', 'Personal access token is invalid or revoked.');
    if (response.status === 403 && parsed?.code === 'not_a_member') return new HostTokenExchangeError('not_a_member', 'Host owner is no longer a team member.');
    if (response.status === 403 && parsed?.code === 'host_revoked') return new HostTokenExchangeError('host_revoked', 'Host has been revoked.');
    if (response.status === 426) return new HostTokenExchangeError('unsupported_schema', 'Remote publication requires a supported schema version.', parsed?.supported);
    if (response.status === 429 || response.status >= 500) return new HostTokenExchangeError(
      'retry', 'Host token exchange is temporarily unavailable.', undefined,
      retryAfter(response.headers.get('Retry-After'), this.#clock.now(), this.#options.capMs ?? 60_000),
      response.status === 429,
    );
    return new HostTokenExchangeError('unavailable', 'Host token exchange was refused.');
  }
}
