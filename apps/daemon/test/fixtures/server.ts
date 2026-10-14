import type { HostConfiguration } from '../../src/daemon/host-services.js';
import type { ProcessAdapter } from '../../src/daemon/process-adapter.js';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { HostAgentRuntime, InMemoryCredentialStore, ModelRuntime, createAssistantMessageEventStream, type ExtensionAPI, type ExtensionConfigDefinition } from '@felan-ai/agent-core';
import { DaemonControlStore, type ControlCapacity } from '../../src/daemon/control-store.js';
import { createTestSessionLifecycle } from './session-runtime.js';
import type { SessionExtensionBindings as ProfileExtensionBindings, SessionExtensionContext as ProfileExtensionContext } from '../../src/daemon/session-execution.js';
import type { DaemonOwnership } from '../../src/daemon/ownership.js';
import type { SessionRuntime } from '../../src/daemon/session-runtime.js';
import type { SessionLifecycleOptions } from '../../src/daemon/session-lifecycle.js';
import type { RuntimeFactory } from '../../src/runtime-factory.js';
import { SessionRegistry, type RegistryOptions } from '../../src/daemon/registry.js';
import { canonicalProspectivePath, identityFor, resolveDaemonTarget } from '../../src/daemon/target.js';
import { assistant, now, offlineModel } from './registry.js';

export { now, requestId } from './registry.js';
export function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

export async function serverFixture(options: { now?: () => number; capacity?: Partial<ControlCapacity>; onStream?: () => Promise<void>; extension?: (pi: ExtensionAPI) => void;
  namespace?: (directory: string) => string;
  configDefinitions?: readonly ExtensionConfigDefinition[];
  configuration?: HostConfiguration;
  deferActivation?: boolean;
  builtins?: readonly string[];
  extensionPackages?: readonly string[];
  composition?: SessionRuntime;
  processAdapter?: ProcessAdapter;
  createComposition?: (runtimeFactory: RuntimeFactory) => SessionRuntime;
  openServiceScope?: SessionLifecycleOptions['openServiceScope'];
  servicesFactory?: (registry: SessionRegistry) => RegistryOptions['services'];
  onBind?: (context: ProfileExtensionContext) => void;
  extensionUi?: (context: ProfileExtensionContext, registry: SessionRegistry) => { context: NonNullable<ProfileExtensionBindings['uiContext']>; dispose(): void | Promise<void> };
  compaction?: { reserveTokens: number; keepRecentTokens: number }; skill?: boolean } = {}) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 's7-')));
  const cwd = join(directory, 'work'); const agentDir = join(directory, 'agent');
  await mkdir(cwd); await mkdir(agentDir, { mode: 0o700 }); await mkdir(join(directory, 'runtime'), { mode: 0o700 });
  if (options.skill) {
    const skills = join(cwd, '.agents', 'skills', 'shared-test-skill'); await mkdir(skills, { recursive: true });
    await writeFile(join(skills, 'SKILL.md'), '---\nname: shared-test-skill\ndescription: Private fixture skill\n---\nLoaded skill instructions from private fixture.\n');
  }
  const target = resolveDaemonTarget({ kind: 'isolated', directory, namespaceId: options.namespace?.(directory) ?? randomUUID(), storeRoots: [directory] });
  // The fixture exercises real profile/control files without acquiring account-wide OS ownership.
  const owner = {
    target, identity: identityFor(target, randomUUID()),
    assertCurrent() {},
    assertOwnsPath(input: string) {
      const path = canonicalProspectivePath(input); const child = relative(directory, path);
      if (child === '..' || child.startsWith('../') || isAbsolute(child)) throw new Error('Outside private server fixture');
      return path;
    },
    async ownRoot(input: string) { owner.assertOwnsPath(input); },
    watchPath: () => () => {}, onLost: () => () => {},
  } as unknown as DaemonOwnership;
  let registry: SessionRegistry | undefined;
  const store = new DaemonControlStore(owner, { now: options.now ?? (() => now), ...(options.capacity ? { capacity: options.capacity } : {}) });
  await writeFile(join(agentDir, 'settings.json'), JSON.stringify({
    ...(options.compaction ? { compaction: options.compaction } : {}) }));
  const runtimeFactory: RuntimeFactory = request => registry!.wrapOpeningRuntime(new HostAgentRuntime(request.cwd, request), request.rootSessionId);
  const composition = options.createComposition?.(runtimeFactory) ?? options.composition;
  const profile = await createTestSessionLifecycle({ agentDir, homeDir: directory, ...(options.deferActivation ? { deferActivation: true } : {}),
    ...(options.extensionPackages ? { extensionAllowlist: options.extensionPackages } : {}),
    ...(composition ? { composition } : {}), definitions: options.configDefinitions ?? [],
    ...(options.openServiceScope ? { openServiceScope: options.openServiceScope } : {}),
    ...(options.skill ? { skillPaths: [join(cwd, '.agents', 'skills')] } : {}),
    runtimeFactory,
    ...(options.configuration ? { configuration: () => options.configuration! } : {}),
    createModelRuntime: async () => {
      const models = await ModelRuntime.create({ modelsPath: null, credentials: new InMemoryCredentialStore(), refreshOnCreate: false });
      models.registerProvider('offline', { api: 'openai-completions', baseUrl: offlineModel.baseUrl, apiKey: 'fixture', models: [offlineModel], streamSimple: () => {
        const stream = createAssistantMessageEventStream();
        void Promise.resolve().then(options.onStream).then(() => stream.push({ type: 'done', reason: 'stop', message: assistant() }));
        return stream;
      } });
      return models;
    } });
  let installedServices: RegistryOptions['services'] | undefined;
  registry = new SessionRegistry({ owner, store, lifecycle: profile, now: options.now ?? (() => now), idleMs: 0,
    ...(options.processAdapter ?? composition?.processAdapter ? { processAdapter: options.processAdapter ?? composition!.processAdapter! } : {}),
    services: input => {
      if (options.servicesFactory) return (installedServices ??= options.servicesFactory(registry!))(input);
      return { getExecutionPolicy: input.getExecutionPolicy, extensions: {
      configuration: async () => options.configDefinitions ?? [], bind: async context => {
        options.onBind?.(context);
        const ui = options.extensionUi?.(context, registry!);
        return { importExtension: context.importExtension, dispose: async () => { await ui?.dispose(); },
          ...(ui ? { uiContext: ui.context } : {}),
          ...(options.extension ? { inlineExtensions: [{ name: 'synthetic', factory: options.extension }] } : {}) };
      },
      } };
    } });
  const root = await registry.create({ cwd, target: { kind: 'new' }, model: offlineModel });
  return { directory, cwd, store, owner, profile, registry, root,
    async dispose() { await registry!.shutdown(); store.close(); await profile.dispose(); await rm(directory, { recursive: true, force: true }); } };
}
