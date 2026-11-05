import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { HostAgentRuntime, SECRETS_SERVICE, createExtensionServiceAccess, createFelanServiceRegistry, defineServiceContract, type SecretsService, type ModelRuntime } from '@felan-ai/agent-core';
import type { ProviderSessionContext, ServiceProviderDefinition } from '@felan-ai/daemon/provider';
import { BROWSER_AUTHORIZATION_SERVICE } from '@felan-ai/ext-browser/service';
import { MCP_OAUTH_CALLBACK_SERVICE } from '@felan-ai/ext-mcp/service';
import browser from '../../src/providers/browser-authorization.js';
import mcp from '../../src/providers/mcp-callback.js';

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

it('names every provider contract in host.json and exports each module', async () => {
  const config = JSON.parse(await readFile(new URL('../../src/host.json', import.meta.url), 'utf8')) as {
    services: Array<{ id: string; major: number; use: string }>;
  };
  expect(config.services.some(row => row.id.startsWith('felan.local.'))).toBe(false);
  const manifest = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
  for (const use of new Set(config.services.map(row => row.use))) {
    let moduleUrl: string;
    if (use.startsWith('@felan-ai/felan/')) {
      const subpath = `.${use.slice('@felan-ai/felan'.length)}`;
      expect(manifest.exports[subpath]).toBeDefined();
      moduleUrl = new URL(`../../src/${subpath.slice(2)}.ts`, import.meta.url).href;
    } else {
      moduleUrl = import.meta.resolve(use);
    }
    const module = await import(moduleUrl) as { default: ServiceProviderDefinition };
    expect(module.default.provides.map(contract => contract.key).sort()).toEqual(config.services
      .filter(row => row.use === use).map(row => `${row.id}@${row.major}`).sort());
  }
});

it('creates extension services from providers even when no extension is enabled', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'felan-extension-providers-')); temporary.push(directory);
  const runtime = new HostAgentRuntime(directory, { sessionStorageRoot: join(directory, 'session'), agentStorageRoot: join(directory, 'agent') });
  const registry = createFelanServiceRegistry();
  registry.set(SECRETS_SERVICE, { get: async () => undefined } as unknown as SecretsService);
  const context = (definition: ServiceProviderDefinition): ProviderSessionContext => ({
    runtime, modelRuntime: {} as ModelRuntime, secretStorage: { read: async () => undefined, write: async () => {}, remove: async () => {} },
    execution: { context: { runtime, extensionConfigOverrides: [], resources: { agentDir: directory } },
      port: { ui: { request: vi.fn(), canPresent: () => false, subscribeClients: () => () => {} } } } as unknown as NonNullable<ProviderSessionContext['execution']>,
    sessionId: 'child', rootSessionId: 'root', allowedModels: undefined, signal: new AbortController().signal, options: undefined,
    services: createExtensionServiceAccess(registry, { required: (definition.requires ?? []).map(contract => defineServiceContract(contract.id, contract.major)), optional: (definition.optional ?? []).map(contract => defineServiceContract(contract.id, contract.major)) }),
  });
  for (const provider of [browser, mcp]) {
    const instance = await provider.create(context(provider));
    const row = instance.implementations[0]!;
    expect(row.value).toBeDefined();
    if (row.contract.key === BROWSER_AUTHORIZATION_SERVICE.key) expect(row.value).toHaveProperty('authorize');
    if (row.contract.key === MCP_OAUTH_CALLBACK_SERVICE.key) expect(row.value).toHaveProperty('reserve');
    await instance.dispose();
  }
  registry.revoke();
});

it('configures memory scheduling as a daemon service rather than a session provider', async () => {
  const config = JSON.parse(await readFile(new URL('../../src/host.json', import.meta.url), 'utf8'));
  expect(config.services.filter((row: { id: string }) => row.id.startsWith('felan.memory'))).toEqual([
    { id: 'felan.memory.scheduler', major: 1, use: '@felan-ai/ext-memory/daemon' },
  ]);
  const { default: provider } = await import('@felan-ai/ext-memory/daemon');
  expect(provider.scope).toBe('daemon');
});
