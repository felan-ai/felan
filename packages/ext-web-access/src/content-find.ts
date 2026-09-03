const CONTEXT_CHARACTERS = 160;
const MAX_MATCHES_PER_QUERY = 100;
const MAX_IDENTIFIER_QUERY_CHARACTERS = 500;
const MAX_IDENTIFIER_TOKENS = 32;
const IDENTIFIER_SEPARATOR_PATTERN = '[ _.\\/:\\-]{1,8}';
export const MAX_MERGED_SNIPPET_BYTES = 4_000;

export interface ContentMatch {
  start: number;
  end: number;
  contextStart: number;
  contextEnd: number;
  snippet: string;
}

export interface QueryMatches {
  matches: ContentMatch[];
  matchCount: number;
  truncated: boolean;
}

export interface MergedContentMatch {
  queryIndexes: number[];
  matchCount: number;
  snippet: string;
}

interface LocatedMatch {
  start: number;
  end: number;
}

export function findContentMatches(text: string, queries: string[]): QueryMatches[] {
  return queries.map((query) => {
    if (!query) return { matches: [], matchCount: 0, truncated: false };
    const scans = matchingExpressions(query).map((expression) => scanMatches(text, expression));
    const unique = new Map<string, LocatedMatch>();
    for (const scan of scans) {
      for (const match of scan.matches) unique.set(`${match.start}:${match.end}`, match);
    }
    const located = [...unique.values()].sort((left, right) => left.start - right.start || left.end - right.end);
    const matches = located.slice(0, MAX_MATCHES_PER_QUERY).map((match): ContentMatch => {
      const index = match.start;
      const start = Math.max(0, index - CONTEXT_CHARACTERS);
      const end = Math.min(text.length, match.end + CONTEXT_CHARACTERS);
      return {
        start: index,
        end: match.end,
        contextStart: start,
        contextEnd: end,
        snippet: snippetForRange(text, start, end),
      };
    });
    return {
      matches,
      matchCount: matches.length,
      truncated: located.length > MAX_MATCHES_PER_QUERY || scans.some((scan) => scan.truncated),
    };
  });
}

export function mergeContentMatches(text: string, queryMatches: QueryMatches[]): MergedContentMatch[] {
  const ordered = queryMatches
    .flatMap((result, queryIndex) => result.matches.map((match) => ({ ...match, queryIndex })))
    .sort((left, right) => left.contextStart - right.contextStart
      || left.contextEnd - right.contextEnd
      || left.queryIndex - right.queryIndex);
  const ranges: Array<{
    contextStart: number;
    contextEnd: number;
    queryIndexes: Set<number>;
    matchCount: number;
  }> = [];
  for (const match of ordered) {
    const current = ranges.at(-1);
    if (current && match.contextStart <= current.contextEnd) {
      const contextEnd = Math.max(current.contextEnd, match.contextEnd);
      const snippetBytes = Buffer.byteLength(snippetForRange(text, current.contextStart, contextEnd), 'utf8');
      if (snippetBytes <= MAX_MERGED_SNIPPET_BYTES) {
        current.contextEnd = contextEnd;
        current.queryIndexes.add(match.queryIndex);
        current.matchCount += 1;
        continue;
      }
    }
    ranges.push({
      contextStart: match.contextStart,
      contextEnd: match.contextEnd,
      queryIndexes: new Set([match.queryIndex]),
      matchCount: 1,
    });
  }

  const deduplicated = new Map<string, MergedContentMatch>();
  for (const range of ranges) {
    const snippet = snippetForRange(text, range.contextStart, range.contextEnd);
    const existing = deduplicated.get(snippet);
    if (existing) {
      existing.queryIndexes = [...new Set([...existing.queryIndexes, ...range.queryIndexes])].sort((a, b) => a - b);
      existing.matchCount += range.matchCount;
      continue;
    }
    deduplicated.set(snippet, {
      queryIndexes: [...range.queryIndexes].sort((a, b) => a - b),
      matchCount: range.matchCount,
      snippet,
    });
  }
  return [...deduplicated.values()];
}

function matchingExpressions(query: string): RegExp[] {
  const variantPattern = separatorAwareIdentifierPattern(query);
  if (variantPattern === null) return [new RegExp(escapeRegExp(query), 'giu')];
  const leftBoundary = '(?<![\\p{L}\\p{N}])(?<![\\p{L}\\p{N}][_.\\/:\\-])';
  const rightBoundary = '(?![\\p{L}\\p{N}])(?!(?:[_.\\/:\\-][\\p{L}\\p{N}]))';
  return [escapeRegExp(query), variantPattern].map((pattern) => (
    new RegExp(`${leftBoundary}${pattern}${rightBoundary}`, 'giu')
  ));
}

function separatorAwareIdentifierPattern(query: string): string | null {
  if (query.length > MAX_IDENTIFIER_QUERY_CHARACTERS || !/[_.\/\-:]/u.test(query)) return null;
  const tokens = query.split(/[_.\/\-:]+/u);
  if (tokens.length < 2 || tokens.length > MAX_IDENTIFIER_TOKENS
    || tokens.some((token) => !/^[\p{L}\p{N}]+$/u.test(token))) {
    return null;
  }
  return tokens.map(escapeRegExp).join(IDENTIFIER_SEPARATOR_PATTERN);
}

function scanMatches(text: string, expression: RegExp): { matches: LocatedMatch[]; truncated: boolean } {
  const matches: LocatedMatch[] = [];
  for (const result of text.matchAll(expression)) {
    matches.push({ start: result.index, end: result.index + result[0].length });
    if (matches.length > MAX_MATCHES_PER_QUERY) {
      return { matches, truncated: true };
    }
  }
  return { matches, truncated: false };
}

function snippetForRange(text: string, start: number, end: number): string {
  return `${start > 0 ? '…' : ''}${text.slice(start, end).replace(/\s+/gu, ' ').trim()}${end < text.length ? '…' : ''}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
