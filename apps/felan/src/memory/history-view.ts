import type { ExtensionContext } from '@felan-ai/agent-core';
import type { TUI } from '@earendil-works/pi-tui';
import { listLocalSessionHistory, readMemoryHistorySnapshot, type LocalSessionHistory } from './history.js';
import { MemoryHistoryView as MemoryHistoryRenderer, type MemoryHistoryViewOptions } from './history-renderer.js';
export type { MemoryDisplaySnapshot } from './history-renderer.js';

export class MemoryHistoryView extends MemoryHistoryRenderer {
  constructor(tui: TUI, history: LocalSessionHistory, done: (path: string | undefined) => void, options: MemoryHistoryViewOptions = {}) {
    super(tui, history, done, { readSnapshot: readMemoryHistorySnapshot, ...options });
  }
}

export async function showMemoryHistory(ctx: ExtensionContext, agentDir: string, status: string, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return;
  if (!ctx.hasUI || ctx.mode !== 'tui') {
    ctx.ui.notify('/memory requires interactive TUI mode.', 'warning');
    return;
  }
  const history = await listLocalSessionHistory({ cwd: ctx.cwd, agentDir, sessionDir: ctx.sessionManager.getSessionDir(), memoryOnly: true });
  if (signal?.aborted) return;
  let abort = () => {};
  try {
    await ctx.ui.custom<string | undefined>((tui, theme, keybindings, done) => {
      const view = new MemoryHistoryView(tui, history, done, { memoryOnly: true, keybindings, status, theme });
      abort = () => { view.dispose(); done(undefined); };
      signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort(); return view;
    });
  } finally { signal?.removeEventListener('abort', abort); }
}
