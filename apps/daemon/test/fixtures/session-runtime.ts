import { TestHostConfiguration, createTestHostServices } from './host-services.js';
import { mkdir, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { HostAgentRuntime, InMemoryCredentialStore, ModelRuntime, SettingsManager, createFelanServiceRegistry, resolveExtensionConfigs, type ExtensionConfigDefinition, type ExtensionPackageImporter, type FelanServiceRegistry } from '@felan-ai/agent-core';
import { createSessionLifecycle, type SessionLifecycleOptions } from '../../src/daemon/session-lifecycle.js';
import { createRuntimeStorageRequest, type RuntimeFactory } from '../../src/runtime-factory.js';
import { assertAbsolutePath, canonicalPath } from '../../src/daemon/profile-storage.js';
import type { SessionRuntime } from '../../src/daemon/session-runtime.js';

export function createTestSessionRuntime(options: {
  runtimeFactory?: RuntimeFactory;
  definitions?: readonly ExtensionConfigDefinition[];
  importExtension?: ExtensionPackageImporter;
  skillPaths?: readonly string[];
} = {}): SessionRuntime {
  const definitions = options.definitions ?? [];
  const toolPolicy = { trustedInlinePaths: ['<inline:@felan-ai/agent-core/runtime-tools>'], approvalExemptTools: ['read', 'find', 'grep', 'ls'] };
  return {
    toolPolicy,
    secretStorage: { read: async () => undefined, write: async () => {}, remove: async () => {} },
    async createHostServices(request) {
      return createTestHostServices(new TestHostConfiguration({ definitions: request.definitions, assertCurrent: request.assertCurrent }));
    },
    createModelRuntime: async () => ModelRuntime.create({ modelsPath: null, credentials: new InMemoryCredentialStore(), refreshOnCreate: false }),
    async resolveEnvironment(request) {
      assertAbsolutePath(request.cwd); assertAbsolutePath(request.agentDir);
      const cwd = await realpath(request.cwd);
      const agentDir = await canonicalPath(request.agentDir);
      const settings = SettingsManager.create(cwd, agentDir);
      const configured = request.sessionDir ?? settings.getSessionDir();
      if (request.sessionDir !== undefined) assertAbsolutePath(request.sessionDir);
      const sessionDir = await canonicalPath(configured === undefined ? join(agentDir, 'sessions') : resolve(cwd, configured.replace(/^~(?=$|\/)/u, request.homeDir ?? agentDir)));
      const sessionStorageBase = await canonicalPath(join(agentDir, 'storage', 'sessions'));
      const agentStorageRoot = await canonicalPath(join(agentDir, 'storage', 'agent'));
      return { cwd, agentDir, sessionDir, sessionStorageBase, agentStorageRoot,
        writableRoots: [sessionDir, sessionStorageBase, agentStorageRoot], workerRoots: [sessionStorageBase, agentStorageRoot] };
    },
    async configuration() { return definitions; },
    async validateConfiguration(_environment, _packages, overrides) { resolveExtensionConfigs(definitions, overrides); },
    async prepare(request) {
      const environment = request.environment;
      const runtimeRequest = createRuntimeStorageRequest(environment.cwd, environment.agentDir, request.session.root);
      await mkdir(runtimeRequest.sessionStorageRoot, { recursive: true, mode: 0o700 }); await mkdir(runtimeRequest.agentStorageRoot, { recursive: true, mode: 0o700 });
      const runtime = options.runtimeFactory?.(runtimeRequest) ?? new HostAgentRuntime(environment.cwd, runtimeRequest);
      return { configuration: request.configuration ?? null, toolPolicy: { ...toolPolicy,
        trustedInlinePaths: [...toolPolicy.trustedInlinePaths, ...request.extensionPackages.map(name => `<inline:${name}>`)] },
        options: { runtime, modelRuntime: request.modelRuntime, settingsManager: SettingsManager.create(environment.cwd, environment.agentDir),
        extensionPackages: request.extensionPackages, importExtension: options.importExtension ?? (async () => ({ default() {} })),
        extensionConfigOverrides: request.extensionConfigOverrides, extensionPaths: request.extensionPaths,
        skillPaths: options.skillPaths ?? [], themePaths: [],
        ...(request.model ? { model: request.model } : {}), ...(request.thinkingLevel ? { thinkingLevel: request.thinkingLevel } : {}),
      }, extensionConfigs: resolveExtensionConfigs(definitions, request.extensionConfigOverrides), diagnostics: [], async dispose() {} };
    },
  };
}

export async function createTestSessionLifecycle(options: Omit<SessionLifecycleOptions,
  'composition' | 'serviceRegistry' | 'openServiceScope' | 'secretStorage' | 'extensionPackages' | 'configurationIdentity' | 'configuration'> & {
  configurationIdentity?: string;
  configuration?: SessionLifecycleOptions['configuration'];
  runtimeFactory?: RuntimeFactory;
  serviceRegistry?: FelanServiceRegistry;
  openServiceScope?: SessionLifecycleOptions['openServiceScope'];
  extensionAllowlist?: readonly string[];
  composition?: SessionRuntime;
  definitions?: readonly ExtensionConfigDefinition[];
  skillPaths?: readonly string[];
}) {
  const services = options.serviceRegistry ?? createFelanServiceRegistry();
  const composition = options.composition ?? createTestSessionRuntime({ ...(options.runtimeFactory ? { runtimeFactory: options.runtimeFactory } : {}),
    ...(options.definitions ? { definitions: options.definitions } : {}), ...(options.skillPaths ? { skillPaths: options.skillPaths } : {}) });
  const configuration = new TestHostConfiguration({ definitions: options.definitions ?? [], assertCurrent() {} });
  return createSessionLifecycle({ ...options,
    configuration: options.configuration ?? (() => configuration),
    configurationIdentity: options.configurationIdentity ?? 'test-composition',
    composition,
    extensionPackages: options.extensionAllowlist ?? [],
    serviceRegistry: services,
    secretStorage: { read: async () => undefined, write: async () => {}, remove: async () => {} },
    openServiceScope: options.openServiceScope ?? (async () => {
      const child = services.fork();
      return { services: child, inlineExtensions: [], busy: () => false,
        activate: async () => {}, settle: async () => {}, dispose: async () => { child.revoke(); } };
    }),
  });
}
