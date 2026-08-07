import type { Api, Model } from '@earendil-works/pi-ai';

export const MODEL_TIERS = ['high', 'medium', 'low'] as const;
export type ModelTier = typeof MODEL_TIERS[number];

export interface ModelReference {
  readonly provider: string;
  readonly id: string;
  readonly name?: string;
}

export type ModelTierClassifier<TModel extends ModelReference = ModelReference> = (
  model: TModel,
) => ModelTier | undefined;

export interface ModelTierSelection<TModel extends ModelReference = Model<Api>> {
  readonly model: TModel;
  readonly tier: ModelTier;
}

export function isModelTier(value: string | undefined): value is ModelTier {
  return MODEL_TIERS.includes(value as ModelTier);
}

export function parseModelReference(value: string): ModelReference | undefined {
  const normalized = value.trim();
  const separator = normalized.indexOf('/');
  if (separator <= 0 || separator === normalized.length - 1) return undefined;

  const provider = normalized.slice(0, separator).trim();
  const id = normalized.slice(separator + 1).trim();
  return provider && id ? { provider, id } : undefined;
}

export function formatModelReference(model: ModelReference): string {
  return `${model.provider}/${model.id}`;
}

export function getModelFamily(model: ModelReference): string {
  const provider = model.provider.toLowerCase();
  const text = `${normalizedModelId(model)} ${model.name?.toLowerCase() ?? ''}`;
  if (AGGREGATE_PROVIDERS.has(provider)) return inferModelFamily(text) ?? provider;
  return PROVIDER_FAMILIES.get(provider) ?? inferModelFamily(text) ?? provider;
}

export function getModelStrength(model: ModelReference): ModelTier {
  const family = getModelFamily(model);
  const id = normalizedModelId(model);

  if (family === 'openai') return classifyOpenAi(id);
  if (family === 'anthropic') return classifyAnthropic(id);
  if (family === 'google') return classifyGoogle(id);
  if (family === 'deepseek') return classifyDeepSeek(id);
  if (family === 'qwen') return classifyQwen(id);
  if (family === 'kimi') return classifyKimi(id);
  if (family === 'zai') return classifyZai(id);
  if (family === 'mistral') return classifyMistral(id);
  if (family === 'xai') return classifyXai(id);
  if (family === 'minimax') return /(?:^|-)m3(?:-|$)/u.test(id) ? 'high' : 'medium';
  if (family === 'xiaomi') return roleTier(id, /(?:^|-)pro(?:-|$)/u, /(?:^|-)(?:flash|mini)(?:-|$)/u);
  if (family === 'amazon') return roleTier(id, /(?:^|-)premier(?:-|$)/u, /(?:^|-)(?:lite|micro)(?:-|$)/u);
  if (family === 'nvidia') return roleTier(id, /(?:^|-)ultra(?:-|$)/u, /(?:^|-)nano(?:-|$)/u);
  return classifyGeneric(id);
}

export function selectModelForTier<TModel extends ModelReference>(
  tier: ModelTier,
  models: readonly TModel[],
  options: {
    readonly preferredModel?: ModelReference;
    readonly classifyModel?: ModelTierClassifier<TModel>;
  } = {},
): ModelTierSelection<TModel> | undefined {
  const classify = options.classifyModel ?? getModelStrength;
  const candidates = models
    .map((model, index) => ({ model, index }))
    .filter(({ model }) => classify(model) === tier)
    .map(({ model, index }) => ({
      model,
      index,
      rank: selectionRank(model, options.preferredModel),
      priority: modelPriority(model, tier),
    }))
    .sort((left, right) => (
      left.rank - right.rank
      || right.priority - left.priority
      || left.index - right.index
    ));
  const selected = candidates[0]?.model;
  return selected ? { model: selected, tier } : undefined;
}

function selectionRank(model: ModelReference, preferredModel: ModelReference | undefined): number {
  if (!preferredModel) return 4;
  if (formatModelReference(model).toLowerCase() === formatModelReference(preferredModel).toLowerCase()) return 0;
  const sameProvider = model.provider.toLowerCase() === preferredModel.provider.toLowerCase();
  const sameFamily = getModelFamily(model) === getModelFamily(preferredModel);
  if (sameProvider && sameFamily) return 1;
  if (sameProvider) return 2;
  if (sameFamily) return 3;
  return 4;
}

function modelPriority(model: ModelReference, tier: ModelTier): number {
  const family = getModelFamily(model);
  const id = normalizedModelId(model);
  let role = 0;

  if (family === 'openai') {
    if (tier === 'high') role = tokenPriority(id, ['sol', 'pro']);
    if (tier === 'medium') role = tokenPriority(id, ['terra']);
    if (tier === 'low') role = tokenPriority(id, ['luna', 'nano', 'mini', 'spark']);
  } else if (family === 'anthropic') {
    if (tier === 'high') role = tokenPriority(id, ['fable', 'opus']);
  } else if (family === 'google') {
    if (tier === 'high') role = tokenPriority(id, ['pro']);
    if (tier === 'medium') role = tokenPriority(id, ['flash']);
    if (tier === 'low') role = tokenPriority(id, ['flash-lite']);
  } else if (family === 'deepseek' && tier === 'high') {
    role = tokenPriority(id, ['pro', 'r1', 'reasoner']);
  } else if (family === 'qwen') {
    if (tier === 'high') role = tokenPriority(id, ['max']);
    if (tier === 'low') role = tokenPriority(id, ['flash', 'mini']);
  } else if (family === 'kimi' && tier === 'high') {
    role = tokenPriority(id, ['k3', 'thinking']);
  } else if (family === 'mistral') {
    if (tier === 'high') role = tokenPriority(id, ['large']);
    if (tier === 'low') role = tokenPriority(id, ['small', 'ministral', 'nemo']);
  }

  return role * 1_000_000 + modelVersionScore(id);
}

function tokenPriority(id: string, tokens: readonly string[]): number {
  const index = tokens.findIndex((token) => new RegExp(`(?:^|-)${token}(?:-|$)`, 'u').test(id));
  return index === -1 ? 0 : tokens.length - index;
}

function modelVersionScore(id: string): number {
  const values = [...id.matchAll(/\d+(?:\.\d+)?/gu)].map((match) => Number(match[0]));
  if (values.length === 0) return 0;
  const primary = values[0]!;
  const secondary = Number.isInteger(primary) && (values[1] ?? 100) < 100 ? values[1]! : 0;
  return primary * 1_000 + secondary;
}

function classifyOpenAi(id: string): ModelTier {
  if (/(?:^|-)(?:luna|nano|mini|spark)(?:-|$)/u.test(id)) return 'low';
  if (/(?:^|-)(?:sol|pro)(?:-|$)/u.test(id) || /(?:^|-)o[13](?:-|$)/u.test(id)) return 'high';
  if (/gpt-5\.5(?:-|$)/u.test(id)) return 'high';
  return classifyGeneric(id);
}

function classifyAnthropic(id: string): ModelTier {
  if (/(?:^|-)(?:fable|opus)(?:-|$)/u.test(id)) return 'high';
  if (/(?:^|-)haiku(?:-|$)/u.test(id)) return 'low';
  return 'medium';
}

function classifyGoogle(id: string): ModelTier {
  if (/flash[-_.]?lite/u.test(id)) return 'low';
  if (/(?:^|-)(?:pro|max)(?:-|$)/u.test(id) || id.includes('deep-research')) return 'high';
  if (/(?:^|-)flash(?:-|$)/u.test(id)) return 'medium';
  return classifyGeneric(id);
}

function classifyDeepSeek(id: string): ModelTier {
  if (/(?:^|-)flash(?:-|$)/u.test(id)) return 'low';
  if (/(?:^|-)(?:pro|r1|reasoner)(?:-|$)/u.test(id)) return 'high';
  return 'medium';
}

function classifyQwen(id: string): ModelTier {
  if (/(?:^|-)(?:flash|mini)(?:-|$)/u.test(id)) return 'low';
  if (/(?:^|-)max(?:-|$)/u.test(id)) return 'high';
  return parameterTier(id) ?? 'medium';
}

function classifyKimi(id: string): ModelTier {
  if (/(?:^|-)k3(?:-|$)/u.test(id) || /(?:^|-)thinking(?:-|$)/u.test(id)) return 'high';
  if (/kimi-k2(?:-|$)/u.test(id) && !/kimi-k2\.[5-9]/u.test(id)) return 'low';
  return 'medium';
}

function classifyZai(id: string): ModelTier {
  if (/(?:^|-)(?:flash|air)(?:-|$)/u.test(id)) return 'low';
  if (/glm-5(?:\.[0-9]+)?(?:-|$)/u.test(id) && !/(?:^|-)turbo(?:-|$)/u.test(id)) return 'high';
  return 'medium';
}

function classifyMistral(id: string): ModelTier {
  if (/(?:^|-)(?:small|ministral|nemo)(?:-|$)/u.test(id)) return 'low';
  if (/(?:^|-)large(?:-|$)/u.test(id)) return 'high';
  return 'medium';
}

function classifyXai(id: string): ModelTier {
  if (/(?:^|-)(?:fast|non-reasoning)(?:-|$)/u.test(id)) return 'low';
  if (/(?:^|-)grok(?:-|$)/u.test(id) && !id.includes('build')) return 'high';
  return 'medium';
}

function classifyGeneric(id: string): ModelTier {
  if (/(?:^|-)(?:flash-lite|nano|mini|small|lite|micro|air|scout|edge|spark)(?:-|$)/u.test(id)) {
    return 'low';
  }
  if (/(?:^|-)(?:fable|opus|sol|ultra|premier|max|pro|large|reasoner|thinking)(?:-|$)/u.test(id)) {
    return 'high';
  }
  return parameterTier(id) ?? 'medium';
}

function roleTier(id: string, high: RegExp, low: RegExp): ModelTier {
  if (low.test(id)) return 'low';
  if (high.test(id)) return 'high';
  return classifyGeneric(id);
}

function parameterTier(id: string): ModelTier | undefined {
  const sizes = [...id.matchAll(/(?:^|-)(\d+(?:\.\d+)?)b(?:-|$)/gu)]
    .map((match) => Number(match[1]))
    .filter(Number.isFinite);
  if (sizes.length === 0) return undefined;
  const largest = Math.max(...sizes);
  if (largest >= 100) return 'high';
  if (largest <= 32) return 'low';
  return 'medium';
}

function normalizedModelId(model: ModelReference): string {
  return model.id.toLowerCase().replace(/^~/u, '');
}

function inferModelFamily(text: string): string | undefined {
  if (text.includes('claude') || text.includes('anthropic')) return 'anthropic';
  if (text.includes('gpt') || /(?:^|[/_.-])o[134](?:[/_.-]|$)/u.test(text)) return 'openai';
  if (text.includes('gemini') || text.includes('gemma')) return 'google';
  if (text.includes('deepseek')) return 'deepseek';
  if (text.includes('qwen')) return 'qwen';
  if (text.includes('kimi') || text.includes('moonshot')) return 'kimi';
  if (text.includes('glm') || text.includes('z-ai')) return 'zai';
  if (/mistral|mixtral|codestral|devstral|magistral|ministral/u.test(text)) return 'mistral';
  if (text.includes('grok') || text.includes('x-ai')) return 'xai';
  if (text.includes('minimax')) return 'minimax';
  if (text.includes('mimo') || text.includes('xiaomi')) return 'xiaomi';
  if (text.includes('llama') || text.includes('meta-llama')) return 'meta';
  if (text.includes('nova') || text.includes('amazon')) return 'amazon';
  if (text.includes('nemotron') || text.includes('nvidia')) return 'nvidia';
  if (text.includes('command-r') || text.includes('cohere')) return 'cohere';
  return undefined;
}

const PROVIDER_FAMILIES = new Map([
  ['anthropic', 'anthropic'],
  ['azure-openai-responses', 'openai'],
  ['deepseek', 'deepseek'],
  ['google', 'google'],
  ['google-vertex', 'google'],
  ['kimi-coding', 'kimi'],
  ['minimax', 'minimax'],
  ['minimax-cn', 'minimax'],
  ['mistral', 'mistral'],
  ['moonshotai', 'kimi'],
  ['moonshotai-cn', 'kimi'],
  ['openai', 'openai'],
  ['openai-codex', 'openai'],
  ['xai', 'xai'],
  ['xiaomi', 'xiaomi'],
  ['zai', 'zai'],
  ['zai-coding-cn', 'zai'],
]);

const AGGREGATE_PROVIDERS = new Set([
  'amazon-bedrock',
  'baseten',
  'cerebras',
  'cloudflare-ai-gateway',
  'cloudflare-workers-ai',
  'fireworks',
  'github-copilot',
  'groq',
  'huggingface',
  'nvidia',
  'opencode',
  'opencode-go',
  'openrouter',
  'qwen-token-plan',
  'qwen-token-plan-cn',
  'together',
  'vercel-ai-gateway',
  'xiaomi-token-plan-ams',
  'xiaomi-token-plan-cn',
  'xiaomi-token-plan-sgp',
]);
