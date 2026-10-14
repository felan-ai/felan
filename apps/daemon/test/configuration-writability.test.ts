import { expect, it, vi } from 'vitest';
import { associateExtensionConfig, bindFelanExtension, configField, defineExtensionConfig, type ExtensionAPI, type FelanExtensionAPI } from '@felan-ai/agent-core';
import { SessionClient } from '../../felan/src/client/client.js';
import { SessionServer } from '../src/daemon/server.js';
import { TestHostConfiguration } from './fixtures/host-services.js';
import { createTestSessionRuntime } from './fixtures/session-runtime.js';
import { serverFixture } from './fixtures/server.js';
import type { SessionExtensionContext } from '../src/daemon/session-execution.js';

it('rejects persistent client and extension writes on a read-only host while session overrides remain available', async () => {
  const definition = defineExtensionConfig({ id: 'example', title: 'Example', fields: { count: configField.number({ default: 1, description: 'Count' }) } });
  const extension = () => {};
  associateExtensionConfig(extension, definition);
  const configuration = new TestHostConfiguration({ definitions: [definition], assertCurrent() {}, readOnly: true });
  const set = vi.spyOn(configuration, 'set');
  const prepare = vi.spyOn(configuration, 'prepare');
  let context!: SessionExtensionContext;
  const f = await serverFixture({ now: Date.now, configuration, configDefinitions: [definition], extensionPackages: ['example-package'],
    composition: createTestSessionRuntime({ definitions: [definition], importExtension: async () => ({ default: extension }) }),
    onBind: value => { context = value; } });
  const server = new SessionServer({ registry: f.registry, models: f.root.runtime.session.modelRuntime, version: 'fixture', configuration });
  const client = new SessionClient({ target: { kind: 'isolated', directory: f.directory, namespaceId: f.owner.target.namespaceId, storeRoots: [f.directory] },
    clientVersion: 'fixture', kind: 'tui' });
  try {
    await server.start(); await client.connect(); await client.attach(f.root.sessionId);
    expect(await client.request('config.get', { scope: 'global' })).toMatchObject({ outcome: 'accepted', result: { writable: false } });
    expect(await client.request('config.get', { scope: 'project' })).toMatchObject({ outcome: 'accepted', result: { writable: false } });
    expect(await client.request('config.set', { scope: 'global', values: { extensionConfig: { example: { count: 2 } } } }))
      .toMatchObject({ outcome: 'rejected', error: { code: 'unavailable' } });
    let api!: FelanExtensionAPI;
    const activate = (pi: FelanExtensionAPI) => { api = pi; };
    associateExtensionConfig(activate, definition);
    const bound = bindFelanExtension('example-package', activate, context.runtime, f.owner.target.agentDir,
      { count: 1 }, undefined, undefined, {}, undefined, context.updateExtensionConfig);
    await (typeof bound === 'function' ? bound : bound.factory)({ on() {} } as unknown as ExtensionAPI);
    await expect(api.updateConfig({ count: 3 })).rejects.toThrow('read-only');
    expect(set).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
    expect(await client.request('set_thinking', { thinking: 'off' }, { session: f.root.sessionId })).toMatchObject({ outcome: 'accepted' });
    expect(await client.request('set_model', { provider: 'offline', id: 'fixture' }, { session: f.root.sessionId })).toMatchObject({ outcome: 'accepted' });
    const result = await client.request('config.set', { scope: 'session', values: { extensionConfig: { example: { count: 4 } } } }, { session: f.root.sessionId });
    expect(result).toMatchObject({ outcome: 'accepted' });
    expect(await client.request('config.get', { scope: 'session' }, { session: f.root.sessionId }))
      .toMatchObject({ outcome: 'accepted', result: { writable: true, values: { extensionConfig: { example: { count: 4 } } } } });
    await expect(context.updateExtensionConfig('example-package', { count: 5 })).rejects.toThrow('Session-overridden');
    expect((await configuration.get('global')).values.extensionConfig?.example?.count).toBe(1);
  } finally { client.close(); server.close(); await server.settleCommands(); await f.dispose(); }
});

it('routes extension persistence through the same configuration provider as client writes', async () => {
  const definition = defineExtensionConfig({ id: 'example', title: 'Example', fields: { count: configField.number({ default: 1, description: 'Count' }) } });
  const extension = () => {};
  associateExtensionConfig(extension, definition);
  const configuration = new TestHostConfiguration({ definitions: [definition], assertCurrent() {} });
  const prepare = vi.spyOn(configuration, 'prepare'); const set = vi.spyOn(configuration, 'set');
  let context!: SessionExtensionContext;
  const f = await serverFixture({ now: Date.now, configuration, configDefinitions: [definition], extensionPackages: ['example-package'],
    composition: createTestSessionRuntime({ definitions: [definition], importExtension: async () => ({ default: extension }) }),
    onBind: value => { context = value; } });
  try {
    const values = { extensionConfig: { example: { count: 2 } } };
    await context.updateExtensionConfig('example-package', { count: 2 });
    expect(prepare).toHaveBeenCalledWith('global', values); expect(set).toHaveBeenCalledExactlyOnceWith('global', values);
    expect((await configuration.get('global')).values).toMatchObject(values);
    await expect(context.updateExtensionConfig('example-package', { count: 'invalid' })).rejects.toThrow();
    expect((await configuration.get('global')).values).toMatchObject(values);
  } finally { await f.dispose(); }
});
