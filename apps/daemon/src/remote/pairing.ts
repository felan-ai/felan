import { hostname } from 'node:os';
import {
  PROTOCOL_VERSION, ROW_SCHEMA_VERSION, parseHostPairingError, parseHostPairingPollResponse, parseHostPairingStartRequest,
  parseHostPairingStartResponse, type HostPairingError as PairingErrorBody, type HostPairingPollResponse, type HostPairingStartResponse,
} from '@felan-ai/session-protocol';
import { redact } from '../logger.js';
import { schedule, systemClock, type RemoteClock, type TimerHandle } from './backoff.js';
import { endpoint, hostName, retryAfter } from './token.js';

export type HostPairingFailureKind = 'denied' | 'expired' | 'unsupported_schema' | 'unavailable' | 'cancelled';
export class HostPairingFailure extends Error {
  constructor(readonly kind: HostPairingFailureKind, message: string, readonly supported?: PairingErrorBody['supported']) {
    super(redact(message));
    this.name = 'HostPairingFailure';
  }
}

export interface HostPairingOptions {
  apiUrl: string;
  installId: string;
  daemonVersion: string;
  name?: string;
  fetch?: typeof fetch;
  clock?: RemoteClock;
  requestTimeoutMs?: number;
}

const SLOW_DOWN_MS = 5_000;
const RETRY_AFTER_CAP_MS = 60_000;

type Sent = { status: number; headers: Headers; body: unknown };
type PollResult = { grant: HostPairingPollResponse } | { slowDown: boolean; retryAfterMs?: number | undefined };

function errorBody(body: unknown): PairingErrorBody | undefined {
  try { return parseHostPairingError(body); } catch { return undefined; }
}

function expired(): HostPairingFailure {
  return new HostPairingFailure('expired', 'Browser pairing expired before it was approved.');
}

// Pairing is a device-code flow: a start request yields a user code for the browser and a device code
// that only this instance may poll with. Neither code is logged or exposed through status.
export class HostPairing {
  #options: HostPairingOptions;
  #url: string;
  #clock: RemoteClock;
  #controller: AbortController | undefined;
  #interrupt: (() => void) | undefined;
  #cancelled = false;

  constructor(options: HostPairingOptions) {
    this.#options = options;
    this.#url = endpoint(options.apiUrl);
    this.#clock = options.clock ?? systemClock;
  }

  async start(): Promise<HostPairingStartResponse> {
    let request;
    try {
      request = parseHostPairingStartRequest({
        installId: this.#options.installId, name: hostName(this.#options.name ?? hostname()),
        daemonVersion: this.#options.daemonVersion, protocol: PROTOCOL_VERSION, rowSchemaVersion: ROW_SCHEMA_VERSION,
      });
    } catch { throw new HostPairingFailure('unavailable', 'Invalid host pairing request.'); }
    const sent = await this.#post('/api/v1/hosts/pairings', request);
    if (!sent) throw new HostPairingFailure('unavailable', 'Browser pairing could not reach Felan.');
    if (sent.status === 426) {
      throw new HostPairingFailure('unsupported_schema', 'Remote publication requires a supported schema version.', errorBody(sent.body)?.supported);
    }
    if (sent.status !== 200) throw new HostPairingFailure('unavailable', 'Browser pairing is temporarily unavailable.');
    try {
      const start = parseHostPairingStartResponse(sent.body);
      if (start.expiresAt <= this.#clock.now()) throw new Error();
      return start;
    } catch { throw new HostPairingFailure('unavailable', 'Invalid browser pairing response.'); }
  }

  async wait(start: HostPairingStartResponse): Promise<HostPairingPollResponse> {
    let interval = start.interval * 1_000;
    let delay = interval;
    for (;;) {
      await this.#pause(Math.min(delay, start.expiresAt - this.#clock.now()));
      if (this.#clock.now() >= start.expiresAt) throw expired();
      const result = await this.#poll(start.deviceCode);
      if ('grant' in result) return result.grant;
      if (result.slowDown) interval += SLOW_DOWN_MS;
      delay = result.retryAfterMs ?? interval;
    }
  }

  cancel(): void {
    this.#cancelled = true;
    this.#controller?.abort();
    this.#interrupt?.();
  }

  async #poll(deviceCode: string): Promise<PollResult> {
    const sent = await this.#post('/api/v1/hosts/pairings/poll', { deviceCode });
    if (!sent) return { slowDown: false };
    if (sent.status === 200) {
      try { return { grant: parseHostPairingPollResponse(sent.body) }; }
      catch { throw new HostPairingFailure('unavailable', 'Invalid browser pairing response.'); }
    }
    const error = errorBody(sent.body);
    switch (error?.code) {
      case 'authorization_pending': return { slowDown: false };
      case 'slow_down': return { slowDown: true };
      case 'access_denied': throw new HostPairingFailure('denied', 'Browser pairing was denied.');
      case 'expired_token': throw expired();
      case 'unsupported_schema': throw new HostPairingFailure('unsupported_schema', 'Remote publication requires a supported schema version.', error.supported);
      case 'rate_limited': return { slowDown: false, retryAfterMs: this.#retryAfter(sent) };
    }
    if (sent.status === 429) return { slowDown: false, retryAfterMs: this.#retryAfter(sent) };
    if (sent.status >= 500) return { slowDown: false };
    throw new HostPairingFailure('unavailable', 'Browser pairing was refused.');
  }

  #retryAfter(sent: Sent): number | undefined {
    return retryAfter(sent.headers.get('Retry-After'), this.#clock.now(), RETRY_AFTER_CAP_MS);
  }

  #assertActive(): void {
    if (this.#cancelled) throw new HostPairingFailure('cancelled', 'Browser pairing was cancelled.');
  }

  #pause(ms: number): Promise<void> {
    this.#assertActive();
    return new Promise<void>((resolve, reject) => {
      const timer: TimerHandle = schedule(this.#clock, () => { this.#interrupt = undefined; resolve(); }, ms);
      this.#interrupt = () => { this.#clock.clearTimeout(timer); this.#interrupt = undefined; reject(new HostPairingFailure('cancelled', 'Browser pairing was cancelled.')); };
    });
  }

  // Transport failures are transient for the poll loop; cancellation takes precedence over them.
  async #post(path: string, body: unknown): Promise<Sent | undefined> {
    try { return await this.#send(path, body); }
    catch { this.#assertActive(); return undefined; }
  }

  async #send(path: string, body: unknown): Promise<Sent> {
    this.#assertActive();
    const controller = new AbortController();
    this.#controller = controller;
    const timeout = schedule(this.#clock, () => controller.abort(), this.#options.requestTimeoutMs ?? 15_000);
    try {
      const response = await (this.#options.fetch ?? fetch)(`${this.#url}${path}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: controller.signal, redirect: 'error',
      });
      return { status: response.status, headers: response.headers, body: await response.json().catch(() => undefined) };
    } finally {
      this.#clock.clearTimeout(timeout);
      if (this.#controller === controller) this.#controller = undefined;
    }
  }
}
