import { createHash } from 'node:crypto';
import { computeAnalytics } from './analytics.js';
import { getInsightsArgumentCompletions, parseInsightsArgs } from './cli.js';
import { sessionsForRange } from './dashboard.js';
import { INSIGHTS_DEFAULT_RANGE } from './data.js';
import { generateMarkdown } from './markdown.js';
import { parseSessionTranscript } from './parser.js';
import { renderReport } from './report.js';
import type { InsightsHost, InsightsLoadedSession, InsightsReport, InsightsSessionReference } from './contracts.js';
import { SessionsServiceError, type AgentRuntime, type ExtensionUi, type FelanExtension } from '@felan-ai/agent-core';
import type { ParsedSession } from './types.js';

const CACHE_PREFIX = 'insights/session-meta/';
const MAX_SESSION_BYTES = 64 * 1024 * 1024;
const PARSER_VERSION = '2';

export type { InsightsHost, InsightsLoadedSession, InsightsReport, InsightsSessionReference } from './contracts.js';
export * from './analytics.js';
export * from './cli.js';
export * from './dashboard.js';
export * from './data.js';
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
          await notify('Scanning available sessions…', 'info');
          let references: readonly InsightsSessionReference[];
          try { references = await host.listSessions(pi.runtime, signal); } catch (error) {
            signal?.throwIfAborted();
            const reason = binding ? (error instanceof SessionsServiceError ? ` (${error.code})` : '') : `: ${errorMessage(error)}`;
            await notify(`Could not list sessions${reason}.`, 'error'); return;
          }
          const skipped = new Map<string, number>();
          const skip = (reason: string) => { skipped.set(reason, (skipped.get(reason) ?? 0) + 1); };
          const loaded: InsightsLoadedSession[] = [];
          let cacheHits = 0;
          let cacheMisses = 0;
          let cacheWrites = 0;
          for (const reference of references) {
            signal?.throwIfAborted();
            if (reference.unavailable) { skip(reference.unavailable); continue; }
            if (reference.size !== undefined && (!Number.isSafeInteger(reference.size) || reference.size < 0 || reference.size > MAX_SESSION_BYTES)) { skip('oversize'); continue; }
            const rootId = reference.rootSessionId ?? reference.id;
            const cached = options.refresh ? undefined : await readCachedSession(pi.runtime, reference);
            signal?.throwIfAborted();
            if (cached?.activity) {
              cacheHits++;
              loaded.push({ rootId, session: cached });
              continue;
            }
            cacheMisses++;
            let transcript: string | undefined;
            try {
              transcript = host.readSessionLines
                ? await collectLines(host.readSessionLines(pi.runtime, reference, signal), signal)
                : await host.readSession(pi.runtime, reference, signal);
            } catch (error) {
              signal?.throwIfAborted();
              skip(error instanceof SessionsServiceError ? error.code : 'unreadable'); continue;
            }
            signal?.throwIfAborted();
            if (!transcript || new TextEncoder().encode(transcript).byteLength > MAX_SESSION_BYTES) continue;
            const session = parseSessionTranscript(transcript, reference.id);
            if (!session) continue;
            await writeCachedSession(pi.runtime, reference, session);
            signal?.throwIfAborted();
            cacheWrites++;
            loaded.push({ rootId, session });
          }
          if (skipped.size) {
            const total = [...skipped.values()].reduce((sum, count) => sum + count, 0);
            const reasons = [...skipped].map(([reason, count]) => `${reason} ${count}`).join(', ');
            await notify(`Skipped ${total} of ${references.length} sessions that could not be read (${reasons}).`, 'warning');
          }
          const generatedAt = new Date();
          const sinceRange = options.sinceDays === undefined ? undefined : `${options.sinceDays}d`;
          const sessions = sessionsForRange(loaded, sinceRange ?? 'all', generatedAt);
          if (!sessions.length) { await notify('No valid sessions found for the selected range.', 'warning'); return; }
          const analytics = computeAnalytics(sessions);
          analytics.cache = { root: pi.runtime.storage('agent').root, refreshed: options.refresh, versions: { schema: '2', parser: PARSER_VERSION }, sessionMeta: { hits: cacheHits, misses: cacheMisses, writes: cacheWrites, errors: 0 } };
          analytics.export = { generatedAt: generatedAt.toISOString(), outputFormats: options.markdown ? ['html', 'markdown'] : ['html'] };
          if (host.savings) analytics.savings = await host.savings(pi.runtime, analytics);
          signal?.throwIfAborted();
          const reportPath = await host.writeReport(pi.runtime, 'felan-insights.html', renderReport(analytics));
          signal?.throwIfAborted();
          if (options.markdown && host.writeMarkdown) await host.writeMarkdown(pi.runtime, 'felan-insights.md', generateMarkdown(analytics));
          signal?.throwIfAborted();
          await notify(`Insights report ready: ${reportPath}`, 'info');
          if (options.openReport && host.presentReport) {
            signal?.throwIfAborted();
            const report: InsightsReport = { path: reportPath, generatedAt, initialRange: sinceRange ?? INSIGHTS_DEFAULT_RANGE, loaded };
            if (signal) await host.presentReport(pi.runtime, report, signal);
            else await host.presentReport(pi.runtime, report);
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
    if (typeof line !== 'string') throw new SessionsServiceError('invalid', 'Session transcript contains invalid data.');
    if (line.length > MAX_SESSION_BYTES) throw new SessionsServiceError('oversize', 'Session transcript exceeds the supported size.');
    bytes += new TextEncoder().encode(line).byteLength + (chunks.length ? 1 : 0);
    if (bytes > MAX_SESSION_BYTES) throw new SessionsServiceError('oversize', 'Session transcript exceeds the supported size.');
    chunks.push(line);
  }
  signal?.throwIfAborted();
  return chunks.join('\n');
}

export default function insightsExtension(pi: Parameters<FelanExtension>[0]): void {
  pi.registerCommand('insights', {
    description: 'Generate a Felan Code session insights report',
    handler: async (_args, ctx) => ctx.ui.notify('Insights requires a host integration.', 'warning'),
  });
}

async function readCachedSession(runtime: AgentRuntime, reference: InsightsSessionReference): Promise<ParsedSession | undefined> {
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

async function writeCachedSession(runtime: AgentRuntime, reference: InsightsSessionReference, session: ParsedSession): Promise<void> {
  const storage = runtime.storage('agent');
  await storage.mkdir(CACHE_PREFIX, { recursive: true });
  await storage.writeFile(`${CACHE_PREFIX}${cacheKey(reference)}.json`, new TextEncoder().encode(JSON.stringify({ session: { ...session, startTime: session.startTime.toISOString(), endTime: session.endTime.toISOString() } })));
}

function cacheKey(reference: InsightsSessionReference): string {
  return createHash('sha256').update(JSON.stringify({ parser: PARSER_VERSION, reference })).digest('hex');
}
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
