import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModelRuntime, type SettingsManager } from '@felan-ai/agent-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLocalClassifier, selectLocalClassifierModel, type LocalClassifierModel } from '../src/providers/classifier.js';
import { composeLocalSession } from './fixtures/local-composition.js';
import { createLocalSettingsManager, getClassifierModelSetting } from '../src/providers/settings.js';
import { mergeDaemonGlobalSettings } from '../src/providers/global-settings.js';

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

function model(provider: string, id: string): LocalClassifierModel {
  return { type: 'classifier', provider, id, api: 'typesafe-system-one', name: id,
    input: ['text'], contextWindow: 64_000, cost: { input: 1, output: 1 } } as LocalClassifierModel;
}

async function directory(): Promise<string> {
  const path = await realpath(await mkdtemp(join(tmpdir(), 'felan-classifier-test-')));
  directories.push(path);
  return path;
}

function settings(value: unknown): SettingsManager {
  return { getGlobalSettings: () => value } as SettingsManager;
}

describe('classifier settings and selection', () => {
  it('defaults to Auto and accepts exact model references with nested IDs', () => {
    expect(getClassifierModelSetting(settings({}))).toBe('auto');
    expect(getClassifierModelSetting(settings({ felanClassifier: {} }))).toBe('auto');
    expect(getClassifierModelSetting(settings({ felanClassifier: { model: 'auto' } }))).toBe('auto');
    expect(getClassifierModelSetting(settings({ felanClassifier: { model: 'openrouter/typesafe/jev-1.13' } })))
      .toBe('openrouter/typesafe/jev-1.13');
    for (const value of [null, 1, false, '', 'jev-latest', 'typesafe/', 'auto\n']) {
      expect(() => getClassifierModelSetting(settings({ felanClassifier: { model: value } }))).toThrow('felanClassifier.model');
    }
    expect(() => getClassifierModelSetting(settings({ felanClassifier: 'auto' }))).toThrow('felanClassifier must be an object');
  });

  it('prefers direct Jev, then existing OpenRouter Jev, then other Jev before catalog-order fallback', () => {
    const fallback = model('local', 'classifier');
    const another = model('other', 'model');
    const gateway = model('gateway', 'typesafe-ai/jev');
    const router = model('openrouter', 'typesafe/jev-1.13');
    const direct = model('typesafe', 'jev-latest');
    expect(selectLocalClassifierModel([fallback, gateway, router, direct]).model).toBe(direct);
    expect(selectLocalClassifierModel([fallback, gateway, router]).model).toBe(router);
    expect(selectLocalClassifierModel([fallback, gateway]).model).toBe(gateway);
    expect(selectLocalClassifierModel([another, fallback]).model).toBe(another);
    expect(selectLocalClassifierModel([])).toEqual({ warnings: [] });
  });

  it('honors a configured model and warns before using Auto when it is unavailable', () => {
    const direct = model('typesafe', 'jev-latest');
    const configured = model('local', 'specific');
    expect(selectLocalClassifierModel([direct, configured], 'local/specific')).toEqual({ model: configured, warnings: [] });
    expect(selectLocalClassifierModel([direct], 'local/specific')).toEqual({
      model: direct, warnings: ['Configured classifier model is unavailable; using Auto.'],
    });
    expect(selectLocalClassifierModel([], 'local/specific').warnings).toHaveLength(1);
  });

  it('uses Pi authenticated availability and performs no inference probe', async () => {
    const selected = model('local', 'ready');
    const native = { getAvailableOfType: vi.fn().mockResolvedValue([selected]), classify: vi.fn() };
    const result = await createLocalClassifier(native, 'local/missing');
    expect(result.model).toBe(selected);
    expect(result.classifier).toBeDefined();
    expect(result.warnings).toHaveLength(1);
    expect(native.getAvailableOfType).toHaveBeenCalledWith('classifier');
    expect(native.classify).not.toHaveBeenCalled();
    native.getAvailableOfType.mockResolvedValueOnce([]);
    expect((await createLocalClassifier(native)).classifier).toBeUndefined();
    native.getAvailableOfType.mockRejectedValueOnce(new Error('secret-key'));
    expect(await createLocalClassifier(native)).toEqual({
      warnings: ['Classifier model discovery failed; classifier features will use their normal fallbacks.'],
    });
  });

  it('persists exact choices without overwriting unrelated global settings', async () => {
    const agentDir = await directory();
    const manager = createLocalSettingsManager(agentDir, agentDir);
    manager.setDefaultProvider('openai');
    await manager.flush();
    await mergeDaemonGlobalSettings(agentDir, { extensions: [], classifierModel: ' openrouter/ typesafe/jev-1.13 ' }, () => {});
    await manager.reload();
    expect(getClassifierModelSetting(manager)).toBe('openrouter/typesafe/jev-1.13');
    expect(manager.getDefaultProvider()).toBe('openai');
    await expect(mergeDaemonGlobalSettings(agentDir, { extensions: [], classifierModel: 'invalid' }, () => {})).rejects.toThrow('felanClassifier.model');
    await mergeDaemonGlobalSettings(agentDir, { extensions: [], classifierModel: 'auto' }, () => {});
    await manager.reload();
    expect(getClassifierModelSetting(manager)).toBe('auto');
  });
});

describe('native classifier runtime integration', () => {
  it.each([
    ['typesafe', 'jev-latest', 'https://api.typesafe.ai/v1/systemone'],
    ['openrouter', 'typesafe/jev-1.13', 'https://openrouter.ai/api/v1/systemone'],
  ])('uses native %s auth and classification transport without a custom client', async (provider, id, endpoint) => {
    const agentDir = await directory();
    await writeFile(join(agentDir, 'auth.json'), JSON.stringify({ [provider!]: { type: 'api_key', key: 'test-key' } }), { mode: 0o600 });
    const runtime = await ModelRuntime.create({ authPath: join(agentDir, 'auth.json'), modelsPath: null, refreshOnCreate: false });
    const selected = runtime.getModelOfType('classifier', provider!, id!)!;
    expect(selected).toBeDefined();
    vi.spyOn(runtime, 'getAvailableOfType').mockResolvedValue([selected]);
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify({
      answers: { yes: { type: 'noul', noul: 0.8 } }, usage: { input_tokens: 10, output_tokens: 1 },
    }), { status: 200 }));
    const classify = runtime.classify.bind(runtime);
    vi.spyOn(runtime, 'classify').mockImplementation((model, context, options) => classify(model, context, { ...options, fetch }));
    const classifier = (await createLocalClassifier(runtime, `${provider}/${id}`)).classifier!;
    expect((await classifier.classify({ request: 'Task' }, {
      yes: { type: 'bool', instructions: 'Yes?', criteria: { true: 'Yes', false: 'No' } },
    })).answers).toEqual({ yes: { type: 'bool', probability: 0.8 } });
    expect(String(fetch.mock.calls[0]?.[0])).toBe(endpoint);
    expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get('authorization')).toBe('Bearer test-key');
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body)).questions.yes.type).toBe('noul');
  });

  it('reselects on root replacement and reports explicit-choice fallback without losing settings', async () => {
    const agentDir = await directory();
    const native = await ModelRuntime.create({ authPath: join(agentDir, 'auth.json'), modelsPath: null, refreshOnCreate: false });
    const direct = native.getModelOfType('classifier', 'typesafe', 'jev-latest')!;
    const router = native.getModelOfType('classifier', 'openrouter', 'typesafe/jev-1.13')!;
    const available = vi.spyOn(native, 'getAvailableOfType').mockImplementation(async type => (
      type === 'classifier' ? [direct, router] : []
    ) as never);
    const classify = vi.spyOn(native, 'classify').mockImplementation(async (model, context) => ({
      api: model.api, provider: model.provider, model: model.id, timestamp: 1, stopReason: 'stop',
      answers: Object.fromEntries(Object.keys(context.questions).map(id => [id, { type: 'bool' as const, probability: 0.7 }])),
    }));
    await mergeDaemonGlobalSettings(agentDir, { extensions: [], classifierModel: 'missing/model' }, () => {});
    const question = { yes: { type: 'bool' as const, instructions: 'Yes?', criteria: { true: 'Yes', false: 'No' } } };
    const first = await composeLocalSession({ cwd: agentDir, agentDir, homeDir: agentDir, modelRuntime: native });
    try {
      expect(first.composition.diagnostics.some(d => d.message.includes('using Auto'))).toBe(true);
      await first.composition.options.runtime.classifier!.classify({}, question);
      expect(classify.mock.calls.at(-1)?.[0]).toBe(direct);
    } finally {
      await first.dispose();
    }
    await mergeDaemonGlobalSettings(agentDir, { extensions: [], classifierModel: 'openrouter/typesafe/jev-1.13' }, () => {});
    const replacement = await composeLocalSession({ cwd: agentDir, agentDir, homeDir: agentDir, modelRuntime: native });
    try {
      await replacement.composition.options.runtime.classifier!.classify({}, question);
      expect(classify.mock.calls.at(-1)?.[0]).toBe(router);
      expect(available.mock.calls).toEqual([['classifier'], ['classifier']]);
      expect(getClassifierModelSetting(replacement.session.settingsManager)).toBe('openrouter/typesafe/jev-1.13');
    } finally {
      await replacement.dispose();
    }
  });

  it('retains feature fallbacks when no authenticated classifier is available', async () => {
    const agentDir = await directory();
    const native = await ModelRuntime.create({ authPath: join(agentDir, 'auth.json'), modelsPath: null, refreshOnCreate: false });
    vi.spyOn(native, 'getAvailableOfType').mockResolvedValue([]);
    const classify = vi.spyOn(native, 'classify');
    const result = await composeLocalSession({ cwd: agentDir, agentDir, homeDir: agentDir, modelRuntime: native });
    try {
      expect(result.composition.options.runtime.classifier).toBeUndefined();
      expect(classify).not.toHaveBeenCalled();
      expect(result.session.resourceLoader.getExtensions().extensions.some(extension =>
        extension.path === '<inline:@felan-ai/agent-core/dynamic-thinking>')).toBe(false);
    } finally {
      await result.dispose();
    }
  });
});
