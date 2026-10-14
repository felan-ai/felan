import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ModelRuntime, InMemoryCredentialStore, createAssistantMessageEventStream,
  AGENT_CORE_VERSION, associateExtensionConfig, configField, defineExtensionConfig,
  createFelanServiceRegistry, defineServiceContract,
  type AssistantMessage, type Model, type Api, type ToolDefinition,
} from '@felan-ai/agent-core';
import { createTestSessionLifecycle } from './fixtures/session-lifecycle.js';
import type { DaemonSessionServices, SessionOpenRequest } from '../../daemon/src/daemon/session-lifecycle-contracts.js';
import type { SessionExtensionContext as ProfileExtensionContext, SessionExecutionPort } from '../../daemon/src/daemon/session-execution.js';
import { initializeLocalDaemonProcess } from '../src/providers/process-bootstrap.js';

vi.mock('../src/extensions.js', () => { throw new Error('Profile imported terminal extension composition'); });
vi.mock('../../felan/src/runtime.js', () => { throw new Error('Profile imported interactive runtime composition'); });
vi.mock('../../felan/src/dependency-onboarding.js', () => { throw new Error('Profile imported terminal prompts'); });

const roots: string[] = [];
const policy = { mode: 'host-default', pendingTightening: false, generation: 0 } as const;
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
    builtinExtensions: {},
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

describe('local daemon profile', () => {
  it('activates provider scopes after registration and disposes them after shutdown UI', async () => {
    const { cwd, agentDir } = await fixture();
    const token = defineServiceContract<object>('fixture.session-provider', 1);
    const scoped = createFelanServiceRegistry(); const value = {};
    scoped.set(token, value);
    const order: string[] = [];
    let registered = false;
    const port = { registerService: vi.fn(() => () => {}) } as unknown as SessionExecutionPort;
    const executionPort = vi.fn(() => port);
    const openServiceScope = vi.fn(async () => {
      order.push('providers:open');
      return { services: scoped, busy: () => false,
        inlineExtensions: [{ name: 'provider-lifetime', factory: (pi: import('@felan-ai/agent-core').FelanExtensionAPI) => {
          pi.on('session_start', () => { order.push('extensions:start'); });
          pi.on('session_shutdown', async () => {
            await Promise.resolve(); expect(scoped.get(token)).toBe(value); order.push('extensions:shutdown');
          });
        } }], async activate() {
        expect(registered).toBe(true); order.push('providers:activate');
      }, async settle() { order.push('providers:settle'); }, async dispose() {
        expect(scoped.get(token)).toBe(value);
        order.push('providers:dispose'); scoped.revoke();
      } };
    });
    const scopedServices: DaemonSessionServices = { getExecutionPolicy: () => policy, extensions: {
      configuration: async () => [], executionPort, bind: async (context, boundPort) => {
        expect(boundPort).toBe(port);
        expect(context.services).toBe(scoped); order.push('extensions:bind');
        return { importExtension: async () => ({ default() {} }), services: scoped,
          async dispose() { order.push('extensions:settle'); },
          async disposeUi() { await Promise.resolve(); expect(scoped.get(token)).toBe(value); order.push('ui:dispose'); },
        };
      },
    } };
    const profile = await createTestSessionLifecycle({ agentDir, initializeProcess, createModelRuntime: fakeModels, openServiceScope, deferActivation: true });
    const binding = await profile.openSession({ resources: await profile.resolveResources({ cwd }),
      ownership: { assertOwned() {} }, policy, services: scopedServices, target: { kind: 'new' }, model });
    try {
      expect(openServiceScope).toHaveBeenCalledWith(expect.objectContaining({ sessionId: binding.sessionId,
        rootSessionId: binding.rootSessionId, allowedModels: undefined }));
      expect(order).toEqual(['providers:open', 'extensions:bind']);
      registered = true;
      await binding.activate!(); await binding.activate!();
      expect(executionPort).toHaveBeenCalledOnce();
      expect(port.registerService).toHaveBeenCalledOnce();
      await binding.runtime.dispose(); await binding.runtime.dispose();
      expect(order).toEqual(['providers:open', 'extensions:bind', 'providers:activate', 'extensions:start', 'providers:settle', 'extensions:settle', 'extensions:shutdown', 'ui:dispose', 'providers:dispose']);
      expect(() => scoped.get(token)).toThrow('revoked');
    } finally { await binding.runtime.dispose(); await profile.dispose(); }
  });

  it('retains scoped services and UI when failed setup cleanup is blocked', async () => {
    const { cwd, agentDir } = await fixture();
    const token = defineServiceContract<object>('fixture.lifecycle', 1);
    const registry = createFelanServiceRegistry();
    const implementation = {};
    registry.set(token, implementation);
    const disposeUi = vi.fn();
    const disposeBindings = vi.fn(async () => {}).mockRejectedValueOnce(new Error('cleanup blocked'));
    const scopedServices: DaemonSessionServices = { getExecutionPolicy: () => policy, extensions: {
      configuration: async () => [],
      bind: async () => ({
        importExtension: async () => ({ default() {} }), services: registry,
        wrapStreamFunction() { throw new Error('wrapper failed'); },
        dispose: disposeBindings, disposeUi,
      }),
    } };
    const profile = await createTestSessionLifecycle({ agentDir, initializeProcess, createModelRuntime: fakeModels });
    try {
      await expect(profile.openSession({ resources: await profile.resolveResources({ cwd }),
        ownership: { assertOwned() {} }, policy, services: scopedServices, target: { kind: 'new' }, model }))
        .rejects.toThrow('Session setup cleanup failed');
      expect(disposeUi).not.toHaveBeenCalled();
      expect(registry.get(token)).toBe(implementation);
    } finally {
      await profile.dispose();
      expect(disposeBindings).toHaveBeenCalledTimes(2);
      expect(disposeUi).toHaveBeenCalledOnce();
      expect(() => registry.get(token)).toThrow('revoked');
    }
  });

  it('keeps bindings alive until all asynchronous extension shutdown handlers settle', async () => {
    const { cwd, agentDir } = await fixture();
    const order: string[] = []; let disposed = false;
    const scopedServices: DaemonSessionServices = { getExecutionPolicy: () => policy, extensions: {
      configuration: async () => [],
      bind: async () => ({ importExtension: async () => ({ default() {} }),
        inlineExtensions: [{ name: 'shutdown-order', factory: pi => {
          pi.on('session_shutdown', async () => {
            order.push('shutdown:start'); await Promise.resolve();
            order.push(disposed ? 'shutdown:disposed' : 'shutdown:live');
          });
        } }],
        dispose: async () => { order.push('host:disposed'); },
        disposeUi: () => { disposed = true; order.push('bindings:disposed'); },
      }),
    } };
    const profile = await createTestSessionLifecycle({ agentDir, initializeProcess, createModelRuntime: fakeModels });
    const binding = await profile.openSession({ resources: await profile.resolveResources({ cwd }),
      ownership: { assertOwned() {} }, policy, services: scopedServices, target: { kind: 'new' }, model });
    try {
      await binding.runtime.dispose(); await binding.runtime.dispose();
      expect(order).toEqual(['host:disposed', 'shutdown:start', 'shutdown:live', 'bindings:disposed']);
    } finally { await binding.runtime.dispose(); await profile.dispose(); }
  });

  it('keeps resource helpers and packaged assets free of client themes', async () => {
    expect(Object.keys(await import('../src/providers/local-resources.js')).sort()).toEqual(['getLocalSkillPaths', 'getLocalSkillSources']);
    const manifest = JSON.parse(await readFile(new URL('../../daemon/package.json', import.meta.url), 'utf8'));
    expect(manifest.scripts.build).not.toContain('themes');
  });

  it('exports only its version at runtime and points its package subpath at emitted files', async () => {
    const source = await import('../../daemon/src/daemon/session-lifecycle-contracts.js');
    expect(Object.keys(source)).toEqual(['SESSION_LIFECYCLE_API_VERSION']);
    const manifest = JSON.parse(await readFile(new URL('../../daemon/package.json', import.meta.url), 'utf8'));
    expect(manifest.exports['./session-runtime']).toEqual({ types: './dist/daemon/session-runtime.d.ts', import: './dist/daemon/session-runtime.js' });
  });

  it('resolves canonical roots without creating stores or loading terminal composition', async () => {
    const { root, cwd, agentDir } = await fixture();
    const missing = join(root, 'missing-agent');
    const alias = join(root, 'alias');
    await symlink(cwd, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const profile = await createTestSessionLifecycle({ agentDir: missing, initializeProcess });
    const resources = await profile.resolveResources({ cwd: alias });
    expect(resources.cwd).toBe(cwd);
    expect(resources.sessionStorageBase).toBe(join(missing, 'storage', 'sessions'));
    expect(await readdir(root)).not.toContain('missing-agent');
    const configured = await createTestSessionLifecycle({ agentDir, initializeProcess });
    await writeFile(join(agentDir, 'settings.json'), JSON.stringify({ sessionDir: './selected' }));
    expect((await configured.resolveResources({ cwd })).sessionDir).toBe(join(cwd, 'selected'));
    await expect(profile.resolveResources({ cwd: 'relative' })).rejects.toThrow('absolute');
    await profile.dispose();
    await expect(profile.resolveResources({ cwd })).rejects.toThrow('disposed');
  });

  it('runs real independent sessions with shared launch env, local cwd and isolated config/model registrations', async () => {
    const { root, cwd, agentDir } = await fixture();
    const otherCwd = join(root, 'other');
    await mkdir(otherCwd);
    const before = { ...process.env };
    const beforeCwd = process.cwd();
    const contexts: ProfileExtensionContext[] = [];
    const dispose = vi.fn(async () => {});
    const profile = await createTestSessionLifecycle({ agentDir, initializeProcess, createModelRuntime: fakeModels });
    const a = await profile.openSession({ resources: await profile.resolveResources({ cwd }), ownership: { assertOwned() {} }, policy, services: services(contexts, dispose), target: { kind: 'new' }, model });
    await writeSettings(agentDir, 'second');
    const b = await profile.openSession({ resources: await profile.resolveResources({ cwd: otherCwd }), ownership: { assertOwned() {} }, policy, services: services(contexts, dispose), target: { kind: 'new' }, model });
    try {
      expect(a.sessionId).not.toBe(b.sessionId);
      expect(a.agentRuntime.cwd).toBe(cwd);
      expect(b.agentRuntime.cwd).toBe(otherCwd);
      expect(Reflect.get(contexts[0]!.settingsManager.getGlobalSettings(), 'marker')).toBe('first');
      expect(Reflect.get(contexts[1]!.settingsManager.getGlobalSettings(), 'marker')).toBe('second');
      contexts[0]!.modelRuntime.registerProvider('only-a', { api: 'openai-completions', baseUrl: model.baseUrl, apiKey: 'fixture', models: [{ ...model, id: 'a' }] });
      expect(contexts[1]!.modelRuntime.getModel('only-a', 'a')).toBeUndefined();
      for (const binding of [a, b]) {
        const result = await binding.agentRuntime.exec(process.execPath, ['-e', 'process.stdout.write(process.env.PATH ?? "")']);
        expect(result.stdout).toBe(process.env.PATH ?? '');
        await binding.runtime.session.prompt('offline prompt');
        expect(binding.runtime.session.messages.at(-1)?.role).toBe('assistant');
      }
      expect(process.env).toEqual(before);
      expect(process.cwd()).toBe(beforeCwd);
      await profile.dispose();
      expect(dispose).toHaveBeenCalledTimes(2);
    } finally { await a.runtime.dispose(); await b.runtime.dispose(); }
    expect(dispose).toHaveBeenCalledTimes(2);
  });

  it('validates ownership before opening and preserves source files across resume/fork/clone/import', async () => {
    const { cwd, agentDir } = await fixture();
    const createModels = vi.fn(fakeModels);
    const profile = await createTestSessionLifecycle({ agentDir, initializeProcess, createModelRuntime: createModels });
    const resources = await profile.resolveResources({ cwd });
    const base: Omit<SessionOpenRequest, 'target'> = { resources, ownership: { assertOwned() {} }, policy, services: services(), model };
    await expect(profile.openSession({ ...base, ownership: { assertOwned() { throw new Error('ownership lost'); } }, target: { kind: 'new' } })).rejects.toThrow('ownership lost');
    expect(createModels).not.toHaveBeenCalled();
    const initial = await profile.openSession({ ...base, target: { kind: 'new' } });
    await initial.runtime.session.prompt('source');
    const file = initial.runtime.session.sessionManager.getSessionFile()!;
    const entryId = initial.runtime.session.sessionManager.getLeafId()!;
    await initial.runtime.dispose();
    const contents = await readFile(file, 'utf8');
    for (const target of [
      { kind: 'resume' as const, sessionFile: file },
      { kind: 'fork' as const, sourceSessionFile: file, entryId, position: 'at' as const },
      { kind: 'clone' as const, sourceSessionFile: file },
      { kind: 'import' as const, sessionFile: file },
    ]) {
      const binding = await profile.openSession({ ...base, target,
        ...(target.kind === 'resume' ? { rootSessionId: initial.sessionId } : {}),
      });
      expect(binding.sessionId === initial.sessionId).toBe(target.kind === 'resume');
      expect(binding.rootSessionId).toBe(binding.sessionId);
      expect(binding.agentRuntime.cwd).toBe(cwd);
      await binding.runtime.dispose();
      expect(await readFile(file, 'utf8')).toBe(contents);
    }
    const outside = join(cwd, 'outside.jsonl');
    await writeFile(outside, contents);
    await expect(profile.openSession({ ...base, target: { kind: 'resume', sessionFile: outside } })).rejects.toThrow('outside the owned');
  });

  it('does not weaken inherited policy or admit external extensions without explicit interactive root permission', async () => {
    const { cwd, agentDir } = await fixture();
    const profile = await createTestSessionLifecycle({ agentDir, initializeProcess, createModelRuntime: fakeModels });
    const base: SessionOpenRequest = { resources: await profile.resolveResources({ cwd }), ownership: { assertOwned() {} },
      policy: { mode: 'acp-strict', pendingTightening: false, generation: 1 }, services: services(), target: { kind: 'new' }, model };
    await expect(profile.openSession(base)).rejects.toThrow('cannot be weakened');
    await expect(profile.openSession({ ...base, source: 'acp', extensionPaths: ['/not-loaded.js'] })).rejects.toThrow('trusted interactive root');
  });

  it('settles owned bindings before Pi disposal and does not hide failed cleanup', async () => {
    const { cwd, agentDir } = await fixture();
    const dispose = vi.fn(async () => {}).mockRejectedValueOnce(new Error('host cleanup failed'));
    const profile = await createTestSessionLifecycle({ agentDir, initializeProcess, createModelRuntime: fakeModels });
    const binding = await profile.openSession({ resources: await profile.resolveResources({ cwd }), ownership: { assertOwned() {} },
      policy, services: services([], dispose), target: { kind: 'new' }, model });
    const piDispose = vi.spyOn(binding.runtime.session, 'dispose');
    await expect(binding.runtime.dispose()).rejects.toThrow('host cleanup failed');
    expect(piDispose).not.toHaveBeenCalled();
    await binding.runtime.dispose();
    expect(dispose).toHaveBeenCalledTimes(2);
    expect(piDispose).toHaveBeenCalledOnce();
  });

  it('rejects every in-binding replacement before hooks, storage or registration changes', async () => {
    const { cwd, agentDir } = await fixture();
    const contexts: ProfileExtensionContext[] = [];
    const dispose = vi.fn(async () => {});
    const models = vi.fn(fakeModels);
    const profile = await createTestSessionLifecycle({ agentDir, initializeProcess, createModelRuntime: models });
    const binding = await profile.openSession({ resources: await profile.resolveResources({ cwd }), ownership: { assertOwned() {} },
      policy, services: services(contexts, dispose), target: { kind: 'new' }, model });
    try {
      await binding.runtime.session.prompt('persist');
      const manager = binding.runtime.session.sessionManager;
      const file = manager.getSessionFile()!;
      const before = await readFile(file, 'utf8');
      const files = await readdir(binding.resources.sessionDir);
      for (const action of [() => binding.runtime.newSession(), () => binding.runtime.switchSession(join(cwd, 'outside.jsonl')),
        () => binding.runtime.fork('missing'), () => binding.runtime.importFromJsonl(join(cwd, 'outside.jsonl'))]) {
        await expect(action()).rejects.toThrow('registry admission');
      }
      await expect(profile.openSession({ resources: binding.resources, ownership: { assertOwned() {} }, policy,
        services: services(), target: { kind: 'new' }, model, rootSessionId: binding.sessionId })).rejects.toThrow('A root session must own its storage identity');
      expect(binding.sessionId).toBe(manager.getSessionId());
      expect(binding.runtime.session.sessionManager).toBe(manager);
      expect(await readFile(file, 'utf8')).toBe(before);
      expect(await readdir(binding.resources.sessionDir)).toEqual(files);
      expect(models).toHaveBeenCalledOnce();
      expect(contexts).toHaveLength(1);
      expect(dispose).not.toHaveBeenCalled();
    } finally { await binding.runtime.dispose(); }
  });

  it('rejects cross-cwd resume and fork before model creation or filesystem effects', async () => {
    const { root, cwd, agentDir } = await fixture();
    const models = vi.fn(fakeModels);
    const profile = await createTestSessionLifecycle({ agentDir, initializeProcess, createModelRuntime: models });
    const base = { ownership: { assertOwned() {} }, policy, services: services(), model };
    const initial = await profile.openSession({ ...base, resources: await profile.resolveResources({ cwd }), target: { kind: 'new' } });
    await initial.runtime.session.prompt('persist');
    const file = initial.runtime.session.sessionManager.getSessionFile()!;
    const entryId = initial.runtime.session.sessionManager.getLeafId()!;
    await initial.runtime.dispose();
    const before = await readFile(file, 'utf8');
    const other = join(root, 'other');
    await mkdir(other);
    const resources = await profile.resolveResources({ cwd: other });
    const files = await readdir(resources.sessionDir);
    for (const target of [{ kind: 'resume' as const, sessionFile: file },
      { kind: 'fork' as const, sourceSessionFile: file, entryId, position: 'at' as const }]) {
      await expect(profile.openSession({ ...base, resources, target })).rejects.toThrow('cwd does not match');
    }
    expect(models).toHaveBeenCalledOnce();
    expect(await readdir(resources.sessionDir)).toEqual(files);
    expect(await readFile(file, 'utf8')).toBe(before);
  });

  it.each(['resume-cwd', 'resume-id', 'fork-cwd', 'fork-id', 'import-limit'] as const)(
    'revalidates %s under the acquired claim before any session effects', async change => {
      const { root, cwd, agentDir } = await fixture();
      const otherCwd = join(root, 'other');
      await mkdir(otherCwd);
      const models = vi.fn(fakeModels);
      const contexts: ProfileExtensionContext[] = [];
      const profile = await createTestSessionLifecycle({ agentDir, initializeProcess, createModelRuntime: models });
      const resources = await profile.resolveResources({ cwd });
      const base = { resources, policy, services: services(contexts), model };
      const initial = await profile.openSession({ ...base, ownership: { assertOwned() {} }, target: { kind: 'new' } });
      await initial.runtime.session.prompt('persist');
      const file = initial.runtime.session.sessionManager.getSessionFile()!;
      const entryId = initial.runtime.session.sessionManager.getLeafId()!;
      await initial.runtime.dispose();
      const files = await readdir(resources.sessionDir);
      const sessionStores = await readdir(resources.sessionStorageBase);
      const agentFiles = await readdir(resources.agentStorageRoot);
      let claimed!: () => void;
      let acquiring!: () => void;
      const claim = new Promise<void>(resolve => { claimed = resolve; });
      const started = new Promise<void>(resolve => { acquiring = resolve; });
      const assertOwned = vi.fn(async () => { acquiring(); await claim; });
      const target: SessionOpenRequest['target'] = change.startsWith('fork')
        ? { kind: 'fork', sourceSessionFile: file, entryId, position: 'at' }
        : change === 'import-limit' ? { kind: 'import', sessionFile: file } : { kind: 'resume', sessionFile: file };
      const opening = profile.openSession({ ...base, ownership: { assertOwned }, target,
        ...(change === 'resume-id' ? { rootSessionId: initial.sessionId } : {}),
      }).then(async binding => { await binding.runtime.dispose(); return undefined; }, error => error as unknown);
      await started;
      if (change === 'import-limit') await truncate(file, 64 * 1024 * 1024 + 1);
      else {
        const lines = (await readFile(file, 'utf8')).split('\n');
        const header = JSON.parse(lines[0]!);
        if (change.endsWith('-cwd')) header.cwd = otherCwd;
        else header.id = 'changed-before-claim';
        lines[0] = JSON.stringify(header);
        await writeFile(file, lines.join('\n'));
      }
      const updatedSource = await readFile(file);
      claimed();
      const error = await opening;
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(/cwd does not match|identity changed|64 MiB/);
      expect(assertOwned).toHaveBeenCalledOnce();
      expect(models).toHaveBeenCalledOnce();
      expect(contexts).toHaveLength(1);
      expect(await readdir(resources.sessionDir)).toEqual(files);
      expect(await readdir(resources.sessionStorageBase)).toEqual(sessionStores);
      expect(await readdir(resources.agentStorageRoot)).toEqual(agentFiles);
      expect((await readFile(file)).equals(updatedSource)).toBe(true);
    },
  );

  it('gives ownership the canonical source identity before opening and bounds owned-copy imports', async () => {
    const { root, cwd, agentDir } = await fixture();
    const models = vi.fn(fakeModels);
    const profile = await createTestSessionLifecycle({ agentDir, initializeProcess, createModelRuntime: models });
    const resources = await profile.resolveResources({ cwd });
    const base = { resources, ownership: { assertOwned() {} }, policy, services: services(), model };
    const initial = await profile.openSession({ ...base, target: { kind: 'new' } });
    await initial.runtime.session.prompt('persist');
    const file = initial.runtime.session.sessionManager.getSessionFile()!;
    await initial.runtime.dispose();
    const alias = join(resources.sessionDir, 'alias.jsonl');
    await symlink(file, alias);
    const assertOwned = vi.fn((_resources, target) => {
      expect(target).toEqual({ kind: 'resume', sourceSessionFile: file, sourceSessionId: initial.sessionId, destinationDirectory: resources.sessionDir });
      throw new Error('source already owned');
    });
    await expect(profile.openSession({ ...base, ownership: { assertOwned }, target: { kind: 'resume', sessionFile: alias } })).rejects.toThrow('source already owned');
    expect(models).toHaveBeenCalledOnce();
    const outside = join(root, 'external.jsonl');
    await writeFile(outside, await readFile(file));
    await expect(profile.openSession({ ...base, target: { kind: 'import', sessionFile: outside } })).rejects.toThrow('outside the owned');
    const oversized = join(resources.sessionDir, 'large.jsonl');
    await writeFile(oversized, await readFile(file));
    await truncate(oversized, 64 * 1024 * 1024 + 1);
    await expect(profile.openSession({ ...base, target: { kind: 'import', sessionFile: oversized } })).rejects.toThrow('64 MiB');
    const invalid = join(resources.sessionDir, 'invalid.jsonl');
    await writeFile(invalid, '{}\n');
    await expect(profile.openSession({ ...base, target: { kind: 'import', sessionFile: invalid } })).rejects.toThrow('Invalid session header');
  });

  it('implements explicit before/at fork positions without rewriting the source', async () => {
    const { cwd, agentDir } = await fixture();
    const profile = await createTestSessionLifecycle({ agentDir, initializeProcess, createModelRuntime: fakeModels });
    const base = { resources: await profile.resolveResources({ cwd }), ownership: { assertOwned() {} }, policy, services: services(), model };
    const initial = await profile.openSession({ ...base, target: { kind: 'new' } });
    await initial.runtime.session.prompt('first');
    await initial.runtime.session.prompt('second');
    const manager = initial.runtime.session.sessionManager;
    const file = manager.getSessionFile()!;
    const userEntries = manager.getEntries().filter(entry => entry.type === 'message' && entry.message.role === 'user');
    const selected = userEntries.at(-1)!;
    const assistantEntry = manager.getLeafId()!;
    await initial.runtime.dispose();
    const before = await readFile(file, 'utf8');
    for (const position of ['before', 'at'] as const) {
      const fork = await profile.openSession({ ...base, target: { kind: 'fork', sourceSessionFile: file, entryId: selected.id, position } });
      expect(fork.runtime.session.sessionManager.getEntries().some(entry => entry.id === selected.id)).toBe(position === 'at');
      expect(fork.sessionId).not.toBe(initial.sessionId);
      await fork.runtime.dispose();
    }
    const empty = await profile.openSession({ ...base, target: { kind: 'fork', sourceSessionFile: file, entryId: userEntries[0]!.id, position: 'before' } });
    expect(empty.runtime.session.messages.filter(message => message.role === 'user' || message.role === 'assistant')).toHaveLength(0);
    await empty.runtime.dispose();
    await expect(profile.openSession({ ...base, target: { kind: 'fork', sourceSessionFile: file, entryId: assistantEntry, position: 'before' } })).rejects.toThrow('Invalid entry');
    expect(await readFile(file, 'utf8')).toBe(before);
  });

  it('derives provenance from bound tools and revokes a safe-name exemption when its implementation changes', async () => {
    const { cwd, agentDir } = await fixture();
    const external = join(cwd, 'extension.mjs');
    await writeFile(external, `export default pi => pi.registerTool({ name:'external_tool', label:'external', description:'fixture', parameters:{type:'object',properties:{}}, execute: async()=>({content:[],details:{}}) });`);
    const profile = await createTestSessionLifecycle({ agentDir, initializeProcess, createModelRuntime: fakeModels });
    const binding = await profile.openSession({ resources: await profile.resolveResources({ cwd }), ownership: { assertOwned() {} },
      policy, services: services(), target: { kind: 'new' }, model, source: 'acp', interactiveExtensions: true, extensionPaths: [external] });
    try {
      expect(binding.toolProvenance).toContainEqual({ name: 'read', source: 'builtin', sourceId: '<inline:@felan-ai/agent-core/runtime-tools>' });
      expect(binding.toolProvenance).toContainEqual({ name: 'external_tool', source: 'external', sourceId: external });
      const strict = { mode: 'acp-strict', pendingTightening: false, generation: 1 } as const;
      expect(binding.tools.requiresApproval(strict, 'read')).toBe(false);
      expect(binding.tools.requiresApproval(strict, 'external_tool')).toBe(true);
      const definitions = Reflect.get(binding.runtime.session, '_toolDefinitions') as Map<string, { definition: ToolDefinition }>;
      const original = definitions.get('read')!;
      definitions.set('read', { ...original, definition: { ...original.definition } });
      expect(binding.tools.requiresApproval(strict, 'read')).toBe(true);
      definitions.set('read', original);
    } finally { await binding.runtime.dispose(); }
  });

  it('releases bindings before disposing a session whose setup fails', async () => {
    const { cwd, agentDir } = await fixture();
    const order: string[] = [];
    const base = services();
    const profile = await createTestSessionLifecycle({ agentDir, initializeProcess, createModelRuntime: fakeModels });
    await expect(profile.openSession({ resources: await profile.resolveResources({ cwd }), ownership: { assertOwned() {} }, policy, model, target: { kind: 'new' }, services: {
      ...base, extensions: { ...base.extensions, bind: async context => ({ ...await base.extensions.bind(context),
        dispose: async () => { order.push('bindings'); },
        onSession: session => {
          const dispose = session.dispose.bind(session);
          session.dispose = () => { order.push('pi'); dispose(); };
          throw new Error('setup failed');
        },
      }) },
    } })).rejects.toThrow('setup failed');
    expect(order).toEqual(['bindings', 'pi']);
  });

  it('creates a profile through the real tolerant bootstrap for malformed settings and warns about invalid proxy values', async () => {
    const { cwd, agentDir } = await fixture();
    const keys = ['PI_CODING_AGENT_DIR', 'PI_SKIP_VERSION_CHECK', 'PI_TELEMETRY'] as const;
    const previous = keys.map(key => process.env[key]);
    try {
      await writeFile(join(agentDir, 'settings.json'), '{"broken":');
      const profile = await createTestSessionLifecycle({ agentDir, createModelRuntime: fakeModels,
        initializeProcess: directory => initializeLocalDaemonProcess(directory, async () => ({
          DEFAULT_HTTP_IDLE_TIMEOUT_MS: 300_000,
          parseHttpIdleTimeoutMs: value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined,
          applyHttpProxySettings() {}, configureHttpDispatcher() {},
        })),
      });
      const base = { resources: await profile.resolveResources({ cwd }), ownership: { assertOwned() {} }, policy,
        services: services(), target: { kind: 'new' as const }, model };
      const malformed = await profile.openSession(base);
      expect(malformed.diagnostics.some(item => item.type === 'warning' && item.message.startsWith('global settings:'))).toBe(true);
      await malformed.runtime.dispose();
      await writeSettings(agentDir, 'corrected');
      const settings = JSON.parse(await readFile(join(agentDir, 'settings.json'), 'utf8'));
      await writeFile(join(agentDir, 'settings.json'), JSON.stringify({ ...settings, httpProxy: 42 }));
      const invalidProxy = await profile.openSession(base);
      expect(invalidProxy.diagnostics.some(item => item.type === 'warning' && item.message.includes('httpProxy'))).toBe(true);
      await invalidProxy.runtime.dispose();
    } finally {
      for (const [index, key] of keys.entries()) {
        if (previous[index] === undefined) delete process.env[key];
        else process.env[key] = previous[index];
      }
    }
  });
});
