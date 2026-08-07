import { createServer } from 'node:http';
import { describe, expect, it } from 'vitest';
import { reserveOAuthCallback } from '../src/mcp/callback-server.js';

describe('local MCP OAuth callback server', () => {
  it('binds loopback, validates path and state, and rejects callback replay', async () => {
    const port = await availablePort();
    const controller = new AbortController();
    const firstState = 'a'.repeat(43);
    const secondState = 'b'.repeat(43);
    const redirectUri = `http://127.0.0.1:${port}/callback`;
    const secondRedirectUri = `http://127.0.0.1:${port}/other-callback`;
    const first = await reserveOAuthCallback(redirectUri, firstState, controller.signal);
    const second = await reserveOAuthCallback(secondRedirectUri, secondState, controller.signal);

    const wrong = await fetch(`${redirectUri}?code=wrong&state=${'c'.repeat(43)}`);
    expect(wrong.status).toBe(400);
    const response = await fetch(`${redirectUri}?code=accepted&state=${firstState}&iss=${encodeURIComponent('https://issuer.test')}`);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('content-security-policy')).toContain("default-src 'none'");
    await expect(first.wait()).resolves.toEqual({ code: 'accepted', iss: 'https://issuer.test' });

    const replay = await fetch(`${redirectUri}?code=replay&state=${firstState}`);
    expect(replay.status).toBe(400);
    const secondResponse = await fetch(`${secondRedirectUri}?code=second&state=${secondState}`);
    expect(secondResponse.status).toBe(200);
    await expect(second.wait()).resolves.toEqual({ code: 'second' });
  });

  it('cancels pending callbacks on abort and timeout', async () => {
    const firstPort = await availablePort();
    const controller = new AbortController();
    const aborted = await reserveOAuthCallback(
      `http://127.0.0.1:${firstPort}/callback`,
      'd'.repeat(43),
      controller.signal,
    );
    controller.abort(new Error('test abort'));
    await expect(aborted.wait()).rejects.toThrow('test abort');

    const secondPort = await availablePort();
    const timedOut = await reserveOAuthCallback(
      `http://127.0.0.1:${secondPort}/callback`,
      'e'.repeat(43),
      new AbortController().signal,
      10,
    );
    await expect(timedOut.wait()).rejects.toThrow('timed out');
  });

  it('rejects non-loopback redirect listeners', async () => {
    await expect(reserveOAuthCallback(
      'https://example.test/callback',
      'f'.repeat(43),
      new AbortController().signal,
    )).rejects.toThrow('loopback');
  });
});

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No test port');
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}
