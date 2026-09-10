import { randomUUID } from 'node:crypto';
import type { AgentRuntime } from '@felan-ai/agent-core';

const RECOVERY_DIRECTORY = 'codebase-memory/recovery';
const WORKER_LOG_LIMIT = 64 * 1024;
export const RECOVERY_TTL_MS = 45_000;
export const RECOVERY_COMPLETION_TTL_MS = 5 * 60_000;

export interface RecoveryRecord {
  readonly id: string;
  readonly createdAt: number;
  readonly expiresAt: number;
}

export interface RecoveryCompletion {
  readonly id: string;
  readonly completedAt: number;
  readonly expiresAt: number;
  readonly success: boolean;
}

export function recoveryRecordPath(id: string): string {
  return `${RECOVERY_DIRECTORY}/active-${id}.json`;
}

export function recoveryCompletionPath(id: string): string {
  return `${RECOVERY_DIRECTORY}/done-${id}.json`;
}

export async function inspectIndexFailure(
  error: unknown,
  cacheRoot: string,
  readFile: (path: string) => Promise<Uint8Array>,
): Promise<{ path: string } | undefined> {
  const message = error instanceof Error ? error.message : String(error);
  const match = message.match(/inspect log:\s*(\S+)/u);
  if (!match?.[1]) return undefined;
  const absolute = normalize(match[1]);
  const root = normalize(cacheRoot).replace(/\/$/u, '');
  if (!absolute.startsWith(`${root}/`)) return undefined;
  const relative = absolute.slice(root.length + 1);
  if (!/^logs\/\.worker-log-[A-Za-z0-9]+$/u.test(relative)) return undefined;
  let content: Uint8Array;
  try {
    content = await readFile(relative);
  } catch {
    return undefined;
  }
  if (content.byteLength > WORKER_LOG_LIMIT) return undefined;
  const text = new TextDecoder().decode(content);
  if (!text.includes('CBM index worker could not start: active daemon coordination could not be verified safely')
    && !text.includes('CBM index worker could not start: a pre-coordination or unverified CBM generation is active')) {
    return undefined;
  }
  return { path: relative };
}

export class RecoveryRecords {
  readonly #runtime: AgentRuntime;
  readonly #now: () => number;

  constructor(runtime: AgentRuntime, now: () => number = Date.now) {
    this.#runtime = runtime;
    this.#now = now;
  }

  async begin(ttlMs: number): Promise<RecoveryRecord> {
    const createdAt = this.#now();
    const record: RecoveryRecord = {
      id: randomUUID(),
      createdAt,
      expiresAt: createdAt + ttlMs,
    };
    const storage = this.#runtime.storage('agent');
    await storage.mkdir(RECOVERY_DIRECTORY, { recursive: true });
    await storage.writeFile(recoveryRecordPath(record.id), new TextEncoder().encode(JSON.stringify(record)));
    return record;
  }

  async complete(record: RecoveryRecord, success: boolean, ttlMs: number): Promise<void> {
    const completedAt = this.#now();
    const completion: RecoveryCompletion = {
      id: record.id,
      completedAt,
      expiresAt: completedAt + ttlMs,
      success,
    };
    const storage = this.#runtime.storage('agent');
    await storage.writeFile(recoveryCompletionPath(record.id), new TextEncoder().encode(JSON.stringify(completion)));
    await storage.remove(recoveryRecordPath(record.id)).catch(() => {});
  }

  async active(): Promise<RecoveryRecord[]> {
    const storage = this.#runtime.storage('agent');
    let paths: string[];
    try {
      paths = await storage.listFiles(RECOVERY_DIRECTORY, {
        maxDepth: 1,
        pattern: 'active-*.json',
        limit: 32,
      });
    } catch {
      return [];
    }
    const records: RecoveryRecord[] = [];
    for (const path of paths) {
      try {
        const value = JSON.parse(new TextDecoder().decode(await storage.readFile(`${RECOVERY_DIRECTORY}/${path}`))) as Partial<RecoveryRecord>;
        if (typeof value.id !== 'string' || typeof value.createdAt !== 'number' || typeof value.expiresAt !== 'number') continue;
        if (value.expiresAt <= this.#now()) {
          await storage.remove(`${RECOVERY_DIRECTORY}/${path}`).catch(() => {});
          continue;
        }
        records.push(value as RecoveryRecord);
      } catch {
        continue;
      }
    }
    return records;
  }

  async successfulSince(since: number): Promise<boolean> {
    const storage = this.#runtime.storage('agent');
    let paths: string[];
    try {
      paths = await storage.listFiles(RECOVERY_DIRECTORY, {
        maxDepth: 1,
        pattern: 'done-*.json',
        limit: 32,
      });
    } catch {
      return false;
    }
    for (const path of paths) {
      try {
        const value = JSON.parse(new TextDecoder().decode(await storage.readFile(`${RECOVERY_DIRECTORY}/${path}`))) as Partial<RecoveryCompletion>;
        if (typeof value.completedAt !== 'number' || typeof value.expiresAt !== 'number') continue;
        if (value.expiresAt <= this.#now()) {
          await storage.remove(`${RECOVERY_DIRECTORY}/${path}`).catch(() => {});
          continue;
        }
        if (value.success === true && value.completedAt >= since) return true;
      } catch {
        continue;
      }
    }
    return false;
  }
}

export class RecoveryCoordinator {
  readonly #records: RecoveryRecords;
  readonly #closeFrontend: () => Promise<void>;
  readonly #stopDaemon: (signal?: AbortSignal) => Promise<boolean>;
  #stopped = false;
  #monitor: Promise<void> | undefined;
  readonly #handled = new Set<string>();

  constructor(
    private readonly runtime: AgentRuntime,
    private readonly cacheRoot: string,
    closeFrontend: () => Promise<void>,
    stopDaemon: (signal?: AbortSignal) => Promise<boolean>,
  ) {
    this.#records = new RecoveryRecords(runtime);
    this.#closeFrontend = closeFrontend;
    this.#stopDaemon = stopDaemon;
  }

  start(): void {
    if (this.#monitor) return;
    this.#monitor = this.#runMonitor();
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    await this.#monitor;
    this.#monitor = undefined;
  }

  async recover(error: unknown, signal?: AbortSignal): Promise<boolean> {
    const diagnostic = await inspectIndexFailure(
      error,
      this.cacheRoot,
      (path) => this.runtime.storage(this.runtime.kind === 'host' ? 'agent' : 'session').readFile(`codebase-memory/cache/${path}`, { maxBytes: WORKER_LOG_LIMIT }),
    );
    if (!diagnostic || this.#stopped || signal?.aborted) return false;
    const record = await this.#records.begin(RECOVERY_TTL_MS);
    try {
      await this.#closeFrontend();
      const success = await this.#stopDaemon(signal);
      await this.#records.complete(record, success, RECOVERY_COMPLETION_TTL_MS);
      return success;
    } catch {
      await this.#records.complete(record, false, RECOVERY_COMPLETION_TTL_MS).catch(() => {});
      return false;
    }
  }

  async waitForRecovery(signal?: AbortSignal): Promise<void> {
    const deadline = Date.now() + RECOVERY_TTL_MS;
    while (!this.#stopped && Date.now() < deadline) {
      if (signal?.aborted) return;
      const active = await this.#records.active();
      if (active.length === 0) return;
      await this.#closeFrontend();
      await delay(100, signal);
    }
  }

  async hasSuccessfulRecoverySince(since: number): Promise<boolean> {
    return this.#records.successfulSince(since);
  }

  async waitForSuccessfulRecoverySince(since: number, signal?: AbortSignal): Promise<boolean> {
    const deadline = Date.now() + RECOVERY_TTL_MS;
    while (!this.#stopped && Date.now() < deadline && !signal?.aborted) {
      if (await this.#records.successfulSince(since)) return true;
      await delay(200, signal);
    }
    return false;
  }

  async #runMonitor(): Promise<void> {
    while (!this.#stopped) {
      const active = await this.#records.active();
      for (const record of active) {
        if (this.#handled.has(record.id)) continue;
        this.#handled.add(record.id);
        await this.#closeFrontend().catch(() => {});
      }
      await delay(200);
    }
  }
}

export async function runStdioCommand(
  runtime: AgentRuntime,
  command: string,
  args: readonly string[],
  options: { cwd: string; env: Readonly<Record<string, string>>; timeoutMs: number; signal?: AbortSignal },
): Promise<number> {
  const startStdio = runtime.processes?.startStdio;
  if (!startStdio) return 1;
  const process = await startStdio(command, args, { cwd: options.cwd, env: options.env });
  let stdoutOffset = 0;
  let stderrOffset = 0;
  const deadline = Date.now() + options.timeoutMs;
  try {
    await process.closeInput();
    while (Date.now() < deadline) {
      if (options.signal?.aborted) {
        await process.terminate('SIGTERM').catch(() => {});
        return 1;
      }
      const [stdout, stderr] = await Promise.all([
        process.readStdout(stdoutOffset, { waitMs: 100, maxBytes: 64 * 1024 }),
        process.readStderr(stderrOffset, { waitMs: 100, maxBytes: 64 * 1024 }),
      ]);
      stdoutOffset = stdout.nextOffset;
      stderrOffset = stderr.nextOffset;
      if (!stdout.running && !stderr.running) return stdout.exitCode ?? stderr.exitCode ?? 1;
    }
    await process.terminate('SIGTERM').catch(() => {});
    return 1;
  } finally {
    await process.dispose().catch(() => {});
  }
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) { resolve(); return; }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

function normalize(value: string): string {
  const normalized = value.replaceAll('\\', '/').replace(/\/+/gu, '/').replace(/\/$/u, '');
  return normalized.replace(/^\/private(?=\/)/u, '');
}
