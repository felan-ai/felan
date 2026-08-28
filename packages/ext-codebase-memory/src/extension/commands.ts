import type { FelanExtensionAPI } from '@felan-ai/agent-core';
import type { CbmInstallStatus } from '../installer.js';

export interface CodebaseMemoryController {
  install(onStatus: (message: string) => void): Promise<CbmInstallStatus>;
  refresh(cwd: string, signal?: AbortSignal): Promise<{ readonly status: string; readonly [key: string]: unknown }>;
}

export function registerCodebaseMemoryCommand(pi: FelanExtensionAPI, controller: CodebaseMemoryController): void {
  pi.registerCommand('codebase-memory', {
    description: 'Install or refresh Codebase Memory',
    getArgumentCompletions: (prefix) => ['install', 'refresh'].filter((item) => item.startsWith(prefix.trim())).map((value) => ({ value, label: value })),
    handler: async (args, ctx) => {
      const action = args.trim().toLowerCase();
      if (action === 'install') {
        ctx.ui.setStatus('codebase-memory-install', '… Installing Codebase Memory');
        try {
          const result = await controller.install((message) => ctx.ui.setStatus('codebase-memory-install', `… ${message}`));
          ctx.ui.notify(result.available ? `Codebase Memory ${result.version} installed. Reload Felan to activate it.` : `Installation failed: ${result.reason}`, result.available ? 'info' : 'error');
        } finally { ctx.ui.setStatus('codebase-memory-install', undefined); }
      } else if (action === 'refresh') {
        ctx.ui.setStatus('codebase-memory-refresh', 'cbm: idx');
        try {
          const result = await controller.refresh(ctx.cwd, ctx.signal);
          ctx.ui.notify(result.status === 'indexed' ? 'Codebase Memory refresh completed.' : `Codebase Memory refresh ${result.status}.`, result.status === 'indexed' ? 'info' : 'warning');
        } finally { ctx.ui.setStatus('codebase-memory-refresh', undefined); }
      } else {
        ctx.ui.notify('Usage: /codebase-memory install|refresh', 'info');
      }
    },
  });
}
