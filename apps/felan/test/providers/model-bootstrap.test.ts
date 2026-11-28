import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { HostAgentRuntime, ModelRuntime, type HostRuntimeService } from '@felan-ai/agent-core';
import { afterEach, expect, it, vi } from 'vitest';
import { setupDependencies } from '../../src/providers/dependencies.js';
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
  expect(initialize).toHaveBeenCalledExactlyOnceWith(resolve('/fixture'));
  expect(create).toHaveBeenCalledTimes(2);
  await expect(runtime.createModelRuntime('/other')).rejects.toThrow('restart');
  expect(create).toHaveBeenCalledTimes(2);
});

async function createDiscreteStackHost(agentDir: string, settingsJson?: string) {
  if (settingsJson !== undefined) await writeFile(join(agentDir, 'settings.json'), settingsJson);
  for (const dependency of setupDependencies) vi.spyOn(dependency, 'check').mockResolvedValue({ available: false });
  const runtimeService = { create: (...args: Parameters<HostRuntimeService['create']>) => new HostAgentRuntime(...args) };
  const local = createLocalSessionRuntime({ runtimeService, initializeProcess: async () => ({ diagnostics: [], assertConfiguration: () => [] }) });
  const models = await local.createModelRuntime(agentDir);
  const host = await local.createHostServices({ agentDir, homeDir: agentDir, models,
    runtime: runtimeService.create(agentDir, { agentStorageRoot: agentDir, sessionStorageRoot: agentDir }),
    definitions: [], interactions: { request: vi.fn() }, refreshModelAvailability: vi.fn(), assertCurrent() {},
  });
  return { local, models, host };
}

it.each([true, false])('gates the DiscreteStack host provider and login catalog when enabled is %s', async enabled => {
  const agentDir = await mkdtemp(join(tmpdir(), 'felan-model-bootstrap-'));
  try {
    const { local, models, host } = await createDiscreteStackHost(agentDir,
      enabled ? undefined : JSON.stringify({ builtinExtensions: { discretestack: false } }));
    const provider = (await host.setup.catalog()).providers.find(({ id }) => id === 'discretestack');
    const login = { kind: 'login', provider: 'discretestack', method: 'api_key' } as const;
    expect(models.getProviders().some(({ id }) => id === 'discretestack')).toBe(enabled);
    if (enabled) {
      expect(provider).toMatchObject({ id: 'discretestack', label: 'DiscreteStack', methods: ['api_key'], apiKeyLogin: true });
      expect(() => host.setup.validateStart(login)).not.toThrow();
    } else {
      expect(provider).toBeUndefined();
      expect(() => host.setup.validateStart(login)).toThrow();
    }
    const sessionModels = await local.createModelRuntime(agentDir);
    expect(sessionModels.getProviders().some(({ id }) => id === 'discretestack')).toBe(false);
  } finally { await rm(agentDir, { recursive: true, force: true }); }
});

it('starts host services with DiscreteStack registered when settings.json is malformed', async () => {
  const agentDir = await mkdtemp(join(tmpdir(), 'felan-model-bootstrap-'));
  try {
    const { models } = await createDiscreteStackHost(agentDir, '{');
    expect(models.getProviders().some(({ id }) => id === 'discretestack')).toBe(true);
  } finally { await rm(agentDir, { recursive: true, force: true }); }
});

it('propagates lost ownership while reading DiscreteStack host settings', async () => {
  const agentDir = await mkdtemp(join(tmpdir(), 'felan-model-bootstrap-'));
  try {
    const runtimeService = { create: (...args: Parameters<HostRuntimeService['create']>) => new HostAgentRuntime(...args) };
    const local = createLocalSessionRuntime({ runtimeService, initializeProcess: async () => ({ diagnostics: [], assertConfiguration: () => [] }) });
    const models = await local.createModelRuntime(agentDir);
    await expect(local.createHostServices({ agentDir, homeDir: agentDir, models,
      runtime: runtimeService.create(agentDir, { agentStorageRoot: agentDir, sessionStorageRoot: agentDir }),
      definitions: [], interactions: { request: vi.fn() }, refreshModelAvailability: vi.fn(),
      assertCurrent() { throw new Error('ownership lost'); },
    })).rejects.toThrow('ownership lost');
  } finally { await rm(agentDir, { recursive: true, force: true }); }
});

it('serves host subscription usage with Claude Code usage restored from host agent storage', async () => {
  const agentDir = await mkdtemp(join(tmpdir(), 'felan-model-bootstrap-'));
  try {
    await writeFile(join(agentDir, 'claude-code-usage.json'), JSON.stringify({ version: 1, providers: { anthropic: { rateLimitedCount: 0,
      snapshot: { windows: [{ label: 'Extra [on]', usedPercent: 3 }], lastSuccessAt: 5 } } } }));
    const { host } = await createDiscreteStackHost(agentDir);
    expect(await host.subscriptions!.read()).toEqual({ subscriptions: [{ provider: 'anthropic', modelProvider: 'claude-code', label: 'Claude Plan',
      windows: [{ label: 'Extra [on]', usedPercent: 3 }], updatedAt: 5 }] });
  } finally { await rm(agentDir, { recursive: true, force: true }); }
});
