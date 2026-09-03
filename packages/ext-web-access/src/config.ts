import { configField, defineExtensionConfig } from '@felan-ai/agent-core';
import { isIP } from 'node:net';
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

const DEFAULT_PDF_MAX_SIZE_MB = 20;
const MAX_PDF_MAX_SIZE_MB = 20;

export interface PdfSettings {
  maximumBytes: number;
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
    fetchContent: configField.json({ default: {}, description: 'Fetch domain policy', validate: validateFetchContent }),
    ssrf: configField.json({ default: {}, description: 'SSRF allow ranges', validate: validateSsrf }),
  },
});

export function webAccessConfigFromSettings(values: Readonly<Record<string, unknown>>): WebAccessConfig {
  return {
    provider: values.searchProvider === undefined || values.searchProvider === null
      ? values.provider
      : values.searchProvider,
    openaiApiKey: values.openaiApiKey,
    openaiSearchModel: values.openaiSearchModel,
    exaApiKey: values.exaApiKey,
    braveApiKey: values.braveApiKey,
    searxngBaseUrl: values.searxngBaseUrl,
    searxngHeaders: values.searxngHeaders,
    ...(values.pdf === undefined ? {} : { pdf: values.pdf as NonNullable<WebAccessConfig['pdf']> }),
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
  if (Array.isArray(value) && value.length > 0 && value.length <= named.size
    && value.every((item) => typeof item === 'string' && named.has(item))) {
    return [...new Set(value)] as ProviderSelection;
  }
  throw new Error(`${label} must be auto, all, openai, exa, brave, searxng, or a non-empty array of up to four named providers`);
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function pdfSettings(config: WebAccessConfig): PdfSettings {
  if (config.pdf !== undefined) {
    const validationError = validatePdf(config.pdf);
    if (validationError) throw new Error(`Invalid pdf configuration: ${validationError}`);
  }
  const maxSizeMB = optionalBoundedNumber(
    config.pdf?.maxSizeMB,
    DEFAULT_PDF_MAX_SIZE_MB,
    MAX_PDF_MAX_SIZE_MB,
    'pdf.maxSizeMB',
  );
  return {
    maximumBytes: Math.floor(maxSizeMB * 1024 * 1024),
  };
}

function validateProvider(value: unknown): string | undefined {
  try {
    normalizeProviderSelection(value);
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
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) {
      return 'must be an HTTP(S) URL without credentials';
    }
    return undefined;
  } catch {
    return 'must be an HTTP(S) URL';
  }
}

function validateHeaders(value: unknown): string | undefined {
  if (!isRecord(value)) return 'must be an object';
  for (const [name, header] of Object.entries(value)) {
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(name) || typeof header !== 'string') {
      return `contains an invalid header: ${name}`;
    }
    try {
      new Headers({ [name]: header });
    } catch {
      return `contains an invalid header: ${name}`;
    }
  }
  return undefined;
}

function validatePdf(value: unknown): string | undefined {
  if (!isRecord(value)) return 'must be an object';
  for (const key of Object.keys(value)) {
    if (key !== 'maxSizeMB') return `contains unknown field: ${key}`;
  }
  try {
    optionalBoundedNumber(value.maxSizeMB, DEFAULT_PDF_MAX_SIZE_MB, MAX_PDF_MAX_SIZE_MB, 'maxSizeMB');
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function validateFetchContent(value: unknown): string | undefined {
  if (!isRecord(value)) return 'must be an object';
  for (const key of Object.keys(value)) {
    if (key !== 'domainPolicy') return `contains unknown field: ${key}`;
  }
  if (value.domainPolicy === undefined) return undefined;
  if (!isRecord(value.domainPolicy)) return 'domainPolicy must be an object';
  const arrayError = validateStringArrays(value.domainPolicy, new Set(['allow', 'deny']));
  if (arrayError) return arrayError;
  for (const [key, domains] of Object.entries(value.domainPolicy)) {
    for (const domain of domains as string[]) {
      const normalized = domain.trim().toLowerCase().replace(/\.$/u, '');
      if (!normalized || /[\s\\/?:#@]/u.test(normalized)) return `${key} contains an invalid hostname`;
    }
  }
  return undefined;
}

function validateSsrf(value: unknown): string | undefined {
  if (!isRecord(value)) return 'must be an object';
  const arrayError = validateStringArrays(value, new Set(['allowRanges']));
  if (arrayError) return arrayError;
  for (const range of (value.allowRanges ?? []) as string[]) {
    const [address, prefix, ...extra] = range.split('/');
    const version = address ? isIP(address) : 0;
    const maximum = version === 4 ? 32 : 128;
    if (extra.length > 0 || !version || (prefix !== undefined
      && (!/^\d+$/u.test(prefix) || Number(prefix) < 1 || Number(prefix) > maximum))) {
      return `allowRanges contains an invalid CIDR: ${range}`;
    }
  }
  return undefined;
}

function validateStringArrays(value: Record<string, unknown>, allowed: ReadonlySet<string>): string | undefined {
  for (const [key, item] of Object.entries(value)) {
    if (!allowed.has(key)) return `contains unknown field: ${key}`;
    if (!Array.isArray(item) || !item.every((entry) => typeof entry === 'string')) {
      return `${key} must be an array of strings`;
    }
  }
  return undefined;
}

function optionalBoundedNumber(value: unknown, fallback: number, maximum: number, label: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > maximum) {
    throw new Error(`${label} must be a number greater than 0 and at most ${maximum}`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
