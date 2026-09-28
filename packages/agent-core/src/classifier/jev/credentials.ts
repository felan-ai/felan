const MAX_CREDENTIAL_BYTES = 16_384;
const INVALID_CREDENTIAL = /[\0-\x1f\x7f]/u;

export type JevProvider = 'auto' | 'typesafe' | 'openrouter';

export interface JevCredentialSources {
  readonly provider?: JevProvider;
  readonly typesafeApiKey?: string;
  readonly openrouterApiKey?: string;
  readonly environment?: NodeJS.ProcessEnv;
}

export interface ResolvedJevTransport {
  readonly provider: 'typesafe' | 'openrouter';
  readonly apiKey: string;
  readonly url: URL;
  readonly model: string;
}

export const TYPESAFE_SYSTEMONE_URL = 'https://api.typesafe.ai/v1/systemone';
export const OPENROUTER_DECISIONS_URL = 'https://openrouter.ai/api/alpha/decisions';
export const TYPESAFE_MODEL = 'jev-latest';
export const OPENROUTER_MODEL = 'typesafe/jev-1.13';

export function resolveJevTransport(sources: JevCredentialSources): ResolvedJevTransport | undefined {
  const environment = sources.environment ?? process.env;
  const typesafeKey = normalizeCredential(sources.typesafeApiKey) ?? normalizeCredential(environment.TYPESAFE_API_KEY);
  const openrouterKey = normalizeCredential(sources.openrouterApiKey)
    ?? normalizeCredential(environment.OPENROUTER_API_KEY);

  const provider = sources.provider ?? 'auto';
  if (provider === 'typesafe') return typesafeKey ? typesafeTransport(typesafeKey) : undefined;
  if (provider === 'openrouter') return openrouterKey ? openrouterTransport(openrouterKey) : undefined;
  if (typesafeKey) return typesafeTransport(typesafeKey);
  if (openrouterKey) return openrouterTransport(openrouterKey);
  return undefined;
}

function typesafeTransport(apiKey: string): ResolvedJevTransport {
  return {
    provider: 'typesafe',
    apiKey,
    url: new URL(TYPESAFE_SYSTEMONE_URL),
    model: TYPESAFE_MODEL,
  };
}

function openrouterTransport(apiKey: string): ResolvedJevTransport {
  return {
    provider: 'openrouter',
    apiKey,
    url: new URL(OPENROUTER_DECISIONS_URL),
    model: OPENROUTER_MODEL,
  };
}

export function redactCredential(value: string, credential: string | undefined): string {
  return credential ? value.split(credential).join('[redacted]') : value;
}

function normalizeCredential(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (Buffer.byteLength(trimmed, 'utf8') > MAX_CREDENTIAL_BYTES || INVALID_CREDENTIAL.test(trimmed)) {
    throw new Error('Jev API key is invalid');
  }
  return trimmed;
}
