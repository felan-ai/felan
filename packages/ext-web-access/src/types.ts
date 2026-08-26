export const PROVIDER_NAMES = ['openai', 'exa', 'brave', 'searxng'] as const;

export type ProviderName = typeof PROVIDER_NAMES[number];
export type ProviderSelection = 'auto' | 'all' | ProviderName | ProviderName[];
export type RecencyFilter = 'day' | 'week' | 'month' | 'year';

export interface SearchOptions {
  numResults: number;
  recencyFilter?: RecencyFilter;
  domainFilter?: string[];
  includeContent?: boolean;
  signal?: AbortSignal;
}

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface GitHubRepositoryProvenance {
  owner: string;
  repo: string;
  mode: 'local-checkout' | 'github-api';
  commit: string;
  requestedRef?: string;
  checkoutPath?: string;
}

export interface ExtractedContent {
  url: string;
  title: string;
  content: string;
  error: string | null;
  contentType?: string;
  truncated?: boolean;
  image?: {
    data: string;
    mimeType: string;
  };
  repository?: GitHubRepositoryProvenance;
}

export interface SearchResponse {
  provider: ProviderName;
  answer: string;
  results: SearchResult[];
  inlineContent?: ExtractedContent[];
}

export interface SearchQueryRecord {
  query: string;
  responses: SearchResponse[];
  fetched: ExtractedContent[];
  errors: Array<{ provider: ProviderName; error: string }>;
}

export interface ResearchPassage {
  passageId: string;
  sourceUrl: string;
  sourceRank: number;
  text: string;
  extractionSpan?: { start: number; end: number };
  contentHash: string;
}

export interface ResearchArtifact {
  id: string;
  type: 'research';
  timestamp: number;
  claim: string;
  provider: string;
  status: 'supported' | 'contradicted' | 'unclear' | 'missing-evidence';
  confidence: number;
  rationale: string;
  summaries: Array<{ provider: ProviderName; text: string }>;
  sources: Array<{
    rank: number;
    url: string;
    title: string;
    snippet: string;
    quality: string;
    fetched: boolean;
    fetchError?: string;
    contentHash?: string;
  }>;
  passages: ResearchPassage[];
  supportingPassages: string[];
  contradictingPassages: string[];
  filters: {
    recency?: RecencyFilter;
    domainInclude: string[];
    domainExclude: string[];
  };
  errors: Array<{ query: string; error: string }>;
}

export interface StoredResult {
  id: string;
  type: 'search' | 'fetch' | 'research';
  timestamp: number;
  queries?: SearchQueryRecord[];
  urls?: ExtractedContent[];
  artifact?: ResearchArtifact;
  answer?: string;
}
