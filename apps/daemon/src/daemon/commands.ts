import type { AgentSession, ModelRuntime } from '@felan-ai/agent-core';
import { LIMITS, parseOperationResult, type ClientEnvelope, type Operation, type OperationParams, type OperationResult, type Origin, type Response } from '@felan-ai/session-protocol';
import type { SessionRegistry } from './registry.js';
import type { AdmittedCommand, AdmissionOutcome } from './admission.js';
import type { DaemonConfiguration } from './configuration.js';
import { boundedText, digest } from './projection.js';
import { agentSummary } from './agent-view.js';
import { prepareExport, prepareImport, publishExport, stageImport } from './session-files.js';
import { sha256 } from './persistence.js';
import { join } from 'node:path';
import type { DaemonTuiPreferences } from './tui-preferences.js';
import type { HostSetupManager } from '../setup/manager.js';

export async function forkSession(
  registry: SessionRegistry,
  requestId: string,
  session: string,
  params: OperationParams<'fork'>,
): Promise<OperationResult<'fork'>> {
  const binding = await registry.forkAdmitted(requestId, session, params.from);
  return { sessionId: binding.sessionId };
}

export interface RootPreparation { cwd: string; extensionPaths: readonly string[] }
export interface CommandContext { origin: Origin; signal?: AbortSignal; rootPreparation?: RootPreparation; invalidateAfterResponse?(revisions: Readonly<Record<string, number>>): void }
export interface CommandOptions {
  registry: SessionRegistry;
  configuration: DaemonConfiguration;
  models: Pick<ModelRuntime, 'getAvailable'>;
  preferences?: DaemonTuiPreferences;
  setup?: HostSetupManager;
  prepareOpenInteraction?(id: string, client: string, signal: AbortSignal): () => Promise<void>;
  invalidated(revisions: Readonly<Record<string, number>>): void;
}

export class SessionCommands {
  readonly operations = new Set<Operation>(['sessions.list', 'sessions.create', 'close', 'prompt', 'steer', 'follow_up', 'cancel', 'set_model', 'set_thinking',
    'compact', 'fork', 'command.invoke', 'session.rename', 'session.tree', 'session.branch.select', 'session.entry.label', 'session.history', 'session.clone', 'shell.execute',
    'config.get', 'config.set', 'processes.list', 'processes.read', 'processes.write', 'processes.stop', 'agents.list', 'agents.read', 'agents.steer', 'agents.cancel',
    'session.adopt', 'session.delete', 'session.reload', 'session.import', 'session.export']);
  constructor(private readonly options: CommandOptions) {
    if (options.preferences) { this.operations.add('tui.preferences.get'); this.operations.add('tui.preferences.set'); }
    if (options.setup) for (const op of ['host.setup.catalog', 'host.setup.start', 'host.setup.read', 'host.setup.answer', 'host.setup.cancel', 'host.setup.open_link'] as const) this.operations.add(op);
    if (options.prepareOpenInteraction) this.operations.add('host.open_interaction');
  }

  async read(request: ClientEnvelope, client?: string): Promise<Response> {
    const { registry, configuration } = this.options;
    switch (request.op) {
      case 'host.setup.catalog': {
        if (!this.options.setup) throw commandError('unavailable');
        return accepted(request, await this.options.setup.catalog());
      }
      case 'host.setup.read': {
        if (!this.options.setup || !client) throw commandError('unavailable');
        return accepted(request, this.options.setup.read(request.params.jobId, client));
      }
      case 'tui.preferences.get': {
        if (!this.options.preferences) throw commandError('unavailable');
        return accepted(request, await this.options.preferences.get());
      }
      case 'sessions.list': {
        const legacy = await registry.legacyInventory(request.params);
        const keys = new WeakMap<object, string>();
        const entries = [...registry.list().map(row => {
          const entry = { session: row.id, root: row.root, ...(row.parent ? { parent: row.parent } : {}), cwd: row.cwd,
          adoption: 'adopted', revision: row.revision, state: row.state, residency: row.residency, title: row.title, ...(row.model ? { model: row.model } : {}), lastActivity: row.updatedAt, run: row.run, policy: row.policy };
          keys.set(entry, JSON.stringify([row.id, 'adopted'])); return entry;
        }), ...legacy.entries.map(row => {
          const entry = { session: row.session, root: row.session, cwd: row.cwd, ...(row.fingerprint ? { sourceFingerprint: row.fingerprint } : {}), adoption: 'legacy', state: 'closed', residency: 'evicted',
          title: 'Legacy session', lastActivity: 0, run: { state: 'idle' }, policy: { effective: 'host-default', generation: 0 } };
          keys.set(entry, JSON.stringify([row.session, 'legacy', sha256(row.source)])); return entry;
        })]
          .filter(row => (!request.params.cwd || row.cwd === request.params.cwd) && (!request.params.root || row.root === request.params.root));
        return accepted(request, { ...keysetPage(entries, request.params, JSON.stringify(['sessions', request.params.cwd ?? null, request.params.root ?? null]), row => keys.get(row)!),
          inventory: { complete: legacy.complete, diagnostics: legacy.diagnostics } });
      }
      case 'config.get': {
        if (request.params.scope !== 'session') return accepted(request, await configuration.get(request.params.scope));
        if (!request.session) throw commandError('invalid_request');
        return accepted(request, await configuration.sessionValues(registry.options.store.session(request.session).profile?.extensionConfigOverrides ?? []));
      }
      case 'agents.list': {
        const rows = registry.subagentView(request.session).listLocalSubagents().map(agentSummary);
        const generation = digest(rows);
        return accepted(request, { generation, ...keysetPage(rows, request.params, JSON.stringify(['agents', request.session, generation]), row => JSON.stringify([row.createdAt, row.agentId])) });
      }
      case 'agents.read': {
        const row = registry.subagentView(request.session).getLocalSubagent(request.params.agentId);
        if (!row) throw commandError('not_found');
        return accepted(request, { agent: agentSummary(row), ...(row.result === undefined ? {} : { result: row.result }) });
      }
      case 'session.history': {
        const projection = registry.projection(request.session); const snapshot = projection.snapshot();
        if (snapshot.revision !== request.params.revision || snapshot.branch !== request.params.branch) throw commandError('resync_required');
        return accepted(request, projection.history(request.params.cursor, request.params.revision, request.params.limit));
      }
      case 'session.tree': {
        const binding = registry.binding(request.session)!; const snapshot = registry.projection(request.session).snapshot(); const manager = binding.runtime.session.sessionManager;
        const entries = manager.getEntries().map(entry => ({ id: entry.id, ...(entry.parentId ? { parent: entry.parentId } : {}), kind: entry.type,
          ...(entry.type === 'message' ? { role: entry.message.role } : {}),
          ...(manager.getLabel(entry.id) ? { label: manager.getLabel(entry.id) } : {}), summary: boundedText(entry.type === 'message' && 'content' in entry.message
            ? typeof entry.message.content === 'string' ? entry.message.content : entry.message.content.filter(part => part.type === 'text').map(part => part.text).join('\n') : entry.type,
          16384), timestamp: Math.max(0, Date.parse(entry.timestamp) || 0) }));
        return accepted(request, { revision: snapshot.revision, branch: snapshot.branch,
          ...page(entries, request.params, `tree:${request.session}:${snapshot.revision}:${snapshot.branch}`) });
      }
      case 'processes.list': {
        this.assertRoot(request.session, request.params.root);
        return accepted(request, keysetPage(registry.processes.list(request.params.root), request.params, JSON.stringify(['processes', request.params.root]), row => row.id));
      }
      case 'processes.read': {
        this.assertRoot(request.session, request.params.root);
        const value = await registry.processes.read(request.session, request.params.resourceId, request.params.offset, request.params.limit);
        return accepted(request, { resourceId: request.params.resourceId, ...value, data: Buffer.from(value.data).toString('base64') });
      }
      default: throw commandError('unavailable');
    }
  }

  async prepare(command: AdmittedCommand, context: CommandContext): Promise<AdmissionOutcome> {
    const { request } = command; const { registry, configuration } = this.options;
    const localTui = context.origin.kind === 'tui' ? context.origin.attachment : undefined;
    switch (request.op) {
      case 'host.setup.start': {
        if (!localTui) throw commandError('forbidden');
        if (!this.options.setup) throw commandError('unavailable');
        this.options.setup.validateStart(request.params);
        return { response: command.dispatch(() => accepted(request, this.options.setup!.start(request.params, localTui))) };
      }
      case 'host.setup.open_link': {
        if (!localTui) throw commandError('forbidden');
        if (!this.options.setup) throw commandError('unavailable');
        const open = this.options.setup.prepareOpenLink(request.params.jobId, request.params.index, localTui);
        return { response: command.dispatch(open).then(() => accepted(request, {})) };
      }
      case 'host.open_interaction': {
        if (!localTui) throw commandError('forbidden');
        if (!this.options.prepareOpenInteraction || !context.signal) throw commandError('unavailable');
        const open = this.options.prepareOpenInteraction(request.params.interactionId, localTui, context.signal);
        return { response: command.dispatch(open).then(() => accepted(request, {})) };
      }
      case 'tui.preferences.set': {
        if (!localTui) throw commandError('forbidden');
        if (!this.options.preferences) throw commandError('unavailable');
        return { response: command.dispatch(() => this.options.preferences!.set(request.params.values)).then(() => accepted(request, {})) };
      }
      case 'sessions.create': {
        const overrides = request.params.config && Object.keys(request.params.config).length ? configuration.sessionOverrides(request.params.config) : [];
        const model = request.params.model && await this.model(request.params.model);
        if (!request.params.model && !(await this.options.models.getAvailable()).length) throw commandError('authentication_required');
        const resources = await registry.options.profile.resolveResources({ cwd: request.params.cwd, ...(request.params.sessionDir ? { sessionDir: request.params.sessionDir } : {}) });
        if (context.rootPreparation && context.rootPreparation.cwd !== resources.cwd) throw commandError('target_mismatch');
        registry.assertClientSessionDirectory(resources);
        const extensionPaths = context.rootPreparation?.extensionPaths ?? request.params.extensions;
        const creation = { cwd: resources.cwd, target: { kind: 'new' as const }, source: request.params.source, clientRoot: true as const,
          sessionDir: resources.sessionDir, ...(context.origin.kind === 'acp' ? { policy: { mode: 'acp-strict', pendingTightening: false, generation: 0 } as const } : {}), ...(model ? { model } : {}),
          ...(request.params.thinking ? { thinkingLevel: request.params.thinking } : {}), ...(extensionPaths ? { extensionPaths } : {}),
          ...(overrides.length ? { extensionConfigOverrides: overrides } : {}) };
        await registry.validateConfiguration(creation, resources);
        command.assertDispatch();
        const work = command.dispatch(() => registry.create(creation));
        return { response: work.then(binding => accepted(request, { sessionId: binding.sessionId })) };
      }
      case 'config.set': {
        if (request.params.scope === 'session') {
          if (!request.session) throw commandError('invalid_request');
          const overrides = configuration.sessionOverrides(request.params.values, registry.options.store.session(request.session).profile?.extensionConfigOverrides ?? []);
          const binding = registry.binding(request.session)!;
          await registry.validateConfiguration({ cwd: binding.resources.cwd, target: { kind: 'resume', sessionFile: registry.options.store.session(request.session).piPath },
            policy: registry.getPolicy(request.session), extensionConfigOverrides: overrides }, binding.resources);
          return { response: registry.reloadAdmitted(request.id, request.session, { values: request.params.values, overrides }).then(() => accepted(request, {})) };
        }
        if (request.params.scope !== 'global') throw commandError('unavailable');
        configuration.prepare(request.params.scope, request.params.values);
        return { response: command.dispatch(() => configuration.set(request.params.scope, request.params.values)).then(() => accepted(request, {})) };
      }
      case 'close': return { response: registry.closeAdmitted(request.id, request.session).then(() => accepted(request, {})) };
      case 'session.delete': return { response: registry.deleteAdmitted(request.id, request.session, request.params.expectedRevision).then(() => accepted(request, {})) };
      case 'session.reload': return { response: registry.reloadAdmitted(request.id, request.session).then(() => accepted(request, {})) };
      case 'session.adopt': {
        const inventory = await registry.legacyInventory({ root: request.session });
        const matches = inventory.entries.filter(row => row.session === request.session);
        const registered = registry.options.store.snapshot().adoptions.find(row => row.session === request.session && row.phase === 'complete');
        if (matches.length > 1) throw commandError('request_conflict');
        if (!inventory.complete) throw commandError('adoption_required');
        const selected = matches[0] ?? (registered ? { session: registered.session, source: registered.source, cwd: registered.cwd, fingerprint: registered.fingerprint, bytes: 0 } : undefined);
        if (!selected) throw commandError('not_found');
        if (!selected.fingerprint || selected.bytes === undefined) throw commandError('adoption_required');
        try { await registry.options.profile.resolveResources({ cwd: selected.cwd }); }
        catch { throw commandError('adoption_required'); }
        command.assertDispatch();
        return { response: registry.adoptAdmitted(request.id, request.session, request.params, { ...selected, fingerprint: selected.fingerprint, bytes: selected.bytes }, inventory.directories).then(value => accepted(request, value)) };
      }
      case 'session.import': {
        const resources = await registry.options.profile.resolveResources({ cwd: request.params.cwd });
        for (const root of resources.writableRoots) registry.options.owner.assertOwnsPath(root);
        registry.assertClientSessionDirectory(resources);
        const state = registry.options.store.snapshot();
        const excluded = [...state.sessions.map(row => row.piPath), ...state.adoptions.map(row => row.destination), join(registry.options.owner.target.agentDir, 'adopted-sessions')];
        const prepared = preflight(() => prepareImport(registry.options.owner, request.params.path, excluded));
        command.assertDispatch();
        return { response: command.dispatch(async () => {
          const staged = stageImport(registry.options.owner, resources.sessionDir, request.params.path, excluded, prepared);
          try {
            const binding = await registry.create({ cwd: resources.cwd, sessionDir: resources.sessionDir, target: { kind: 'import', sessionFile: staged.path }, source: 'tui', clientRoot: true });
            return accepted(request, { sessionId: binding.sessionId });
          } finally { staged.dispose(); }
        }) };
      }
      case 'session.export': {
        const binding = registry.binding(request.session)!;
        const prepared = preflight(() => prepareExport(registry.options.owner, request.params.destination));
        return { response: registry.mutateAdmitted(request.id, request.session, async ({ session, assertCurrent }) => {
          const destination = await publishExport(registry.options.owner, binding.agentRuntime.storage('session').root, request.params.destination,
            async path => { if (request.params.format === 'html') await session.exportToHtml(path); else await session.exportToJsonl(path); assertCurrent(); }, prepared);
          assertCurrent(); return accepted(request, { destination });
        }) };
      }
      case 'cancel': return { response: registry.cancelAdmitted(request.id, request.session, request.params.runId).then(() => accepted(request, {})) };
      case 'agents.steer': case 'agents.cancel': {
        const host = registry.subagentView(request.session);
        if (!host.getLocalSubagent(request.params.agentId)) throw commandError('not_found');
        return { response: registry.mutateAdmitted(request.id, request.session, async ({ assertCurrent }) => {
          const result = request.op === 'agents.steer' ? await host.steer(request.params.agentId, request.params.message)
            : await host.cancel(request.params.agentId, request.params.reason);
          assertCurrent();
          return accepted(request, result.ok ? { ok: true, agent: agentSummary(host.getLocalSubagent(result.value.agentId) ?? result.value) }
            : { ok: false, error: result.error });
        }) };
      }
      case 'fork': return { response: forkSession(registry, request.id, request.session, request.params).then(value => accepted(request, value)) };
      case 'session.clone': return { response: registry.cloneAdmitted(request.id, request.session).then(binding => accepted(request, { sessionId: binding.sessionId })) };
      case 'shell.execute': {
        const settings = registry.binding(request.session)!.runtime.session.settingsManager;
        const prepared = registry.processes.prepareForeground(request.session, { shell: settings.getShellPath(), prefix: settings.getShellCommandPrefix() });
        let resolve!: (response: Response) => void; let reject!: (error: unknown) => void;
        const response = new Promise<Response>((done, fail) => { resolve = done; reject = fail; });
        const work = registry.runAdmitted(request.id, request.session, context.origin, async session => {
          const { resourceId } = await registry.processes.startForeground(request.id, request.session, request.params, prepared);
          resolve(accepted(request, { resourceId, runId: registry.options.store.session(request.session).run.id! }));
          const result = await registry.processes.waitForeground(request.session, resourceId);
          session.recordBashResult(request.params.command, result, { excludeFromContext: !request.params.includeInContext });
        });
        void work.catch(error => {
          reject(error);
          if (registry.binding(request.session)) {
            try { registry.projection(request.session).setPresentation({ id: 'shell-error', kind: 'notification', level: 'error', text: 'Shell execution failed. Inspect the process before retrying.' }); } catch {}
          }
        });
        return { response };
      }
      case 'prompt': {
        const session = registry.binding(request.session)!.runtime.session;
        const model = session.model;
        if (!model || !(await session.modelRuntime.getAvailable()).some(candidate => candidate.provider === model.provider && candidate.id === model.id)) throw commandError('authentication_required');
        return this.start(request, context.origin, session => {
          const input = promptInput(request.params);
          return session.prompt(input.text, { images: input.images, source: 'rpc', expandPromptTemplates: false });
        });
      }
      case 'compact': {
        if (request.params.method && request.params.method !== 'summary') throw commandError('unavailable');
        return this.start(request, context.origin, async session => { await session.compact(request.params.instructions); });
      }
      case 'command.invoke': {
        if (!registry.projection(request.session).snapshot().catalog.commands.some(item => item.name === request.params.name)) throw commandError('unavailable');
        return this.start(request, context.origin, session => session.prompt(`/${request.params.name}${request.params.arguments ? ` ${request.params.arguments}` : ''}`, { source: 'rpc' }));
      }
      case 'steer': case 'follow_up': {
        const projection = registry.projection(request.session);
        if (!projection.canObserveQueue) throw commandError('unavailable');
        const work = registry.mutateAdmitted(request.id, request.session, async ({ session, assertCurrent }) => {
          const input = promptInput(request.params);
          const result = await projection.withQueueOrigin(context.origin, () => request.op === 'steer'
            ? session.steer(input.text, input.images, { source: 'rpc' }) : session.followUp(input.text, input.images, { source: 'rpc' }));
          assertCurrent();
          if (result.value === 'handled') return { status: 'handled' as const };
          if (result.value !== 'queued' || result.ids.length !== 1) throw commandError('indeterminate');
          return { itemId: result.ids[0]! };
        });
        return { response: work.then(result => accepted(request, result)) };
      }
      case 'set_model': {
        const model = await this.model(request.params, registry.binding(request.session)!.runtime.session);
        if (!await registry.binding(request.session)!.runtime.session.modelRuntime.checkAuth(model.provider)) throw commandError('unavailable');
        command.assertDispatch();
        return this.mutate(request, async ({ session, assertCurrent }) => { await session.setModel(model, { persist: false }); assertCurrent(); });
      }
      case 'set_thinking': return this.mutate(request, async ({ session }) => { session.setThinkingLevel(request.params.thinking, { persist: false }); });
      case 'session.rename': return this.mutate(request, async ({ session }) => { session.setSessionName(request.params.name); });
      case 'session.entry.label': case 'session.branch.select': {
        const stored = registry.options.store.session(request.session);
        if (stored.revision !== request.params.expectedRevision) throw commandError('resync_required');
        const session = registry.binding(request.session)!.runtime.session;
        if (!session.sessionManager.getEntry(request.params.entryId)) throw commandError('not_found');
        return this.mutate(request, async ({ session, assertCurrent }) => {
          if (request.op === 'session.branch.select') {
            const result = await session.navigateTree(request.params.entryId, request.params.summarize === undefined ? {} : { summarize: request.params.summarize });
            assertCurrent(); if (result.cancelled) throw commandError('unavailable');
          } else {
            session.sessionManager.appendLabelChange(request.params.entryId, request.params.label);
            (context.invalidateAfterResponse ?? this.options.invalidated)({ [request.session]: registry.options.store.session(request.session).revision });
          }
        });
      }
      case 'processes.write': case 'processes.stop': {
        this.assertRoot(request.session, request.params.root);
        if (request.op === 'processes.write') registry.processes.assertWritable(request.session, request.params.resourceId);
        else await registry.processes.prepareStop(request.session, request.params.resourceId);
        command.assertDispatch();
        const work = registry.mutateAdmitted(request.id, request.session, async ({ assertCurrent }) => {
          if (request.op === 'processes.write') {
            const writtenBytes = await registry.processes.write(request.session, request.params.resourceId, Buffer.from(request.params.data, 'base64'));
            assertCurrent(); return { writtenBytes };
          }
          await registry.processes.stopForSession(request.session, request.params.resourceId, request.params.signal); assertCurrent(); return {};
        });
        return { response: work.then(value => accepted(request, value)) };
      }
      default: throw commandError('unavailable');
    }
  }

  private mutate(request: ClientEnvelope & { session: string }, effect: Parameters<SessionRegistry['mutateAdmitted']>[2]): AdmissionOutcome {
    return { response: this.options.registry.mutateAdmitted(request.id, request.session, effect).then(() => accepted(request, {})) };
  }

  private start(request: ClientEnvelope & { session: string }, origin: Origin, effect: (session: AgentSession) => Promise<unknown>): AdmissionOutcome {
    const { registry } = this.options;
    let started = false;
    const work = registry.runAdmitted(request.id, request.session, origin, session => { started = true; return effect(session); });
    if (!started) return { response: work.then(() => { throw commandError('unavailable'); }) };
    const runId = registry.options.store.session(request.session).run.id!;
    void work.catch(() => {
      if (!registry.binding(request.session)) return;
      try { registry.projection(request.session).setPresentation({ id: 'run-error', kind: 'notification', level: 'error', text: 'Run failed. Inspect the session before retrying.' }); } catch {}
    });
    return { response: accepted(request, request.op === 'command.invoke' ? { runId, status: 'started' } : { runId }) };
  }

  private async model(reference: OperationParams<'set_model'>, session?: AgentSession) {
    const available = await (session?.modelRuntime ?? this.options.models).getAvailable();
    if (!available.length) throw commandError('authentication_required');
    const model = available.find(model => model.provider === reference.provider && model.id === reference.id);
    if (!model || session && session.scopedModels.length && !session.scopedModels.some(item => item.model.provider === model.provider && item.model.id === model.id)) throw commandError('not_found');
    return model;
  }

  private assertRoot(session: string, root: string): void {
    if (this.options.registry.options.store.session(session).root !== root) throw commandError('forbidden');
  }
}

export function commandError(code: string): Error & { code: string } { return Object.assign(new Error('Operation unavailable or rejected.'), { code }); }
export function accepted(request: ClientEnvelope, value: unknown): Response {
  return { v: 1, re: request.id, outcome: 'accepted', result: parseOperationResult(request.op, value) };
}

function preflight<T>(prepare: () => T): T {
  try { return prepare(); }
  catch (error) {
    const code = (error as { code?: unknown })?.code;
    if (code === undefined || ['ENOENT', 'ENOTDIR', 'EISDIR', 'ELOOP', 'EACCES'].includes(String(code))) throw commandError('invalid_request');
    throw error;
  }
}

function keysetPage<T>(values: readonly T[], params: { cursor?: string; limit?: number }, scope: string, key: (entry: T) => string) {
  const entries = [...values].sort((a, b) => key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0);
  let start = 0;
  if (params.cursor) {
    let token: unknown;
    try { token = JSON.parse(Buffer.from(params.cursor, 'base64url').toString('utf8')); } catch { throw commandError('resync_required'); }
    if (!Array.isArray(token) || token.length !== 2 || token[0] !== scope || typeof token[1] !== 'string') throw commandError('resync_required');
    const at = entries.findIndex(entry => key(entry) === token[1]);
    if (at < 0) throw commandError('resync_required');
    start = at + 1;
  }
  const result: T[] = []; let size = 0; let end = start;
  while (end < entries.length && result.length < (params.limit ?? LIMITS.pageEntries)) {
    const entry = entries[end]!; const bytes = Buffer.byteLength(JSON.stringify(entry));
    if (size + bytes > LIMITS.pageBytes / 2) { if (!result.length) throw commandError('unavailable'); break; }
    result.push(entry); size += bytes; end++;
  }
  return { entries: result, ...(end < entries.length && result.length ? { cursor: Buffer.from(JSON.stringify([scope, key(result[result.length - 1]!)])).toString('base64url') } : {}) };
}

function page<T>(entries: readonly T[], params: { cursor?: string; limit?: number }, identity: string) {
  let start = 0;
  if (params.cursor) {
    let cursor: unknown;
    try { cursor = JSON.parse(Buffer.from(params.cursor, 'base64url').toString('utf8')); } catch { throw commandError('resync_required'); }
    if (!Array.isArray(cursor) || cursor.length !== 2 || cursor[0] !== identity || !Number.isSafeInteger(cursor[1]) || cursor[1] < 0 || cursor[1] > entries.length) throw commandError('resync_required');
    start = cursor[1];
  }
  const result: T[] = []; let bytes = 0; let end = start;
  while (end < entries.length && result.length < (params.limit ?? LIMITS.pageEntries)) {
    const row = entries[end]!; const size = Buffer.byteLength(JSON.stringify(row));
    if (bytes + size > LIMITS.pageBytes / 2) { if (!result.length) throw commandError('unavailable'); break; }
    result.push(row); bytes += size; end++;
  }
  return { entries: result, ...(end < entries.length ? { cursor: Buffer.from(JSON.stringify([identity, end])).toString('base64url') } : {}) };
}

function promptInput(prompt: OperationParams<'prompt'>) {
  const text = [prompt.text]; const images: NonNullable<Parameters<AgentSession['prompt']>[1]>['images'] = [];
  for (const part of prompt.attachments ?? []) {
    if (part.type === 'image') images.push({ type: 'image', data: part.data, mimeType: part.mimeType });
    else text.push(part.type === 'text' ? part.text : `${part.name ?? 'Resource'}: ${part.uri}${part.description ? `\n${part.description}` : ''}`);
  }
  return { text: text.join('\n'), images };
}
