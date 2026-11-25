import { createProvider, openAICompletionsApi, type ApiKeyAuth, type ExtensionFactory, type Provider } from '@felan-ai/agent-core';
import {
  DISCRETESTACK_API_KEY_ENV,
  DISCRETESTACK_BASE_URLS,
  DISCRETESTACK_KEY_TYPE_ENV,
  DISCRETESTACK_MODELS,
  DISCRETESTACK_PROVIDER_ID,
  DISCRETESTACK_PROVIDER_NAME,
  type DiscreteStackKeyType,
} from './provider.js';

const STORED_SOURCE = 'stored credential';

function keyType(value: string | undefined): DiscreteStackKeyType {
  if (!value || value === 'user') return 'user';
  if (value === 'provider') return 'provider';
  throw new Error(`${DISCRETESTACK_KEY_TYPE_ENV} must be "user" or "provider".`);
}

// The key type is read from the same source as the key. A stored personal key therefore never
// reaches the provider channel because of an unrelated environment variable.
const apiKeyAuth: ApiKeyAuth = {
  name: 'DiscreteStack API key',
  login: async (interaction) => ({
    type: 'api_key',
    key: await interaction.prompt({ type: 'secret', message: 'Enter your DiscreteStack API key' }),
  }),
  // Availability checks run for every provider at once, so an invalid key type must not throw here.
  // resolve() reports it when a request is made.
  check: async ({ ctx, credential }) => {
    if (credential) return credential.key ? { type: 'api_key', source: STORED_SOURCE } : undefined;
    return await ctx.env(DISCRETESTACK_API_KEY_ENV) ? { type: 'api_key', source: DISCRETESTACK_API_KEY_ENV } : undefined;
  },
  resolve: async ({ ctx, credential }) => {
    const key = credential ? credential.key : await ctx.env(DISCRETESTACK_API_KEY_ENV);
    if (!key) return undefined;
    const type = keyType(credential ? credential.env?.[DISCRETESTACK_KEY_TYPE_ENV] : await ctx.env(DISCRETESTACK_KEY_TYPE_ENV));
    return {
      auth: { apiKey: key, baseUrl: DISCRETESTACK_BASE_URLS[type] },
      // Callers that pass a resolved key back as a request apiKey reach resolve() again with this
      // env as the credential env, which keeps the managed key on the provider channel.
      env: { [DISCRETESTACK_KEY_TYPE_ENV]: type },
      source: credential ? STORED_SOURCE : DISCRETESTACK_API_KEY_ENV,
    };
  },
};

export function createDiscreteStackProvider(): Provider {
  return createProvider({
    id: DISCRETESTACK_PROVIDER_ID,
    name: DISCRETESTACK_PROVIDER_NAME,
    auth: { apiKey: apiKeyAuth },
    models: DISCRETESTACK_MODELS,
    api: openAICompletionsApi(),
  });
}

export function createDiscreteStackExtension(): ExtensionFactory {
  return (pi) => {
    pi.registerProvider(createDiscreteStackProvider());
  };
}

export default createDiscreteStackExtension();
