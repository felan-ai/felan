import type { AgentRuntime, HostWorkerLauncher, SessionsService } from '@felan-ai/agent-core';

export interface MemoryContext {
  readonly runtime: AgentRuntime;
  readonly sessions: SessionsService;
  readonly openWorker?: HostWorkerLauncher;
}

export async function removeIfPresent(context: MemoryContext, path: string, options?: { recursive?: boolean }): Promise<void> {
  try { await context.runtime.remove(path, options); }
  catch (error) {
    if (!(error instanceof Error) || Reflect.get(error, 'code') !== 'ENOENT') throw error;
  }
}
