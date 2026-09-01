import { createReadStream } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline';
import { basename, join } from 'node:path';
import open from 'open';
import type { AgentRuntime } from '@felan-ai/agent-core';
import type { InsightsHost, InsightsSessionReference } from '@felan-ai/ext-insights';
import type { InsightsSavingsReport } from '@felan-ai/ext-insights';
import type { SavingsService } from './savings.js';

const MAX_SESSION_BYTES = 64 * 1024 * 1024;
const REPORT_DIRECTORY = 'insights-reports';

export function createLocalInsightsHost(savings?: SavingsService): InsightsHost {
  return {
  listSessions: async (runtime) => {
    const sessionDirectory = join(runtimeAgentDir(runtime), 'sessions');
    try {
      const entries = await readdir(sessionDirectory, { withFileTypes: true });
      const references: InsightsSessionReference[] = [];
      for (const entry of entries) {
        const path = join(sessionDirectory, entry.name);
        if (entry.isDirectory()) {
          for (const nested of await readdir(path, { withFileTypes: true })) {
            if (nested.isFile() && nested.name.endsWith('.jsonl')) references.push(await reference(join(path, nested.name)));
          }
        } else if (entry.isFile() && entry.name.endsWith('.jsonl')) references.push(await reference(path));
      }
      const subagentsDirectory = join(runtimeAgentDir(runtime), 'subagents');
      for (const root of await safeReadDirectories(subagentsDirectory)) {
        const childSessions = join(subagentsDirectory, root, 'sessions');
        for (const child of await safeReadDirectories(childSessions)) {
          if (!child.endsWith('.jsonl')) continue;
          references.push(await reference(join(childSessions, child), root, true));
        }
      }
      return references;
    } catch { return []; }
  },
  readSession: async (_runtime, session) => {
    try { return await readFile(session.path, { encoding: 'utf8' }); } catch { return undefined; }
  },
  readSessionLines: (_runtime, session) => readLines(session.path),
  writeReport: async (runtime, fileName, content) => {
    const storage = runtime.storage('agent');
    await storage.mkdir(REPORT_DIRECTORY, { recursive: true });
    const path = `${REPORT_DIRECTORY}/${fileName}`;
    await storage.writeFile(path, new TextEncoder().encode(content));
    return join(storage.root, path);
  },
  writeMarkdown: async (runtime, fileName, content) => {
    const storage = runtime.storage('agent');
    await storage.mkdir(REPORT_DIRECTORY, { recursive: true });
    const path = `${REPORT_DIRECTORY}/${fileName}`;
    await storage.writeFile(path, new TextEncoder().encode(content));
    return join(storage.root, path);
  },
    openReport: async (_runtime, reportPath) => { await open(reportPath); },
    ...(savings === undefined ? {} : { savings: async (_runtime: import('@felan-ai/agent-core').AgentRuntime, analytics) => readSavings(savings, analytics) }),
  };
}

async function* readLines(path: string): AsyncIterable<string> {
  const input = createReadStream(path, { encoding: 'utf8' });
  try {
    for await (const line of createInterface({ input, crlfDelay: Infinity })) yield line;
  } catch {
    return;
  } finally {
    input.destroy();
  }
}

export const localInsightsHost: InsightsHost = createLocalInsightsHost();

function runtimeAgentDir(runtime: AgentRuntime): string { return runtime.storage('agent').root.replace(/\/storage\/agent$/u, ''); }
async function reference(path: string, rootSessionId?: string, isAgent?: boolean): Promise<InsightsSessionReference> {
  const info = await stat(path);
  return { id: basename(path, '.jsonl'), path, size: info.size, modifiedAtMs: info.mtimeMs, ...(rootSessionId ? { rootSessionId } : {}), ...(isAgent ? { isAgent } : {}) };
}

async function safeReadDirectories(directory: string): Promise<string[]> {
  try {
    return (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() || entry.isFile())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

async function readSavings(savings: SavingsService, analytics: import('@felan-ai/ext-insights').Analytics): Promise<InsightsSavingsReport> {
  const report = await savings.query({ scope: 'all' });
  const projectNames = new Map<string, string>();
  for (const session of analytics.sessions) {
    if (!session.cwd) continue;
    projectNames.set(createHash('sha256').update(session.cwd, 'utf8').digest('hex'), session.projectName);
  }
  return {
    scope: report.scope,
    calls: report.calls,
    baselineCostUsd: report.baselineCostUsd,
    actualCostUsd: report.actualCostUsd,
    savedCostUsd: report.savedCostUsd,
    hasUnpricedMeasurements: report.hasUnpricedMeasurements,
    diagnostics: [...report.diagnostics],
    buckets: report.buckets.map((bucket) => {
      const projectName = projectNames.get(bucket.projectKey);
      return {
        day: bucket.day,
        sessionId: bucket.sessionId,
        projectKey: bucket.projectKey,
        ...(projectName === undefined ? {} : { projectName }),
        producerId: bucket.producerId,
        category: bucket.category,
        ...(bucket.operation === undefined ? {} : { operation: bucket.operation }),
        basis: bucket.basis.kind,
        ...(bucket.tool === undefined ? {} : { tool: bucket.tool }),
        ...(bucket.techniques === undefined ? {} : { techniques: [...bucket.techniques] }),
        calls: bucket.calls,
        ...(bucket.baseline.costUsd === undefined ? {} : { baselineCostUsd: bucket.baseline.costUsd }),
        ...(bucket.actual.costUsd === undefined ? {} : { actualCostUsd: bucket.actual.costUsd }),
        ...(bucket.baseline.model === undefined ? {} : { baselineModel: `${bucket.baseline.model.provider}/${bucket.baseline.model.id}` }),
        ...(bucket.actual.model === undefined ? {} : { actualModel: `${bucket.actual.model.provider}/${bucket.actual.model.id}` }),
        priceSource: `${bucket.baseline.priceSource}/${bucket.actual.priceSource}`,
      };
    }),
  };
}
