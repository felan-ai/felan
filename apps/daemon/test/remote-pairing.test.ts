import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HostPairingStartResponse } from '@felan-ai/session-protocol';
import { HostPairing, HostPairingFailure } from '../src/remote/pairing.js';
import type { RemoteClock } from '../src/remote/backoff.js';

const id = '0199e5f0-0000-7000-8000-000000000001';
const deviceCode = 'device-code-secret-that-must-never-escape';
const credential = 'fln_pat_approved_secret_that_must_never_escape';
const granted = { credential, host: { id, teamId: id, userId: id } };
const clock: RemoteClock = {
  now: () => Date.now(),
  setTimeout: (callback, delay) => setTimeout(callback, delay),
  clearTimeout: timer => clearTimeout(timer as ReturnType<typeof setTimeout>),
};
function start(overrides: Partial<HostPairingStartResponse> = {}): HostPairingStartResponse {
  return {
    deviceCode, userCode: 'BCDF-GHJK', verificationUri: 'https://app.example.test/pair',
    verificationUriComplete: 'https://app.example.test/pair?code=BCDF-GHJK', interval: 1, expiresAt: 600_000, ...overrides,
  };
}
function json(status: number, data: unknown, headers?: HeadersInit) {
  return new Response(JSON.stringify(data), { status, ...(headers ? { headers } : {}) });
}
const pending = () => json(400, { code: 'authorization_pending', message: 'Authorization is pending.' });
const slowDown = () => json(400, { code: 'slow_down', message: 'Slow down.' });
function pairing(fetcher: typeof fetch, options: Partial<ConstructorParameters<typeof HostPairing>[0]> = {}) {
  return new HostPairing({ apiUrl: 'https://api.example.test/', installId: id, daemonVersion: '0.1.0', fetch: fetcher, clock, ...options });
}
function settle<T>(work: Promise<T>): Promise<{ value: T } | { error: unknown }> {
  return work.then(value => ({ value }), error => ({ error }));
}
const polls = (fetcher: ReturnType<typeof vi.fn<typeof fetch>>) => fetcher.mock.calls.filter(([url]) => String(url).endsWith('/pairings/poll')).length;

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0); });
afterEach(() => { vi.useRealTimers(); });

describe('HostPairing start', () => {
  it('starts a pairing without credentials and returns the verification details', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(200, start()));
    expect(await pairing(fetcher, { name: '🌍'.repeat(40) }).start()).toEqual(start());
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe('https://api.example.test/api/v1/hosts/pairings');
    expect(init?.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(init?.redirect).toBe('error');
    expect(JSON.parse(String(init?.body))).toEqual({ installId: id, name: '🌍'.repeat(32), daemonVersion: '0.1.0', protocol: 1, rowSchemaVersion: 1 });
  });

  it.each([
    [426, { code: 'unsupported_schema', message: 'Upgrade.', supported: { protocol: [1], rowSchemaVersion: [2, 3] } }, 'unsupported_schema'],
    [503, { code: 'oops', message: 'Unavailable.' }, 'unavailable'],
    [429, { code: 'rate_limited', message: 'Slow down.' }, 'unavailable'],
    [200, { deviceCode }, 'unavailable'],
    [200, start({ expiresAt: 0 }), 'unavailable'],
  ])('maps start HTTP %s to %s', async (status, body, kind) => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(() => Promise.resolve(json(status, body)));
    const error = await pairing(fetcher).start().catch(value => value as HostPairingFailure);
    expect(error).toBeInstanceOf(HostPairingFailure);
    expect(error.kind).toBe(kind);
    if (status === 426) expect(error.supported).toEqual({ protocol: [1], rowSchemaVersion: [2, 3] });
    expect(`${error.stack} ${JSON.stringify(error)}`).not.toContain(deviceCode);
  });

  it('reports a network failure as unavailable', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('network down'));
    await expect(pairing(fetcher).start()).rejects.toMatchObject({ kind: 'unavailable' });
  });
});

describe('HostPairing wait', () => {
  it('polls at the server interval and returns the credential once approved', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementationOnce(() => Promise.resolve(pending())).mockImplementationOnce(() => Promise.resolve(json(200, granted)));
    const result = settle(pairing(fetcher).wait(start()));
    await vi.advanceTimersByTimeAsync(999); expect(fetcher).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); expect(polls(fetcher)).toBe(1);
    await vi.advanceTimersByTimeAsync(999); expect(polls(fetcher)).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toEqual({ value: granted });
    expect(polls(fetcher)).toBe(2);
    expect(fetcher.mock.calls[1]![0]).toBe('https://api.example.test/api/v1/hosts/pairings/poll');
    expect(JSON.parse(String(fetcher.mock.calls[1]![1]?.body))).toEqual({ deviceCode });
    expect(fetcher.mock.calls[1]![1]?.headers).toEqual({ 'Content-Type': 'application/json' });
  });

  it('adds five seconds to the interval after slow_down', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementationOnce(() => Promise.resolve(slowDown())).mockImplementationOnce(() => Promise.resolve(json(200, granted)));
    const result = settle(pairing(fetcher).wait(start()));
    await vi.advanceTimersByTimeAsync(1_000); expect(polls(fetcher)).toBe(1);
    await vi.advanceTimersByTimeAsync(5_999); expect(polls(fetcher)).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toEqual({ value: granted });
  });

  it('honors Retry-After on rate limiting before the next poll', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementationOnce(() => Promise.resolve(json(429, { code: 'rate_limited', message: 'Slow down.' }, { 'Retry-After': '7' })))
      .mockImplementationOnce(() => Promise.resolve(json(200, granted)));
    const result = settle(pairing(fetcher).wait(start()));
    await vi.advanceTimersByTimeAsync(1_000); expect(polls(fetcher)).toBe(1);
    await vi.advanceTimersByTimeAsync(6_999); expect(polls(fetcher)).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toEqual({ value: granted });
  });

  it('retries network failures and server errors at the interval', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('network down'))
      .mockImplementationOnce(() => Promise.resolve(json(503, { code: 'oops', message: 'Unavailable.' })))
      .mockImplementationOnce(() => Promise.resolve(json(200, granted)));
    const result = settle(pairing(fetcher).wait(start()));
    await vi.advanceTimersByTimeAsync(1_000); expect(polls(fetcher)).toBe(1);
    await vi.advanceTimersByTimeAsync(1_000); expect(polls(fetcher)).toBe(2);
    await vi.advanceTimersByTimeAsync(1_000); expect(polls(fetcher)).toBe(3);
    expect(await result).toEqual({ value: granted });
  });

  it('stops polling at expiresAt and reports expiry', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(() => Promise.resolve(pending()));
    const result = settle(pairing(fetcher).wait(start({ expiresAt: 3_000 })));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await result).toMatchObject({ error: { kind: 'expired' } });
    expect(polls(fetcher)).toBe(2);
  });

  it('reports a denial from the user', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(() => Promise.resolve(json(400, { code: 'access_denied', message: 'Denied.' })));
    const result = settle(pairing(fetcher).wait(start()));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await result).toMatchObject({ error: { kind: 'denied' } });
    expect(polls(fetcher)).toBe(1);
  });

  it('reports an expired or consumed device code', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(() => Promise.resolve(json(400, { code: 'expired_token', message: 'Expired.' })));
    const result = settle(pairing(fetcher).wait(start()));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await result).toMatchObject({ error: { kind: 'expired' } });
  });

  it('reports an unsupported schema while polling', async () => {
    const supported = { protocol: [1], rowSchemaVersion: [2] };
    const fetcher = vi.fn<typeof fetch>().mockImplementation(() => Promise.resolve(json(400, { code: 'unsupported_schema', message: 'Upgrade.', supported })));
    const result = settle(pairing(fetcher).wait(start()));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await result).toMatchObject({ error: { kind: 'unsupported_schema', supported } });
  });

  it('treats an unexpected poll refusal as unavailable instead of retrying', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(() => Promise.resolve(json(404, { code: 'missing', message: 'Missing.' })));
    const result = settle(pairing(fetcher).wait(start()));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await result).toMatchObject({ error: { kind: 'unavailable' } });
    expect(polls(fetcher)).toBe(1);
  });

  it('rejects a malformed approval without exposing the credential', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(() => Promise.resolve(json(200, { credential: '' })));
    const result = settle(pairing(fetcher).wait(start()));
    await vi.advanceTimersByTimeAsync(1_000);
    const outcome = await result;
    expect(outcome).toMatchObject({ error: { kind: 'unavailable' } });
    expect(`${JSON.stringify(outcome)}`).not.toContain(deviceCode);
  });

  it('cancels a pending wait without polling again and keeps secrets out of errors', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(() => Promise.resolve(pending()));
    const value = pairing(fetcher);
    const result = settle(value.wait(start()));
    await vi.advanceTimersByTimeAsync(1_000); expect(polls(fetcher)).toBe(1);
    value.cancel();
    const outcome = await result;
    expect(outcome).toMatchObject({ error: { kind: 'cancelled' } });
    expect(`${(outcome as { error: Error }).error.stack} ${JSON.stringify(outcome)}`).not.toContain(deviceCode);
    await vi.advanceTimersByTimeAsync(60_000); expect(polls(fetcher)).toBe(1);
  });

  it('aborts an in-flight poll on cancel', async () => {
    let signal: AbortSignal | null | undefined;
    const fetcher = vi.fn<typeof fetch>().mockImplementation((_url, init) => {
      signal = init?.signal;
      return new Promise<Response>((_resolve, reject) => { signal?.addEventListener('abort', () => reject(new Error('aborted'))); });
    });
    const value = pairing(fetcher);
    const result = settle(value.wait(start()));
    await vi.advanceTimersByTimeAsync(1_000); expect(polls(fetcher)).toBe(1);
    value.cancel();
    expect(signal?.aborted).toBe(true);
    expect(await result).toMatchObject({ error: { kind: 'cancelled' } });
  });
});
