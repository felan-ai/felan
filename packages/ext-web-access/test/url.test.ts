import { describe, expect, it } from 'vitest';
import { canonicalUrlKey } from '../src/url.js';

describe('URL deduplication keys', () => {
  it('removes host casing, default ports, and fragments only', () => {
    expect(canonicalUrlKey('HTTPS://Example.com:443/docs#one'))
      .toBe(canonicalUrlKey('https://example.com/docs#two'));
    expect(canonicalUrlKey('http://example.com:80/docs'))
      .toBe(canonicalUrlKey('http://EXAMPLE.com/docs#fragment'));
  });

  it('keeps non-default ports and query strings distinct', () => {
    expect(canonicalUrlKey('https://example.com:8443/docs'))
      .not.toBe(canonicalUrlKey('https://example.com/docs'));
    expect(canonicalUrlKey('https://example.com/docs?a=1'))
      .not.toBe(canonicalUrlKey('https://example.com/docs?a=2'));
  });
});
