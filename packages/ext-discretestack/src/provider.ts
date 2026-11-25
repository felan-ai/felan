import type { Model } from '@felan-ai/agent-core';

export const DISCRETESTACK_PROVIDER_ID = 'discretestack';
export const DISCRETESTACK_PROVIDER_NAME = 'DiscreteStack';
export const DISCRETESTACK_API_KEY_ENV = 'DISCRETESTACK_API_KEY';
export const DISCRETESTACK_KEY_TYPE_ENV = 'DISCRETESTACK_KEY_TYPE';

// Personal keys use the public API. The provider channel serves Felan's managed key, which is
// marked with DISCRETESTACK_KEY_TYPE=provider.
export const DISCRETESTACK_BASE_URLS = {
  user: 'https://api.discretestack.eu/v1',
  provider: 'https://api.discretestack.eu/provider/v1',
} as const;

export type DiscreteStackKeyType = keyof typeof DISCRETESTACK_BASE_URLS;

// The gateway rejects a request whose prompt plus max_tokens exceeds 1,048,576 tokens instead of
// clamping the output, and the personal-key endpoint also rejects max_tokens above 64,000. Pi sends
// maxTokens on every request and compacts against contextWindow, so the advertised window leaves
// room for a full response.
const GATEWAY_CONTEXT_TOKENS = 1_048_576;
const MAX_OUTPUT_TOKENS = 64_000;

// Small budgeted requests such as session titles ask for minimal reasoning. The gateway has no
// minimal effort, and Pi would otherwise round it up to low, which DeepSeek can spend entirely on
// reasoning before writing any text.

const chatModel = {
  api: 'openai-completions',
  provider: DISCRETESTACK_PROVIDER_ID,
  baseUrl: DISCRETESTACK_BASE_URLS.user,
  reasoning: true,
  input: ['text', 'image'],
  contextWindow: GATEWAY_CONTEXT_TOKENS - MAX_OUTPUT_TOKENS,
  maxTokens: MAX_OUTPUT_TOKENS,
  thinkingLevelMap: { off: 'none', minimal: 'none', low: 'low', medium: null, high: 'high', xhigh: null, max: 'max' },
  compat: {
    supportsStore: false,
    supportsDeveloperRole: false,
    supportsReasoningEffort: true,
    maxTokensField: 'max_tokens',
  },
} satisfies Omit<Model<'openai-completions'>, 'id' | 'name' | 'cost'>;

export const DISCRETESTACK_MODELS: readonly Model<'openai-completions'>[] = [
  {
    ...chatModel,
    id: 'discretestack-max',
    name: 'DiscreteStack Max',
    cost: { input: 0.07, output: 0.18, cacheRead: 0.002, cacheWrite: 0 },
  },
  {
    ...chatModel,
    id: 'discretestack-compact',
    name: 'DiscreteStack Compact',
    cost: { input: 0.05, output: 0.2, cacheRead: 0.015, cacheWrite: 0 },
  },
];
