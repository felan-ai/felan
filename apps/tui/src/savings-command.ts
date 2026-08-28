import { join } from 'node:path';
import { HostAgentRuntime } from '@felan-ai/agent-core';
import type { InlineExtension } from '@felan-ai/agent-core';
import { SavingsService, formatSavingsReport, type SavingsQuery, type SavingsScope } from './savings.js';

export const SAVINGS_COMMAND_EXTENSION_NAME = '@felan-ai/felan/savings';

export function createSavingsCommandExtension(service: SavingsService): InlineExtension {
  return {
    name: SAVINGS_COMMAND_EXTENSION_NAME,
    hidden: true,
    factory: (pi) => {
      pi.registerCommand('savings', {
        description: 'Show estimated API-equivalent savings',
        getArgumentCompletions: (prefix) => {
          const value = prefix.trim().toLowerCase();
          if (value.includes(' ')) return null;
          return ['project', 'all', 'details'].filter((entry) => entry.startsWith(value))
            .map((entry) => ({ value: entry, label: entry }));
        },
        handler: async (args, ctx) => {
          const words = args.trim().toLowerCase().split(/\s+/u).filter(Boolean);
          if (words.length > 1 || (words[0] !== undefined && !['project', 'all', 'details'].includes(words[0]))) {
            ctx.ui.notify('Usage: /savings [project|all|details]', 'warning');
            return;
          }
          const detailed = words[0] === 'details';
          const scope: SavingsScope = words[0] === 'project' ? 'project' : words[0] === 'all' ? 'all' : 'session';
          const report = await service.query({ scope });
          ctx.ui.notify(formatSavingsReport(report, detailed), 'info');
        },
      });
    },
  };
}

export async function runLocalSavingsCli(options: {
  readonly agentDir: string;
  readonly cwd: string;
  readonly sessionId?: string;
  readonly projectKey: string;
  readonly query: SavingsQuery;
  readonly format: 'text' | 'json';
  readonly writeOutput: (line: string) => void;
}): Promise<number> {
  const runtime = new HostAgentRuntime(options.cwd, {
    sessionStorageRoot: join(options.agentDir, 'storage', 'sessions', 'cli'),
    agentStorageRoot: join(options.agentDir, 'storage', 'agent'),
    agentDir: options.agentDir,
    pathAccess: 'host',
  });
  const service = new SavingsService({
    runtime,
    rootSessionId: options.sessionId ?? 'cli',
    projectKey: options.projectKey,
  });
  const report = await service.query(options.query);
  options.writeOutput(options.format === 'json' ? JSON.stringify(report) : formatSavingsReport(report, true));
  return 0;
}
