import { mkdir, open, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  AGENT_CORE_VERSION, HostAgentRuntime, SessionManager, createAgentCoreSessionRuntimeFactory, createAgentSessionRuntime,
  resolveExtensionConfigs, type AgentRuntime, type AgentSession, type AgentSessionRuntimeDiagnostic, type Logger, type ModelRuntime,
} from '@felan-ai/agent-core';
import { resolveModelScopeWithDiagnostics } from '@earendil-works/pi-coding-agent';
import { createLocalClassifier } from '../classifier.js';
import { createLocalCodemodeExtension } from '../codemode.js';
import { resolveBuiltinExtensionPackages } from '../extension-catalog.js';
import { createLocalAgentLogger } from '../logger.js';
import { createLocalModelRuntime, getLocalSkillPaths } from '../local-resources.js';
import { acquireFelanModelDefaults } from '../model-defaults.js';
import { createLocalAgentRuntimeFactoryRequest, type LocalAgentRuntimeFactory } from '../runtime-factory.js';
import {
  createLocalSettingsManager, getClassifierModelSetting, getDynamicThinkingEnabled, getFelanSettings,
  getLocalCodemodeMode, resolveExtensionConfigSettings,
} from '../settings.js';
import { loadLocalAppendSystemPrompt } from '../system-prompt.js';
import { inheritExecutionPolicy, TrustedToolCatalog } from './execution-policy.js';
import { initializeLocalDaemonProcess, type DaemonProcessConfiguration } from './process-bootstrap.js';
import { restoreSessionCursor } from './session-cursor.js';
import {
  DAEMON_PROFILE_API_VERSION, type DaemonProfile, type ProfileExtensionBindings, type ProfileOpenRequest,
  type ProfileResources, type ProfileSessionBinding, type ProfileTargetIdentity, type SessionExecutionPolicy,
} from './profile.js';

export interface LocalDaemonProfileOptions {
  readonly agentDir: string;
  readonly homeDir?: string;
  readonly createModelRuntime?: (agentDir: string) => Promise<ModelRuntime>;
  readonly runtimeFactory?: LocalAgentRuntimeFactory;
  readonly initializeProcess?: (agentDir: string) => Promise<DaemonProcessConfiguration>;
  readonly deferActivation?: boolean;
  readonly wrapRuntime?: (runtime: AgentRuntime, request: Parameters<LocalAgentRuntimeFactory>[0]) => AgentRuntime;
  readonly createLogger?: (agentStorageRoot: string) => Logger;
}

export async function createLocalDaemonProfile(options: LocalDaemonProfileOptions): Promise<DaemonProfile> {
  assertAbsolutePath(options.agentDir);
  const processConfiguration = await (options.initializeProcess ?? initializeLocalDaemonProcess)(options.agentDir);
  const resources = new WeakSet<ProfileResources>();
  const resourceWarnings = new WeakMap<ProfileResources, readonly AgentSessionRuntimeDiagnostic[]>();
  const modelRuntimes = new WeakSet<ModelRuntime>();
  let disposed = false;
  return {
    apiVersion: DAEMON_PROFILE_API_VERSION,
    id: 'local',
    async validateConfiguration(resolved, overrides, configuration) {
      if (disposed || !resources.has(resolved)) throw new Error('Session resources must be resolved by this profile');
      const settings = createLocalSettingsManager(resolved.cwd, resolved.agentDir);
      const packages = resolveBuiltinExtensionPackages(getFelanSettings(settings).builtinExtensions);
      const definitions = await configuration(packages);
      const configured = resolveExtensionConfigSettings(getFelanSettings(settings), definitions);
      resolveExtensionConfigs(definitions, [...configured.overrides, ...overrides]);
    },
    async resolveResources(request) {
      if (disposed) throw new Error('Local profile is disposed');
      assertAbsolutePath(request.cwd);
      if (request.sessionDir !== undefined) assertAbsolutePath(request.sessionDir);
      const cwd = await canonicalPath(request.cwd);
      if (!(await stat(cwd)).isDirectory()) throw new Error('Session cwd must be a directory');
      const agentDir = await canonicalPath(options.agentDir);
      const settings = createLocalSettingsManager(cwd, agentDir);
      const warnings: AgentSessionRuntimeDiagnostic[] = [];
      let configuredSessionDir = request.sessionDir;
      if (configuredSessionDir === undefined) {
        try {
          configuredSessionDir = settings.getSessionDir();
          if (configuredSessionDir !== undefined && (typeof configuredSessionDir !== 'string'
            || configuredSessionDir.length === 0 || configuredSessionDir.includes('\0'))) throw new Error('Invalid configured session directory');
        } catch {
          configuredSessionDir = undefined;
          warnings.push({ type: 'warning', message: 'Invalid configured session directory; using the default.' });
        }
      }
      const home = options.homeDir ?? homedir();
      const directory = configuredSessionDir?.replace(/^~(?=$|[\\/])/u, home);
      const sessionDir = await canonicalPath(directory === undefined ? join(agentDir, 'sessions') : resolve(cwd, directory));
      const sessionStorageBase = await canonicalPath(join(agentDir, 'storage', 'sessions'));
      const agentStorageRoot = await canonicalPath(join(agentDir, 'storage', 'agent'));
      const subagentRoot = await canonicalPath(join(agentDir, 'subagents'));
      const memoryRoot = await canonicalPath(join(agentDir, 'memory', 'v1'));
      const resolved = Object.freeze({
        cwd, agentDir, sessionDir, sessionStorageBase, agentStorageRoot, subagentRoot, memoryRoot,
        writableRoots: Object.freeze([...new Set([sessionDir, sessionStorageBase, agentStorageRoot, subagentRoot, memoryRoot])]),
      });
      resources.add(resolved);
      resourceWarnings.set(resolved, warnings);
      return resolved;
    },
    async openSession(request) {
      if (disposed) throw new Error('Local profile is disposed');
      if (!resources.has(request.resources)) throw new Error('Session resources must be resolved by this profile');
      const originalPolicy = inheritExecutionPolicy(request.policy);
      if (request.extensionPaths?.length && (request.source !== 'tui' || request.parentSessionId !== undefined)) {
        throw new Error('External extensions require a trusted root TUI session');
      }
      const extensionPaths = await Promise.all((request.extensionPaths ?? []).map(async path => {
        assertAbsolutePath(path);
        return realpath(path);
      }));
      const resolvedTarget = await resolveTarget(request);
      const target = resolvedTarget.identity;
      if (request.parentSessionId !== undefined && request.rootSessionId === undefined) throw new Error('Child sessions require their root session identity');
      if (request.parentSessionId === undefined && request.rootSessionId !== undefined
        && (target.kind !== 'resume' || request.rootSessionId !== target.sourceSessionId)) {
        throw new Error('A root session must own its own storage identity');
      }
      await request.ownership.assertOwned(request.resources, target);
      const ownedTarget = await resolveTarget(request);
      assertTargetUnchanged(resolvedTarget, ownedTarget);
      const manager = await openSessionManager(request, ownedTarget);
      await assertSessionManagerMatches(manager, request.resources.cwd,
        target.kind === 'resume' ? ownedTarget.identity.sourceSessionId : undefined);
      if (request.target.kind === 'resume' && request.target.cursor) restoreSessionCursor(manager, request.target.cursor);
      const sessionId = manager.getSessionId();
      const models = await (options.createModelRuntime ?? createLocalModelRuntime)(request.resources.agentDir);
      if (modelRuntimes.has(models)) throw new Error('Each daemon session requires its own model registration state');
      modelRuntimes.add(models);
      const rootSessionId = request.parentSessionId === undefined ? sessionId : request.rootSessionId!;
      if (!rootSessionId || rootSessionId === '.' || rootSessionId === '..' || rootSessionId.includes('\0')) throw new Error('Invalid root session identity');
      let currentRuntime: AgentRuntime | undefined;
      let currentBindings: ProfileExtensionBindings | undefined;
      let diagnostics: readonly AgentSessionRuntimeDiagnostic[] = [];
      let releaseBindings: (() => Promise<void>) | undefined;
      let releaseUi: (() => void) | undefined;
      let createdSession: AgentSession | undefined;
      let activateSession: (() => Promise<void>) | undefined;
      let activePackages: readonly string[] = [];
      const coreFactory = createAgentCoreSessionRuntimeFactory(async ({ cwd, sessionManager }) => {
        if (sessionManager !== manager) throw new Error('Daemon session replacement requires profile.openSession');
        if (await canonicalPath(cwd) !== request.resources.cwd) throw new Error('Session cwd does not match its owned resources');
        await assertSessionManagerMatches(sessionManager, request.resources.cwd, sessionId);
        await request.ownership.assertOwned(request.resources, target);
        const settings = createLocalSettingsManager(cwd, request.resources.agentDir);
        const processWarnings = processConfiguration.assertConfiguration(settings.getGlobalSettings());
        const packages = resolveBuiltinExtensionPackages(getFelanSettings(settings).builtinExtensions);
        activePackages = packages;
        const definitions = await request.services.extensions.configuration(packages);
        const config = resolveExtensionConfigSettings(getFelanSettings(settings), definitions);
        const extensionConfigOverrides = [...config.overrides, ...(request.extensionConfigOverrides ?? [])];
        const extensionConfigs = resolveExtensionConfigs(definitions, extensionConfigOverrides);
        const scope = settings.getEnabledModels();
        const modelScope = scope?.length ? await resolveModelScopeWithDiagnostics(scope, models) : { scopedModels: [], diagnostics: [] };
        const runtimeRequest = createLocalAgentRuntimeFactoryRequest(cwd, request.resources.agentDir, rootSessionId);
        await Promise.all([mkdir(runtimeRequest.sessionStorageRoot, { recursive: true, mode: 0o700 }), mkdir(runtimeRequest.agentStorageRoot, { recursive: true, mode: 0o700 })]);
        const classifier = options.runtimeFactory === undefined
          ? await createLocalClassifier(models, getClassifierModelSetting(settings)) : { warnings: [] };
        const baseRuntime = options.runtimeFactory?.(runtimeRequest) ?? new HostAgentRuntime(cwd, {
          ...runtimeRequest, logger: (options.createLogger ?? createLocalAgentLogger)(runtimeRequest.agentStorageRoot),
          ...('classifier' in classifier && classifier.classifier ? { classifier: classifier.classifier } : {}),
        });
        const runtime = options.wrapRuntime?.(baseRuntime, runtimeRequest) ?? baseRuntime;
        const skillPaths = getLocalSkillPaths(cwd, options.homeDir);
        const dynamicThinking = request.thinkingLevel === undefined && getDynamicThinkingEnabled(settings);
        const bindings = await request.services.extensions.bind({
          runtime, modelRuntime: models, settingsManager: settings, sessionManager, resources: request.resources,
          rootSessionId, policy: effectivePolicy(request, originalPolicy), extensionPackages: packages, source: request.source ?? 'headless',
          extensionConfigs, extensionConfigOverrides, scopedModels: modelScope.scopedModels, skillPaths,
          classifier: runtime.classifier, dynamicThinking,
        });
        currentRuntime = runtime;
        currentBindings = bindings;
        releaseUi = bindings.disposeUi;
        let bindingDisposal: Promise<void> | undefined;
        releaseBindings = async () => {
          bindingDisposal ??= bindings.dispose().catch(error => { bindingDisposal = undefined; throw error; });
          await bindingDisposal;
        };
        if (packages.includes('@felan-ai/ext-codex') && bindings.wrapStreamFunction === undefined) {
          throw new Error('Codex execution bindings must supply their stream wrapper');
        }
        const boundPaths = [...extensionPaths, ...(bindings.extensionPaths ?? [])];
        if (boundPaths.length && (request.source !== 'tui' || request.parentSessionId !== undefined)) {
          throw new Error('External extensions require a trusted root TUI session');
        }
        for (const path of boundPaths) assertAbsolutePath(path);
        diagnostics = [...(resourceWarnings.get(request.resources) ?? []), ...processWarnings,
          ...modelScope.diagnostics, ...[...config.warnings, ...classifier.warnings].map(message => ({ type: 'warning' as const, message }))];
        const codemode = createLocalCodemodeExtension(getLocalCodemodeMode(settings));
        const append = await loadLocalAppendSystemPrompt(request.resources.agentDir);
        return {
          runtime, modelRuntime: models, settingsManager: settings, extensionPackages: packages,
          importExtension: bindings.importExtension,
          ...(boundPaths.length ? { extensionPaths: [...new Set(boundPaths)] } : {}),
          extensionConfigOverrides,
          inlineExtensions: [...(codemode ? [codemode] : []), ...(bindings.inlineExtensions ?? [])],
          skillPaths, themePaths: [],
          ...(append ? { appendSystemPrompt: [append] } : {}),
          ...(bindings.savings ? { savings: bindings.savings } : {}),
          ...(bindings.wrapStreamFunction ? { wrapStreamFunction: bindings.wrapStreamFunction } : {}),
          ...(modelScope.scopedModels.length ? { scopedModels: modelScope.scopedModels } : {}),
          ...(request.model ? { model: request.model } : {}),
          ...(request.thinkingLevel ? { thinkingLevel: request.thinkingLevel } : dynamicThinking ? { dynamicThinking: true } : {}),
        };
      });
      const releaseDefaults = await acquireFelanModelDefaults();
      try {
        const factory: typeof coreFactory = async creation => {
          const result = await coreFactory(creation);
          createdSession = result.session;
          const bindings = currentBindings;
          let activation: Promise<void> | undefined;
          activateSession = () => activation ??= (async () => {
            await bindings?.onSession?.(result.session);
            await result.session.bindExtensions({ mode: 'print', ...(bindings?.uiContext ? { uiContext: bindings.uiContext } : {}) });
          })();
          if (!options.deferActivation) await activateSession();
          const settingsErrors = result.services.settingsManager.drainErrors();
          return { ...result, diagnostics: [
            { type: 'info', message: `Agent Core version: ${AGENT_CORE_VERSION}` }, ...result.diagnostics, ...diagnostics,
            ...settingsErrors.map(({ scope, error }) => ({ type: 'warning' as const, message: `${scope} settings: ${error.message}` })),
          ] };
        };
        const runtime = await createAgentSessionRuntime(factory, { cwd: request.resources.cwd, agentDir: request.resources.agentDir, sessionManager: manager });
        const rejectReplacement = async (): Promise<never> => { throw new Error('Daemon session replacement requires profile.openSession'); };
        runtime.newSession = rejectReplacement;
        runtime.switchSession = rejectReplacement;
        runtime.fork = rejectReplacement;
        runtime.importFromJsonl = rejectReplacement;
        const tools = TrustedToolCatalog.fromSession(runtime.session, activePackages);
        const dispose = runtime.dispose.bind(runtime);
        let released = false;
        let disposing: Promise<void> | undefined;
        runtime.dispose = () => {
          if (released) return Promise.resolve();
          disposing ??= (async () => {
            await releaseBindings?.();
            await dispose();
            releaseUi?.();
            released = true;
            releaseDefaults();
          })().catch(error => { disposing = undefined; throw error; });
          return disposing;
        };
        return {
          runtime, get agentRuntime() { return currentRuntime!; }, sessionId, rootSessionId,
          ...(request.parentSessionId === undefined ? {} : { parentSessionId: request.parentSessionId }),
          resources: request.resources, diagnostics: runtime.diagnostics, tools, toolProvenance: tools.provenance,
          ...(options.deferActivation ? { activate: async () => {
            if (released) throw new Error('Session binding is disposed.');
            await activateSession!();
          } } : {}),
        } satisfies ProfileSessionBinding;
      } catch (error) {
        try {
          await releaseBindings?.();
          createdSession?.dispose();
        } catch (cleanupError) {
          throw new AggregateError([error, cleanupError], 'Daemon session setup cleanup failed');
        } finally { releaseUi?.(); releaseDefaults(); }
        throw error;
      }
    },
    async dispose() { disposed = true; },
  };
}

function effectivePolicy(request: ProfileOpenRequest, original: SessionExecutionPolicy): SessionExecutionPolicy {
  const policy = inheritExecutionPolicy(request.services.getExecutionPolicy());
  if (policy.generation < original.generation
    || (original.mode === 'acp-strict' && policy.mode !== 'acp-strict')
    || (original.pendingTightening && !policy.pendingTightening && policy.mode !== 'acp-strict')) {
    throw new Error('Daemon execution policy cannot be weakened');
  }
  return policy;
}

const MAX_IMPORTED_SESSION_BYTES = 64 * 1024 * 1024;
const MAX_SESSION_HEADER_BYTES = 64 * 1024;

interface ResolvedProfileTarget {
  readonly identity: ProfileTargetIdentity;
  readonly sourceCwd?: string;
}

async function resolveTarget(request: ProfileOpenRequest): Promise<ResolvedProfileTarget> {
  const { target, resources } = request;
  if (target.kind === 'new') return { identity: { kind: target.kind, destinationDirectory: resources.sessionDir } };
  const file = await ownedSessionFile('sourceSessionFile' in target ? target.sourceSessionFile : target.sessionFile, resources.sessionDir);
  if (target.kind === 'import' && (await stat(file)).size > MAX_IMPORTED_SESSION_BYTES) {
    throw new Error('Imported session exceeds the 64 MiB limit');
  }
  const handle = await open(file, 'r');
  let header: unknown;
  try {
    const buffer = Buffer.alloc(MAX_SESSION_HEADER_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const newline = buffer.subarray(0, bytesRead).indexOf(10);
    if (newline === -1 && bytesRead === buffer.length) throw new Error('Session header exceeds the 64 KiB limit');
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, newline === -1 ? bytesRead : newline));
      header = JSON.parse(text.trim());
    } catch { throw new Error('Invalid session header'); }
  } finally { await handle.close(); }
  if (typeof header !== 'object' || header === null || Reflect.get(header, 'type') !== 'session') throw new Error('Invalid session header');
  const id: unknown = Reflect.get(header, 'id');
  const cwd: unknown = Reflect.get(header, 'cwd');
  if (typeof id !== 'string' || id.length === 0 || Buffer.byteLength(id) > 128 || typeof cwd !== 'string') throw new Error('Invalid session header');
  assertAbsolutePath(cwd);
  const sourceCwd = await canonicalPath(cwd);
  if ((target.kind === 'resume' || target.kind === 'fork') && sourceCwd !== resources.cwd) {
    throw new Error('Session cwd does not match the persisted session');
  }
  if (target.kind === 'fork' && target.position !== 'at' && target.position !== 'before') throw new Error('Invalid fork position');
  return { identity: { kind: target.kind, destinationDirectory: resources.sessionDir, sourceSessionFile: file, sourceSessionId: id }, sourceCwd };
}

function assertTargetUnchanged(before: ResolvedProfileTarget, after: ResolvedProfileTarget): void {
  if (before.identity.kind !== after.identity.kind
    || before.identity.destinationDirectory !== after.identity.destinationDirectory
    || before.identity.sourceSessionFile !== after.identity.sourceSessionFile
    || before.identity.sourceSessionId !== after.identity.sourceSessionId
    || before.sourceCwd !== after.sourceCwd) {
    throw new Error('Session source identity changed while acquiring ownership');
  }
}

async function assertSessionManagerMatches(manager: SessionManager, cwd: string, sessionId?: string): Promise<void> {
  if (await canonicalPath(manager.getCwd()) !== cwd || (sessionId !== undefined && manager.getSessionId() !== sessionId)) {
    throw new Error('Loaded session does not match its validated identity');
  }
}

async function openSessionManager(request: ProfileOpenRequest, resolved: ResolvedProfileTarget): Promise<SessionManager> {
  const { target, resources } = request;
  if (target.kind === 'new') return SessionManager.create(resources.cwd, resources.sessionDir);
  const file = resolved.identity.sourceSessionFile!;
  if (target.kind === 'resume' || target.kind === 'fork') {
    const manager = SessionManager.open(file, resources.sessionDir);
    await assertSessionManagerMatches(manager, resolved.sourceCwd!, resolved.identity.sourceSessionId);
    if (target.kind === 'resume') return manager;
    const entry = manager.getEntry(target.entryId);
    if (!entry || (target.position === 'before' && (entry.type !== 'message' || entry.message.role !== 'user'))) throw new Error('Invalid entry ID for forking');
    const leaf = target.position === 'at' ? entry.id : entry.parentId;
    if (leaf) manager.createBranchedSession(leaf);
    else {
      const empty = SessionManager.create(resources.cwd, resources.sessionDir);
      empty.newSession({ parentSession: file });
      return empty;
    }
    return manager;
  }
  return SessionManager.forkFrom(file, resources.cwd, resources.sessionDir);
}

async function ownedSessionFile(file: string, root: string): Promise<string> {
  assertAbsolutePath(file);
  const canonical = await realpath(file);
  const path = relative(root, canonical);
  if (path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path) || !(await stat(canonical)).isFile()) {
    throw new Error('Session file is outside the owned session directory');
  }
  return canonical;
}

function assertAbsolutePath(path: string): void {
  if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0') || Buffer.byteLength(path) > 4096) {
    throw new Error('Profile paths must be absolute, at most 4096 bytes and contain no NUL');
  }
}

async function canonicalPath(path: string): Promise<string> {
  try { return await realpath(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const parent = dirname(path);
    if (parent === path) throw error;
    return join(await canonicalPath(parent), basename(path));
  }
}

