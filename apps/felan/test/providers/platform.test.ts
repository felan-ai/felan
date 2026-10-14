import { afterEach, expect, it, vi } from 'vitest';
import { createExtensionServiceAccess, createFelanServiceRegistry, type FelanExtensionAPI } from '@felan-ai/agent-core';
import extension from '@felan-ai/ext-felan-api';
import platform from '../../src/providers/felan-platform.js';

afterEach(() => vi.unstubAllEnvs());

it('registers no platform gateway or capability when the local key is absent', async () => {
  vi.stubEnv('FELAN_API_KEY', '');
  const instance = await platform.create({ services: { get: () => undefined }, options: undefined, signal: new AbortController().signal });
  expect(instance.implementations).toEqual([]);
  const registry = createFelanServiceRegistry();
  const registerTool = vi.fn();
  const registerCapability = vi.fn();
  await extension({ services: createExtensionServiceAccess(registry, extension.serviceRequirements!), registerTool, registerCapability } as unknown as FelanExtensionAPI);
  expect(registerTool).not.toHaveBeenCalled();
  expect(registerCapability).not.toHaveBeenCalled();
  await instance.dispose();
});
