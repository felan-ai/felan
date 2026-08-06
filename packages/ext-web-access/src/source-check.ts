import { createHash } from 'node:crypto';
import type {
  ExtractedContent,
  RecencyFilter,
  ResearchArtifact,
  ResearchPassage,
  SearchResult,
} from './types.js';

const MAX_SOURCES = 20;
const MAX_PASSAGES = 40;
const MAX_PASSAGE_CHARACTERS = 400;

export interface BuildResearchArtifactOptions {
  id: string;
  claim: string;
  provider: string;
  results: SearchResult[];
  summaries: Array<{ provider: ResearchArtifact['summaries'][number]['provider']; text: string }>;
  fetched: ExtractedContent[];
  recencyFilter?: RecencyFilter;
  domainFilter?: string[];
  errors: Array<{ query: string; error: string }>;
}

export function buildResearchArtifact(options: BuildResearchArtifactOptions): ResearchArtifact {
  const fetchedByUrl = new Map(options.fetched.map((page) => [page.url, page]));
  const seen = new Set<string>();
  const uniqueResults = options.results.filter((result) => {
    if (seen.has(result.url)) return false;
    seen.add(result.url);
    return true;
  }).slice(0, MAX_SOURCES);
  const sources = uniqueResults.map((result, index) => {
    const page = fetchedByUrl.get(result.url);
    return {
      rank: index + 1,
      url: result.url,
      title: result.title,
      snippet: result.snippet,
      quality: classifySource(result.url),
      fetched: Boolean(page && !page.error),
      ...(page?.error ? { fetchError: page.error } : {}),
      ...(page && !page.error ? { contentHash: hashContent(page.content) } : {}),
    };
  });
  const passages = buildPassages(options.claim, sources, fetchedByUrl).slice(0, MAX_PASSAGES);
  const assessment = assessClaim(passages);
  const filters = options.domainFilter ?? [];
  return {
    id: options.id,
    type: 'research',
    timestamp: Date.now(),
    claim: options.claim,
    provider: options.provider,
    status: assessment.status,
    confidence: assessment.confidence,
    rationale: assessment.rationale,
    summaries: options.summaries.slice(0, 16).map((summary) => ({
      provider: summary.provider,
      text: summary.text.slice(0, 5_000),
    })),
    sources,
    passages,
    supportingPassages: assessment.supporting,
    contradictingPassages: assessment.contradicting,
    filters: {
      ...(options.recencyFilter ? { recency: options.recencyFilter } : {}),
      domainInclude: filters.filter((domain) => !domain.startsWith('-')),
      domainExclude: filters.filter((domain) => domain.startsWith('-')).map((domain) => domain.slice(1)),
    },
    errors: options.errors,
  };
}

function buildPassages(
  claim: string,
  sources: ResearchArtifact['sources'],
  fetched: Map<string, ExtractedContent>,
): ResearchPassage[] {
  const passages: ResearchPassage[] = [];
  const terms = tokens(claim);
  for (const source of sources) {
    const page = fetched.get(source.url);
    if (!page || page.error || !page.content) continue;
    for (const [index, span] of relevantSpans(page.content, terms).entries()) {
      passages.push({
        passageId: `p-${source.rank}-${index + 1}`,
        sourceUrl: source.url,
        sourceRank: source.rank,
        text: span.text,
        extractionSpan: { start: span.start, end: span.end },
        contentHash: hashContent(span.text),
      });
    }
  }
  return passages;
}

function relevantSpans(content: string, terms: string[]): Array<{ text: string; start: number; end: number }> {
  if (terms.length === 0) return [];
  const spans: Array<{ text: string; start: number; end: number; score: number }> = [];
  for (const match of content.matchAll(/[^.!?\n]+(?:[.!?]+(?=\s|$)|$)/gu)) {
    if (match.index === undefined) continue;
    const raw = match[0];
    const text = raw.trim();
    if (!text || text.length > MAX_PASSAGE_CHARACTERS) continue;
    const score = terms.filter((term) => text.toLocaleLowerCase().includes(term)).length;
    if (score === 0) continue;
    const start = match.index + raw.indexOf(text);
    spans.push({ text, start, end: start + text.length, score });
  }
  return spans.sort((left, right) => right.score - left.score || left.start - right.start).slice(0, 3).map(({ score: _score, ...span }) => span);
}

function assessClaim(passages: ResearchPassage[]) {
  if (passages.length === 0) return {
    status: 'missing-evidence' as const,
    confidence: 0,
    rationale: 'No exact fetched passages were available.',
    supporting: [],
    contradicting: [],
  };
  return {
    status: 'unclear' as const,
    confidence: 0,
    rationale: 'Exact passages were extracted; semantic review is required.',
    supporting: [],
    contradicting: [],
  };
}

export function hashContent(text: string): string {
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
}

function tokens(value: string): string[] {
  return [...new Set(value.toLocaleLowerCase().split(/[^\p{L}\p{N}]+/u).filter((term) => term.length > 3))];
}

function classifySource(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    if (/\/(issues|pull|pulls)\//iu.test(url.pathname)) return 'repo_issue';
    if (/^(developers\.|docs\.|learn\.|reference\.)|\.github\.io$/iu.test(url.hostname) || /\/(docs?|reference)(\/|$)/iu.test(url.pathname)) return 'official_docs';
    if (/(stackoverflow\.com|serverfault\.com|discourse\.|community\.)/iu.test(url.hostname)) return 'forum';
    if (/(reuters\.com|bloomberg\.com|techcrunch\.com|theverge\.com|arstechnica\.com|wired\.com)/iu.test(url.hostname)) return 'news';
    if (/(medium\.com|substack\.com|dev\.to|hashnode\.)/iu.test(url.hostname) || /\/blog(s)?\//iu.test(url.pathname)) return 'blog';
    return 'unknown';
  } catch {
    return 'unknown';
  }
}
