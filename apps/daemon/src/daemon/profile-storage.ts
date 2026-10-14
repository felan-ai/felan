import { open, realpath, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { SessionManager, createAgentCoreSessionRuntimeFactory, createAgentSessionRuntime } from '@felan-ai/agent-core';
import { createRuntimeStorageRequest } from '../runtime-factory.js';
import { TrustedToolCatalog } from './execution-policy.js';
import type { SessionLifecycleOptions } from './session-lifecycle.js';
import type { SessionOpenRequest, SessionBinding, SessionTargetIdentity } from './session-lifecycle-contracts.js';

const MAX_SESSION_HEADER_BYTES = 64 * 1024;

export interface ResolvedProfileTarget {
  readonly identity: SessionTargetIdentity;
  readonly sourceCwd?: string;
}

export async function resolveTarget(request: SessionOpenRequest): Promise<ResolvedProfileTarget> {
  const { target, resources } = request;
  if (target.kind === 'new') return { identity: { kind: target.kind, destinationDirectory: resources.sessionDir } };
  const file = await sessionFile('sourceSessionFile' in target ? target.sourceSessionFile : target.sessionFile, resources.sessionDir);
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
  if (target.kind === 'fork' && target.position !== 'at' && target.position !== 'before') throw new Error('Invalid fork position');
  return { identity: { kind: target.kind, destinationDirectory: resources.sessionDir, sourceSessionFile: file, sourceSessionId: id }, sourceCwd };
}

export function assertTargetUnchanged(before: ResolvedProfileTarget, after: ResolvedProfileTarget): void {
  if (before.identity.kind !== after.identity.kind
    || before.identity.destinationDirectory !== after.identity.destinationDirectory
    || before.identity.sourceSessionFile !== after.identity.sourceSessionFile
    || before.identity.sourceSessionId !== after.identity.sourceSessionId
    || before.sourceCwd !== after.sourceCwd) {
    throw new Error('Session source identity changed while acquiring ownership');
  }
}

export function assertSessionManagerMatches(manager: SessionManager, sessionId?: string): void {
  if (sessionId !== undefined && manager.getSessionId() !== sessionId) {
    throw new Error('Loaded session does not match its validated identity');
  }
}

export async function openSessionManager(request: SessionOpenRequest, resolved: ResolvedProfileTarget): Promise<SessionManager> {
  const { target, resources } = request;
  if (request.worker) {
    if (target.kind !== 'resume' || request.worker.sessionManager.getSessionFile() !== resolved.identity.sourceSessionFile) {
      throw new Error('Worker transcript identity changed.');
    }
    return request.worker.sessionManager;
  }
  if (target.kind === 'new') return SessionManager.create(resources.cwd, resources.sessionDir, target.id ? { id: target.id } : undefined);
  const file = resolved.identity.sourceSessionFile!;
  if (target.kind === 'resume' || target.kind === 'fork') {
    // The resolved cwd is canonical; a header written under a symlinked project path names the same directory.
    const manager = SessionManager.open(file, resources.sessionDir, resources.cwd);
    assertSessionManagerMatches(manager, resolved.identity.sourceSessionId);
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

export async function createWorkerBinding(request: SessionOpenRequest, manager: SessionManager, options: Pick<SessionLifecycleOptions, 'wrapRuntime' | 'composition'>): Promise<SessionBinding> {
  const worker = request.worker!;
  if (!request.parentSessionId || !request.rootSessionId) throw new Error('Worker requires a registered parent scope.');
  const runtimeRequest = createRuntimeStorageRequest(request.resources.cwd, request.resources.agentDir, request.rootSessionId);
  const runtime = options.wrapRuntime?.(worker.runtime, runtimeRequest) ?? worker.runtime;
  const factory = createAgentCoreSessionRuntimeFactory(async () => ({ runtime, modelRuntime: worker.modelRuntime,
    settingsManager: worker.settingsManager, model: worker.model,
    ...(worker.thinkingLevel === undefined ? {} : { thinkingLevel: worker.thinkingLevel }),
    extensionPackages: [], importExtension: async () => { throw new Error('Worker extension discovery is disabled.'); },
    ...(worker.customTools === undefined ? {} : { customTools: worker.customTools }),
    ...(worker.appendSystemPrompt === undefined ? {} : { appendSystemPrompt: worker.appendSystemPrompt }),
  }));
  const created = await createAgentSessionRuntime(factory, { cwd: request.resources.cwd, agentDir: request.resources.agentDir, sessionManager: manager });
  const tools = TrustedToolCatalog.fromSession(created.session, options.composition.toolPolicy);
  return {
    runtime: created, agentRuntime: runtime, sessionId: manager.getSessionId(), rootSessionId: request.rootSessionId,
    parentSessionId: request.parentSessionId, resources: request.resources, diagnostics: created.diagnostics,
    tools, toolProvenance: tools.provenance,
    activate: async () => {
      await created.session.bindExtensions({ mode: 'print' });
      created.session.setActiveToolsByName([...worker.allowedTools]);
      const actual = created.session.getActiveToolNames();
      if (actual.length !== worker.allowedTools.length || actual.some(name => !worker.allowedTools.includes(name))) {
        throw new Error('Worker tool restrictions could not be installed.');
      }
    },
  };
}

// A transcript linked from elsewhere (for example a symlinked dotfile store) keeps its listed path.
async function sessionFile(file: string, root: string): Promise<string> {
  assertAbsolutePath(file);
  const canonical = await realpath(file);
  if (!(await stat(canonical)).isFile()) throw new Error('Session file is not a regular file');
  const path = relative(root, canonical);
  return path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path) ? file : canonical;
}

export function assertAbsolutePath(path: string): void {
  if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0') || Buffer.byteLength(path) > 4096) {
    throw new Error('Profile paths must be absolute, at most 4096 bytes and contain no NUL');
  }
}

export async function canonicalPath(path: string): Promise<string> {
  try { return await realpath(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const parent = dirname(path);
    if (parent === path) throw error;
    return join(await canonicalPath(parent), basename(path));
  }
}

