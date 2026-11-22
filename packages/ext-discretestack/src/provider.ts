import type { ExtensionAPI } from '@felan-ai/agent-core';

type ProviderConfig = Parameters<ExtensionAPI['registerProvider']>[1];
type ChatModelConfig = Extract<NonNullable<ProviderConfig['models']>[number], { type?: 'chat' }>;

export const DISCRETESTACK_PROVIDER_ID = 'discretestack';
export const DISCRETESTACK_API_KEY_ENV = 'DISCRETESTACK_API_KEY';

// The gateway rejects a request whose prompt plus max_tokens exceeds 1,048,576 tokens instead of
// clamping the output. Pi sends maxTokens on every request and compacts against contextWindow, so
// the advertised window leaves room for a full response.
const GATEWAY_CONTEXT_TOKENS = 1_048_576;
const MAX_OUTPUT_TOKENS = 131_072;

// Small budgeted requests such as session titles ask for minimal reasoning. The gateway has no
// minimal effort, and Pi would otherwise round it up to low, which DeepSeek can spend entirely on
// reasoning before writing any text.

const chatModel = {
  type: 'chat',
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
} satisfies Omit<ChatModelConfig, 'id' | 'name' | 'cost'>;

export const DISCRETESTACK_PROVIDER = {
  name: 'DiscreteStack',
  baseUrl: 'https://api.discretestack.eu/provider/v1',
  api: 'openai-completions',
  apiKey: `\${${DISCRETESTACK_API_KEY_ENV}}`,
  models: [
    {
      ...chatModel,
      id: 'deepseek-v4.1-flash-1017',
      name: 'DiscreteStack Max',
      cost: { input: 0.07, output: 0.18, cacheRead: 0.002, cacheWrite: 0 },
    },
    {
      ...chatModel,
      id: 'glm-5.3-flash',
      name: 'DiscreteStack Compact',
      cost: { input: 0.05, output: 0.2, cacheRead: 0.015, cacheWrite: 0 },
    },
  ],
} satisfies ProviderConfig;
