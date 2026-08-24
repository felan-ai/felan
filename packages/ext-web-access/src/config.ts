import { configField, defineExtensionConfig } from '@felan-ai/agent-core';
import type { ProviderSelection } from './types.js';

export interface WebAccessConfig {
  provider?: unknown;
  searchProvider?: unknown;
  openaiApiKey?: unknown;
  openaiSearchModel?: unknown;
  exaApiKey?: unknown;
  braveApiKey?: unknown;
  searxngBaseUrl?: unknown;
  searxngHeaders?: unknown;
  pdf?: {
    maxSizeMB?: unknown;
    maxPages?: unknown;
  };
  githubClone?: {
    enabled?: unknown;
    maxRepoSizeMB?: unknown;
    cloneTimeoutSeconds?: unknown;
  };
  fetchContent?: {
    domainPolicy?: {
      allow?: unknown;
      deny?: unknown;
    };
  };
  ssrf?: {
    allowRanges?: unknown;
  };
}

export const WEB_ACCESS_CONFIG = defineExtensionConfig({
  id: 'webAccess',
  title: 'Web access',
  fields: {
    provider: configField.json({ default: 'auto', description: 'Default web search provider', validate: validateProvider }),
    searchProvider: configField.json({ default: null, description: 'Legacy provider alias', validate: (value) => value === null ? undefined : validateProvider(value) }),
    openaiApiKey: configField.string({ default: '', description: 'OpenAI credential source', sensitive: true }),
    openaiSearchModel: configField.string({ default: '', description: 'OpenAI web search model' }),
    exaApiKey: configField.string({ default: '', description: 'Exa credential source', sensitive: true }),
    braveApiKey: configField.string({ default: '', description: 'Brave credential source', sensitive: true }),
    searxngBaseUrl: configField.string({ default: '', description: 'SearXNG base URL', validate: validateOptionalUrl }),
    searxngHeaders: configField.json({ default: {}, description: 'SearXNG request headers', sensitive: true, validate: validateHeaders }),
    pdf: configField.json({ default: {}, description: 'PDF extraction limits', validate: validatePdf }),
    githubClone: configField.json({ default: {}, description: 'GitHub clone limits', validate: validateGithubClone }),
    fetchContent: configField.json({ default: {}, description: 'Fetch domain policy', validate: validateFetchContent }),
    ssrf: configField.json({ default: {}, description: 'SSRF allow ranges', validate: validateSsrf }),
  },
});

export function webAccessConfigFromSettings(values: Readonly<Record<string, unknown>>): WebAccessConfig {
  return {
    provider: values.searchProvider === null ? values.provider : values.searchProvider,
    openaiApiKey: values.openaiApiKey,
    openaiSearchModel: values.openaiSearchModel,
    exaApiKey: values.exaApiKey,
    braveApiKey: values.braveApiKey,
    searxngBaseUrl: values.searxngBaseUrl,
    searxngHeaders: values.searxngHeaders,
    ...(values.pdf === undefined ? {} : { pdf: values.pdf as NonNullable<WebAccessConfig['pdf']> }),
    ...(values.githubClone === undefined ? {} : { githubClone: values.githubClone as NonNullable<WebAccessConfig['githubClone']> }),
    ...(values.fetchContent === undefined ? {} : { fetchContent: values.fetchContent as NonNullable<WebAccessConfig['fetchContent']> }),
    ...(values.ssrf === undefined ? {} : { ssrf: values.ssrf as NonNullable<WebAccessConfig['ssrf']> }),
  };
}

export function configuredProvider(config: WebAccessConfig): ProviderSelection | undefined {
  const value = config.searchProvider ?? config.provider;
  if (value === undefined) return undefined;
  return normalizeProviderSelection(value, 'configured provider');
}

export function normalizeProviderSelection(value: unknown, label = 'provider'): ProviderSelection {
  const named = new Set(['openai', 'exa', 'brave', 'searxng']);
  if (value === 'auto' || value === 'all' || (typeof value === 'string' && named.has(value))) {
    return value as ProviderSelection;
  }
  if (Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === 'string' && named.has(item))) {
    return [...new Set(value)] as ProviderSelection;
  }
  throw new Error(`${label} must be auto, all, openai, exa, brave, searxng, or a non-empty array of named providers`);
}

export function positiveNumber(value: unknown, fallback: number, maximum: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.min(value, maximum)
    : fallback;
}

export function positiveInteger(value: unknown, fallback: number, maximum: number): number {
  return Math.floor(positiveNumber(value, fallback, maximum));
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateProvider(value: unknown): string | undefined {
  try {
    normalizeProviderSelection(value, 'provider');
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function validateOptionalUrl(value: unknown): string | undefined {
  if (value === '') return undefined;
  if (typeof value !== 'string') return 'must be a string';
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return 'must be an HTTP(S) URL without credentials';
    return undefined;
  } catch {
    return 'must be an HTTP(S) URL';
  }
}

function validateHeaders(value: unknown): string | undefined {
  if (!isRecord(value)) return 'must be an object';
  for (const [name, header] of Object.entries(value)) {
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(name) || typeof header !== 'string') return `contains an invalid header: ${name}`;
  }
  return undefined;
}

function validatePdf(value: unknown): string | undefined {
  return validateOptionalNumberObject(value, new Set(['maxSizeMB', 'maxPages']));
}

function validateGithubClone(value: unknown): string | undefined {
  return validateOptionalNumberObject(value, new Set(['maxRepoSizeMB', 'cloneTimeoutSeconds']), new Set(['enabled']));
}

function validateFetchContent(value: unknown): string | undefined {
  if (!isRecord(value)) return 'must be an object';
  if (value.domainPolicy === undefined) return undefined;
  if (!isRecord(value.domainPolicy)) return 'domainPolicy must be an object';
  return validateStringArrays(value.domainPolicy, new Set(['allow', 'deny']));
}

function validateSsrf(value: unknown): string | undefined {
  if (!isRecord(value)) return 'must be an object';
  return validateStringArrays(value, new Set(['allowRanges']));
}

function validateOptionalNumberObject(
  value: unknown,
  numberKeys: ReadonlySet<string>,
  booleanKeys: ReadonlySet<string> = new Set(),
): string | undefined {
  if (!isRecord(value)) return 'must be an object';
  for (const [key, item] of Object.entries(value)) {
    if (!numberKeys.has(key) && !booleanKeys.has(key)) return `contains unknown field: ${key}`;
    if (numberKeys.has(key) && (typeof item !== 'number' || !Number.isFinite(item) || item <= 0)) return `${key} must be a positive number`;
    if (booleanKeys.has(key) && typeof item !== 'boolean') return `${key} must be a boolean`;
  }
  return undefined;
}

function validateStringArrays(value: Record<string, unknown>, allowed: ReadonlySet<string>): string | undefined {
  for (const [key, item] of Object.entries(value)) {
    if (!allowed.has(key)) return `contains unknown field: ${key}`;
    if (!Array.isArray(item) || !item.every((entry) => typeof entry === 'string')) return `${key} must be an array of strings`;
  }
  return undefined;
}
