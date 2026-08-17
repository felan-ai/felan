import type {
  Api,
  ExtensionContext,
  FelanExtension,
  FelanExtensionAPI,
  Model,
} from '@felan-ai/agent-core';
import { StringEnum } from '@felan-ai/agent-core';
import { Type, type Static } from 'typebox';
import {
  IMAGE_WARNING,
  WEB_CONTENT_CAPABILITY_INSTRUCTION,
  trustedResultText,
  wrapUntrustedWebContent,
} from './boundary.js';
import {
  configuredProvider,
  loadConfig,
  normalizeProviderSelection,
} from './config.js';
import { findContent, type FindMode } from './content-find.js';
import { extractContent, fetchWithConcurrency } from './extract.js';
import { combinedSignal } from './http.js';
import { searchProviders, type ProviderEnvironment } from './providers.js';
import { buildResearchArtifact } from './source-check.js';
import { generateResponseId, ResultStore } from './storage.js';
import {
  PROVIDER_NAMES,
  type ExtractedContent,
  type ProviderSelection,
  type RecencyFilter,
  type SearchQueryRecord,
  type SearchResult,
  type StoredResult,
} from './types.js';

const SEARCH_SELECTIONS = ['auto', 'all', ...PROVIDER_NAMES] as const;
const RECENCY_FILTERS = ['day', 'week', 'month', 'year'] as const;
const FIND_MODES = ['exact', 'case-insensitive', 'fuzzy'] as const;
const MAX_GET_CHARACTERS = 30_000;
const MAX_INCLUDED_URLS = 8;
const MAX_MODEL_PREVIEW_CHARACTERS = 30_000;
const MAX_PAGE_PREVIEW_CHARACTERS = 12_000;
const NESTED_ANSWER_TIMEOUT_MS = 60_000;

const ProviderSelectionSchema = Type.Union([
  StringEnum(SEARCH_SELECTIONS),
  Type.Array(StringEnum(PROVIDER_NAMES), { minItems: 1 }),
]);

const WebSearchParams = Type.Object({
  query: Type.Optional(Type.String({ minLength: 1, maxLength: 2_000, description: 'Single search query' })),
  queries: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 2_000 }), { minItems: 1, maxItems: 4, description: 'Search queries run in sequence' })),
  numResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, description: 'Results per query. Default: 5.' })),
  includeContent: Type.Optional(Type.Boolean({ description: 'Fetch result pages synchronously with concurrency 3' })),
  recencyFilter: Type.Optional(StringEnum(RECENCY_FILTERS)),
  domainFilter: Type.Optional(Type.Array(Type.String(), { maxItems: 100 })),
  provider: Type.Optional(ProviderSelectionSchema),
}, { additionalProperties: false });

const SourceCheckParams = Type.Object({
  claim: Type.String({ minLength: 1, maxLength: 10_000, description: 'Assertion to check' }),
  queries: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 2_000 }), { minItems: 1, maxItems: 4 })),
  numResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
  fetchContent: Type.Optional(Type.Boolean({ description: 'Fetch up to five result pages for exact passages' })),
  recencyFilter: Type.Optional(StringEnum(RECENCY_FILTERS)),
  domainFilter: Type.Optional(Type.Array(Type.String(), { maxItems: 100 })),
  provider: Type.Optional(ProviderSelectionSchema),
}, { additionalProperties: false });

const FetchContentParams = Type.Object({
  url: Type.Optional(Type.String({ minLength: 1, maxLength: 4_096 })),
  urls: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 4_096 }), { minItems: 1, maxItems: 5 })),
  forceClone: Type.Optional(Type.Boolean({ description: 'Clone a GitHub repository even when it exceeds the configured size threshold' })),
  prompt: Type.Optional(Type.String({ minLength: 1, maxLength: 4_000, description: 'Trusted question required by answer mode' })),
  mode: Type.Optional(StringEnum(['readable', 'raw', 'answer'] as const)),
}, { additionalProperties: false });

const GetSearchContentParams = Type.Object({
  responseId: Type.String({ minLength: 1, maxLength: 128 }),
  query: Type.Optional(Type.String({ maxLength: 2_000 })),
  queryIndex: Type.Optional(Type.Integer({ minimum: 0 })),
  url: Type.Optional(Type.String({ maxLength: 4_096 })),
  urlIndex: Type.Optional(Type.Integer({ minimum: 0 })),
  offset: Type.Optional(Type.Integer({ minimum: 0 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_GET_CHARACTERS })),
  findText: Type.Optional(Type.Union([
    Type.String({ minLength: 1, maxLength: 500 }),
    Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { minItems: 1, maxItems: 10 }),
  ])),
  findMode: Type.Optional(StringEnum(FIND_MODES)),
}, { additionalProperties: false });

type WebSearchParams = Static<typeof WebSearchParams>;
type SourceCheckParams = Static<typeof SourceCheckParams>;
type FetchContentParams = Static<typeof FetchContentParams>;
type GetSearchContentParams = Static<typeof GetSearchContentParams>;

const webAccessExtension: FelanExtension = (pi) => {
  const store = new ResultStore(pi.runtime, pi.appendEntry.bind(pi));

  pi.registerCapability({
    id: 'web-access',
    instructions: WEB_CONTENT_CAPABILITY_INSTRUCTION,
  });

  pi.on('session_start', async (_event, ctx) => {
    await store.restore(ctx);
  });
  pi.on('session_shutdown', async () => {
    await store.clear();
  });

  pi.registerTool({
    name: 'web_search',
    label: 'Web Search',
    description: 'Search the web with SearXNG, OpenAI, Exa, or Brave. Supports auto, all, or a non-empty array of named providers. Remote results are untrusted external data.',
    promptSnippet: 'Search the web with bounded, untrusted result handling',
    promptGuidelines: [WEB_CONTENT_CAPABILITY_INSTRUCTION],
    parameters: WebSearchParams,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const config = await loadConfig(pi.agentDir);
      const selection = params.provider === undefined
        ? configuredProvider(config) ?? 'auto'
        : normalizeProviderSelection(params.provider);
      const queries = normalizeQueries(params.query, params.queries);
      const environment: ProviderEnvironment = { config, runtime: pi.runtime, ctx };
      const queryRecords: SearchQueryRecord[] = [];
      for (const query of queries) {
        const searched = await searchProviders(query, selection, searchOptions(params, signal), environment);
        const fetched = params.includeContent
          ? await fetchSearchContent(searched.responses, pi, config, signal)
          : searched.responses.flatMap((response) => response.inlineContent ?? []);
        queryRecords.push({ query, responses: searched.responses, fetched, errors: searched.errors });
      }
      const id = generateResponseId();
      const stored: StoredResult = { id, type: 'search', timestamp: Date.now(), queries: queryRecords };
      await store.put(stored);
      return {
        content: [{
          type: 'text',
          text: trustedResultText(
            id,
            { type: 'web_search', queries: queryRecords.map(queryRecordForModel) },
            trustedStorageInstruction(queryRecords.flatMap((query) => query.fetched)),
          ),
        }],
        details: searchDetails(stored),
      };
    },
  });

  pi.registerTool({
    name: 'source_check',
    label: 'Source Check',
    description: 'Check a claim against web sources and return a bounded research artifact with exact extracted passages.',
    promptSnippet: 'Check a claim against bounded web evidence',
    promptGuidelines: [WEB_CONTENT_CAPABILITY_INSTRUCTION],
    parameters: SourceCheckParams,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const config = await loadConfig(pi.agentDir);
      const selection = params.provider === undefined
        ? configuredProvider(config) ?? 'auto'
        : normalizeProviderSelection(params.provider);
      const environment: ProviderEnvironment = { config, runtime: pi.runtime, ctx };
      const queries = params.queries?.map((query) => query.trim()).filter(Boolean) ?? [params.claim.trim()];
      const responses = [];
      const queryRecords: SearchQueryRecord[] = [];
      const errors: Array<{ query: string; error: string }> = [];
      for (const query of queries) {
        const searched = await searchProviders(query, selection, {
          numResults: params.numResults ?? 5,
          ...(params.recencyFilter ? { recencyFilter: params.recencyFilter } : {}),
          ...(params.domainFilter ? { domainFilter: params.domainFilter } : {}),
          ...(signal ? { signal } : {}),
        }, environment);
        responses.push(...searched.responses);
        errors.push(...searched.errors.map((error) => ({ query, error: `${error.provider}: ${error.error}` })));
        queryRecords.push({ query, responses: searched.responses, fetched: [], errors: searched.errors });
      }
      const results = deduplicateResults(responses.flatMap((response) => response.results)).slice(0, 20);
      const fetched = params.fetchContent
        ? await fetchWithConcurrency(results.slice(0, 5).map((result) => result.url), 3, (url) => extractContent(url, pi.runtime, config, signal, { allowGitHub: false }))
        : [];
      const id = generateResponseId();
      const artifact = buildResearchArtifact({
        id,
        claim: params.claim.trim(),
        provider: [...new Set(responses.map((response) => response.provider))].join(','),
        results,
        summaries: responses.map((response) => ({ provider: response.provider, text: response.answer })),
        fetched,
        ...(params.recencyFilter ? { recencyFilter: params.recencyFilter } : {}),
        ...(params.domainFilter ? { domainFilter: params.domainFilter } : {}),
        errors,
      });
      const stored: StoredResult = { id, type: 'research', timestamp: artifact.timestamp, artifact, urls: fetched, queries: queryRecords };
      await store.put(stored);
      return {
        content: [{ type: 'text', text: trustedResultText(id, artifact, 'Use get_search_content with this response ID for paging or exact text lookup.') }],
        details: researchDetails(stored),
      };
    },
  });

  pi.registerTool({
    name: 'fetch_content',
    label: 'Fetch Content',
    description: 'Fetch HTTP(S) pages as readable Markdown, exact text, direct images, PDF text, GitHub repository content, or a page-grounded answer.',
    promptSnippet: 'Fetch secure HTTP(S) content with private-network protection',
    promptGuidelines: [WEB_CONTENT_CAPABILITY_INSTRUCTION],
    parameters: FetchContentParams,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const urls = normalizeUrls(params.url, params.urls);
      const mode = params.mode ?? 'readable';
      if (mode === 'answer' && !params.prompt?.trim()) throw new Error('prompt is required when mode is answer');
      const config = await loadConfig(pi.agentDir);
      const pages = await fetchWithConcurrency(urls, 3, (url) => extractContent(url, pi.runtime, config, signal, {
        mode: mode === 'raw' ? 'raw' : 'readable',
        ...(params.forceClone !== undefined ? { forceClone: params.forceClone } : {}),
      }));
      const answer = mode === 'answer'
        ? await answerFromPages(pages, params.prompt!.trim(), ctx, signal)
        : undefined;
      const id = generateResponseId();
      const stored: StoredResult = {
        id,
        type: 'fetch',
        timestamp: Date.now(),
        urls: pages,
        ...(answer !== undefined ? { answer } : {}),
      };
      await store.put(stored);
      if (answer !== undefined) {
        return {
          content: [{
            type: 'text',
            text: trustedResultText(id, { type: 'answer', answer, sources: pages.map(pageMetadata) }, trustedStorageInstruction(pages)),
          }],
          details: fetchDetails(stored, pages),
        };
      }
      return { content: fetchedPageContent(id, pages), details: fetchDetails(stored, pages) };
    },
  });

  pi.registerTool<typeof GetSearchContentParams, unknown>({
    name: 'get_search_content',
    label: 'Get Search Content',
    description: 'Retrieve bounded slices or exact, case-insensitive, or fuzzy matches from a previous web_search, source_check, or fetch_content result.',
    promptSnippet: 'Retrieve stored web content by trusted response ID',
    promptGuidelines: [WEB_CONTENT_CAPABILITY_INSTRUCTION],
    parameters: GetSearchContentParams,
    async execute(_toolCallId, params) {
      if (params.findText !== undefined && (params.offset !== undefined || params.limit !== undefined)) {
        throw new Error('findText cannot be combined with offset or limit');
      }
      const stored = await store.get(params.responseId);
      if (!stored) throw new Error(`No current web result found for response ID ${params.responseId}`);
      const selected = selectStoredContent(stored, params);
      if (selected.page?.image && params.findText === undefined && params.offset === undefined && params.limit === undefined) {
        return {
          content: imageContent(params.responseId, selected.page),
          details: { responseId: params.responseId, imageTrust: [imageTrust(selected.page)] },
        };
      }
      const text = selected.text;
      if (params.findText !== undefined) {
        const queries = typeof params.findText === 'string' ? [params.findText] : params.findText;
        const found = findContent(text, queries, (params.findMode ?? 'case-insensitive') as FindMode);
        return {
          content: [{ type: 'text', text: trustedResultText(params.responseId, found, 'Match snippets are bounded to 20,000 characters.') }],
          details: {
            responseId: params.responseId,
            mode: found.mode,
            matchCount: found.matchCount,
            returnedMatches: found.returnedMatches,
            queryCount: found.queryResults.length,
          },
        };
      }
      const offset = params.offset ?? 0;
      if (offset > text.length) throw new Error(`offset ${offset} exceeds content length ${text.length}`);
      const limit = params.limit ?? MAX_GET_CHARACTERS;
      const slice = text.slice(offset, offset + limit);
      const end = offset + slice.length;
      const paging = end < text.length
        ? `Showing characters ${offset}-${end} of ${text.length}. Request offset ${end} for the next slice.`
        : `Showing characters ${offset}-${end} of ${text.length}.`;
      return {
        content: [{ type: 'text', text: trustedResultText(params.responseId, { content: slice }, paging) }],
        details: { responseId: params.responseId, offset, limit, totalCharacters: text.length },
      };
    },
  });
};

function searchOptions(params: WebSearchParams, signal: AbortSignal | undefined) {
  return {
    numResults: params.numResults ?? 5,
    ...(params.recencyFilter ? { recencyFilter: params.recencyFilter as RecencyFilter } : {}),
    ...(params.domainFilter ? { domainFilter: params.domainFilter } : {}),
    ...(params.includeContent !== undefined ? { includeContent: params.includeContent } : {}),
    ...(signal ? { signal } : {}),
  };
}

function normalizeQueries(query: string | undefined, queries: string[] | undefined): string[] {
  if (query?.trim() && queries?.length) throw new Error('Provide query or queries, not both');
  const normalized = queries?.map((value) => value.trim()).filter(Boolean) ?? (query?.trim() ? [query.trim()] : []);
  if (normalized.length === 0) throw new Error('query or queries is required');
  return [...new Set(normalized)];
}

function normalizeUrls(url: string | undefined, urls: string[] | undefined): string[] {
  if (url?.trim() && urls?.length) throw new Error('Provide url or urls, not both');
  const normalized = urls?.map((value) => value.trim()).filter(Boolean) ?? (url?.trim() ? [url.trim()] : []);
  if (normalized.length === 0) throw new Error('url or urls is required');
  for (const value of normalized) {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      throw new Error('URL must be an absolute HTTP(S) URL');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('Only HTTP and HTTPS URLs are supported');
    if (parsed.username || parsed.password) throw new Error('URLs with embedded credentials are not supported');
  }
  return [...new Set(normalized)];
}

async function fetchSearchContent(
  responses: Awaited<ReturnType<typeof searchProviders>>['responses'],
  pi: FelanExtensionAPI,
  config: Awaited<ReturnType<typeof loadConfig>>,
  signal: AbortSignal | undefined,
): Promise<ExtractedContent[]> {
  const inline = responses.flatMap((response) => response.inlineContent ?? [])
    .slice(0, MAX_INCLUDED_URLS)
    .map(boundedStoredPage);
  const inlineUrls = new Set(inline.map((page) => page.url));
  const urls = [...new Set(responses.flatMap((response) => response.results.map((result) => result.url)))]
    .filter((url) => !inlineUrls.has(url))
    .slice(0, Math.max(0, MAX_INCLUDED_URLS - inline.length));
  return [
    ...inline,
    ...await fetchWithConcurrency(urls, 3, (url) => extractContent(url, pi.runtime, config, signal, { allowGitHub: false })),
  ];
}

async function answerFromPages(
  pages: ExtractedContent[],
  prompt: string,
  ctx: ExtensionContext,
  signal: AbortSignal | undefined,
): Promise<string> {
  const model = ctx.model;
  if (!model) throw new Error('answer mode requires a selected Pi model');
  if (pages.some((page) => page.image) && !model.input.includes('image')) {
    throw new Error(`Selected model does not support image input: ${model.id}`);
  }
  const provider = ctx.modelRegistry.getProvider(model.provider);
  if (!provider) throw new Error(`Selected model provider is unavailable: ${model.provider}`);
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) throw new Error('Selected model authentication is unavailable');
  const outputTokens = Math.max(1, Math.min(4_096, model.maxTokens));
  const inputTokens = Math.max(0, Math.min(
    Math.floor(model.contextWindow * 0.6),
    model.contextWindow - outputTokens - 4_096,
  ));
  const pageBudget = new PreviewBudget(Math.max(0, inputTokens * 4 - prompt.length - 4_000));
  const remotePages = pages.filter((page) => !page.image).map((page) => pageForModel(page, pageBudget));
  const content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> = [{
    type: 'text',
    text: [
      WEB_CONTENT_CAPABILITY_INSTRUCTION,
      'Answer the trusted question using only the supplied external data. State when the data is insufficient.',
      ...(pages.some((page) => page.truncated) ? ['Some supplied source content was truncated to bounded extraction limits.'] : []),
      `Trusted question: ${prompt}`,
      wrapUntrustedWebContent({ pages: remotePages }),
    ].join('\n\n'),
  }];
  for (const page of pages.filter((candidate) => candidate.image)) {
    content.push({ type: 'text', text: `${IMAGE_WARNING}\n\n${wrapUntrustedWebContent(pageMetadata(page))}` });
    content.push({ type: 'image', data: page.image!.data, mimeType: page.image!.mimeType });
  }
  const stream = provider.streamSimple(model as Model<Api>, {
    systemPrompt: WEB_CONTENT_CAPABILITY_INSTRUCTION,
    messages: [{ role: 'user', content, timestamp: Date.now() }],
  }, {
    ...(auth.apiKey ? { apiKey: auth.apiKey } : {}),
    ...(auth.headers ? { headers: auth.headers } : {}),
    ...(auth.env ? { env: auth.env } : {}),
    signal: combinedSignal(signal, NESTED_ANSWER_TIMEOUT_MS),
    maxTokens: outputTokens,
  });
  const response = await stream.result();
  if (response.stopReason === 'aborted') throw new Error('Nested answer request was aborted');
  if (response.stopReason === 'error') throw new Error('Nested answer request failed');
  const answer = response.content.flatMap((part) => part.type === 'text' ? [part.text] : []).join('').trim();
  if (!answer) throw new Error('Nested answer request returned no text');
  return answer.slice(0, MAX_MODEL_PREVIEW_CHARACTERS);
}

function fetchedPageContent(responseId: string, pages: ExtractedContent[]) {
  const content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> = [];
  const budget = new PreviewBudget(MAX_MODEL_PREVIEW_CHARACTERS);
  const textPages = pages.filter((page) => !page.image).map((page) => pageForModel(page, budget));
  if (textPages.length > 0) {
    content.push({
      type: 'text',
      text: trustedResultText(responseId, { type: 'fetch', pages: textPages }, trustedStorageInstruction(pages)),
    });
  }
  for (const page of pages.filter((candidate) => candidate.image).slice(0, 1)) {
    const prefix = content.length === 0 ? `Response ID: ${responseId}\n\n` : '';
    content.push({ type: 'text', text: `${prefix}${IMAGE_WARNING}\n\n${wrapUntrustedWebContent(pageMetadata(page))}` });
    content.push({ type: 'image', data: page.image!.data, mimeType: page.image!.mimeType });
  }
  if (content.length === 0) {
    content.push({ type: 'text', text: trustedResultText(responseId, { type: 'fetch', pages: [] }, trustedStorageInstruction(pages)) });
  }
  return content;
}

function imageContent(responseId: string, page: ExtractedContent) {
  return [
    { type: 'text' as const, text: `Response ID: ${responseId}\n\n${IMAGE_WARNING}\n\n${wrapUntrustedWebContent(pageMetadata(page))}` },
    { type: 'image' as const, data: page.image!.data, mimeType: page.image!.mimeType },
  ];
}

function pageForModel(page: ExtractedContent, budget = new PreviewBudget(MAX_MODEL_PREVIEW_CHARACTERS)) {
  const content = budget.take(page.content, MAX_PAGE_PREVIEW_CHARACTERS);
  return {
    url: budget.take(page.url, 2_048).text,
    title: budget.take(page.title, 500).text,
    content: content.text,
    totalCharacters: page.content.length,
    previewTruncated: content.truncated,
    error: page.error,
    contentType: page.contentType,
  };
}

function pageMetadata(page: ExtractedContent) {
  return {
    url: page.url.slice(0, 2_048),
    title: page.title.slice(0, 500),
    content: page.content.slice(0, 200),
    error: page.error,
    contentType: page.contentType,
    trust: imageTrust(page),
  };
}

function imageTrust(page: ExtractedContent) {
  return { source: 'remote-web', untrusted: true, mimeType: page.image?.mimeType ?? page.contentType };
}

function searchDetails(stored: StoredResult) {
  const queries = stored.queries ?? [];
  const pages = queries.flatMap((query) => query.fetched);
  return withImageTrust({
    responseId: stored.id,
    type: stored.type,
    queryCount: queries.length,
    providerResponseCount: queries.reduce((total, query) => total + query.responses.length, 0),
    resultCount: queries.reduce(
      (total, query) => total + query.responses.reduce((queryTotal, response) => queryTotal + response.results.length, 0),
      0,
    ),
    fetchedCount: pages.length,
  }, pages);
}

function researchDetails(stored: StoredResult) {
  const pages = stored.urls ?? [];
  return withImageTrust({
    responseId: stored.id,
    type: stored.type,
    queryCount: stored.queries?.length ?? 0,
    sourceCount: stored.artifact?.sources.length ?? 0,
    passageCount: stored.artifact?.passages.length ?? 0,
    fetchedCount: pages.length,
  }, pages);
}

function fetchDetails(stored: StoredResult, pages: ExtractedContent[]) {
  return withImageTrust({
    responseId: stored.id,
    type: stored.type,
    urlCount: pages.length,
    successfulCount: pages.filter((page) => page.error === null).length,
    totalCharacters: pages.reduce((total, page) => total + page.content.length, 0),
  }, pages);
}

function withImageTrust<T extends Record<string, unknown>>(details: T, pages: ExtractedContent[]) {
  const trust = pages.flatMap((page, urlIndex) => page.image ? [{ urlIndex, ...imageTrust(page) }] : []);
  return trust.length > 0 ? { ...details, imageTrust: trust } : details;
}

function queryRecordForModel(query: SearchQueryRecord) {
  const budget = new PreviewBudget(MAX_MODEL_PREVIEW_CHARACTERS);
  return {
    query: query.query,
    responses: query.responses.map((response) => ({
      provider: response.provider,
      answer: budget.take(response.answer, 6_000).text,
      results: response.results.map((result) => ({
        title: budget.take(result.title, 500).text,
        url: budget.take(result.url, 2_048).text,
        snippet: budget.take(result.snippet, 1_000).text,
      })),
    })),
    fetched: query.fetched.map((page) => pageForModel(page, budget)),
    errors: query.errors.map((error) => ({ ...error, error: budget.take(error.error, 500).text })),
  };
}

function boundedStoredPage(page: ExtractedContent): ExtractedContent {
  if (page.content.length <= 750_000) return page;
  return { ...page, content: page.content.slice(0, 750_000), truncated: true };
}

class PreviewBudget {
  #used = 0;

  constructor(readonly maximum: number) {}

  take(value: string, perItemMaximum: number): { text: string; truncated: boolean } {
    const available = Math.max(0, Math.min(perItemMaximum, this.maximum - this.#used));
    const text = value.slice(0, available);
    this.#used += text.length;
    return { text, truncated: text.length < value.length };
  }
}

function trustedStorageInstruction(pages: ExtractedContent[]): string {
  const truncation = pages.some((page) => page.truncated)
    ? ' Some content was truncated to bounded extraction limits.'
    : '';
  return `Use get_search_content with this response ID for stored full content.${truncation}`;
}

function deduplicateResults(results: SearchResult[]): SearchResult[] {
  const seen = new Set<string>();
  return results.filter((result) => {
    if (seen.has(result.url)) return false;
    seen.add(result.url);
    return true;
  });
}

function selectStoredContent(stored: StoredResult, params: GetSearchContentParams): { text: string; page?: ExtractedContent } {
  if (stored.type === 'fetch') {
    const page = selectPage(stored.urls ?? [], params.url, params.urlIndex);
    if (page) return { text: page.content, page };
    if (params.url !== undefined || params.urlIndex !== undefined) throw new Error('Requested URL was not found in the stored fetch result');
    return { text: JSON.stringify({ answer: stored.answer, urls: stored.urls }, null, 2) };
  }
  if (stored.type === 'research') {
    if (params.query !== undefined || params.queryIndex !== undefined) {
      const queries = stored.queries ?? [];
      const query = params.query !== undefined
        ? queries.find((candidate) => candidate.query === params.query)
        : queries[params.queryIndex!];
      if (!query) throw new Error('Requested query was not found in the stored research result');
      return { text: JSON.stringify(query, null, 2) };
    }
    const page = selectPage(stored.urls ?? [], params.url, params.urlIndex);
    if (page) return { text: page.content, page };
    if (params.url !== undefined || params.urlIndex !== undefined) throw new Error('Requested URL was not found in the stored research result');
    return { text: JSON.stringify(stored.artifact, null, 2) };
  }
  const queries = stored.queries ?? [];
  const query = params.query !== undefined
    ? queries.find((candidate) => candidate.query === params.query)
    : params.queryIndex !== undefined ? queries[params.queryIndex] : queries.length === 1 ? queries[0] : undefined;
  if (!query) {
    if (params.query !== undefined || params.queryIndex !== undefined || queries.length !== 1) {
      throw new Error('Select a stored search query with query or queryIndex');
    }
    return { text: JSON.stringify(queries, null, 2) };
  }
  const page = selectPage(query.fetched, params.url, params.urlIndex);
  if (page) return { text: page.content, page };
  if (params.url !== undefined || params.urlIndex !== undefined) throw new Error('Requested URL was not found in the selected search query');
  return { text: JSON.stringify(query, null, 2) };
}

function selectPage(pages: ExtractedContent[], url: string | undefined, index: number | undefined): ExtractedContent | undefined {
  if (url !== undefined) return pages.find((page) => page.url === url);
  if (index !== undefined) return pages[index];
  return undefined;
}

export default webAccessExtension;
