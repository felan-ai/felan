import { createHash } from 'node:crypto';
import { computeAnalytics } from './analytics.js';
import { getInsightsArgumentCompletions, getSinceCutoff, parseInsightsArgs } from './cli.js';
import { generateMarkdown } from './markdown.js';
import { mergeParsedSessions, parseSessionTranscript } from './parser.js';
import { sliceParsedSession } from './slicing.js';
import { renderReport } from './report.js';
import type { Analytics, ParsedSession } from './types.js';
import type { InsightsHost, InsightsSessionReference } from './contracts.js';
import type { ExtensionUi, FelanExtension } from '@felan-ai/agent-core';

const CACHE_PREFIX = 'insights/session-meta/';
const MAX_SESSION_BYTES = 64 * 1024 * 1024;
const PARSER_VERSION = '2';

export type { InsightsHost, InsightsSessionReference } from './contracts.js';
export * from './analytics.js';
export * from './cli.js';
export * from './markdown.js';
export * from './parser.js';
export * from './rage.js';
export * from './types.js';
export { renderReport } from './report.js';

export interface InsightsExtensionOptions {
  readonly ui: Pick<ExtensionUi, 'notify'>;
  readonly signal?: AbortSignal;
}

export function createInsightsExtension(host: InsightsHost, binding?: InsightsExtensionOptions): FelanExtension {
  return (pi) => {
    const lifetime = new AbortController();
    let queue = Promise.resolve();
    if (binding) pi.on('session_shutdown', async () => { lifetime.abort(); await queue; });
    pi.registerCommand('insights', {
      description: 'Generate a Felan Code session insights report',
      getArgumentCompletions: getInsightsArgumentCompletions,
      handler: (args, ctx) => {
        const execute = async () => {
          const signal = binding ? AbortSignal.any([lifetime.signal, ...(binding.signal ? [binding.signal] : []), ...(ctx.signal ? [ctx.signal] : [])]) : ctx.signal;
          signal?.throwIfAborted();
          const notify = async (text: string, level: 'info' | 'warning' | 'error') => {
            if (binding) await binding.ui.notify({ text, level });
            else ctx.ui.notify(text, level);
          };
          const parsed = parseInsightsArgs(args ?? '');
          if (!parsed.ok) { await notify(parsed.error, 'error'); return; }
          const options = parsed.options;
          const cutoff = getSinceCutoff(options);
          await notify('Scanning available sessions…', 'info');
          let references: readonly InsightsSessionReference[];
          try { references = await host.listSessions(pi.runtime, signal); } catch (error) {
            signal?.throwIfAborted();
            await notify(binding ? 'Could not list sessions.' : `Could not list sessions: ${errorMessage(error)}`, 'error'); return;
          }
          const grouped = new Map<string, ParsedSession[]>();
          let cacheHits = 0;
          let cacheMisses = 0;
          let cacheWrites = 0;
          for (const reference of references) {
            signal?.throwIfAborted();
            if (reference.size !== undefined && (!Number.isSafeInteger(reference.size) || reference.size < 0 || reference.size > MAX_SESSION_BYTES)) continue;
            const cached = options.refresh ? undefined : await readCachedSession(pi.runtime, reference);
            signal?.throwIfAborted();
            if (cached?.activity) {
              cacheHits++;
              const sliced = sliceParsedSession(cached, cutoff, new Date());
              if (sliced) addGrouped(grouped, reference, sliced);
              continue;
            }
            cacheMisses++;
            const transcript = host.readSessionLines
              ? await collectLines(host.readSessionLines(pi.runtime, reference, signal), signal)
              : await host.readSession(pi.runtime, reference, signal);
            signal?.throwIfAborted();
            if (!transcript || new TextEncoder().encode(transcript).byteLength > MAX_SESSION_BYTES) continue;
            const session = parseSessionTranscript(transcript, reference.id);
            if (!session) continue;
            await writeCachedSession(pi.runtime, reference, session);
            signal?.throwIfAborted();
            cacheWrites++;
            const sliced = sliceParsedSession(session, cutoff, new Date());
            if (sliced) addGrouped(grouped, reference, sliced);
          }
          const sessions = [...grouped.entries()].flatMap(([rootId, parts]) => {
            const merged = mergeParsedSessions(parts, rootId);
            return merged ? [merged] : [];
          });
          if (!sessions.length) { await notify('No valid sessions found for the selected range.', 'warning'); return; }
          let analytics = computeAnalytics(sessions);
          analytics.cache = { root: pi.runtime.storage('agent').root, refreshed: options.refresh, versions: { schema: '2', parser: PARSER_VERSION }, sessionMeta: { hits: cacheHits, misses: cacheMisses, writes: cacheWrites, errors: 0 } };
          analytics.export = { generatedAt: new Date().toISOString(), outputFormats: options.markdown ? ['html', 'markdown'] : ['html'] };
          if (host.enrichAnalytics) analytics = await host.enrichAnalytics(analytics, pi.runtime);
          if (host.savings) analytics.savings = await host.savings(pi.runtime, analytics);
          signal?.throwIfAborted();
          const reportPath = await host.writeReport(pi.runtime, 'felan-insights.html', renderReport(analytics));
          signal?.throwIfAborted();
          if (options.markdown && host.writeMarkdown) await host.writeMarkdown(pi.runtime, 'felan-insights.md', generateMarkdown(analytics));
          signal?.throwIfAborted();
          await notify(`Insights report ready: ${reportPath}`, 'info');
          if (options.openReport && host.openReport) {
            signal?.throwIfAborted();
            if (signal) await host.openReport(pi.runtime, reportPath, signal);
            else await host.openReport(pi.runtime, reportPath);
          }
        };
        if (!binding) return execute();
        const work = queue.then(execute);
        queue = work.catch(() => {});
        return work;
      },
    });
  };
}

async function collectLines(lines: AsyncIterable<string>, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  const chunks: string[] = [];
  let bytes = 0;
  for await (const line of lines) {
    signal?.throwIfAborted();
    if (typeof line !== 'string') throw new Error('Session transcript contains invalid data.');
    if (line.length > MAX_SESSION_BYTES) throw new Error('Session transcript exceeds the supported size.');
    bytes += new TextEncoder().encode(line).byteLength + (chunks.length ? 1 : 0);
    if (bytes > MAX_SESSION_BYTES) throw new Error('Session transcript exceeds the supported size.');
    chunks.push(line);
  }
  signal?.throwIfAborted();
  return chunks.join('\n');
}

function addGrouped(groups: Map<string, ParsedSession[]>, reference: InsightsSessionReference, session: ParsedSession): void {
  const rootId = reference.rootSessionId ?? reference.id;
  const parts = groups.get(rootId) ?? [];
  parts.push(session);
  groups.set(rootId, parts);
}

export default function insightsExtension(pi: Parameters<FelanExtension>[0]): void {
  pi.registerCommand('insights', {
    description: 'Generate a Felan Code session insights report',
    handler: async (_args, ctx) => ctx.ui.notify('Insights requires a host integration.', 'warning'),
  });
}

async function readCachedSession(runtime: import('@felan-ai/agent-core').AgentRuntime, reference: import('./contracts.js').InsightsSessionReference): Promise<ParsedSession | undefined> {
  try {
    const key = cacheKey(reference);
    const raw = new TextDecoder().decode(await runtime.storage('agent').readFile(`${CACHE_PREFIX}${key}.json`, { maxBytes: MAX_SESSION_BYTES }));
    const value = JSON.parse(raw) as { session?: Omit<ParsedSession, 'startTime' | 'endTime'> & { startTime: string; endTime: string } };
    if (!value.session) return undefined;
    return {
      ...value.session,
      startTime: new Date(value.session.startTime),
      endTime: new Date(value.session.endTime),
      activity: value.session.activity?.map((item) => ({ ...item, timestamp: new Date(item.timestamp) })),
    };
  } catch { return undefined; }
}

async function writeCachedSession(runtime: import('@felan-ai/agent-core').AgentRuntime, reference: import('./contracts.js').InsightsSessionReference, session: ParsedSession): Promise<void> {
  const storage = runtime.storage('agent');
  await storage.mkdir(CACHE_PREFIX, { recursive: true });
  await storage.writeFile(`${CACHE_PREFIX}${cacheKey(reference)}.json`, new TextEncoder().encode(JSON.stringify({ session: { ...session, startTime: session.startTime.toISOString(), endTime: session.endTime.toISOString() } })));
}

function cacheKey(reference: import('./contracts.js').InsightsSessionReference): string {
  return createHash('sha256').update(JSON.stringify({ parser: PARSER_VERSION, reference })).digest('hex');
}
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }

export { INSIGHTS_DOCUMENT_HINT } from './ui.js';
