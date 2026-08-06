export type FindMode = 'exact' | 'case-insensitive' | 'fuzzy';

const CONTEXT_CHARACTERS = 400;
const MAX_OUTPUT_CHARACTERS = 20_000;

interface Match {
  query: string;
  start: number;
  end: number;
}

export function findContent(text: string, queries: string[], mode: FindMode) {
  const normalizedQueries = [...new Set(queries.map((query) => query.trim()).filter(Boolean))];
  const matches = normalizedQueries.flatMap((query) => mode === 'fuzzy'
    ? fuzzyMatches(text, query)
    : literalMatches(text, query, mode === 'case-insensitive'));
  const queryResults = normalizedQueries.map((query) => ({
    query,
    matchCount: matches.filter((match) => match.query === query).length,
  }));
  const snippets: string[] = [];
  let outputCharacters = 0;
  let returnedMatches = 0;
  for (const match of matches) {
    const start = Math.max(0, match.start - CONTEXT_CHARACTERS);
    const end = Math.min(text.length, match.end + CONTEXT_CHARACTERS);
    const snippet = `${start > 0 ? '…' : ''}${text.slice(start, end).replace(/\s+/gu, ' ').trim()}${end < text.length ? '…' : ''}`;
    if (outputCharacters + snippet.length > MAX_OUTPUT_CHARACTERS) break;
    snippets.push(snippet);
    outputCharacters += snippet.length;
    returnedMatches += 1;
  }
  return { mode, matchCount: matches.length, returnedMatches, queryResults, snippets };
}

function literalMatches(text: string, query: string, caseInsensitive: boolean): Match[] {
  const haystack = caseInsensitive ? text.toLocaleLowerCase() : text;
  const needle = caseInsensitive ? query.toLocaleLowerCase() : query;
  const matches: Match[] = [];
  for (let index = haystack.indexOf(needle); index >= 0; index = haystack.indexOf(needle, index + Math.max(needle.length, 1))) {
    matches.push({ query, start: index, end: index + query.length });
  }
  return matches;
}

function fuzzyMatches(text: string, query: string): Match[] {
  const queryTokens = normalize(query).match(/[\p{L}\p{N}]+/gu) ?? [];
  if (queryTokens.length === 0) return [];
  const matches: Match[] = [];
  for (const paragraph of text.matchAll(/[^\n]+(?:\n(?!\n)[^\n]+)*/gu)) {
    if (paragraph.index === undefined) continue;
    const tokens = [...paragraph[0].matchAll(/[\p{L}\p{N}]+/gu)];
    const matched = queryTokens.filter((queryToken) => tokens.some((token) => {
      const candidate = normalize(token[0]);
      const maximum = queryToken.length >= 9 ? 2 : queryToken.length >= 5 ? 1 : 0;
      return editDistanceWithin(queryToken, candidate, maximum);
    }));
    const required = queryTokens.length === 1 ? 1 : Math.ceil(queryTokens.length * 0.6);
    if (matched.length < required) continue;
    const first = tokens.find((token) => matched.some((queryToken) => editDistanceWithin(queryToken, normalize(token[0]), queryToken.length >= 9 ? 2 : queryToken.length >= 5 ? 1 : 0)));
    const start = paragraph.index + (first?.index ?? 0);
    matches.push({ query, start, end: start + (first?.[0].length ?? query.length) });
  }
  return matches;
}

function normalize(value: string): string {
  return value.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLocaleLowerCase();
}

function editDistanceWithin(left: string, right: string, maximum: number): boolean {
  if (Math.abs(left.length - right.length) > maximum) return false;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    let rowMinimum = leftIndex;
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const value = Math.min(
        previous[rightIndex]! + 1,
        current[rightIndex - 1]! + 1,
        previous[rightIndex - 1]! + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
      );
      current[rightIndex] = value;
      rowMinimum = Math.min(rowMinimum, value);
    }
    if (rowMinimum > maximum) return false;
    previous = current;
  }
  return previous[right.length]! <= maximum;
}
