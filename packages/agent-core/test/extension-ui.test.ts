import { describe, expect, it, vi } from 'vitest';
import {
  associateExtensionConfig,
  bindFelanExtension,
  configField,
  createUnavailableExtensionUi,
  defineExtensionConfig,
  defineServiceContract,
  ExtensionUiUnavailableError,
  loadFelanExtensions,
  type ExtensionAPI,
  type ExtensionUi,
  type FelanExtension,
  type FelanExtensionAPI,
  type InlineExtension,
  type UiDocument,
  type UiForm,
  type UiStatus,
} from '../src/index.js';
import { TestAgentRuntime } from './test-agent-runtime.js';

const form: UiForm = {
  title: 'Continue?', fallback: 'Choose Continue or Cancel.', input: { fields: [] },
  actions: [
    { id: 'continue', label: 'Continue', target: 'element', outcome: 'submit' },
    { id: 'cancel', label: 'Cancel', target: 'element', outcome: 'cancel' },
  ],
};
const document: UiDocument = {
  id: 'plan', kind: 'document', revision: 1, title: 'Plan', markdown: 'Review the plan.',
  actions: [], fallback: 'Review the plan.',
};
const status: UiStatus = {
  id: 'work', kind: 'status', key: 'work', value: { kind: 'tokens', value: 10 }, fallback: '10 tokens',
};

describe('extension UI binding', () => {
  it('always exposes an unavailable UI without approving or silently publishing', async () => {
    let received!: FelanExtensionAPI;
    const raw = {} as ExtensionAPI;
    const inline = bindFelanExtension('example', pi => { received = pi; }, new TestAgentRuntime());
    await factory(inline)(raw);
    expect('ui' in received).toBe(true);
    expect(received.ui).toBe(received.ui);
    expect(received.ui.canRequest(form, { audience: 'host' })).toBe(false);
    expect(Reflect.set(received, 'ui', createUnavailableExtensionUi())).toBe(false);
    await expect(received.ui.request(form)).resolves.toEqual({ state: 'cancelled', reason: 'unsupported' });
    const controller = new AbortController();
    controller.abort();
    await expect(received.ui.request(form, { signal: controller.signal, audience: 'owner', timeoutMs: 100 }))
      .resolves.toEqual({ state: 'cancelled', reason: 'abort' });
    for (const operation of [
      () => received.ui.notify({ level: 'info', text: 'Not published' }),
      () => received.ui.status(status),
      () => received.ui.removeStatus(status.id),
      () => received.ui.present(document),
    ]) {
      await expect(operation()).rejects.toBeInstanceOf(ExtensionUiUnavailableError);
    }
    expect(raw).not.toHaveProperty('ui');
  });

  it('binds independent UI implementations for each package and activation', async () => {
    const received: ExtensionUi[] = [];
    const extension: FelanExtension = pi => { received.push(pi.ui); };
    const createExtensionUi = vi.fn((_packageName: string) => createUnavailableExtensionUi());
    const loaded = await loadFelanExtensions(
      ['first', 'second'], async () => ({ default: extension }), new TestAgentRuntime(),
      '/agent', [], undefined, undefined, undefined, createExtensionUi,
    );
    expect(createExtensionUi).not.toHaveBeenCalled();
    const raw = {} as ExtensionAPI;
    await factory(loaded[0]!)(raw);
    await factory(loaded[1]!)(raw);
    await factory(loaded[0]!)(raw);
    expect(createExtensionUi.mock.calls.map(([name]) => name)).toEqual(['first', 'second', 'first']);
    expect(received).toEqual(createExtensionUi.mock.results.map(result => result.value));
    expect(new Set(received).size).toBe(3);
  });

  it('passes forms, action callbacks and presentation handles through the scoped binding', async () => {
    const controller = new AbortController();
    const onAction = vi.fn(async () => {});
    const handle = { update: vi.fn(async () => {}), close: vi.fn(async () => {}) };
    const request = vi.fn<ExtensionUi['request']>(async () => ({
      state: 'answered', answer: { kind: 'form', actionId: 'cancel', outcome: 'cancel', values: {} },
    }));
    const present = vi.fn<ExtensionUi['present']>(async () => handle);
    const canRequest = vi.fn<ExtensionUi['canRequest']>(() => true);
    const ui: ExtensionUi = { ...createUnavailableExtensionUi(), canRequest, request, present };
    const inline = bindFelanExtension('example', async pi => {
      expect(pi.ui.canRequest(form, { audience: 'host' })).toBe(true);
      const result = await pi.ui.request(form, { signal: controller.signal, timeoutMs: 500, audience: 'host', transient: true });
      expect(result).toEqual({
        state: 'answered', answer: { kind: 'form', actionId: 'cancel', outcome: 'cancel', values: {} },
      });
      const element = await pi.ui.present(document, { signal: controller.signal, onAction });
      expect(element).toBe(handle);
      await element.update({ ...document, revision: 2 });
      await element.close();
    }, new TestAgentRuntime(), '/agent', {}, undefined, undefined, {}, () => ui);
    await factory(inline)({} as ExtensionAPI);
    expect(request).toHaveBeenCalledWith(form, { signal: controller.signal, timeoutMs: 500, audience: 'host', transient: true });
    expect(canRequest).toHaveBeenCalledWith(form, { audience: 'host' });
    expect(present).toHaveBeenCalledWith(document, { signal: controller.signal, onAction });
    expect(handle.update).toHaveBeenCalledWith({ ...document, revision: 2 });
    expect(handle.close).toHaveBeenCalledOnce();
  });

  it('does not create bindings during configuration or missing-service preflight', async () => {
    const createExtensionUi = vi.fn((_packageName: string) => createUnavailableExtensionUi());
    const extension: FelanExtension = () => {};
    associateExtensionConfig(extension, defineExtensionConfig({
      id: 'example', title: 'Example', fields: {
        enabled: configField.boolean({ default: true, description: 'Enable example' }),
      },
    }));
    await expect(loadFelanExtensions(
      ['example'], async () => ({ default: extension }), new TestAgentRuntime(), '/agent',
      [{ extensionId: 'example', source: 'test', values: { enabled: 'invalid' } }],
      undefined, undefined, undefined, createExtensionUi,
    )).rejects.toThrow();
    const missing = Object.assign(() => {}, {
      serviceRequirements: { required: [defineServiceContract<{}>('example.required', 1)] },
    });
    expect(await loadFelanExtensions(
      ['missing'], async () => ({ default: missing }), new TestAgentRuntime(), '/agent',
      [], undefined, undefined, undefined, createExtensionUi,
    )).toEqual([]);
    expect(createExtensionUi).not.toHaveBeenCalled();
  });

  it('reports binding failure instead of substituting an unavailable binding', async () => {
    const extension = vi.fn();
    const inline = bindFelanExtension('example', extension, new TestAgentRuntime(), '/agent',
      {}, undefined, undefined, {}, () => { throw new Error('UI scope unavailable'); });
    await expect(factory(inline)({} as ExtensionAPI)).rejects.toThrow('UI scope unavailable');
    expect(extension).not.toHaveBeenCalled();
  });
});

function factory(extension: InlineExtension) {
  return typeof extension === 'function' ? extension : extension.factory;
}
