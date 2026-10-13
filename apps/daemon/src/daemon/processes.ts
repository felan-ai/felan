import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { setImmediate as yieldTurn } from 'node:timers/promises';
import { stripVTControlCharacters } from 'node:util';
import { DEFAULT_MAX_BYTES, getShellConfig, truncateTail } from '@earendil-works/pi-coding-agent';
import type { AgentRuntime, AgentRuntimeProcess, AgentRuntimeStorage, AgentRuntimeTerminationSignal } from '@felan-ai/agent-core';
import { LIMITS, canonicalRequestPayload, type OperationParams, type Process as ProcessView } from '@felan-ai/session-protocol';
import type { DaemonControlStore } from './control-store.js';
import { CONTROL_LIMITS, type ControlResource } from './control-state.js';
import type { ProcessAdapter, ProcessRecord } from './process-adapter.js';
import { boundedText } from './projection.js';
import { readOwnedOutputRange } from './session-files.js';
import { pathInside } from './target.js';

interface Scope { session: string; root: string }
interface Lifetime { scope: Scope; runtime: AgentRuntime; draining: boolean; revoked: boolean }
interface LiveProcess { raw: AgentRuntimeProcess; process: AgentRuntimeProcess; view: ProcessView; transport: boolean; settled: boolean; disposed: boolean; signal?: AgentRuntimeTerminationSignal }
export interface ProcessTrackerOptions {
  store: DaemonControlStore;
  assertCurrent(): void;
  changed(session: string, process: ProcessView, revision: number): void;
  processAdapter?: ProcessAdapter;
  now?: () => number;
}
export interface RegistryProcessOutput {
  data: Uint8Array;
  offset: number;
  nextOffset: number;
  state: 'running' | 'exited' | 'missing' | 'interrupted';
  exitCode?: number;
}

export class RegistryProcesses {
  private readonly live = new Map<string, LiveProcess>();
  private readonly views = new Map<string, ProcessView>();
  private readonly lifetimes = new Set<Lifetime>();
  private readonly starting = new Set<string>();
  private readonly operations = new Map<Promise<unknown>, { scope: Scope; passive: boolean }>();
  private readonly foregroundId = new AsyncLocalStorage<string>();
  private readonly foregroundStarts = new Map<string, string>();
  private readonly cleanup = new AsyncLocalStorage<ReadonlySet<string>>();
  private readonly now: () => number;
  constructor(private readonly options: ProcessTrackerOptions) { this.now = options.now ?? Date.now; }

  wrap(runtime: AgentRuntime, scope: Scope): AgentRuntime {
    const storage = new Map<string, AgentRuntimeStorage>();
    const lifetime: Lifetime = { scope, runtime, draining: false, revoked: false };
    const current = () => this.assertLifetime(lifetime);
    const checked = <T>(operation: () => Promise<T>): Promise<T> => this.track((async () => {
      current(); const value = await operation(); this.options.assertCurrent(); return value;
    })(), scope);
    const wrapped: AgentRuntime = {
      kind: runtime.kind, cwd: runtime.cwd, logger: runtime.logger, ...(runtime.classifier ? { classifier: runtime.classifier } : {}),
      storage: (kind = 'session') => {
        let result = storage.get(kind);
        if (!result) {
          const original = runtime.storage(kind);
          result = {
            root: original.root,
            readFile: (path, opts) => checked(() => original.readFile(path, opts)),
            writeFile: (path, content) => checked(async () => {
              if (kind === 'session') this.observeJob(path, content, runtime, scope);
              await original.writeFile(path, content);
            }),
            appendFile: (path, content) => checked(() => original.appendFile(path, content)),
            listFiles: (path, opts) => checked(() => original.listFiles(path, opts)),
            mkdir: (path, opts) => checked(() => original.mkdir(path, opts)),
            remove: (path, opts) => checked(() => original.remove(path, opts)),
          };
          storage.set(kind, result);
        }
        return result;
      },
      exec: (command, args, opts) => checked(() => runtime.exec(command, args, opts)),
      shell: (command, opts) => checked(() => runtime.shell(command, opts)),
      readFile: (path, opts) => checked(() => runtime.readFile(path, opts)),
      writeFile: (path, content, opts) => checked(() => runtime.writeFile(path, content, opts)),
      listFiles: (path, opts) => checked(() => runtime.listFiles(path, opts)),
      mkdir: (path, opts) => checked(() => runtime.mkdir(path, opts)),
      remove: (path, opts) => checked(() => runtime.remove(path, opts)),
      ...(runtime.files ? { files: {
        inspect: path => checked(() => runtime.files!.inspect(path)),
        canonicalPath: path => checked(() => runtime.files!.canonicalPath(path)),
        move: (source, target) => checked(() => runtime.files!.move(source, target)),
        removeEmptyDirectory: path => checked(() => runtime.files!.removeEmptyDirectory(path)),
        touch: (path, modifiedAt) => checked(() => runtime.files!.touch(path, modifiedAt)),
        ensurePrivateDirectory: (path, options) => checked(() => runtime.files!.ensurePrivateDirectory(path, options)),
        snapshot: (path, maxBytes) => checked(() => runtime.files!.snapshot(path, maxBytes)),
        append: (path, content, expected) => checked(() => runtime.files!.append(path, content, expected)),
      } } : {}),
      ...(runtime.readAgentFile ? { readAgentFile: (path: string) => checked(() => runtime.readAgentFile!(path)) } : {}),
      ...(runtime.privateRuntime ? { privateRuntime: { ensureDirectory: (name: string) => checked(() => runtime.privateRuntime!.ensureDirectory(name)) } } : {}),
      ...(runtime.processes ? { processes: {
        startShell: (command, opts) => this.start(lifetime, 'foreground', command, () => runtime.processes!.startShell(command, opts), this.foregroundId.getStore()),
        ...(runtime.processes.startStdio ? { startStdio: (command: string, args: readonly string[], opts?: Parameters<NonNullable<NonNullable<AgentRuntime['processes']>['startStdio']>>[2]) => this.start(lifetime, 'foreground', command, () => runtime.processes!.startStdio!(command, args, opts), undefined, true) } : {}),
      } } : {}),
      ...(runtime.terminals ? { terminals: {
        startShell: async (command, opts) => {
          const id = opts?.id ?? randomUUID();
          await this.start(lifetime, 'pty', command, () => runtime.terminals!.startShell(command, opts), id);
          return this.terminalHandle(lifetime, id)!;
        },
        attach: id => this.terminalHandle(lifetime, id),
      } } : {}),
    };
    lifetime.runtime = wrapped; this.lifetimes.add(lifetime);
    return wrapped;
  }

  seal(session: string): void { for (const lifetime of this.lifetimes) if (lifetime.scope.session === session) lifetime.draining = true; }
  revoke(session: string): void { for (const lifetime of this.lifetimes) if (lifetime.scope.session === session) { lifetime.revoked = true; this.lifetimes.delete(lifetime); } }
  revokeRuntime(runtime: AgentRuntime): void { for (const lifetime of this.lifetimes) if (lifetime.runtime === runtime) { lifetime.revoked = true; this.lifetimes.delete(lifetime); } }
  sealAll(): void { for (const lifetime of this.lifetimes) lifetime.draining = true; }
  withCleanup<T>(session: string | readonly string[], operation: () => Promise<T>): Promise<T> {
    return this.cleanup.run(new Set([...(this.cleanup.getStore() ?? []), ...(typeof session === 'string' ? [session] : session)]), operation);
  }

  private assertLifetime(lifetime: Lifetime, starting = false): void {
    this.options.assertCurrent();
    if (!lifetime.scope.session) throw new Error('Session runtime is not bound yet.');
    if (lifetime.revoked || lifetime.draining && (starting || !this.cleanup.getStore()?.has(lifetime.scope.session))) throw new Error('Session runtime is closed to new work.');
  }

  private runtime(session: string, root: string): AgentRuntime | undefined {
    return [...this.lifetimes].reverse().find(item => !item.revoked && item.scope.session === session && item.scope.root === root)?.runtime;
  }

  private terminalHandle(lifetime: Lifetime, id: string): AgentRuntimeProcess | undefined {
    this.assertLifetime(lifetime);
    const live = this.live.get(id);
    if (!live || live.view.root !== lifetime.scope.root || live.view.kind !== 'pty') return undefined;
    const checked = <T>(operation: () => Promise<T>) => {
      this.assertLifetime(lifetime);
      return this.track(operation(), lifetime.scope);
    };
    return {
      pid: live.raw.pid,
      read: (offset, options) => checked(() => live.process.read(offset, options)),
      write: content => checked(() => live.process.write(content)),
      terminate: signal => checked(() => live.process.terminate(signal)),
      ...(live.process.interrupt ? { interrupt: () => checked(() => live.process.interrupt!()) } : {}),
      dispose: async () => {},
    };
  }

  list(root: string): ProcessView[] {
    return this.options.store.snapshot().resources.filter(row => row.root === root).map(row => {
      const known = this.views.get(row.id);
      return known ?? { id: row.id, session: row.session, root, kind: row.kind as ProcessView['kind'],
        state: row.state === 'reconciling' ? 'interrupted' : row.state, command: '', startedAt: row.updatedAt, controllable: false, outputOffset: 0 };
    });
  }

  prepareForeground(session: string, settings: { shell?: string | undefined; prefix?: string | undefined } = {}) {
    const lifetime = this.currentLifetime(session); this.assertLifetime(lifetime, true);
    if (!lifetime.runtime.processes) throw processFault('unavailable', 'Foreground processes are unavailable.');
    const shell = getShellConfig(settings.shell).shell;
    return { shell, prefix: settings.prefix, assertCurrent: () => this.assertLifetime(lifetime, true) };
  }

  async startForeground(requestId: string, session: string, params: OperationParams<'shell.execute'>,
    prepared = this.prepareForeground(session)): Promise<{ resourceId: string }> {
    const lifetime = this.currentLifetime(session);
    this.assertLifetime(lifetime, true);
    const request = this.options.store.snapshot().requests.find(item => item.id === requestId);
    if (request?.session !== session || request.op !== 'shell.execute' || request.phase !== 'dispatch_intent') throw new Error('Foreground start requires its committed shell dispatch.');
    const payload = canonicalRequestPayload({ v: 1, id: requestId, op: 'shell.execute', session, params }, { checkFreshness: false });
    if (request.identity.bytes !== Buffer.byteLength(payload) || request.identity.sha256 !== createHash('sha256').update(payload).digest('hex')) throw new Error('Shell command differs from its admitted payload.');
    if (!lifetime.runtime.processes) throw new Error('Foreground processes are unavailable.');
    if (this.foregroundStarts.has(requestId)) throw new Error('Foreground dispatch cannot be repeated.');
    if (this.foregroundStarts.size >= CONTROL_LIMITS.resources) throw new Error('Foreground dispatch capacity reached.');
    const resourceId = `foreground:${requestId}`;
    if (this.options.store.snapshot().resources.some(row => row.id === resourceId)) throw processFault('already_resolved', 'Foreground dispatch already has a durable resource intent.');
    this.foregroundStarts.set(requestId, resourceId);
    return this.track((async () => {
      prepared.assertCurrent();
      const command = prepared.prefix ? `${prepared.prefix}\n${params.command}` : params.command;
      const process = await this.foregroundId.run(resourceId, () => lifetime.runtime.processes!.startShell(command, { shellFlavor: 'posix', shell: prepared.shell }));
      this.assertLifetime(lifetime, true);
      const live = this.live.get(resourceId);
      if (!live || live.process !== process || live.view.session !== session) throw new Error('Foreground process identity changed.');
      return { resourceId };
    })().catch(error => { this.foregroundStarts.delete(requestId); throw error; }), lifetime.scope);
  }

  async waitForeground(requester: string, id: string): Promise<{ output: string; exitCode: number | undefined; cancelled: boolean; truncated: boolean; fullOutputPath?: string }> {
    const row = this.authorizeResource(requester, id); const live = this.live.get(id);
    if (row.kind !== 'foreground' || !live) throw new Error('Foreground process is unavailable.');
    const lifetime = this.currentLifetime(row.session); this.assertLifetime(lifetime);
    return this.track((async () => {
      let offset = 0; let retained = 0; let total = 0; let discarded = false; const chunks: string[] = [];
      const decoder = new TextDecoder(); let pending = ''; let fullOutputPath: string | undefined;
      const storage = lifetime.runtime.storage('session');
      const append = async (raw: string) => {
        const text = stripVTControlCharacters(raw).replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\uFFF9-\uFFFB\r]/gu, '');
        if (!text) return;
        total += Buffer.byteLength(text);
        if (!fullOutputPath && total > DEFAULT_MAX_BYTES) {
          const directory = join(storage.root, 'shell-output'); await storage.mkdir(directory, { recursive: true });
          fullOutputPath = join(directory, `${id}.log`); await storage.writeFile(fullOutputPath, Buffer.from(chunks.join('')));
        }
        if (fullOutputPath) await storage.appendFile(fullOutputPath, Buffer.from(text));
        chunks.push(text); retained += Buffer.byteLength(text);
        while (retained > DEFAULT_MAX_BYTES * 2 && chunks.length > 1) { retained -= Buffer.byteLength(chunks.shift()!); discarded = true; }
      };
      try { for (;;) {
        const result = await live.process.read(offset, { waitMs: 1000, maxBytes: LIMITS.processReadBytes });
        this.assertLifetime(lifetime); this.assertLiveIdentity(this.authorizeResource(requester, id), live);
        if (!Number.isSafeInteger(result.nextOffset) || result.nextOffset !== offset + result.output.byteLength || result.output.byteLength > LIMITS.processReadBytes) throw new Error('Foreground output range is unavailable.');
        const decoded = pending + decoder.decode(result.output, { stream: true });
        const split = splitShellOutput(decoded);
        pending = split.pending;
        await append(split.complete); offset = result.nextOffset;
        if (!result.running && result.output.byteLength === 0) {
          await append(pending + decoder.decode());
          const resultText = truncateTail(chunks.join(''));
          return { output: resultText.content, exitCode: result.exitCode, cancelled: result.exitCode === undefined,
            truncated: discarded || resultText.truncated, ...(fullOutputPath ? { fullOutputPath } : {}) };
        }
        if (!result.output.byteLength) await yieldTurn();
      } } finally { for (const [request, resource] of this.foregroundStarts) if (resource === id) this.foregroundStarts.delete(request); }
    })(), lifetime.scope);
  }

  async cancelForeground(session: string): Promise<void> {
    const rows = this.options.store.snapshot().resources.filter(row => row.session === session && row.kind === 'foreground' && row.state === 'running');
    for (const row of rows) await this.stop(row.root, row.id);
  }

  async read(requester: string, id: string, offset: number, limit: number): Promise<RegistryProcessOutput> {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > LIMITS.processReadBytes) throw new Error('Invalid process read range.');
    const row = this.authorizeResource(requester, id);
    if (row.kind === 'detached') {
      const lifetime = this.currentLifetime(requester); this.assertLifetime(lifetime);
      if (!row.reference || !row.startIdentity) throw new Error('Detached output identity is unavailable.');
      const root = this.currentLifetime(row.root); this.assertLifetime(root);
      const storage = root.runtime.storage('session'); const reference = row.reference;
      const directory = this.options.processAdapter?.storageDirectory(root.runtime);
      if (!directory || !pathInside(directory, reference)) throw new Error('Detached output is outside its root storage.');
      return this.track((async () => {
        const info = this.describeJob(root.runtime, reference, await storage.readFile(reference, { maxBytes: 65536 }));
        this.assertLifetime(lifetime); this.assertLifetime(root);
        const current = this.authorizeResource(requester, id);
        if (current.reference !== reference || current.startIdentity !== row.startIdentity || current.kind !== 'detached'
          || !info || info.id !== id || info.startIdentity !== row.startIdentity || info.kind !== 'detached') throw new Error('Detached output identity changed.');
        const data = readOwnedOutputRange(this.options.store.owner, info.outputPath, offset, limit);
        this.assertLifetime(lifetime); this.assertLifetime(root); this.authorizeResource(requester, id);
        const state = current.state === 'reconciling' ? 'interrupted' : info.status === 'unknown' ? 'missing'
          : info.status !== 'running' ? 'exited' : current.state;
        return { data, offset, nextOffset: offset + data.byteLength, state,
          ...(state === 'exited' && typeof info.exitCode === 'number' && Number.isInteger(info.exitCode) ? { exitCode: info.exitCode } : {}) };
      })(), lifetime.scope);
    }
    const live = this.live.get(id);
    if (!live) return { data: new Uint8Array(), offset, nextOffset: offset, state: row.state === 'interrupted' ? 'interrupted' : 'missing' };
    const lifetime = this.currentLifetime(row.session);
    this.assertLifetime(lifetime);
    this.assertLiveIdentity(row, live);
    return this.track((async () => {
      const snapshot = await live.process.read(offset, { maxBytes: limit });
      this.assertLifetime(lifetime); this.assertLiveIdentity(this.authorizeResource(requester, id), live);
      if (!(snapshot.output instanceof Uint8Array) || snapshot.output.byteLength > limit
        || !Number.isSafeInteger(snapshot.nextOffset) || snapshot.nextOffset !== offset + snapshot.output.byteLength) {
        throw Object.assign(new Error('Process output range is no longer retained.'), { code: 'resync_required' });
      }
      return { data: new Uint8Array(snapshot.output), offset, nextOffset: snapshot.nextOffset,
        state: snapshot.running ? 'running' : 'exited', ...(snapshot.exitCode === undefined ? {} : { exitCode: snapshot.exitCode }) };
    })(), lifetime.scope);
  }

  async write(requester: string, id: string, data: Uint8Array): Promise<number> {
    if (!(data instanceof Uint8Array) || data.byteLength > LIMITS.processWriteBytes) throw new Error('Invalid process input size.');
    const bytes = new Uint8Array(data);
    const row = this.authorizeResource(requester, id); const live = this.live.get(id);
    if (!live || live.disposed || live.settled || !live.view.controllable) throw new Error('Process stdin is unavailable.');
    const lifetime = this.currentLifetime(row.session);
    this.assertLifetime(lifetime); this.assertLiveIdentity(row, live);
    return this.track((async () => {
      await live.process.write(bytes);
      this.assertLifetime(lifetime); this.assertLiveIdentity(this.authorizeResource(requester, id), live);
      return bytes.byteLength;
    })(), lifetime.scope);
  }

  assertWritable(requester: string, id: string): void {
    const row = this.authorizeResource(requester, id); const live = this.live.get(id);
    if (!live || live.disposed || live.settled || !live.view.controllable) throw processFault('unavailable', 'Process stdin is unavailable.');
    this.assertLifetime(this.currentLifetime(row.session)); this.assertLiveIdentity(row, live);
  }

  async prepareStop(requester: string, id: string): Promise<void> {
    let row = this.authorizeResource(requester, id);
    this.assertLifetime(this.currentLifetime(row.session));
    if (this.live.has(id)) return;
    await this.refresh(row.root);
    row = this.authorizeResource(requester, id); this.assertLifetime(this.currentLifetime(row.session));
    if (row.kind !== 'detached' || !this.views.get(id)?.controllable) throw processFault('unavailable', 'Process identity is missing or unverified.');
  }

  async stopForSession(requester: string, id: string, signal: 'SIGTERM' | 'SIGKILL'): Promise<void> {
    if (signal !== 'SIGTERM' && signal !== 'SIGKILL') throw new Error('Unsupported process termination signal.');
    const row = this.authorizeResource(requester, id);
    const lifetime = this.currentLifetime(row.session);
    this.assertLifetime(lifetime);
    return this.track((async () => {
      await this.stop(row.root, id, signal);
      this.assertLifetime(lifetime); this.authorizeResource(requester, id);
    })(), lifetime.scope);
  }

  private currentLifetime(session: string): Lifetime {
    const stored = this.options.store.session(session);
    const lifetime = [...this.lifetimes].reverse().find(item => !item.revoked && item.scope.session === session && item.scope.root === stored.root);
    if (!lifetime || stored.state !== 'open') throw new Error('Process creator runtime is unavailable.');
    return lifetime;
  }

  private authorizeResource(requester: string, id: string): ControlResource {
    this.options.assertCurrent();
    const state = this.options.store.snapshot(); const session = state.sessions.find(item => item.id === requester);
    const row = state.resources.find(item => item.id === id);
    if (!session || session.state !== 'open' || !row || row.root !== session.root) throw new Error('Process not found in the authorized session scope.');
    const creator = state.sessions.find(item => item.id === row.session);
    if (!creator || creator.root !== row.root) throw new Error('Process creator identity is invalid.');
    let ancestor = creator; const seen = new Set<string>();
    while (ancestor.id !== requester && ancestor.parent && !seen.has(ancestor.id)) {
      seen.add(ancestor.id);
      const parent = state.sessions.find(item => item.id === ancestor.parent && item.root === row.root);
      if (!parent) break;
      ancestor = parent;
    }
    if (ancestor.id !== requester) throw new Error('Process belongs to another session lineage.');
    return row;
  }

  private assertLiveIdentity(row: ControlResource, live: LiveProcess): void {
    if (this.live.get(row.id) !== live || live.view.session !== row.session || live.view.root !== row.root || live.view.kind !== row.kind) throw new Error('Retained process identity changed.');
  }

  blocksEviction(root: string): boolean {
    return [...this.operations.values()].some(({ scope, passive }) => scope.root === root && !passive)
      || this.options.store.snapshot().resources.some(row => row.root === root && !this.live.get(row.id)?.transport && (row.state === 'running' || row.state === 'reconciling'));
  }

  async refresh(root: string): Promise<void> {
    for (const row of this.options.store.snapshot().resources.filter(row => row.root === root)) {
      const live = this.live.get(row.id);
      if (live) { await live.process.read(live.view.outputOffset, { maxBytes: 0 }); continue; }
      if (row.kind !== 'detached' || !row.reference || !row.startIdentity) continue;
      const runtime = this.runtime(row.session, root) ?? this.runtime(root, root);
      if (!runtime) continue;
      const bytes = await runtime.storage('session').readFile(row.reference, { maxBytes: 64 * 1024 }).catch(() => undefined);
      this.options.assertCurrent();
      if (!bytes) { this.update(row, 'missing'); continue; }
      const adapter = this.options.processAdapter;
      if (!adapter) continue;
      let info: ProcessRecord | undefined;
      try { info = this.describeJob(runtime, row.reference, bytes); } catch { this.update(row, 'missing'); continue; }
      if (!info || info.id !== row.id || info.startIdentity !== row.startIdentity || info.kind !== 'detached') { this.update(row, 'missing'); continue; }
      const job = await adapter.inspectDetached(runtime, row.id);
      this.options.assertCurrent();
      if (job.status !== 'running') { this.update(row, job.status === 'unknown' ? 'missing' : 'exited'); continue; }
      const pid = job.pid;
      const inspection = pid ? await runtime.exec('ps', ['-o', 'command=', '-p', String(pid)]) : undefined;
      this.options.assertCurrent();
      const verified = inspection?.code === 0 && info.commandIdentity.every(value => inspection.stdout.includes(value)) && inspection.stdout.includes(row.startIdentity);
      this.update(row, verified ? 'running' : 'reconciling', {
        id: row.id, session: row.session, root, kind: 'detached', state: verified ? 'running' : 'interrupted',
        command: boundedText(info.command, 16384), startedAt: info.startedAt, controllable: verified, outputOffset: 0,
      });
    }
  }

  async stop(root: string, id: string, signal: 'SIGTERM' | 'SIGKILL' = 'SIGTERM'): Promise<void> {
    this.options.assertCurrent();
    const row = this.options.store.snapshot().resources.find(row => row.id === id && row.root === root);
    if (!row) throw new Error('Process not found in this root session.');
    const live = this.live.get(id);
    if (live) { await live.process.terminate(signal); await live.process.read(0, { maxBytes: 0 }); return; }
    await this.refresh(root);
    this.options.assertCurrent();
    const runtime = this.runtime(row.session, root) ?? this.runtime(root, root);
    if (!runtime || !this.views.get(id)?.controllable || row.kind !== 'detached') throw new Error('Process identity is missing or unverified.');
    const adapter = this.options.processAdapter;
    if (!adapter) throw processFault('unavailable', 'Detached process control is unavailable.');
    await adapter.stopDetached(runtime, id, signal);
    await this.refresh(root);
  }

  async settle(root: string, fenced = false, sessions?: ReadonlySet<string>): Promise<void> {
    const owns = (scope: Scope) => scope.root === root && (!sessions || sessions.has(scope.session));
    for (const lifetime of this.lifetimes) if (owns(lifetime.scope)) lifetime.draining = true;
    const failures: unknown[] = [];
    const join = async (operations: Promise<unknown>[]) => {
      const results = await Promise.allSettled(operations);
      for (const result of results) if (result.status === 'rejected') failures.push(result.reason);
    };
    for (;;) {
      // Terminate first: a pending foreground read may need process exit to unblock.
      const handles = [...this.live.values()].filter(item => owns(item.view) && !item.disposed);
      await join(handles.map(async item => {
        if (!item.settled) await item.raw.terminate('SIGTERM');
      }));
      const pending = [...this.operations].filter(([, { scope }]) => owns(scope)).map(([operation]) => operation);
      await join(pending);
      await join(handles.map(async item => {
        const snapshot = await item.raw.read(0, { maxBytes: 0 });
        if (snapshot.running) throw new Error('A live process did not settle.');
        item.settled = true;
        if (!fenced) {
          item.view = { ...item.view, state: 'exited', controllable: false, outputOffset: snapshot.nextOffset, ...(snapshot.exitCode === undefined ? {} : { exitCode: snapshot.exitCode }) };
          const row = this.options.store.snapshot().resources.find(row => row.id === item.view.id)!;
          this.update(row, 'exited', item.view);
        }
        await item.raw.dispose(); item.disposed = true;
      }));
      if (failures.length) throw new AggregateError(failures, 'Owned processes did not settle.');
      if (![...this.operations.values()].some(({ scope }) => owns(scope)) && ![...this.live.values()].some(item => owns(item.view) && !item.disposed)) break;
    }
  }

  private start<T extends AgentRuntimeProcess>(lifetime: Lifetime, kind: ProcessView['kind'], command: string, create: () => Promise<T>, requestedId?: string, transport = false): Promise<T> {
    const scope = lifetime.scope;
    return this.track((async () => {
      this.assertLifetime(lifetime, true);
      const id = requestedId ?? randomUUID();
      const previous = this.options.store.snapshot().resources.find(row => row.id === id);
      if (this.live.has(id) || this.starting.has(id) || previous && (previous.session !== scope.session || previous.root !== scope.root || previous.kind !== kind)) throw new Error('Process identity is already registered.');
      this.starting.add(id);
      const row: ControlResource = previous ?? { id, ...scope, kind, state: 'running', updatedAt: this.now() };
      this.update(row, 'running', { id, ...scope, kind, state: 'running', command: boundedText(command, 16384), startedAt: this.now(), controllable: false, outputOffset: 0 });
      let process: T;
      try { process = await create(); } catch (error) { this.update(row, 'missing'); throw error; } finally { this.starting.delete(id); }
      try { this.options.assertCurrent(); } catch (error) {
        await process.terminate('SIGTERM'); await process.dispose(); throw error;
      }
      const view: ProcessView = { id, ...scope, kind, state: 'running', command: boundedText(command, 16384), startedAt: this.now(), controllable: true, outputOffset: 0 };
      const live: LiveProcess = { raw: process, process, view, transport, settled: false, disposed: false };
      const wrapped = new Proxy(process, { get: (target, key) => {
        const current = () => { this.options.assertCurrent(); if (live.disposed) throw new Error('Process handle is disposed.'); };
        if (key === 'read' || transport && (key === 'readStdout' || key === 'readStderr')) return (...args: Parameters<AgentRuntimeProcess['read']>) => {
          if (live.disposed) return Promise.resolve({ output: new Uint8Array(), nextOffset: live.view.outputOffset, running: false,
            ...(live.view.exitCode === undefined ? {} : { exitCode: live.view.exitCode }), ...(live.signal ? { signal: live.signal } : {}) });
          return this.track((async () => {
          current(); const read = Reflect.get(target, key, target) as AgentRuntimeProcess['read'];
          const snapshot = await read.apply(target, args); this.options.assertCurrent();
          live.settled ||= !snapshot.running;
          live.view = { ...live.view, state: live.settled ? 'exited' : 'running', controllable: !live.settled, outputOffset: key === 'read' ? Math.max(live.view.outputOffset, snapshot.nextOffset) : live.view.outputOffset, ...(snapshot.exitCode === undefined ? {} : { exitCode: snapshot.exitCode }) };
          this.update(row, live.view.state, live.view);
          return { ...snapshot, running: !live.settled, ...(live.view.exitCode === undefined ? {} : { exitCode: live.view.exitCode }), ...(!snapshot.running && live.signal ? { signal: live.signal } : {}) };
          })(), scope, transport);
        };
        if (key === 'terminate') return (signal: AgentRuntimeTerminationSignal = 'SIGTERM') => {
          if (live.disposed) return Promise.resolve();
          current();
          live.signal = signal;
          return this.track(target.terminate(signal).catch(error => { delete live.signal; throw error; }), scope);
        };
        const value: unknown = Reflect.get(target, key, target);
        if (typeof value !== 'function') return value;
        return (...args: unknown[]) => {
          if (live.disposed && (key === 'dispose' || key === 'terminate')) return Promise.resolve();
          current();
          if (key === 'write' || key === 'resize') this.assertLifetime(lifetime);
          return this.track(Promise.resolve(Reflect.apply(value, target, args)).then(result => {
            this.options.assertCurrent(); if (key === 'dispose') live.disposed = true; return result;
          }), scope);
        };
      } });
      live.process = wrapped; this.live.set(id, live); this.update(row, 'running', view); return wrapped;
    })(), scope);
  }

  private describeJob(runtime: AgentRuntime, path: string, bytes: Uint8Array): ProcessRecord | undefined {
    const adapter = this.options.processAdapter;
    if (!adapter || !pathInside(adapter.storageDirectory(runtime), path)) return undefined;
    const info = adapter.describeJob(runtime, path, bytes);
    if (info && !pathInside(adapter.storageDirectory(runtime), info.outputPath)) throw new Error('Process output is outside its root storage.');
    return info;
  }

  private observeJob(path: string, bytes: Uint8Array, runtime: AgentRuntime, scope: Scope): void {
    const absolute = resolve(runtime.storage('session').root, path);
    const directory = this.options.processAdapter?.storageDirectory(runtime);
    if (!directory || !pathInside(directory, absolute)) return;
    const info = this.describeJob(runtime, absolute, bytes);
    if (!info) return;
    const previous = this.options.store.snapshot().resources.find(row => row.id === info.id);
    const row: ControlResource = previous ?? { id: info.id, ...scope, kind: info.kind, state: 'running', reference: absolute,
      ...(info.startIdentity ? { startIdentity: info.startIdentity } : {}), updatedAt: this.now() };
    if (previous && (previous.root !== scope.root || previous.reference !== absolute || previous.startIdentity !== info.startIdentity)) throw new Error('Background job identity changed.');
    this.update(row, info.status === 'running' ? 'running' : info.status === 'unknown' ? 'missing' : 'exited', {
      id: info.id, session: row.session, root: row.root, kind: row.kind as ProcessView['kind'], state: info.status === 'running' ? 'running' : info.status === 'unknown' ? 'missing' : 'exited',
      command: boundedText(info.command, 16384), startedAt: info.startedAt, controllable: this.live.has(info.id), outputOffset: 0,
    });
  }
  private update(row: ControlResource, state: ControlResource['state'], view?: ProcessView): void {
    this.options.assertCurrent();
    const old = this.options.store.snapshot().resources.find(item => item.id === row.id);
    const known = view ?? this.views.get(row.id);
    const next: ProcessView = known ? { ...known, state: state === 'reconciling' ? 'interrupted' : state, controllable: state === 'running' && known.controllable }
      : { id: row.id, session: row.session, root: row.root, kind: row.kind as ProcessView['kind'], state: state === 'reconciling' ? 'interrupted' : state,
        command: '', startedAt: row.updatedAt, controllable: false, outputOffset: 0 };
    if (!old || old.state !== state || JSON.stringify(this.views.get(row.id)) !== JSON.stringify(next)) {
      const commit = this.options.store.putResource({ ...row, state });
      this.views.set(row.id, next);
      this.options.changed(row.session, next, commit.revisions[row.session]!);
    }
  }
  private track<T>(operation: Promise<T>, scope: Scope, passive = false): Promise<T> {
    this.operations.set(operation, { scope, passive }); void operation.then(() => this.operations.delete(operation), () => this.operations.delete(operation)); return operation;
  }
}

function processFault(code: string, message: string): Error & { code: string } { return Object.assign(new Error(message), { code }); }

function splitShellOutput(value: string): { complete: string; pending: string } {
  const start = Math.max(0, value.length - 256); const tail = value.slice(start);
  const osc = tail.lastIndexOf('\x1b]');
  if (osc >= 0 && !/[\x07\x9c]|\x1b\\/u.test(tail.slice(osc + 2))) return { complete: value.slice(0, start + osc), pending: tail.slice(osc) };
  const incomplete = /(?:\x1b(?:\[[0-?]*[ -/]*|[()][ -/]*)?|\x9b[0-?]*[ -/]*)$/u.exec(tail);
  return incomplete ? { complete: value.slice(0, start + incomplete.index), pending: incomplete[0] } : { complete: value, pending: '' };
}
