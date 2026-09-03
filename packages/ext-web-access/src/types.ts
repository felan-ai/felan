export const PROVIDER_NAMES = ['openai', 'exa', 'brave', 'searxng'] as const;

export type ProviderName = typeof PROVIDER_NAMES[number];
export type ProviderSelection = 'auto' | 'all' | ProviderName | ProviderName[];
export type RecencyFilter = 'day' | 'week' | 'month' | 'year';

export interface SearchOptions {
  numResults: number;
  recencyFilter?: RecencyFilter;
  domainFilter?: string[];
  signal?: AbortSignal;
}

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface SearchResponse {
  provider: ProviderName;
  results: SearchResult[];
}

export interface ExtractedContent {
  url: string;
  title: string;
  content: string;
  error: string | null;
  contentType?: string;
  converter?: 'MarkItDown';
  truncated?: boolean;
  llmsTxtReplacement?: true;
}
