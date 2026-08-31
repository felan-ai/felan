import { createHash } from 'node:crypto';
import { buildAiInsights } from './facets.js';
import { computeAnalytics } from './analytics.js';
import { getInsightsArgumentCompletions, getSinceCutoff, parseInsightsArgs } from './cli.js';
import { generateMarkdown } from './markdown.js';
import { parseSessionTranscript } from './parser.js';
import { renderReport } from './report.js';
import type { Analytics, ParsedSession } from './types.js';
import type { InsightsHost, InsightsSessionReference } from './contracts.js';
import type { FelanExtension } from '@felan-ai/agent-core';

const CACHE_PREFIX = 'insights/session-meta/';
const MAX_SESSION_BYTES = 8 * 1024 * 1024;

export type { InsightsHost, InsightsSessionReference } from './contracts.js';
export type { FacetModelClient } from './facets.js';
export * from './analytics.js';
export * from './cli.js';
export * from './markdown.js';
export * from './parser.js';
export * from './rage.js';
export * from './types.js';
export { renderReport } from './report.js';

export function createInsightsExtension(host: InsightsHost): FelanExtension {
  return (pi) => {
    pi.registerCommand('insights', {
      description: 'Generate a Felan session insights report',
      getArgumentCompletions: getInsightsArgumentCompletions,
      handler: async (args, ctx) => {
        const parsed = parseInsightsArgs(args ?? '');
        if (!parsed.ok) { ctx.ui.notify(parsed.error, 'error'); return; }
        const options = parsed.options;
        const cutoff = getSinceCutoff(options);
        ctx.ui.notify('Scanning available sessions…', 'info');
        let references: readonly InsightsSessionReference[];
        try { references = await host.listSessions(pi.runtime); } catch (error) { ctx.ui.notify(`Could not list sessions: ${errorMessage(error)}`, 'error'); return; }
        const sessions: ParsedSession[] = [];
        const transcripts = new Map<string, string>();
        let cacheHits = 0;
        let cacheMisses = 0;
        let cacheWrites = 0;
        for (const reference of references) {
          if (!Number.isSafeInteger(reference.size) || reference.size < 0 || reference.size > MAX_SESSION_BYTES) continue;
          const cached = options.refresh ? undefined : await readCachedSession(pi.runtime, reference);
          if (cached) { cacheHits++; if (!cutoff || cached.startTime >= cutoff) sessions.push(cached); continue; }
          cacheMisses++;
          const transcript = await host.readSession(pi.runtime, reference);
          if (!transcript || new TextEncoder().encode(transcript).byteLength > MAX_SESSION_BYTES) continue;
          const session = parseSessionTranscript(transcript, reference.id);
          if (!session) continue;
          transcripts.set(session.id, transcript);
          await writeCachedSession(pi.runtime, reference, session);
          cacheWrites++;
          if (!cutoff || session.startTime >= cutoff) sessions.push(session);
        }
        if (!sessions.length) { ctx.ui.notify('No valid sessions found for the selected range.', 'warning'); return; }
        let analytics = computeAnalytics(sessions);
        analytics.cache = { root: pi.runtime.storage('agent').root, refreshed: options.refresh, versions: { schema: '1', parser: '1', facetPrompt: '1' }, sessionMeta: { hits: cacheHits, misses: cacheMisses, writes: cacheWrites, errors: 0 } };
        if (host.enrichAnalytics) analytics = await host.enrichAnalytics(analytics, pi.runtime);
        if (host.savings) analytics.savings = await host.savings(pi.runtime, analytics);
        analytics.ai = await buildAiInsights({ sessions, transcriptById: transcripts, modelClient: host.modelClient?.(pi.runtime) });
        const reportPath = await host.writeReport(pi.runtime, 'felan-insights.html', renderReport(analytics));
        if (options.markdown && host.writeMarkdown) await host.writeMarkdown(pi.runtime, 'pi-insights.md', generateMarkdown(analytics));
        ctx.ui.notify(`Insights report ready: ${reportPath}`, 'info');
        if (options.openReport && host.openReport) await host.openReport(pi.runtime, reportPath);
      },
    });
  };
}

export default function insightsExtension(pi: Parameters<FelanExtension>[0]): void {
  pi.registerCommand('insights', {
    description: 'Generate a Felan session insights report',
    handler: async (_args, ctx) => ctx.ui.notify('Insights requires a host integration.', 'warning'),
  });
}

async function readCachedSession(runtime: import('@felan-ai/agent-core').AgentRuntime, reference: import('./contracts.js').InsightsSessionReference): Promise<ParsedSession | undefined> {
  try {
    const key = cacheKey(reference);
    const raw = new TextDecoder().decode(await runtime.storage('agent').readFile(`${CACHE_PREFIX}${key}.json`, { maxBytes: MAX_SESSION_BYTES }));
    const value = JSON.parse(raw) as { session?: Omit<ParsedSession, 'startTime' | 'endTime'> & { startTime: string; endTime: string } };
    if (!value.session) return undefined;
    return { ...value.session, startTime: new Date(value.session.startTime), endTime: new Date(value.session.endTime) };
  } catch { return undefined; }
}

async function writeCachedSession(runtime: import('@felan-ai/agent-core').AgentRuntime, reference: import('./contracts.js').InsightsSessionReference, session: ParsedSession): Promise<void> {
  const storage = runtime.storage('agent');
  await storage.mkdir(CACHE_PREFIX, { recursive: true });
  await storage.writeFile(`${CACHE_PREFIX}${cacheKey(reference)}.json`, new TextEncoder().encode(JSON.stringify({ session: { ...session, startTime: session.startTime.toISOString(), endTime: session.endTime.toISOString() } })));
}

function cacheKey(reference: import('./contracts.js').InsightsSessionReference): string { return createHash('sha256').update(JSON.stringify(reference)).digest('hex'); }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
