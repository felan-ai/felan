import { builtinProviders } from '@felan-ai/agent-core';

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

let resolverPromise: Promise<Record<string, string>> | undefined;
let activeLeases = 0;
let restoreEntries: ReadonlyArray<readonly [string, string]> | undefined;

export async function acquireFelanModelDefaults(): Promise<() => void> {
  // Pi uses one unexported map for both startup and post-login selection. Its
  // exact version is pinned, and the coverage tests guard this internal seam.
  const defaults = await loadPiModelDefaults();
  if (activeLeases === 0) {
    assertBuiltinProviderCoverage();
    restoreEntries = Object.entries(defaults);
    replaceDefaults(defaults, Object.entries(FELAN_DEFAULT_MODEL_PER_PROVIDER));
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
    if (entries) replaceDefaults(defaults, entries);
  };
}

function loadPiModelDefaults(): Promise<Record<string, string>> {
  resolverPromise ??= (async () => {
    const piEntry = import.meta.resolve('@earendil-works/pi-coding-agent');
    const resolverUrl = new URL('./core/model-resolver.js', piEntry);
    const resolver = await import(resolverUrl.href) as PiModelResolverModule;
    if (!resolver.defaultModelPerProvider) {
      throw new Error('The installed Pi version does not expose its default model map');
    }
    return resolver.defaultModelPerProvider;
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
    .map(({ id }) => id)
    .filter((providerId) => !(providerId in FELAN_DEFAULT_MODEL_PER_PROVIDER));
  if (missing.length > 0) {
    throw new Error(`Felan model defaults are missing providers: ${missing.join(', ')}`);
  }
}
