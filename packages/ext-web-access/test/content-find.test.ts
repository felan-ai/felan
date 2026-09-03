import { describe, expect, it } from 'vitest';
import { findContentMatches, mergeContentMatches } from '../src/content-find.js';

describe('findContentMatches', () => {
  it('finds case-insensitive literal matches with bounded context', () => {
    const [result] = findContentMatches(`prefix ${'x'.repeat(200)} Alpha\n evidence ALPHA suffix`, ['alpha']);

    expect(result).toMatchObject({ matchCount: 2, truncated: false });
    expect(result!.matches).toHaveLength(2);
    expect(result!.matches[0]).toMatchObject({ start: 208, end: 213 });
    expect(result!.matches[0]!.snippet).toMatch(/^…/u);
    expect(result!.matches[1]!.snippet).toContain('evidence ALPHA suffix');
  });

  it('treats regular-expression characters literally and reports missing terms', () => {
    const [literal, missing] = findContentMatches('Use findContentMatches(value) and a.b, not axb.', [
      'findContentMatches(value)',
      'missing.*term',
    ]);

    expect(literal).toMatchObject({ matchCount: 1, truncated: false });
    expect(literal!.matches[0]!.snippet).toContain('findContentMatches(value)');
    expect(missing).toEqual({ matches: [], matchCount: 0, truncated: false });
  });

  it('matches bounded identifier separator variants without enabling fuzzy search', () => {
    const text = 'foo bar, FOO_bar, foo-bar, foo.bar, foo/bar, foo:bar; not foo+bar or xfoo bar or foo barista';
    const [result] = findContentMatches(text, ['foo_bar']);

    expect(result).toMatchObject({ matchCount: 6, truncated: false });
    expect(result!.matches.map((match) => text.slice(match.start, match.end))).toEqual([
      'foo bar',
      'FOO_bar',
      'foo-bar',
      'foo.bar',
      'foo/bar',
      'foo:bar',
    ]);
  });

  it('preserves exact identifiers at punctuation and path boundaries without continuation matches', () => {
    const hyphenText = 'Use foo-bar. Set foo-bar: value; reject xfoo-bar and foo-bar-baz.';
    const pathText = 'Read /foo/bar/ but reject x/foo/bar and /foo/bar/baz.';
    const [hyphen] = findContentMatches(hyphenText, ['foo-bar']);
    const [path] = findContentMatches(pathText, ['foo/bar']);

    expect(hyphen!.matches.map((match) => hyphenText.slice(match.start, match.end)))
      .toEqual(['foo-bar', 'foo-bar']);
    expect(path!.matches.map((match) => pathText.slice(match.start, match.end)))
      .toEqual(['foo/bar']);
  });

  it('keeps plain prose exact and rejects identifier substrings and unrelated punctuation', () => {
    const [plain, mixed, identifier] = findContentMatches(
      'web-access web access; web_access-policy web-access policy; xfoo bar, foo barista, foo+bar, foo-bar-baz, foo_bar_baz, foo bar',
      ['web access', 'web-access policy', 'foo-bar'],
    );

    expect(plain!.matches).toHaveLength(1);
    expect(mixed!.matches).toHaveLength(1);
    expect(mixed!.matches[0]!.snippet).toContain('web-access policy');
    expect(identifier!.matches).toHaveLength(1);
    expect(identifier!.matches[0]!.snippet).toContain('foo bar');
  });

  it('bounds separator pattern complexity and treats adversarial input literally', () => {
    const query = Array.from({ length: 40 }, () => 'a').join('-');
    const [result] = findContentMatches(`${query} ${'a '.repeat(10_000)}`, [query]);

    expect(result).toMatchObject({ matchCount: 1, truncated: false });
  });

  it('merges touching context windows and deduplicates identical snippets with query attribution', () => {
    const text = `${'a'.repeat(170)} alpha ${'b'.repeat(10)} beta ${'c'.repeat(400)}`;
    const found = findContentMatches(text, ['alpha', 'beta']);
    const merged = mergeContentMatches(text, found);

    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ queryIndexes: [0, 1], matchCount: 2 });
    expect(merged[0]!.snippet).toContain('alpha');
    expect(merged[0]!.snippet).toContain('beta');

    const repeatedText = `${'x'.repeat(400)} alpha ${'x'.repeat(400)} alpha ${'x'.repeat(400)}`;
    const deduplicated = mergeContentMatches(repeatedText, findContentMatches(repeatedText, ['alpha']));
    expect(deduplicated).toHaveLength(1);
    expect(deduplicated[0]).toMatchObject({ queryIndexes: [0], matchCount: 2 });
  });

  it('splits transitive overlap chains before a merged snippet exceeds 4,000 UTF-8 bytes', () => {
    const text = Array.from({ length: 20 }, (_, index) => (
      `term ${index.toString().padStart(2, '0')} ${'x'.repeat(290)}`
    )).join('');
    const merged = mergeContentMatches(text, findContentMatches(text, ['term']));

    expect(merged.length).toBeGreaterThan(1);
    expect(merged.reduce((total, match) => total + match.matchCount, 0)).toBe(20);
    expect(merged.every((match) => Buffer.byteLength(match.snippet, 'utf8') <= 4_000)).toBe(true);
  });

  it('bounds pathological match enumeration per query', () => {
    const [result] = findContentMatches('a'.repeat(1_000), ['a']);

    expect(result).toMatchObject({ matchCount: 100, truncated: true });
    expect(result!.matches).toHaveLength(100);
  });
});
