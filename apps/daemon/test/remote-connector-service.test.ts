import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { InMemoryCredentialStore, ModelRuntime } from '@felan-ai/agent-core';
import { startDaemonService } from '../src/daemon/service.js';
import { acquireDaemonOwnership } from '../src/daemon/ownership.js';
import { ControlDatabase } from '../src/daemon/persistence.js';
import { DaemonControlStore } from '../src/daemon/control-store.js';
import { RemoteConnector } from '../src/remote/connector.js';
import { offlineModel } from './fixtures/registry.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.restoreAllMocks(); });
it.each([false, true])('starts and stops the local daemon with remote storage unavailable=%s', async brokenStorage => {
  const directory = await mkdtemp(join(tmpdir(), 'rc-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const target = { kind: 'isolated' as const, directory, namespaceId: randomUUID() };
  const owner = await acquireDaemonOwnership(target);
  const hostConfigPath = join(owner.target.agentDir, 'host.json');
  await writeFile(hostConfigPath, JSON.stringify({ version: 1, services: [
    { id: 'felan.runtime', major: 1, use: '@felan-ai/test-manager/provider' },
    { id: 'felan.session-runtime', major: 1, use: '@felan-ai/test-manager/provider' },
  ], extensions: [] }));
  if (brokenStorage) vi.spyOn(ControlDatabase.prototype, 'record').mockImplementation(() => { throw new Error('remote records unavailable'); });
  await owner.release();
  const order: string[] = [];
  const stop = RemoteConnector.prototype.stop; const close = DaemonControlStore.prototype.close;
  vi.spyOn(RemoteConnector.prototype, 'stop').mockImplementation(async function () { order.push('connector'); await stop.call(this); });
  vi.spyOn(DaemonControlStore.prototype, 'close').mockImplementation(function () { order.push('store'); close.call(this); });
  const service = await startDaemonService(target, { hostConfigPath, manager: { packageName: '@felan-ai/test-manager', version: '0.0.0', resolveFrom: import.meta.url,
    resolveProvider: () => new URL('./fixtures/service-provider.ts', import.meta.url).href },
    createModelRuntime: async () => {
      const models = await ModelRuntime.create({ modelsPath: null, credentials: new InMemoryCredentialStore(), refreshOnCreate: false });
      models.registerProvider('offline', { api: 'openai-completions', baseUrl: offlineModel.baseUrl, apiKey: 'fixture', models: [offlineModel] });
      return models;
    } });
  cleanups.push(async () => { if (service.lifecycle.state !== 'stopped') { await service.requestStop('stop', 'force'); await service.stopped; } });
  expect(service.lifecycle.state).toBe('ready');
  await service.requestStop('stop', 'force'); expect(await service.stopped).toBe('stop');
  if (!brokenStorage) expect(order.indexOf('connector')).toBeLessThan(order.lastIndexOf('store'));
  else expect(await readFile(join(service.owner.target.runtimeDirectory, 'stderr.log'), 'utf8')).toContain('Remote connector storage is unavailable');
});
