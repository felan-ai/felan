import { join } from 'node:path';
import type { AgentRuntime, AgentRuntimeStorage } from '@felan-ai/agent-core';
import { shellQuote } from './runtime-support.js';
import { removeRetainedJob } from './retention-removal.js';

export const RETENTION_INTERVAL = 32;
export const RETENTION_BATCH_SIZE = 32;
export const RETAINED_TERMINAL_JOBS = 1_000;
export const TERMINAL_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1_000;
export const TERMINAL_RETENTION_GRACE_MS = 5 * 60 * 1_000;
const states = new Map<string, {
  mutations: number;
  cursor?: string;
  retained: number;
  pending: Promise<void>;
}>();
const terminal = new Set(['completed', 'failed', 'killed']);

export class BackgroundBashRetention {
  constructor(
    private readonly runtime: AgentRuntime,
    private readonly storage: AgentRuntimeStorage,
    private readonly jobsDir: string,
    private readonly listIds: () => Promise<string[]>,
    private readonly withJob: <T>(id: string, operation: () => Promise<T>) => Promise<T>,
  ) {}

  async recordMutation(): Promise<void> {
    const state = states.get(this.jobsDir) ?? { mutations: 0, retained: 0, pending: Promise.resolve() };
    states.set(this.jobsDir, state);
    state.mutations++;
    if (state.mutations % RETENTION_INTERVAL) return;
    state.pending = state.pending.then(async () => {
      const ids = await this.listIds();
      const candidates = ids.filter(id => /^bash-\d{14}-[a-f0-9]{6}$/u.test(id) && (state.cursor === undefined || id < state.cursor)).slice(0, RETENTION_BATCH_SIZE);
      for (const id of candidates) {
        await this.withJob(id, async () => {
          const jobDir = join(this.jobsDir, id);
          const info = await this.readRecord(join(jobDir, 'info.json'));
          const completion = await this.readRecord(join(jobDir, 'completion.json'));
          if (!info || !completion || info.id !== id || completion.id !== id
            || info.cwd !== this.runtime.cwd || typeof info.command !== 'string'
            || !terminal.has(String(info.status)) || info.status !== completion.status
            || !timestamp(info.startedAt) || !timestamp(completion.completedAt)
            || info.completedAt !== completion.completedAt
            || completion.completedAt < info.startedAt || completion.completedAt > Date.now()) return;
          state.retained++;
          if (state.retained <= RETAINED_TERMINAL_JOBS && Date.now() - completion.completedAt <= TERMINAL_MAX_AGE_MS) return;
          if (Date.now() - completion.completedAt < TERMINAL_RETENTION_GRACE_MS) return;
          const pids = new Set([info.pid, completion.pid].filter(pid => pid !== undefined));
          for (const pid of pids) {
            if (!Number.isSafeInteger(pid) || (pid as number) <= 0) return;
            const probe = await this.runtime.shell(`ps -p ${shellQuote(String(pid))} -o pid=`, { shellFlavor: 'posix' });
            if (probe.code !== 1 || probe.killed || probe.stdout.trim() || probe.stderr.trim()) return;
          }
          const group = info.processGroupId;
          if (pids.size && (!Number.isSafeInteger(group) || (group as number) <= 0)) return;
          if (group !== undefined) {
            if (!Number.isSafeInteger(group) || (group as number) <= 0) return;
            const probe = await this.runtime.shell('ps -eo pgid=', { shellFlavor: 'posix' });
            if (probe.code !== 0 || probe.killed || probe.stderr.trim()) return;
            const groups = probe.stdout.trim().split(/\s+/u);
            if (groups.some(value => !/^\d+$/u.test(value) || Number(value) === group)) return;
          }
          await removeRetainedJob(this.runtime, this.storage.root, jobDir);
        });
      }
      const last = candidates.at(-1);
      if (last !== undefined && ids.some(id => id < last)) state.cursor = last;
      else { delete state.cursor; state.retained = 0; }
    }).catch(() => {
      // Failed or ambiguous inspection must never make a record eligible for deletion.
      delete state.cursor;
      state.retained = 0;
    });
    await state.pending;
  }

  private async readRecord(path: string): Promise<Record<string, unknown> | undefined> {
    try {
      const value: unknown = JSON.parse(new TextDecoder().decode(await this.storage.readFile(path, { maxBytes: 64 * 1024 })));
      return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
    } catch { return undefined; }
  }

}

function timestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
