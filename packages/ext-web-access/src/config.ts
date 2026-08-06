import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
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

export function configPath(agentDir: string): string {
  return join(agentDir, 'web-search.json');
}

export async function loadConfig(agentDir: string): Promise<WebAccessConfig> {
  const path = configPath(agentDir);
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if (isMissingFile(error)) return {};
    throw new Error(`Failed to read ${path}: ${errorMessage(error)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Failed to parse ${path}: ${errorMessage(error)}`);
  }
  if (!isRecord(parsed)) throw new Error(`${path} must contain a JSON object`);
  return parsed as WebAccessConfig;
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

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
