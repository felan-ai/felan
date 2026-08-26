import { join } from 'node:path';
import { HostAgentRuntime } from '@felan-ai/agent-core';
import type { FelanExtensionAPI } from '@felan-ai/agent-core';
import { SavingsService, formatSavingsReport, type SavingsQuery, type SavingsScope } from './savings.js';

export function createGainExtension(service: SavingsService) {
  return (pi: FelanExtensionAPI): void => {
    pi.registerCommand('gain', {
      description: 'Show Felan savings',
      getArgumentCompletions: (prefix) => {
        const value = prefix.trim().toLowerCase();
        if (value.includes(' ')) return null;
        return ['project', 'all', 'details'].filter((entry) => entry.startsWith(value))
          .map((entry) => ({ value: entry, label: entry }));
      },
      handler: async (args, ctx) => {
        const words = args.trim().toLowerCase().split(/\s+/u).filter(Boolean);
        if (words.length > 1 || (words[0] !== undefined && !['project', 'all', 'details'].includes(words[0]))) {
          ctx.ui.notify('Usage: /gain [project|all|details]', 'warning');
          return;
        }
        const detailed = words[0] === 'details';
        const scope: SavingsScope = words[0] === 'project' ? 'project' : words[0] === 'all' ? 'all' : 'session';
        const report = await service.query({ scope });
        ctx.ui.notify(formatSavingsReport(report, detailed), 'info');
      },
    });
  };
}

export async function runLocalGainCli(options: {
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
