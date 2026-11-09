import { createHash } from 'node:crypto';
import { availableParallelism } from 'node:os';
import { computeAnalytics } from './analytics.js';
import { getInsightsArgumentCompletions, parseInsightsArgs } from './cli.js';
import { sessionsForRange, withoutSharedEntries } from './dashboard.js';
import { INSIGHTS_DEFAULT_RANGE } from './data.js';
import { generateMarkdown } from './markdown.js';
import { parseSessionEvents, parseSessionTranscript } from './parser.js';
import { renderReport } from './report.js';
import type { InsightsHost, InsightsLoadedSession, InsightsReport, InsightsSessionReference } from './contracts.js';
import { SessionsServiceError, type AgentRuntime, type ExtensionUi, type FelanExtension } from '@felan-ai/agent-core';
import type { ParsedSession } from './types.js';

const CACHE_DIRECTORY = 'insights/session-meta';
const CACHE_PREFIX = `${CACHE_DIRECTORY}/`;
const CACHE_FILE = /^[0-9a-f]{64}\.json$/u;
const STATUS_ID = 'insights';
const MAX_SESSION_BYTES = 64 * 1024 * 1024;
const PARSER_VERSION = '3';

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
  readonly ui: Pick<ExtensionUi, 'notify'> & Partial<Pick<ExtensionUi, 'status' | 'removeStatus'>>;
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
            else await ctx.ui.notify(text, level);
          };
          const parsed = parseInsightsArgs(args ?? '');
          if (!parsed.ok) { await notify(parsed.error, 'error'); return; }
          const options = parsed.options;
          await notify('Scanning available sessions…', 'info');
          const stopped = async () => {
            try { await notify('Insights stopped because this session is cancelling or closing.', 'warning'); } catch {}
          };
          let references: readonly InsightsSessionReference[];
          try { references = await host.listSessions(pi.runtime, signal); } catch (error) {
            signal?.throwIfAborted();
            if (unavailable(error)) { await stopped(); return; }
            const reason = binding ? (error instanceof SessionsServiceError ? ` (${error.code})` : '') : `: ${errorMessage(error)}`;
            await notify(`Could not list sessions${reason}.`, 'error'); return;
          }
          const native = !binding && typeof ctx.ui?.setStatus === 'function';
          const setStatus = binding?.ui.status ? (text: string) => binding.ui.status!({ id: STATUS_ID, kind: 'status', key: STATUS_ID, value: { kind: 'text', text }, fallback: text })
            : native ? async (text: string) => ctx.ui.setStatus(STATUS_ID, text) : undefined;
          const clearStatus = binding?.ui.removeStatus ? () => binding.ui.removeStatus!(STATUS_ID)
            : native ? async () => ctx.ui.setStatus(STATUS_ID, undefined) : undefined;
          // Status is advisory, so updates are serialized off the scan path and their failures ignored.
          let statusQueue = Promise.resolve();
          const status = (update: (() => Promise<void>) | undefined) => {
            if (update) statusQueue = statusQueue.then(update).catch(() => {});
          };
          let shownPercent = -1;
          const progress = (done: number) => {
            const percent = Math.floor((done * 100) / Math.max(1, references.length));
            if (percent === shownPercent) return;
            shownPercent = percent;
            status(setStatus && (() => setStatus(`Insights: scanning sessions ${done}/${references.length}`)));
          };
          let scan: Awaited<ReturnType<typeof loadSessions>>;
          try {
            progress(0);
            scan = await loadSessions(host, pi.runtime, references, options.refresh, progress, signal);
          } catch (error) {
            if (!unavailable(error)) throw error;
            await stopped();
            return;
          } finally {
            status(clearStatus);
            await statusQueue;
          }
          const { skipped } = scan;
          const loaded = withoutSharedEntries(scan.loaded);
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
          analytics.cache = { root: pi.runtime.storage('agent').root, refreshed: options.refresh, versions: { schema: '2', parser: PARSER_VERSION }, sessionMeta: { hits: scan.hits, misses: scan.misses, writes: scan.writes, errors: scan.errors } };
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

async function loadSessions(host: InsightsHost, runtime: AgentRuntime, references: readonly InsightsSessionReference[], refresh: boolean,
  progress: (done: number) => void, signal?: AbortSignal) {
  const skipped = new Map<string, number>();
  const skip = (reason: string) => { skipped.set(reason, (skipped.get(reason) ?? 0) + 1); };
  const sessions: Array<InsightsLoadedSession | undefined> = [];
  const keys = new Set<string>();
  let unavailable: SessionsServiceError | undefined;
  let hits = 0, misses = 0, writes = 0, errors = 0, done = 0;
  const load = async (reference: InsightsSessionReference, index: number) => {
    const key = cacheKey(reference);
    keys.add(key);
    if (reference.unavailable) { skip(reference.unavailable); return; }
    if (reference.size !== undefined && (!Number.isSafeInteger(reference.size) || reference.size < 0 || reference.size > MAX_SESSION_BYTES)) { skip('oversize'); return; }
    const rootId = reference.rootSessionId ?? reference.id;
    const cached = refresh ? undefined : await readCachedSession(runtime, key);
    signal?.throwIfAborted();
    if (unavailable) return;
    if (cached?.activity) { hits++; sessions[index] = { rootId, session: cached }; return; }
    misses++;
    let session: ParsedSession | null;
    try {
      if (host.readSessionEntries) {
        const events = await host.readSessionEntries(runtime, reference, signal);
        signal?.throwIfAborted();
        if (!events.length) { skip('empty'); return; }
        session = parseSessionEvents(events, reference.id);
      } else {
        const transcript = host.readSessionLines
          ? await collectLines(host.readSessionLines(runtime, reference, signal), signal)
          : await host.readSession(runtime, reference, signal);
        signal?.throwIfAborted();
        if (!transcript) { skip('empty'); return; }
        if (new TextEncoder().encode(transcript).byteLength > MAX_SESSION_BYTES) { skip('oversize'); return; }
        session = parseSessionTranscript(transcript, reference.id);
      }
    } catch (error) {
      if (error instanceof SessionsServiceError && error.code === 'unavailable') {
        unavailable ??= error;
        throw error;
      }
      signal?.throwIfAborted();
      skip(error instanceof SessionsServiceError ? error.code : 'unreadable'); return;
    }
    signal?.throwIfAborted();
    if (!session) { skip('unparseable'); return; }
    try { await writeCachedSession(runtime, key, session); writes++; } catch { errors++; }
    signal?.throwIfAborted();
    sessions[index] = { rootId, session };
  };
  let next = 0;
  const worker = async () => {
    while (next < references.length && !unavailable) {
      signal?.throwIfAborted();
      const index = next++;
      await load(references[index]!, index);
      progress(++done);
    }
  };
  const results = await Promise.allSettled(Array.from({ length: Math.min(references.length, availableParallelism()) }, worker));
  if (unavailable) throw unavailable;
  const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
  if (failure) throw failure.reason;
  errors += await pruneCache(runtime, keys);
  return { loaded: sessions.filter((session): session is InsightsLoadedSession => session !== undefined), skipped, hits, misses, writes, errors };
}

async function pruneCache(runtime: AgentRuntime, keep: ReadonlySet<string>): Promise<number> {
  const storage = runtime.storage('agent');
  let files: string[];
  try { files = await storage.listFiles(CACHE_DIRECTORY); } catch { return 0; }
  let errors = 0;
  for (const file of Array.isArray(files) ? files : []) {
    if (!CACHE_FILE.test(file) || keep.has(file.slice(0, -'.json'.length))) continue;
    try { await storage.remove(`${CACHE_PREFIX}${file}`); } catch { errors++; }
  }
  return errors;
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

async function readCachedSession(runtime: AgentRuntime, key: string): Promise<ParsedSession | undefined> {
  try {
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

async function writeCachedSession(runtime: AgentRuntime, key: string, session: ParsedSession): Promise<void> {
  const storage = runtime.storage('agent');
  await storage.mkdir(CACHE_PREFIX, { recursive: true });
  await storage.writeFile(`${CACHE_PREFIX}${key}.json`, new TextEncoder().encode(JSON.stringify({ session: { ...session, startTime: session.startTime.toISOString(), endTime: session.endTime.toISOString() } })));
}

// Listing metadata identifies a transcript version, so a cache hit needs no transcript or checkpoint read.
function cacheKey(reference: InsightsSessionReference): string {
  const { id, rootSessionId, modifiedAtMs, contentVersion, size } = reference;
  return createHash('sha256').update(JSON.stringify({ parser: PARSER_VERSION, id, root: rootSessionId ?? id, modifiedAtMs, contentVersion, size })).digest('hex');
}
function unavailable(error: unknown): boolean { return error instanceof SessionsServiceError && error.code === 'unavailable'; }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
