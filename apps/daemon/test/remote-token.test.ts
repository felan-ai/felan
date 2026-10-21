import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HostTokenExchangeError, HostTokenSource } from '../src/remote/token.js';
import { retryDelay, type RemoteClock, type TimerHandle } from '../src/remote/backoff.js';

const id = '0199e5f0-0000-7000-8000-000000000001';
const pat = 'fln_pat_test_secret_that_must_never_escape';
const clock: RemoteClock = {
  now: () => Date.now(),
  setTimeout: (callback, delay) => setTimeout(callback, delay),
  clearTimeout: timer => clearTimeout(timer as ReturnType<typeof setTimeout>),
};
function body(token = 'opaque-host-token', refreshAt = 10_000, expiresAt = 20_000) {
  return { token, refreshAt, expiresAt, host: { id, teamId: id, userId: id }, supabase: { url: 'https://db.example.test', publishableKey: 'public' } };
}
function response(status = 200, data: unknown = body(), headers?: HeadersInit) {
  return new Response(JSON.stringify(data), { status, ...(headers ? { headers } : {}) });
}
const sources: HostTokenSource[] = [];
function source(fetcher: typeof fetch, options: Partial<ConstructorParameters<typeof HostTokenSource>[0]> = {}) {
  const value = new HostTokenSource({ apiUrl: 'https://api.example.test/', pat, installId: id, daemonVersion: '0.1.0', fetch: fetcher, clock, random: () => 1, ...options });
  sources.push(value);
  return value;
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0); });
afterEach(() => { for (const value of sources.splice(0)) value.stop(); vi.useRealTimers(); });

describe('HostTokenSource', () => {
  it('exchanges a team API key without requiring a user identity in the host response', async () => {
    const team = { ...body(), host: { id, teamId: id } };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(200, team));
    const value = source(fetcher, { pat: 'bzy_team_fixture_secret' });
    expect(await value.token()).toBe(team.token);
    expect(fetcher.mock.calls[0]![1]?.headers).toMatchObject({ Authorization: 'Bearer bzy_team_fixture_secret' });
    expect(value.current()?.host).toEqual({ id, teamId: id });
  });

  it('validates the exchange request, caches, truncates by UTF-8 bytes and exposes no token in current()', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response());
    const value = source(fetcher, { name: '🌍'.repeat(40) });
    expect(await value.token()).toBe('opaque-host-token');
    expect(await value.token()).toBe('opaque-host-token');
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe('https://api.example.test/api/v1/hosts/token');
    expect(init?.headers).toMatchObject({ Authorization: `Bearer ${pat}`, 'Content-Type': 'application/json' });
    expect(init?.redirect).toBe('error');
    expect(JSON.parse(String(init?.body))).toEqual({ installId: id, name: '🌍'.repeat(32), daemonVersion: '0.1.0', protocol: 1, rowSchemaVersion: 1 });
    expect(value.current()).toEqual({ ...body(), token: undefined });
    expect(JSON.stringify(value.current())).not.toContain('opaque-host-token');
  });

  it('renews proactively at refreshAt, single-flights and notifies observers', async () => {
    let resolve!: (response: Response) => void;
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response())
      .mockImplementationOnce(() => new Promise<Response>(done => { resolve = done; }));
    const value = source(fetcher);
    const changed = vi.fn();
    const off = value.onChange(changed);
    await value.token();
    await vi.advanceTimersByTimeAsync(9_999);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    const first = value.token();
    const second = value.token();
    expect(fetcher).toHaveBeenCalledTimes(2);
    resolve(response(200, body('renewed', 30_000, 40_000)));
    expect(await first).toBe('renewed');
    expect(await second).toBe('renewed');
    expect(changed).toHaveBeenCalledTimes(2);
    expect(changed.mock.calls[1]?.[0]).toBe('renewed');
    expect(value.cachedToken()).toBe('renewed');
    off();
  });

  it('keeps the cached token on retryable renewal only until expiresAt', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(response()).mockRejectedValue(new Error(`network ${pat}`));
    const value = source(fetcher);
    await value.token();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await value.token()).toBe('opaque-host-token');
    expect(fetcher).toHaveBeenCalledTimes(2);
    vi.setSystemTime(20_000);
    expect(value.cachedToken()).toBeNull();
    await expect(value.token()).rejects.toMatchObject({ kind: 'retry', retryable: true });
  });

  it.each([
    [401, 'invalid_pat', 'invalid_pat'], [403, 'not_a_member', 'not_a_member'],
    [403, 'host_revoked', 'host_revoked'], [403, 'unexpected', 'unavailable'],
    [400, 'invalid', 'unavailable'], [404, 'missing', 'unavailable'],
    [426, 'unsupported_schema', 'unsupported_schema'], [429, 'rate_limited', 'retry'], [503, 'oops', 'retry'],
  ])('maps HTTP %s / %s to %s without leaking the PAT', async (status, code, kind) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(status as number, {
      code, message: `${pat} Bearer token`, supported: { protocol: [1], rowSchemaVersion: [1, 2] },
    }));
    const value = source(fetcher);
    const error = await value.token().catch(value => value as HostTokenExchangeError);
    expect(error).toBeInstanceOf(HostTokenExchangeError);
    if (!(error instanceof HostTokenExchangeError)) throw new Error('Expected token exchange failure');
    expect(error.kind).toBe(kind);
    expect(error.retryable).toBe(kind === 'retry' || kind === 'unavailable');
    expect(`${error.stack} ${JSON.stringify(error)}`).not.toContain(pat);
    if (status === 426) expect(error.supported).toEqual({ protocol: [1], rowSchemaVersion: [1, 2] });
    if (!error.retryable) {
      await vi.advanceTimersByTimeAsync(60_000);
      await expect(value.token()).rejects.toBe(error);
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
  });

  it.each([
    new Response('<html>Sign in to this network</html>', { status: 200 }),
    response(200, { token: pat }),
    response(400, { code: 'unexpected' }),
    response(403, { code: 'unexpected' }),
    response(404, { code: 'missing' }),
  ])('recovers from malformed responses and non-terminal HTTP failures after backoff', async failure => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(failure).mockResolvedValue(response());
    const value = source(fetcher);
    await expect(value.token()).rejects.toMatchObject({ retryable: true });
    await expect(value.token()).rejects.toMatchObject({ retryable: true });
    await vi.advanceTimersByTimeAsync(999);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await value.token()).toBe('opaque-host-token');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('identifies rate-limited exchanges without relying on response text', async () => {
    await expect(source(vi.fn<typeof fetch>().mockResolvedValue(response(429, {}))).token())
      .rejects.toMatchObject({ kind: 'retry', retryable: true, rateLimited: true });
  });

  it.each(['10', 'Thu, 01 Jan 1970 00:00:10 GMT'])('honors Retry-After %s', async header => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(response(429, {}, { 'Retry-After': header })).mockResolvedValue(response(200, body('later', 30_000, 40_000)));
    const value = source(fetcher);
    await expect(value.token()).rejects.toMatchObject({ retryAfterMs: 10_000 });
    await vi.advanceTimersByTimeAsync(9_999);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(await value.token()).toBe('later');
  });

  it('does not trust malformed or wrapped token error bodies as schema negotiation', async () => {
    for (const data of [
      { error: { code: 'unsupported_schema', message: pat, supported: { protocol: [1], rowSchemaVersion: [2] } } },
      { code: 'unsupported_schema', message: pat, supported: { protocol: ['1'], rowSchemaVersion: [2] } },
    ]) {
      const failure = await source(vi.fn<typeof fetch>().mockResolvedValue(response(426, data))).token().catch(error => error as HostTokenExchangeError);
      expect(failure).toMatchObject({ kind: 'unsupported_schema', supported: undefined, message: 'Remote publication requires a supported schema version.' });
    }
  });

  it('caps Retry-After and jittered exponential backoff', async () => {
    const value = source(vi.fn<typeof fetch>().mockResolvedValue(response(503, {}, { 'Retry-After': '100000' })));
    await expect(value.token()).rejects.toMatchObject({ retryAfterMs: 60_000 });
    expect([0, 1, 2, 20].map(attempt => retryDelay(attempt, { random: () => 1 }))).toEqual([1_000, 2_000, 4_000, 60_000]);
    expect(retryDelay(2, { random: () => 0 })).toBe(2_000);
  });

  it('invalidates a cached token and stops pending timers and exchanges', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => response());
    const value = source(fetcher);
    await value.token();
    value.invalidate();
    expect(value.current()).toBeUndefined();
    await value.token();
    expect(fetcher).toHaveBeenCalledTimes(2);
    value.stop();
    expect(value.cachedToken()).toBeNull();
    await vi.advanceTimersByTimeAsync(100_000);
    expect(fetcher).toHaveBeenCalledTimes(2);
    await expect(value.token()).rejects.toMatchObject({ kind: 'unavailable' });
  });

  it('does not use a still-valid cached token after terminal renewal failure', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(response()).mockResolvedValueOnce(response(401, {}));
    const value = source(fetcher);
    await value.token();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(value.cachedToken()).toBeNull();
    await expect(value.token()).rejects.toMatchObject({ kind: 'invalid_pat' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('aborts timed out requests without exposing the transport error', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error(pat)));
    }));
    const value = source(fetcher);
    const pending = expect(value.token()).rejects.toMatchObject({ kind: 'retry', message: 'Host token exchange is temporarily unavailable.' });
    await vi.advanceTimersByTimeAsync(15_000);
    await pending;
    value.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('unrefs timers and ignores late success after invalidation', async () => {
    const unref = vi.fn();
    const customClock: RemoteClock = { now: () => 0, setTimeout: () => ({ unref }), clearTimeout: vi.fn<(timer: TimerHandle) => void>() };
    let resolve!: (response: Response) => void;
    const value = source(vi.fn<typeof fetch>().mockImplementation(() => new Promise(done => { resolve = done; })), { clock: customClock });
    const pending = value.token();
    value.invalidate();
    resolve(response());
    await expect(pending).rejects.toMatchObject({ kind: 'unavailable' });
    expect(value.current()).toBeUndefined();
    expect(unref).toHaveBeenCalled();
  });

  it.each(['http://remote.test', 'ftp://localhost', 'https://user:secret@remote.test', 'invalid'])('rejects unsafe API URL %s', apiUrl => {
    expect(() => source(vi.fn(), { apiUrl })).toThrow('Remote API URL must use HTTPS');
  });

  it.each(['http://localhost:3000', 'http://127.0.0.1:3000', 'http://[::1]:3000', 'http://host.docker.internal:3000'])('allows local URL %s', apiUrl => {
    expect(() => source(vi.fn(), { apiUrl })).not.toThrow();
  });

  it('validates requests before sending and safely rejects malformed responses', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(200, { token: pat }));
    await expect(source(fetcher, { installId: 'bad' }).token()).rejects.toMatchObject({ kind: 'unavailable' });
    expect(fetcher).not.toHaveBeenCalled();
    const error = await source(fetcher).token().catch(value => value as Error);
    if (!(error instanceof Error)) throw new Error('Expected invalid response');
    expect(error.message).toBe('Invalid host token response.');
    expect(error.message).not.toContain(pat);
  });
});
