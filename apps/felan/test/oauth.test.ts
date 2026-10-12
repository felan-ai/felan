import { beforeEach, describe, expect, it, vi } from 'vitest';
import open from 'open';
import { openLocalOAuthUrl } from '../src/oauth.js';

vi.mock('open', () => ({ default: vi.fn() }));
beforeEach(() => vi.mocked(open).mockReset());

describe('local OAuth browser opener', () => {
  it.each(['https://oauth.example.test/authorize?state=fixture', 'http://127.0.0.1:1234/authorize', 'http://[::1]:1234/authorize'])('opens an allowed URL only in the client: %s', async url => {
    await openLocalOAuthUrl(url, new AbortController().signal);
    expect(open).toHaveBeenCalledExactlyOnceWith(url);
  });

  it.each(['javascript:alert(1)', 'file:///tmp/secret', 'http://oauth.example.test/authorize', 'https://name:password@example.test', 'https://example.test/\nnext'])('refuses an unsafe URL: %s', async url => {
    await expect(openLocalOAuthUrl(url, new AbortController().signal)).rejects.toThrow();
    expect(open).not.toHaveBeenCalled();
  });

  it('does not open after cancellation', async () => {
    await expect(openLocalOAuthUrl('https://oauth.example.test', AbortSignal.abort())).rejects.toThrow();
    expect(open).not.toHaveBeenCalled();
  });
});
