import type { HostConfiguration, HostSetup } from './host-services.js';
import { registrySessionExecutions } from './session-services.js';
import { SessionsServiceError, type AgentSession, type ModelRuntime } from '@felan-ai/agent-core';
import { truncateTail } from '@earendil-works/pi-coding-agent';
import { LIMITS, parseOperationResult, type ClientEnvelope, type Operation, type OperationParams, type OperationResult, type Origin, type Response } from '@felan-ai/session-protocol';
import type { SessionRegistry } from './registry.js';
import type { LegacySession } from './legacy-sessions.js';
import type { AdmittedCommand, AdmissionOutcome } from './admission.js';
import { boundedText, digest } from './projection.js';
import { projectTreeEntries } from './tree.js';
import { prepareExport, prepareImport, publishExport, stageImport } from './session-files.js';
import { sha256 } from './persistence.js';
import { canonicalPath } from './profile-storage.js';
import { dirname, join } from 'node:path';

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
  configuration: HostConfiguration;
  models: Pick<ModelRuntime, 'getAvailable'>;
  setup?: HostSetup;
  prepareOpenInteraction?(id: string, client: string, signal: AbortSignal): () => Promise<void>;
  invalidated(revisions: Readonly<Record<string, number>>): void;
}

export class SessionCommands {
  readonly operations = new Set<Operation>(['sessions.list', 'sessions.create', 'close', 'prompt', 'steer', 'follow_up', 'cancel', 'set_model', 'set_thinking',
    'compact', 'fork', 'command.invoke', 'session.rename', 'session.tree', 'session.branch.select', 'session.entry.label', 'session.history', 'session.clone', 'shell.execute',
    'config.get', 'config.set', 'processes.list', 'processes.read', 'processes.write', 'processes.stop', 'executions.list', 'executions.read', 'executions.steer', 'executions.cancel',
    'session.delete', 'session.reload', 'session.import', 'session.export', 'ui.action']);
  constructor(private readonly options: CommandOptions) {
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
      case 'host.setup.answer': {
        if (!this.options.setup || !client) throw commandError('unavailable');
        await this.options.setup.answer(request.params.jobId, request.params.promptId, request.params.text, client);
        return accepted(request, {});
      }
      case 'host.setup.cancel': {
        if (!this.options.setup || !client) throw commandError('unavailable');
        this.options.setup.cancel(request.params.jobId, client);
        return accepted(request, {});
      }
      case 'sessions.list': {
        const previews = new Map<string, () => Promise<string>>(); const legacy = new Map<string, LegacySession>();
        const cwd = request.params.cwd === undefined ? undefined : await canonicalPath(request.params.cwd).catch(() => request.params.cwd!);
        const entries = [...registry.listed().map(row => {
          const entry = { session: row.id, root: row.root, ...(row.parent ? { parent: row.parent } : {}), cwd: row.cwd,
          revision: row.revision, state: row.state, residency: row.residency, title: row.title, ...(row.model ? { model: row.model } : {}), lastActivity: row.updatedAt, run: row.run, policy: row.policy };
          previews.set(row.id, () => registry.preview(row)); return entry;
        }), ...(request.params.root ? [] : await registry.legacySessions(cwd)).map(row => {
          legacy.set(row.id, row);
          return { session: row.id, root: row.id, cwd: row.cwd, revision: 0, state: 'open' as const, residency: 'evicted' as const, title: '',
            lastActivity: row.modifiedAt, run: { state: 'idle' as const }, policy: { effective: 'host-default' as const, generation: 0 } };
        })]
          .filter(row => (!cwd || row.cwd === cwd) && (!request.params.root || row.root === request.params.root));
        const result = recentPage(entries, request.params, JSON.stringify(['sessions', request.params.cwd ?? null, request.params.root ?? null]));
        // Only the returned page pays for transcript reads.
        const page = await Promise.all(result.entries.map(async entry => {
          const row = legacy.get(entry.session);
          if (row) {
            const summary = await registry.legacySummary(row);
            return { ...entry, title: summary.title, ...(summary.preview ? { preview: summary.preview } : {}) };
          }
          const preview = await previews.get(entry.session)!();
          return preview ? { ...entry, preview } : entry;
        }));
        return accepted(request, { ...result, entries: page });
      }
      case 'config.get': {
        if (request.params.scope !== 'session') return accepted(request, await configuration.get(request.params.scope, request.session ? registry.binding(request.session)?.runtime.session.model : undefined));
        if (!request.session) throw commandError('invalid_request');
        return accepted(request, { ...await configuration.sessionValues(registry.options.store.session(request.session).profile?.extensionConfigOverrides ?? []), writable: true });
      }
      case 'executions.list': return accepted(request, await executionRequest(() => registrySessionExecutions(registry, request.session).executions(request.params)));
      case 'executions.read': return accepted(request, await executionRequest(() => registrySessionExecutions(registry, request.session).execution(request.params.executionId)));
      case 'session.history': {
        const projection = registry.projection(request.session); const snapshot = projection.snapshot();
        if (snapshot.revision !== request.params.revision || snapshot.branch !== request.params.branch) throw commandError('resync_required');
        return accepted(request, projection.history(request.params.cursor, request.params.revision, request.params.limit));
      }
      case 'session.tree': {
        const binding = registry.binding(request.session)!; const snapshot = registry.projection(request.session).snapshot(); const manager = binding.runtime.session.sessionManager;
        const entries = projectTreeEntries(manager);
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
    const localClient = 'attachment' in context.origin ? context.origin.attachment : undefined;
    switch (request.op) {
      case 'ui.action': {
        const execute = registry.prepareUiAction(request.session, request.params);
        command.assertDispatch();
        return { response: registry.mutateAdmitted(request.id, request.session, async ({ assertCurrent }) => {
          assertCurrent();
          await execute({ requestId: request.id, signal: context.signal ?? new AbortController().signal });
          assertCurrent();
        }).then(() => accepted(request, {})) };
      }
      case 'host.setup.start': {
        if (!localClient) throw commandError('forbidden');
        if (!this.options.setup) throw commandError('unavailable');
        this.options.setup.validateStart(request.params);
        return { response: command.dispatch(() => accepted(request, this.options.setup!.start(request.params, localClient))) };
      }
      case 'host.setup.open_link': {
        if (!localClient) throw commandError('forbidden');
        if (!this.options.setup) throw commandError('unavailable');
        const open = this.options.setup.prepareOpenLink(request.params.jobId, request.params.index, localClient);
        return { response: command.dispatch(open).then(() => accepted(request, {})) };
      }
      case 'host.open_interaction': {
        if (!localClient) throw commandError('forbidden');
        if (!this.options.prepareOpenInteraction || !context.signal) throw commandError('unavailable');
        const open = this.options.prepareOpenInteraction(request.params.interactionId, localClient, context.signal);
        return { response: command.dispatch(open).then(() => accepted(request, {})) };
      }
      case 'sessions.create': {
        const overrides = request.params.config && Object.keys(request.params.config).length ? configuration.sessionOverrides(request.params.config) : [];
        const model = request.params.model && await this.model(request.params.model);
        if (!request.params.model && !(await this.options.models.getAvailable()).length) throw commandError('authentication_required', 'No model is available. Log in with /login or configure a provider API key.');
        const resources = await registry.options.lifecycle.resolveResources({ cwd: request.params.cwd, ...(request.params.sessionDir ? { sessionDir: request.params.sessionDir } : {}) });
        if (context.rootPreparation && context.rootPreparation.cwd !== resources.cwd) throw commandError('target_mismatch');
        registry.assertClientSessionDirectory(resources);
        const extensionPaths = context.rootPreparation?.extensionPaths ?? request.params.extensions;
        if ((request.params.interactiveExtensions || extensionPaths?.length) && !localClient) throw commandError('forbidden');
        const creation = { interactiveExtensions: request.params.interactiveExtensions === true, cwd: resources.cwd, target: { kind: 'new' as const }, source: request.params.source, clientRoot: true as const,
          sessionDir: resources.sessionDir, ...(request.params.requirePolicy === 'acp-strict' ? { policy: { mode: 'acp-strict', generation: 0 } as const } : {}), ...(model ? { model } : {}),
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
          const stored = registry.options.store.session(request.session); const resources = registry.binding(request.session)?.resources;
          await registry.validateConfiguration({ cwd: resources?.cwd ?? stored.cwd, sessionDir: dirname(stored.piPath), target: { kind: 'resume', sessionFile: stored.piPath },
            policy: registry.getPolicy(request.session), extensionConfigOverrides: overrides }, resources);
          return { response: registry.configureAdmitted(request.id, request.session, { values: request.params.values, overrides }).then(() => accepted(request, {})) };
        }
        if (!localClient) throw commandError('forbidden');
        if (!(await configuration.get(request.params.scope)).writable) throw Object.assign(new Error('This configuration scope is read-only.'), { code: 'unavailable' });
        configuration.prepare(request.params.scope, request.params.values);
        return { response: command.dispatch(() => configuration.set(request.params.scope, request.params.values)).then(() => accepted(request, {})) };
      }
      case 'close': return { response: registry.closeAdmitted(request.id, request.session).then(() => accepted(request, {})) };
      case 'session.delete': return { response: registry.deleteAdmitted(request.id, request.session).then(() => accepted(request, {})) };
      case 'session.reload': return { response: registry.reloadAdmitted(request.id, request.session).then(() => accepted(request, {})) };
      case 'session.import': {
        const resources = await registry.options.lifecycle.resolveResources({ cwd: request.params.cwd });
        for (const root of resources.writableRoots) registry.options.owner.assertOwnsPath(root);
        registry.assertClientSessionDirectory(resources);
        const prepared = preflight(() => prepareImport(registry.options.owner, request.params.path));
        command.assertDispatch();
        return { response: command.dispatch(async () => {
          const staged = stageImport(registry.options.owner, resources.sessionDir, request.params.path, prepared);
          try {
            const binding = await registry.create({ cwd: resources.cwd, sessionDir: resources.sessionDir, target: { kind: 'import', sessionFile: staged.path },
              source: context.origin.kind === 'acp' ? 'acp' : context.origin.kind === 'headless' ? 'headless' : 'tui', clientRoot: true,
              ...(request.params.requirePolicy === 'acp-strict' ? { policy: { mode: 'acp-strict', generation: 0 } as const } : {}) });
            return accepted(request, { sessionId: binding.sessionId });
          } finally { staged.dispose(); }
        }) };
      }
      case 'session.export': {
        const managed = [registry.options.store.directory, registry.options.owner.target.runtimeDirectory, ...registry.options.store.snapshot().sessions.map(row => row.piPath)];
        const prepared = preflight(() => prepareExport(registry.options.owner, request.params.destination, managed));
        return { response: registry.mutateAdmitted(request.id, request.session, async ({ session, assertCurrent }) => {
          const destination = await publishExport(registry.options.owner,
            async path => { if (request.params.format === 'html') await session.exportToHtml(path); else await session.exportToJsonl(path); assertCurrent(); }, prepared);
          assertCurrent(); return accepted(request, { destination });
        }) };
      }
      case 'cancel': return { response: registry.cancelAdmitted(request.id, request.session, request.params.runId).then(() => accepted(request, {})) };
      case 'executions.steer': case 'executions.cancel': {
        const executions = registrySessionExecutions(registry, request.session);
        await executionRequest(() => executions.execution(request.params.executionId));
        return { response: registry.mutateAdmitted(request.id, request.session, async ({ assertCurrent }) => {
          if (request.op === 'executions.steer') await executionRequest(() => executions.steer(request.params.executionId, request.params.message));
          else await executionRequest(() => executions.cancel(request.params.executionId, request.params.reason));
          assertCurrent();
          return accepted(request, await executions.execution(request.params.executionId));
        }) };
      }
      case 'fork': return { response: forkSession(registry, request.id, request.session, request.params).then(value => accepted(request, value)) };
      case 'session.clone': return { response: registry.cloneAdmitted(request.id, request.session).then(binding => accepted(request, { sessionId: binding.sessionId })) };
      case 'shell.execute': {
        const settings = registry.binding(request.session)!.runtime.session.settingsManager;
        const prepared = registry.processes.prepareForeground(request.session, { shell: settings.getShellPath(), prefix: settings.getShellCommandPrefix() });
        let resolve!: (response: Response) => void; let reject!: (error: unknown) => void;
        const response = new Promise<Response>((done, fail) => { resolve = done; reject = fail; });
        // Like Pi, a shell command during an active run joins that run; its result is queued for the next turn.
        const active = registry.options.store.session(request.session).run;
        const joinsRun = ['running', 'waiting', 'cancelling'].includes(active.state) && active.id !== undefined;
        const execute = async (session: AgentSession) => {
          const { resourceId } = await registry.processes.startForeground(request.id, request.session, request.params, prepared);
          const projection = registry.projection(request.session);
          let revision = 0; let lastPublished = 0;
          let pendingOutput: string | undefined; let timer: ReturnType<typeof setTimeout> | undefined;
          const flushOutput = () => {
            timer = undefined;
            if (pendingOutput === undefined) return;
            let command = boundedText(request.params.command, 16_384);
            let retained = truncateTail(pendingOutput, { maxBytes: 16_384, maxLines: 2000 }).content;
            pendingOutput = undefined;
            lastPublished = Date.now();
            const frame = () => {
              const content = `$ ${command}\n${retained}`;
              const fence = '`'.repeat(Math.max(3, ...[...content.matchAll(/`+/gu)].map(match => match[0].length + 1)));
              return { id: resourceId, kind: 'document' as const, revision: revision + 1, title: 'Shell execution',
                hint: { id: 'shell.execution', version: '1.0.0' }, fallback: 'Shell command is running.', actions: [],
                markdown: `${fence}\n${content}\n${fence}`, data: { commandLength: command.length, excludeFromContext: !request.params.includeInContext } };
            };
            let value = frame();
            while (Buffer.byteLength(JSON.stringify(value)) > LIMITS.structuredBytes) {
              if (retained.length) {
                const points = [...retained];
                retained = points.slice(Math.ceil(points.length / 2)).join('');
              } else command = boundedText(command, Math.floor(Buffer.byteLength(command) / 2));
              value = frame();
            }
            revision++;
            try { projection.setPresentation(value); } catch {}
          };
          const publishOutput = (output: string) => {
            pendingOutput = output;
            const delay = Math.max(0, 100 - (Date.now() - lastPublished));
            if (!delay) {
              if (timer) clearTimeout(timer);
              flushOutput();
            } else timer ??= setTimeout(flushOutput, delay);
          };
          publishOutput('');
          resolve(accepted(request, { resourceId, runId: registry.options.store.session(request.session).run.id! }));
          try {
            const result = await registry.processes.waitForeground(request.session, resourceId, publishOutput);
            session.recordBashResult(request.params.command, result, { excludeFromContext: !request.params.includeInContext });
            projection.refresh();
          } finally {
            if (timer) clearTimeout(timer);
            pendingOutput = undefined;
            try { projection.setPresentation({ id: resourceId, remove: true }); } catch {}
          }
        };
        const work = joinsRun ? registry.mutateAdmitted(request.id, request.session, ({ session }) => execute(session))
          : registry.runAdmitted(request.id, request.session, context.origin, execute);
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
        if (!model || !(await session.modelRuntime.getAvailable()).some(candidate => candidate.provider === model.provider && candidate.id === model.id)) throw commandError('authentication_required', model ? `Model ${model.provider}/${model.id} is not available. Log in with /login or choose another model.` : 'No model is selected. Choose one with /model.');
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
        const target = registry.projection(request.session).snapshot().catalog.commands.find(item => item.name === request.params.name);
        if (!target) throw commandError('unavailable');
        const invoke = (session: AgentSession) => session.prompt(`/${request.params.name}${request.params.arguments ? ` ${request.params.arguments}` : ''}`, { source: 'rpc' });
        // Like Pi, extension commands execute immediately during an active run; skill commands still wait for it.
        const active = registry.options.store.session(request.session).run;
        if (target.kind === 'extension' && ['running', 'waiting', 'cancelling'].includes(active.state) && active.id !== undefined) {
          let started = false;
          const work = registry.mutateAdmitted(request.id, request.session, ({ session }) => { started = true; return invoke(session); });
          if (!started) return { response: work.then(() => { throw commandError('unavailable'); }) };
          void work.catch(() => {
            if (!registry.binding(request.session)) return;
            try { registry.projection(request.session).setPresentation({ id: 'run-error', kind: 'notification', level: 'error', text: 'Command failed. Inspect the session before retrying.' }); } catch {}
          });
          return { response: accepted(request, { runId: active.id, status: 'started' }) };
        }
        return this.start(request, context.origin, invoke);
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
    if (!available.length) throw commandError('authentication_required', 'No model is available. Log in with /login or configure a provider API key.');
    const model = available.find(model => model.provider === reference.provider && model.id === reference.id);
    if (!model || session && session.scopedModels.length && !session.scopedModels.some(item => item.model.provider === model.provider && item.model.id === model.id)) throw commandError('not_found', `Model ${reference.provider}/${reference.id} is not available.`);
    return model;
  }

  private assertRoot(session: string, root: string): void {
    if (this.options.registry.options.store.session(session).root !== root) throw commandError('forbidden');
  }
}

export function commandError(code: string, message = 'Operation unavailable or rejected.'): Error & { code: string } { return Object.assign(new Error(message), { code }); }
export function accepted(request: ClientEnvelope, value: unknown): Response {
  return { v: 1, re: request.id, outcome: 'accepted', result: parseOperationResult(request.op, value) };
}

function preflight<T>(prepare: () => T): T {
  try { return prepare(); }
  catch (error) {
    const code = (error as { code?: unknown })?.code;
    if (code === undefined || ['ENOENT', 'ENOTDIR', 'EISDIR', 'ELOOP', 'EACCES'].includes(String(code))) throw commandError('invalid_request', error instanceof Error ? error.message : undefined);
    throw error;
  }
}

/** Newest activity first, then session ID. The cursor holds the last row's position, so rows that vanish or move do not break paging. */
function recentPage<T extends { session: string; lastActivity: number }>(values: readonly T[], params: { cursor?: string; limit?: number }, scope: string) {
  const entries = [...values].sort((a, b) => b.lastActivity - a.lastActivity || (a.session < b.session ? -1 : a.session > b.session ? 1 : 0));
  let start = 0;
  if (params.cursor) {
    let token: unknown;
    try { token = JSON.parse(Buffer.from(params.cursor, 'base64url').toString('utf8')); } catch { throw commandError('resync_required'); }
    if (!Array.isArray(token) || token.length !== 3 || token[0] !== scope || !Number.isSafeInteger(token[1]) || typeof token[2] !== 'string') throw commandError('resync_required');
    const [, activity, session] = token as [string, number, string];
    const at = entries.findIndex(entry => entry.lastActivity < activity || (entry.lastActivity === activity && entry.session > session));
    start = at < 0 ? entries.length : at;
  }
  const result: T[] = []; let size = 0; let end = start;
  while (end < entries.length && result.length < (params.limit ?? LIMITS.pageEntries)) {
    const entry = entries[end]!; const bytes = Buffer.byteLength(JSON.stringify(entry));
    if (size + bytes > LIMITS.pageBytes / 2) { if (!result.length) throw commandError('unavailable'); break; }
    result.push(entry); size += bytes; end++;
  }
  const last = result[result.length - 1];
  return { entries: result, ...(end < entries.length && last ? { cursor: Buffer.from(JSON.stringify([scope, last.lastActivity, last.session])).toString('base64url') } : {}) };
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

async function executionRequest<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); }
  catch (error) {
    if (!(error instanceof SessionsServiceError)) throw error;
    throw commandError(error.code === 'stale' ? 'resync_required' : error.code === 'inaccessible' ? 'forbidden'
      : error.code === 'unsupported' ? 'unavailable' : 'invalid_request');
  }
}
