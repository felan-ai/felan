import type { ExtensionAPI } from '@felan-ai/agent-core';
import { describe, expect, it, vi } from 'vitest';
import extension, { createDiscreteStackExtension } from '../src/index.js';
import { DISCRETESTACK_PROVIDER } from '../src/provider.js';

describe('DiscreteStack extension', () => {
  it.each([
    ['default extension', extension],
    ['named factory', createDiscreteStackExtension()],
  ] as const)('registers exactly one provider through the %s', async (_entry, activate) => {
    const registerProvider = vi.fn<ExtensionAPI['registerProvider']>();
    await activate({ registerProvider } as unknown as ExtensionAPI);
    expect(registerProvider).toHaveBeenCalledExactlyOnceWith('discretestack', DISCRETESTACK_PROVIDER);
  });
});
