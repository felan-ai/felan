import { createLogger, createSilentLogger, type Logger } from '@felan-ai/agent-core';
import { appendLocalLogLine, resolveLocalLoggerLevel } from '../logger.js';
import type { DaemonOwnership } from './ownership.js';

export class DaemonAgentLogs {
  private readonly pending = new Set<Promise<void>>();
  private closed = false;
  constructor(private readonly owner: DaemonOwnership) {}

  create(directory: string): Logger {
    const root = this.owner.assertOwnsPath(directory);
    const level = resolveLocalLoggerLevel();
    if (level === 'off') return createSilentLogger();
    return createLogger({ level, destination: { write: record => {
      if (this.closed) return;
      try { this.owner.assertCurrent(); } catch { return; }
      const write = appendLocalLogLine(root, record);
      this.pending.add(write);
      void write.finally(() => this.pending.delete(write));
    } } });
  }

  async close(): Promise<void> { this.closed = true; await Promise.all(this.pending); }
}
