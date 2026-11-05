import { dirname, join } from 'node:path';
import type { DaemonOwnership } from './ownership.js';
import type { RegistryProcesses } from './processes.js';
import type { SessionBinding, SessionLifecycle, SessionOpenRequest, SessionWorkerConfiguration } from './session-lifecycle-contracts.js';
import { assertStagedWorker } from './worker.js';
import { canonicalProspectivePath, pathInside } from './target.js';

interface HostWorkerEntry {
  readonly binding: SessionBinding;
  readonly path: string;
  running?: Promise<void>;
  cancelling?: Promise<void>;
  closing?: Promise<void>;
}

interface HostWorkersOptions {
  readonly owner: DaemonOwnership;
  readonly processes: RegistryProcesses;
  lifecycle(): SessionLifecycle;
  assertNewWork(): void;
  claim(id: string, path: string): void;
  release(path: string): void;
  openSession(request: SessionOpenRequest): Promise<SessionBinding>;
  fail(error: unknown): void;
}

export class HostWorkers {
  private readonly entries = new Map<string, HostWorkerEntry>();
  private readonly identities = new Set<string>();
  private readonly opening = new Set<Promise<SessionBinding>>();
  private lifetime = new AbortController();
  get signal(): AbortSignal { return this.lifetime.signal; }

  constructor(private readonly options: HostWorkersOptions) {}

  owns(id: string): boolean { return this.identities.has(id); }
  roots(): string[] { return [...this.entries.keys()]; }

  open(worker: SessionWorkerConfiguration): Promise<SessionBinding> {
    this.options.assertNewWork();
    const operation = this.performOpen(worker, this.signal);
    this.opening.add(operation);
    void operation.then(() => this.opening.delete(operation), () => this.opening.delete(operation));
    return operation;
  }

  private async performOpen(worker: SessionWorkerConfiguration, signal: AbortSignal): Promise<SessionBinding> {
    const manager = worker.sessionManager;
    const file = manager.getSessionFile();
    if (!file) throw Object.assign(new Error('Worker transcript must have a fresh identity.'), { code: 'invalid_request' });
    const transcript = this.options.owner.assertOwnsPath(file);
    if (!pathInside(canonicalProspectivePath(join(this.options.owner.target.agentDir, 'sessions')), transcript)) {
      throw Object.assign(new Error('Worker transcript is outside the host session directory.'), { code: 'forbidden' });
    }
    const resources = await this.options.lifecycle().resolveResources({ cwd: manager.getCwd(), sessionDir: dirname(transcript) });
    signal.throwIfAborted();
    const { id, path } = assertStagedWorker(this.options.owner, resources, worker, id => this.identities.has(id));
    if (manager.getCwd() !== resources.cwd) throw new Error('Worker workspace does not match its transcript.');
    for (const root of resources.writableRoots) this.options.owner.assertOwnsPath(root);
    this.options.claim(id, path);
    this.identities.add(id);
    let binding: SessionBinding | undefined;
    const policy = { mode: 'host-default', generation: 0 } as const;
    try {
      binding = await this.options.openSession({ resources, target: { kind: 'resume', sessionFile: path }, rootSessionId: id,
        policy, extensionPaths: [], allowedTools: worker.allowedTools, worker: { ...worker, host: true },
        ownership: { assertOwned: (resolved, target) => {
          signal.throwIfAborted();
          for (const root of resolved.writableRoots) this.options.owner.assertOwnsPath(root);
          if (target.sourceSessionId !== id || this.options.owner.assertOwnsPath(target.sourceSessionFile!) !== path
            || target.destinationDirectory !== resources.sessionDir) throw new Error('Worker transcript identity changed.');
        } },
        services: { getExecutionPolicy: () => policy, currentRun: () => undefined,
          extensions: { configuration: async () => [], bind: async () => { throw new Error('Host worker extension discovery is disabled.'); } } },
      });
      signal.throwIfAborted();
      if (binding.sessionId !== id || binding.rootSessionId !== id || binding.parentSessionId !== undefined
        || manager.getSessionFile() !== path || manager.getCwd() !== resources.cwd) throw new Error('Lifecycle returned inconsistent worker identity.');
      await binding.activate?.();
      signal.throwIfAborted();
      this.entries.set(id, { binding, path });
      return binding;
    } catch (error) {
      try {
        if (binding) await this.disposeBinding(binding);
        else { await this.options.processes.settle(id); this.options.processes.revoke(id); }
        this.options.release(path);
      } catch (cleanup) {
        const failure = new AggregateError([error, cleanup], 'Host worker setup cleanup failed.');
        this.options.fail(failure); throw failure;
      }
      throw error;
    }
  }

  interrupt(): void {
    this.lifetime.abort();
    this.lifetime = new AbortController();
    for (const entry of this.entries.values()) {
      if (entry.cancelling || entry.closing) continue;
      const cancellation = Promise.resolve().then(() => entry.binding.runtime.session.abort());
      entry.cancelling = cancellation;
      void cancellation.then(() => { delete entry.cancelling; }, error => this.options.fail(error));
    }
  }

  async run<T>(id: string, operation: () => Promise<T>): Promise<T> {
    this.options.assertNewWork();
    const entry = this.entries.get(id);
    if (!entry || entry.closing) throw new Error('Host worker is closed.');
    if (entry.running || !entry.binding.runtime.session.isIdle) throw Object.assign(new Error('Worker is already running.'), { code: 'busy' });
    const work = operation();
    entry.running = work.then(() => {}, () => {});
    try { return await work; }
    finally { delete entry.running; }
  }

  async settle(): Promise<void> {
    await Promise.allSettled([...this.opening]);
    for (const entry of this.entries.values()) {
      await entry.cancelling?.catch(() => {});
      await entry.running;
      if (!entry.binding.runtime.session.isIdle) await entry.binding.runtime.session.waitForIdle();
      await entry.closing;
    }
  }

  close(id: string): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry) return Promise.resolve();
    if (entry.closing) return entry.closing;
    this.options.processes.seal(id);
    const closing = this.options.processes.withCleanup(id, async () => {
      await entry.cancelling?.catch(() => {});
      await entry.binding.runtime.session.abort();
      await entry.running;
      await this.disposeBinding(entry.binding);
      this.options.release(entry.path); this.entries.delete(id);
    });
    entry.closing = closing;
    void closing.catch(error => { delete entry.closing; this.options.fail(error); });
    return closing;
  }

  async shutdown(): Promise<void> {
    this.interrupt();
    await Promise.allSettled([...this.opening]);
    const results = await Promise.allSettled([...this.entries.keys()].map(id => this.close(id)));
    const failures = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
    if (failures.length === 1) throw failures[0];
    if (failures.length) throw new AggregateError(failures, 'Host worker shutdown failed.');
  }

  private async disposeBinding(binding: SessionBinding): Promise<void> {
    await this.options.processes.withCleanup(binding.sessionId, async () => {
      await binding.runtime.session.abort();
      await binding.runtime.session.waitForIdle();
      await this.options.processes.settle(binding.rootSessionId);
      await binding.runtime.dispose();
    });
    this.options.processes.revoke(binding.sessionId);
    this.options.processes.revokeRuntime(binding.agentRuntime);
  }
}
