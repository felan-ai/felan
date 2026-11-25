import type { ExtensionAPI, Provider } from '@felan-ai/agent-core';
import { describe, expect, it, vi } from 'vitest';
import extension, { createDiscreteStackExtension } from '../src/index.js';
import { DISCRETESTACK_MODELS } from '../src/provider.js';

describe('DiscreteStack extension', () => {
  it.each([
    ['default extension', extension],
    ['named factory', createDiscreteStackExtension()],
  ] as const)('registers exactly one native provider through the %s', async (_entry, activate) => {
    const registerProvider = vi.fn<(provider: Provider) => void>();
    await activate({ registerProvider } as unknown as ExtensionAPI);
    expect(registerProvider).toHaveBeenCalledOnce();
    const [provider] = registerProvider.mock.calls[0] ?? [];
    expect(provider).toMatchObject({ id: 'discretestack', name: 'DiscreteStack' });
    expect(provider?.getModels()).toEqual(DISCRETESTACK_MODELS);
    expect(provider?.auth.apiKey?.login).toBeTypeOf('function');
  });
});
