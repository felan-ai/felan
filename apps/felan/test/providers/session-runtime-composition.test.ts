import { importLocalExtension, loadLocalExtensionConfigDefinitions } from '../../src/providers/extensions.js';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ModelRuntime, InMemoryCredentialStore, createAssistantMessageEventStream,
  AGENT_CORE_VERSION,
  type AssistantMessage, type Model, type Api,
} from '@felan-ai/agent-core';
import { createTestLocalSessionLifecycle as createTestSessionLifecycle } from './fixtures/session-runtime.js';
import { builtinExtensionPackages } from '../../src/providers/extension-catalog.js';
import type { DaemonSessionServices } from '../../../daemon/src/daemon/session-lifecycle-contracts.js';
import type { SessionExtensionContext as ProfileExtensionContext } from '../../../daemon/src/daemon/session-execution.js';
import { createLocalSettingsManager, getClassifierModelSetting } from '../../src/providers/settings.js';
import { DaemonConfiguration } from '../../src/providers/configuration.js';


const roots: string[] = [];
const policy = { mode: 'host-default', generation: 0 } as const;
const model: Model<Api> = {
  id: 'fixture', name: 'Fixture', api: 'openai-completions', provider: 'offline', baseUrl: 'https://example.invalid',
  reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 1024,
};

afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'felan-profile-')));
  roots.push(root);
  const cwd = join(root, 'workspace');
  const agentDir = join(root, 'agent');
  await mkdir(cwd);
  await mkdir(agentDir);
  await writeSettings(agentDir, 'first');
  return { root, cwd, agentDir };
}

async function writeSettings(agentDir: string, marker: string) {
  await writeFile(join(agentDir, 'settings.json'), JSON.stringify({ marker,
    builtinExtensions: Object.fromEntries(Object.keys(builtinExtensionPackages).map(name => [name, false])),
  }));
}

async function fakeModels(): Promise<ModelRuntime> {
  const models = await ModelRuntime.create({ modelsPath: null, credentials: new InMemoryCredentialStore(), refreshOnCreate: false });
  models.registerProvider('offline', { api: 'openai-completions', baseUrl: model.baseUrl, apiKey: 'fixture', models: [model],
    streamSimple: () => {
      const stream = createAssistantMessageEventStream();
      const message: AssistantMessage = { role: 'assistant', api: model.api, provider: model.provider, model: model.id,
        content: [{ type: 'text', text: 'Done' }], stopReason: 'stop', timestamp: Date.now(),
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      };
      queueMicrotask(() => stream.push({ type: 'done', reason: 'stop', message }));
      return stream;
    },
  });
  return models;
}

function services(contexts: ProfileExtensionContext[] = [], dispose = vi.fn(async () => {})): DaemonSessionServices {
  return { getExecutionPolicy: () => policy, extensions: {
    configuration: async () => [],
    bind: async context => {
      contexts.push(context);
      return { importExtension: async () => ({ default: () => {} }), wrapStreamFunction: stream => stream, dispose };
    },
  } };
}

const initializeProcess = async () => ({ diagnostics: [], assertConfiguration: () => [] });

describe('local provider session composition', () => {
  it('does not repeat process setup when preparing sessions and still validates each session configuration', async () => {
    const { cwd, agentDir } = await fixture();
    const assertConfiguration = vi.fn(() => []);
    const initialize = vi.fn(async () => ({ diagnostics: [], assertConfiguration }));
    const profile = await createTestSessionLifecycle({ agentDir, initializeProcess: initialize, createModelRuntime: fakeModels });
    const resources = await profile.resolveResources({ cwd });
    for (let index = 0; index < 2; index++) {
      const binding = await profile.openSession({ resources, ownership: { assertOwned() {} }, policy, model,
        target: { kind: 'new' }, services: services() });
      await binding.runtime.dispose();
    }
    expect(initialize).toHaveBeenCalledExactlyOnceWith(agentDir);
    expect(assertConfiguration).toHaveBeenCalledTimes(2);
    await profile.dispose();
  });

  it('uses changed execution defaults only when opening a new binding', async () => {
    const { cwd, agentDir } = await fixture(); const contexts: ProfileExtensionContext[] = [];
    const profile = await createTestSessionLifecycle({ agentDir, initializeProcess, createModelRuntime: fakeModels });
    const resources = await profile.resolveResources({ cwd });
    const open = () => profile.openSession({ resources, ownership: { assertOwned() {} }, policy, model,
      target: { kind: 'new' }, services: services(contexts) });
    const first = await open();
    try {
      await new DaemonConfiguration({ agentDir, definitions: [], assertCurrent() {} }).set('global', {
        classifierModel: 'offline/fixture', builtinExtensions: { outputStyle: true },
      });
      const second = await open();
      try {
        expect(getClassifierModelSetting(first.runtime.session.settingsManager)).toBe('auto');
        expect(getClassifierModelSetting(second.runtime.session.settingsManager)).toBe('offline/fixture');
        expect(contexts[0]!.extensionConfigs.has('outputStyle')).toBe(false);
        expect(contexts[1]!.extensionConfigs.has('outputStyle')).toBe(true);
      } finally { await second.runtime.dispose(); }
    } finally { await first.runtime.dispose(); }
  });

  it('supplies effective config, model scope, skills, classifier and thinking values to bindings', async () => {
    const { cwd, agentDir } = await fixture();
    const settings = JSON.parse(await readFile(join(agentDir, 'settings.json'), 'utf8'));
    const definitions = await loadLocalExtensionConfigDefinitions([builtinExtensionPackages.codex, builtinExtensionPackages.browser]);
    await writeFile(join(agentDir, 'settings.json'), JSON.stringify({ ...settings,
      builtinExtensions: { ...settings.builtinExtensions, codex: true, browser: true }, enabledModels: ['offline/fixture'],
      extensionConfig: { codex: { fast: false }, browser: { authorizationPolicy: 'always-allow' } }, felanThinking: { dynamic: true },
    }));
    const skills = join(cwd, '.agents', 'skills');
    await mkdir(skills, { recursive: true });
    let context!: ProfileExtensionContext;
    const extensionServices: DaemonSessionServices = { getExecutionPolicy: () => policy, extensions: {
      configuration: async () => definitions,
      bind: async value => {
        context = value;
        return { dispose: async () => {}, wrapStreamFunction: stream => stream, importExtension: importLocalExtension };
      },
    } };
    const profile = await createTestSessionLifecycle({ agentDir, initializeProcess, createModelRuntime: fakeModels });
    const overrides = [{ extensionId: 'codex', values: { fast: true }, source: 'request' }];
    const binding = await profile.openSession({ resources: await profile.resolveResources({ cwd }), ownership: { assertOwned() {} },
      policy, services: extensionServices, target: { kind: 'new' }, model, extensionConfigOverrides: overrides });
    try {
      expect(context.extensionConfigs.get('codex')?.fast).toBe(true);
      expect(context.extensionConfigs.get('browser')?.authorizationPolicy).toBe('always-allow');
      expect(context.extensionConfigOverrides.at(-1)).toEqual(overrides[0]);
      expect(context.scopedModels.map(item => item.model.id)).toEqual(['fixture']);
      expect(context.skillPaths).toContain(skills);
      expect(context.classifier).toBe(binding.agentRuntime.classifier);
      expect(context.dynamicThinking).toBe(true);
    } finally { await binding.runtime.dispose(); }
  });

  it('keeps composition ordering, resource policy and diagnostics without loading client themes', async () => {
    const { cwd, agentDir } = await fixture();
    const settings = JSON.parse(await readFile(join(agentDir, 'settings.json'), 'utf8'));
    await writeFile(join(agentDir, 'settings.json'), JSON.stringify({ ...settings, sessionDir: './selected', codemode: { mode: 'on' } }));
    await mkdir(join(cwd, '.pi'), { recursive: true });
    await writeFile(join(cwd, '.pi', 'settings.json'), JSON.stringify({ sessionDir: './untrusted-project-path' }));
    await mkdir(join(agentDir, 'themes'));
    await writeFile(join(agentDir, 'themes', 'client-only.json'), 'invalid theme JSON');
    const profile = await createTestSessionLifecycle({ agentDir, initializeProcess, createModelRuntime: fakeModels });
    const resources = await profile.resolveResources({ cwd });
    expect(resources.sessionDir).toBe(join(cwd, createLocalSettingsManager(cwd, agentDir).getSessionDir()!));
    const baseServices = services();
    const binding = await profile.openSession({ resources, ownership: { assertOwned() {} }, policy, model, target: { kind: 'new' }, services: {
      ...baseServices, extensions: { ...baseServices.extensions, bind: async context => ({ ...await baseServices.extensions.bind(context),
        inlineExtensions: [{ name: 'parity-fixture', factory: () => {} }],
      }) },
    } });
    try {
      const extensions = binding.runtime.services.resourceLoader.getExtensions().extensions.map(extension => extension.path);
      expect(extensions.indexOf('<inline:@felan-ai/felan/codemode>')).toBeLessThan(extensions.indexOf('<inline:parity-fixture>'));
      expect(binding.diagnostics).toContainEqual({ type: 'info', message: `Agent Core version: ${AGENT_CORE_VERSION}` });
      expect(binding.runtime.services.resourceLoader.getThemes()).toEqual({ themes: [], diagnostics: [] });
      await binding.runtime.services.resourceLoader.reload();
      expect(binding.runtime.services.resourceLoader.getThemes()).toEqual({ themes: [], diagnostics: [] });
    } finally { await binding.runtime.dispose(); }
    await writeFile(join(agentDir, 'settings.json'), '{"broken":');
    const malformed = await profile.openSession({ resources: await profile.resolveResources({ cwd }), ownership: { assertOwned() {} }, policy, model, target: { kind: 'new' }, services: services() });
    expect(malformed.diagnostics.some(item => item.type === 'warning' && item.message.startsWith('global settings:'))).toBe(true);
    await malformed.runtime.dispose();
  });

});
