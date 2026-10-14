import { createFelanPlatformService } from '@felan-ai/ext-felan-api/service';
import type { FelanPlatformService } from '@felan-ai/agent-core';

export function createLocalPlatformService(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  request: typeof globalThis.fetch = globalThis.fetch.bind(globalThis),
): FelanPlatformService | undefined {
  const apiKey = environment.FELAN_API_KEY?.trim();
  if (!apiKey) return undefined;
  return createFelanPlatformService({
    apiKey,
    baseUrl: environment.FELAN_API_URL?.trim() || 'https://app.felan.ai',
    docsBaseUrl: environment.FELAN_DOCS_URL?.trim() || 'https://felan.ai/docs',
    ...(environment.FELAN_TEAM_SLUG?.trim() ? { teamSlug: environment.FELAN_TEAM_SLUG.trim() } : {}),
    fetch: request,
  });
}
