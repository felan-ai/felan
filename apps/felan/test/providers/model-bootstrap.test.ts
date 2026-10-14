import { ModelRuntime, type HostRuntimeService } from '@felan-ai/agent-core';
import { afterEach, expect, it, vi } from 'vitest';
import { createLocalModelRuntime } from '../../src/providers/local-model-runtime.js';
import { createLocalSessionRuntime } from '../../src/providers/session-runtime.js';

afterEach(() => vi.restoreAllMocks());

it('initializes process settings before a model runtime can discover models or authenticate', async () => {
  const order: string[] = [];
  const models = {} as ModelRuntime;
  vi.spyOn(ModelRuntime, 'create').mockImplementation(async () => { order.push('models'); return models; });
  const initialize = vi.fn(async () => {
    order.push('process');
    return { diagnostics: [], assertConfiguration: () => [] };
  });
  expect(await createLocalModelRuntime('/fixture', undefined, initialize)).toBe(models);
  expect(order).toEqual(['process', 'models']);
  expect(initialize).toHaveBeenCalledExactlyOnceWith('/fixture');
});

it('initializes the configured session provider once before startup model discovery', async () => {
  const initialize = vi.fn(async () => ({ diagnostics: [], assertConfiguration: () => [] }));
  const create = vi.spyOn(ModelRuntime, 'create').mockImplementation(async () => {
    expect(initialize).toHaveBeenCalledOnce();
    return {} as ModelRuntime;
  });
  const runtime = createLocalSessionRuntime({ initializeProcess: initialize, runtimeService: {} as HostRuntimeService });
  await runtime.createModelRuntime('/fixture');
  await runtime.createModelRuntime('/fixture');
  expect(initialize).toHaveBeenCalledExactlyOnceWith('/fixture');
  expect(create).toHaveBeenCalledTimes(2);
  await expect(runtime.createModelRuntime('/other')).rejects.toThrow('restart');
  expect(create).toHaveBeenCalledTimes(2);
});
