import open from 'open';
import { createMemoryControlExtension, type CreateMemoryControlExtensionOptions } from '@felan-ai/daemon/internal/memory/control';
import { showMemoryHistory } from './history-view.js';

export type CreateLocalMemoryControlExtensionOptions = Omit<CreateMemoryControlExtensionOptions, 'presentation'>;

export function createLocalMemoryControlExtension(options: CreateLocalMemoryControlExtensionOptions) {
  return createMemoryControlExtension({ ...options, presentation: {
    isInteractive: ctx => ctx.hasUI && ctx.mode === 'tui',
    showHistory: (ctx, agentDir, status, signal) => showMemoryHistory(ctx, agentDir, status, signal),
    async openDirectory(directory, signal) { signal.throwIfAborted(); await open(directory); },
  } });
}
