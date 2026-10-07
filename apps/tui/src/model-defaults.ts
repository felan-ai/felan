import { builtinProviders } from '@felan-ai/agent-core';
import { findPackageJSON } from 'node:module';
import { pathToFileURL } from 'node:url';

export const FELAN_DEFAULT_MODEL_PER_PROVIDER = {
  'amazon-bedrock': 'us.anthropic.claude-opus-5',
  'ant-ling': 'Ring-2.6-1T',
  anthropic: 'claude-opus-5',
  openai: 'gpt-5.6-sol',
  'azure-openai-responses': 'gpt-5.6-sol',
  'openai-codex': 'gpt-5.6-sol',
  radius: 'balanced',
  nvidia: 'nvidia/nemotron-3-ultra-550b-a55b',
  deepseek: 'deepseek-v4-pro',
  google: 'gemini-3.8-flash',
  'google-vertex': 'gemini-3.8-flash',
  'github-copilot': 'gpt-5.6-sol',
  openrouter: 'moonshotai/kimi-k3',
  'vercel-ai-gateway': 'zai/glm-5.3',
  xai: 'grok-4.6',
  groq: 'openai/gpt-oss-120b',
  cerebras: 'gpt-oss-120b',
  zai: 'glm-5.3',
  'zai-coding-cn': 'glm-5.3',
  mistral: 'devstral-medium-latest',
  minimax: 'MiniMax-M3',
  'minimax-cn': 'MiniMax-M3',
  meta: 'muse-spark-1.3',
  moonshotai: 'kimi-k3',
  'moonshotai-cn': 'kimi-k3',
  huggingface: 'moonshotai/Kimi-K3',
  fireworks: 'accounts/fireworks/models/kimi-k3',
  together: 'moonshotai/Kimi-K3',
  baseten: 'zai-org/GLM-5.3',
  opencode: 'kimi-k3',
  'opencode-go': 'kimi-k3',
  'kimi-coding': 'k3',
  'cloudflare-workers-ai': '@cf/moonshotai/kimi-k2.7-code',
  'cloudflare-ai-gateway': 'workers-ai/@cf/moonshotai/kimi-k2.7-code',
  'qwen-token-plan': 'qwen3.8-max',
  'qwen-token-plan-cn': 'qwen3.8-max',
  'qwen-token-plan-individual': 'qwen3.8-max',
  xiaomi: 'mimo-v2.5-pro',
  'xiaomi-token-plan-cn': 'mimo-v2.5-pro',
  'xiaomi-token-plan-ams': 'mimo-v2.5-pro',
  'xiaomi-token-plan-sgp': 'mimo-v2.5-pro',
} as const satisfies Readonly<Record<string, string>>;

interface PiModelResolverModule {
  readonly defaultModelPerProvider?: Record<string, string>;
}

let resolverPromise: Promise<ReadonlyArray<Record<string, string>>> | undefined;
let activeLeases = 0;
let restoreEntries: ReadonlyArray<{ target: Record<string, string>; entries: ReadonlyArray<readonly [string, string]> }> | undefined;

export async function acquireFelanModelDefaults(): Promise<() => void> {
  // Peer resolution can load distinct Pi copies for Core startup and TUI login.
  // Their pinned model maps must receive and release the same defaults together.
  const defaults = await loadPiModelDefaults();
  if (activeLeases === 0) {
    assertBuiltinProviderCoverage();
    restoreEntries = defaults.map(target => ({ target, entries: Object.entries(target) }));
    for (const target of defaults) replaceDefaults(target, Object.entries(FELAN_DEFAULT_MODEL_PER_PROVIDER));
  }
  activeLeases += 1;

  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeLeases -= 1;
    if (activeLeases > 0) return;

    const entries = restoreEntries;
    restoreEntries = undefined;
    for (const original of entries ?? []) replaceDefaults(original.target, original.entries);
  };
}

function loadPiModelDefaults(): Promise<ReadonlyArray<Record<string, string>>> {
  resolverPromise ??= (async () => {
    const bases = [import.meta.url, import.meta.resolve('@felan-ai/agent-core')];
    const targets = await Promise.all(bases.map(async base => {
      const manifest = findPackageJSON('@earendil-works/pi-coding-agent', base);
      if (!manifest) throw new Error('The installed Pi package cannot be resolved');
      const resolverUrl = new URL('./dist/core/model-resolver.js', pathToFileURL(manifest));
      const resolver = await import(resolverUrl.href) as PiModelResolverModule;
      if (!resolver.defaultModelPerProvider) {
        throw new Error('The installed Pi version does not expose its default model map');
      }
      return resolver.defaultModelPerProvider;
    }));
    return [...new Set(targets)];
  })();
  return resolverPromise;
}

function replaceDefaults(
  target: Record<string, string>,
  entries: ReadonlyArray<readonly [string, string]>,
): void {
  for (const providerId of Object.keys(target)) {
    delete target[providerId];
  }
  Object.assign(target, Object.fromEntries(entries));
}

function assertBuiltinProviderCoverage(): void {
  const missing = builtinProviders()
    .filter((provider) => provider.getModels().length > 0)
    .map(({ id }) => id)
    .filter((providerId) => !(providerId in FELAN_DEFAULT_MODEL_PER_PROVIDER));
  if (missing.length > 0) {
    throw new Error(`Felan model defaults are missing providers: ${missing.join(', ')}`);
  }
}
