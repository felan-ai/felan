import { appendFile, readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import type { ModelRuntime } from '@felan-ai/agent-core';
import type { SessionCheckpoint } from '@felan-ai/ext-memory';
import { LocalMemoryCoordinator } from '../../src/memory/coordinator.js';

interface WorkerConfig {
  readonly cwd: string;
  readonly agentDir: string;
  readonly sessionDir: string;
  readonly callLog: string;
  readonly action: 'run' | 'retry';
  readonly outcome: 'fail' | 'success';
  readonly checkpoint: SessionCheckpoint;
  readonly automatic?: boolean;
  readonly barrierPath?: string;
  readonly barrierParticipants?: number;
  readonly crashOnModel?: boolean;
  readonly leaseStaleMs?: number;
  readonly retryDelaysMs?: readonly [number, number];
}

const configPath = process.env.FELAN_MEMORY_PROCESS_CONFIG;

describe.skipIf(!configPath)('memory process worker', () => {
  it('executes one isolated coordinator lifecycle', async () => {
    const config = JSON.parse(await readFile(configPath!, 'utf8')) as WorkerConfig;
    const coordinator = new LocalMemoryCoordinator({
      agentDir: config.agentDir,
      sessionDir: config.sessionDir,
      modelRuntime: {} as ModelRuntime,
      enabled: !config.automatic,
      recover: false,
      debounceMs: config.automatic ? 0 : 60_000,
      monitorIntervalMs: 60_000,
      retryDelaysMs: config.retryDelaysMs ?? [0, 0],
      ...(config.leaseStaleMs ? { leaseOptions: { staleMs: config.leaseStaleMs, updateMs: 1_000 } } : {}),
      dreamRunner: async (input) => {
        await appendFile(config.callLog, `${JSON.stringify({ pid: process.pid, at: Date.now() })}\n`);
        if (config.crashOnModel) {
          process.kill(process.pid, 'SIGKILL');
          await new Promise<never>(() => {});
        }
        if (config.outcome === 'fail') throw new Error('isolated fixture failure');
        return input.baseSnapshot;
      },
    });
    try {
      for (let attempt = 0; ; attempt += 1) {
        try {
          await coordinator.recordCheckpoint(config.cwd, config.checkpoint);
          break;
        } catch (error) {
          if (attempt >= 399 || !(error instanceof Error)
            || !error.message.includes('initialization needs writer ownership')) throw error;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
      if (config.barrierPath) {
        await appendFile(config.barrierPath, `${process.pid}\n`);
        for (let attempt = 0; ; attempt += 1) {
          const participants = (await readFile(config.barrierPath, 'utf8')).trim().split('\n').filter(Boolean).length;
          if (participants >= (config.barrierParticipants ?? 1)) break;
          if (attempt >= 399) throw new Error('Worker barrier was not released');
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
      if (config.automatic) coordinator.setEnabled(true);
      if (config.action === 'retry') {
        expect(await coordinator.retryProject(config.cwd)).toMatchObject({
          state: 'idle', consecutiveFailures: 0, pendingCheckpoints: 0,
        });
        return;
      }
      for (let attempt = 0; attempt < 400; attempt += 1) {
        const status = await coordinator.runNow(config.cwd);
        if (config.outcome === 'success' && status.pendingCheckpoints === 0 && status.state === 'idle') {
          expect(status).toMatchObject({ state: 'idle', consecutiveFailures: 0 });
          return;
        }
        if (config.outcome === 'fail' && status.autoDisabled) {
          expect(status).toMatchObject({ state: 'disabled', consecutiveFailures: 3 });
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error('Project did not reach its expected terminal processing state');
    } finally {
      await coordinator.dispose();
    }
  });
});
