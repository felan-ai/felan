import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ModelRuntime, SessionManager, SettingsManager, type ExtensionAPI, type InlineExtension } from '../src/index.js';
import { associateExtensionConfig, configField, defineExtensionConfig } from '../src/extension-config.js';
import { bindFelanExtension, getExecutionContribution, loadFelanExtensions, type FelanExtension, type FelanExtensionAPI, type ExtensionConfigWriter } from '../src/extensions.js';
import { createAgentCoreSessionRuntimeFactory, type StreamFunction } from '../src/session.js';
import { createAgentSessionRuntime } from '../src/index.js';
import { TestAgentRuntime } from './test-agent-runtime.js';

const paths: string[] = [];
afterEach(async () => { await Promise.all(paths.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const definition = defineExtensionConfig({ id: 'example', title: 'Example', fields: {
  count: configField.number({ default: 1, description: 'Positive count', validate: value => typeof value === 'number' && Number.isInteger(value) && value > 0 ? undefined : 'must be a positive integer' }),
  mode: configField.enum(['fast', 'safe'], { default: 'safe', description: 'Execution mode' }),
  data: configField.json({ default: { tags: [] as string[] }, description: 'Structured configuration' }),
  secret: configField.string({ default: '', description: 'Secret', sensitive: true }),
} });
function configured(activate: FelanExtension): FelanExtension { associateExtensionConfig(activate, definition); return activate; }
function factory(extension: InlineExtension) { return typeof extension === 'function' ? extension : extension.factory; }
function rawPi() {
  const shutdown: Array<() => unknown> = [];
  const api = { on: (event: string, listener: () => unknown) => { if (event === 'session_shutdown') shutdown.push(listener); } } as unknown as ExtensionAPI;
  return { api, shutdown: async () => { for (const listener of shutdown) await listener(); } };
}
function gate() { let finish!: () => void; const promise = new Promise<void>(resolve => { finish = resolve; }); return { finish, promise }; }
async function bound(writer?: ExtensionConfigWriter) {
  let api!: FelanExtensionAPI;
  const inline = bindFelanExtension('actual-package', configured(pi => { api = pi; }), new TestAgentRuntime(), '/agent',
    { count: 1 }, undefined, undefined, {}, undefined, writer);
  const raw = rawPi(); await factory(inline)(raw.api);
  return { api, inline, raw };
}

describe('scoped extension configuration writes', () => {
  it('always exposes a protected method and rejects a missing writer without modifying config', async () => {
    const h = await bound();
    expect('updateConfig' in h.api).toBe(true);
    expect(Reflect.set(h.api, 'updateConfig', async () => {})).toBe(false);
    await expect(h.api.updateConfig({ count: 2 })).rejects.toThrow('unsupported');
    expect(h.api.config).toEqual({ count: 1 }); expect(h.raw.api).not.toHaveProperty('updateConfig');
  });

  it('validates typed values, enumeration, JSON and sensitive fields before calling the writer', async () => {
    const writer = vi.fn<ExtensionConfigWriter>(async () => {}); const h = await bound(writer);
    const cycle: Record<string, unknown> = {}; cycle.self = cycle;
    const getter = vi.fn(() => 2);
    const malformed: unknown[] = [null, [], new Date(), { count: 0 }, { count: '2' }, { mode: 'unknown' },
      { otherPackage: { count: 2 } }, { secret: 'do-not-forward' }, { data: cycle }, { count: Infinity },
      JSON.parse('{"__proto__":{"polluted":true}}'), { [Symbol('field')]: 1 },
      Object.defineProperty({}, 'count', { get: getter, enumerable: true }),
    ];
    for (const patch of malformed) await expect(h.api.updateConfig(patch as Parameters<FelanExtensionAPI['updateConfig']>[0])).rejects.toThrow();
    expect(getter).not.toHaveBeenCalled(); expect(writer).not.toHaveBeenCalled();
    await h.api.updateConfig({ count: 3, mode: 'fast', data: { tags: ['safe'] } });
    expect(writer).toHaveBeenCalledExactlyOnceWith('actual-package', { count: 3, mode: 'fast', data: { tags: ['safe'] } });
    expect(h.api.config).toEqual({ count: 1 });
  });

  it('copies queued patches, orders persistence and preserves provider failures', async () => {
    const held = gate(); const writer = vi.fn<ExtensionConfigWriter>().mockImplementationOnce(() => held.promise).mockRejectedValueOnce(new Error('policy denied')).mockResolvedValue(undefined);
    const h = await bound(writer);
    const first = h.api.updateConfig({ count: 2 });
    const patch = { data: { tags: ['original'] } }; const second = h.api.updateConfig(patch);
    const rejected = expect(second).rejects.toThrow('policy denied'); patch.data.tags[0] = 'changed';
    await Promise.resolve(); expect(writer).toHaveBeenCalledTimes(1); held.finish(); await first; await rejected;
    expect(writer).toHaveBeenNthCalledWith(2, 'actual-package', { data: { tags: ['original'] } });
    const stored = writer.mock.calls[1]![1];
    expect(Object.isFrozen(stored)).toBe(true); expect(Object.isFrozen(stored.data)).toBe(true);
    await h.api.updateConfig({ count: 4 }); expect(writer).toHaveBeenCalledTimes(3);
  });

  it('binds the real package identity, not the configuration id or a caller-supplied package', async () => {
    const received: FelanExtensionAPI[] = []; const writer = vi.fn<ExtensionConfigWriter>(async () => {});
    const extension = configured(pi => { received.push(pi); });
    const loaded = await loadFelanExtensions(['first-package', 'second-package'], async () => ({ default: extension }), new TestAgentRuntime(),
      '/agent', [], undefined, undefined, undefined, undefined, writer);
    expect(writer).not.toHaveBeenCalled();
    for (const inline of loaded) await factory(inline)(rawPi().api);
    await received[0]!.updateConfig.call(received[1], { count: 2 });
    await received[1]!.updateConfig({ count: 3 });
    expect(writer.mock.calls).toEqual([['first-package', { count: 2 }], ['second-package', { count: 3 }]]);
  });

  it('fences old and queued writes on reload and orders the new activation after in-flight persistence', async () => {
    const received: FelanExtensionAPI[] = []; const held = gate();
    const writer = vi.fn<ExtensionConfigWriter>().mockImplementationOnce(() => held.promise).mockResolvedValue(undefined);
    const inline = bindFelanExtension('package', configured(pi => { received.push(pi); }), new TestAgentRuntime(), '/agent', {}, undefined, undefined, {}, undefined, writer);
    await factory(inline)(rawPi().api);
    const first = received[0]!.updateConfig({ count: 2 });
    const oldQueued = received[0]!.updateConfig({ count: 3 });
    const oldResults = [expect(first).rejects.toThrow('no longer active'), expect(oldQueued).rejects.toThrow('no longer active')];
    await Promise.resolve(); expect(writer).toHaveBeenCalledTimes(1);
    await factory(inline)(rawPi().api);
    await expect(received[0]!.updateConfig({ count: 4 })).rejects.toThrow('no longer active');
    const current = received[1]!.updateConfig({ count: 5 });
    expect(writer).toHaveBeenCalledTimes(1); held.finish(); await Promise.all(oldResults); await current;
    expect(writer.mock.calls).toEqual([['package', { count: 2 }], ['package', { count: 5 }]]);
  });

  it('allows extension shutdown persistence, then revokes the binding', async () => {
    let received!: FelanExtensionAPI; const writer = vi.fn<ExtensionConfigWriter>(async () => {});
    const inline = bindFelanExtension('package', configured(pi => {
      received = pi; pi.on('session_shutdown', async () => { await pi.updateConfig({ count: 2 }); });
    }), new TestAgentRuntime(), '/agent', {}, undefined, undefined, {}, undefined, writer);
    const raw = rawPi(); await factory(inline)(raw.api); await raw.shutdown();
    expect(writer).toHaveBeenCalledExactlyOnceWith('package', { count: 2 });
    await expect(received.updateConfig({ count: 3 })).rejects.toThrow('no longer active');
  });

  it('revokes a failed activation and refuses writes without a config declaration', async () => {
    let received!: FelanExtensionAPI; const writer = vi.fn<ExtensionConfigWriter>(async () => {});
    const failed = bindFelanExtension('package', configured(pi => { received = pi; throw new Error('initialization failed'); }),
      new TestAgentRuntime(), '/agent', {}, undefined, undefined, {}, undefined, writer);
    await expect(factory(failed)(rawPi().api)).rejects.toThrow('initialization failed');
    await expect(received.updateConfig({ count: 2 })).rejects.toThrow('no longer active');
    const plain = bindFelanExtension('plain', pi => { received = pi; }, new TestAgentRuntime(), '/agent', {}, undefined, undefined, {}, undefined, writer);
    await factory(plain)(rawPi().api);
    await expect(received.updateConfig({ count: 2 })).rejects.toThrow('does not declare'); expect(writer).not.toHaveBeenCalled();
  });

  it('preserves resolved configuration, execution wrappers and runtime-factory reload propagation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'felan-config-write-')); paths.push(root);
    const cwd = join(root, 'workspace'); const agentDir = join(root, 'agent'); await mkdir(cwd, { recursive: true });
    const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, 'auth.json'), modelsPath: null });
    const received: FelanExtensionAPI[] = []; const writer = vi.fn<ExtensionConfigWriter>(async () => {});
    const wrap = vi.fn((original: StreamFunction) => original);
    const execution = vi.fn(() => ({ wrapStreamFunction: wrap }));
    const extension = Object.assign(configured(pi => { received.push(pi); }), { execution });
    const createRuntime = createAgentCoreSessionRuntimeFactory(() => ({
      runtime: new TestAgentRuntime(cwd), modelRuntime, settingsManager: SettingsManager.inMemory(),
      extensionPackages: ['runtime-package'], importExtension: async () => ({ default: extension }),
      extensionConfigOverrides: [{ extensionId: 'example', source: 'test', values: { count: 7 } }], updateExtensionConfig: writer,
    }));
    const runtime = await createAgentSessionRuntime(createRuntime, { cwd, agentDir, sessionManager: SessionManager.inMemory(cwd) });
    try {
      expect(received[0]!.config.count).toBe(7); expect(execution).toHaveBeenCalledOnce(); expect(wrap).toHaveBeenCalledOnce();
      await received[0]!.updateConfig({ count: 8 });
      await runtime.session.bindExtensions({ mode: 'print' }); await runtime.session.reload();
      await expect(received[0]!.updateConfig({ count: 9 })).rejects.toThrow('no longer active');
      await received[1]!.updateConfig({ count: 10 });
      expect(writer.mock.calls).toEqual([['runtime-package', { count: 8 }], ['runtime-package', { count: 10 }]]);
      expect(received[1]!.config.count).toBe(7);
    } finally { await runtime.dispose(); }
    const inline = bindFelanExtension('check', extension, new TestAgentRuntime());
    await factory(inline)(rawPi().api); expect(getExecutionContribution(inline)?.wrapStreamFunction).toBe(wrap);
  });
});
