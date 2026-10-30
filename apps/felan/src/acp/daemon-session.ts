import { DAEMON_VERSION } from '@felan-ai/daemon';
import { resolve } from 'node:path';
import { LIMITS, type Message, type SessionSnapshot } from '@felan-ai/session-protocol';
import { SessionClient, type SessionClientOptions } from '../client/client.js';
import { clientDaemonTarget } from '../client-application.js';
import { resolveClientHostComposition, resolveInstalledDaemonEntrypoint } from '../daemon-entrypoint.js';
import { FELAN_VERSION } from '../version.js';

export interface DaemonClientOptions {
  readonly agentDir?: string;
  readonly daemonRuntime?: string;
  readonly sessionDir?: string;
  readonly createClient?: (options: SessionClientOptions) => SessionClient;
}

/** Backoff of 250 ms doubling to 10 s spans about 36 s over eight attempts, covering the 30 s headless reconnect window. */
const HEADLESS_RECONNECT_ATTEMPTS = 8;

export function daemonRestartRecovery(daemonRuntime?: string): string {
  const runtime = daemonRuntime && resolve(daemonRuntime);
  const target = runtime ? ` --daemon-runtime ${/^[\w\-./~:@]+$/u.test(runtime) ? runtime : `'${runtime.replaceAll("'", "'\\''")}'`}` : '';
  return `Run felan daemon restart${target} to apply the new build.`;
}

export async function createDaemonClient(options: DaemonClientOptions, kind: 'acp' | 'headless', interactionKinds: SessionClientOptions['interactionKinds'] = [], capabilities: SessionClientOptions['capabilities'] = []): Promise<SessionClient> {
  const target = clientDaemonTarget(options);
  const expectedComposition = options.createClient ? undefined : await resolveClientHostComposition(target);
  return (options.createClient ?? (settings => new SessionClient(settings)))({
    target, clientVersion: FELAN_VERSION, expectedDaemonVersion: DAEMON_VERSION, ...(expectedComposition ? { expectedComposition } : {}),
    kind, interactionKinds, capabilities, launch: { entrypoint: resolveInstalledDaemonEntrypoint() },
    ...(kind === 'headless' ? { reconnectAttempts: HEADLESS_RECONNECT_ATTEMPTS } : {}),
  });
}

export class DaemonRequestError extends Error {
  constructor(readonly code: string, message: string, readonly outcome: 'rejected' | 'indeterminate', readonly retryable: boolean) {
    super(message);
  }
}

export function accepted<T>(response: { outcome: 'accepted'; result: T } | { outcome: 'rejected' | 'indeterminate'; error: { code: string; message: string; retryable: boolean } }): T {
  if (response.outcome !== 'accepted') throw new DaemonRequestError(response.error.code, response.error.message, response.outcome, response.error.retryable);
  return response.result;
}

export async function readDaemonHistory(client: SessionClient, session: string, snapshot: SessionSnapshot): Promise<Message[]> {
  let entries = [...snapshot.history.entries];
  let cursor = snapshot.history.cursor;
  const seen = new Set<string>();
  while (cursor) {
    if (seen.has(cursor)) throw new Error('Session history cursor repeated');
    seen.add(cursor);
    const page = accepted(await client.request('session.history', { revision: snapshot.history.revision, branch: snapshot.history.branch, cursor, limit: LIMITS.pageEntries }, { session }));
    if (page.revision !== snapshot.history.revision || page.branch !== snapshot.history.branch) throw new Error('Session changed while loading history; retry the attachment');
    entries = [...page.entries, ...entries];
    cursor = page.cursor;
  }
  return entries;
}

export function waitForDaemonAttachment(client: SessionClient, session: string, signal?: AbortSignal): Promise<SessionSnapshot> {
  return new Promise((resolve, reject) => {
    let unsubscribe = () => {};
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: Error, snapshot?: SessionSnapshot) => {
      unsubscribe(); clearTimeout(timer); signal?.removeEventListener('abort', abort);
      error ? reject(error) : resolve(snapshot!);
    };
    const abort = () => finish(new Error('Client detached while waiting for session recovery'));
    const check = () => {
      const attachment = client.getAttachment(session);
      if (signal?.aborted) { abort(); return; }
      if (!attachment || ['closed', 'blocked', 'incompatible'].includes(client.status) || attachment.state.status === 'blocked') {
        finish(new Error('Session recovery failed')); return;
      }
      if (client.status !== 'ready') {
        timer ??= setTimeout(() => finish(new Error('Session reconnect timed out')), 30_000);
        return;
      }
      clearTimeout(timer); timer = undefined;
      if (attachment.state.status === 'live' && attachment.state.snapshot) finish(undefined, attachment.state.snapshot);
    };
    unsubscribe = client.subscribe(check);
    signal?.addEventListener('abort', abort, { once: true });
    check();
  });
}

export async function readCurrentDaemonHistory(client: SessionClient, session: string, signal?: AbortSignal): Promise<{ snapshot: SessionSnapshot; messages: Message[] }> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const snapshot = await waitForDaemonAttachment(client, session, signal);
    const response = await client.request('session.history', { revision: snapshot.revision, branch: snapshot.branch, limit: LIMITS.pageEntries }, { session });
    if (response.outcome !== 'accepted' && response.error.code === 'resync_required') continue;
    const history = accepted(response);
    const current = { ...snapshot, revision: history.revision, branch: history.branch, history };
    try { return { snapshot: current, messages: await readDaemonHistory(client, session, current) }; }
    catch (error) { if (!(error instanceof DaemonRequestError) || error.code !== 'resync_required') throw error; }
  }
  throw new Error('Session changed repeatedly while reading completed history');
}

export function waitForDaemonRun(client: SessionClient, session: string, runId: string, signal?: AbortSignal): Promise<SessionSnapshot> {
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let unsubscribe = () => {};
    const finish = (error?: unknown, snapshot?: SessionSnapshot) => {
      unsubscribe(); clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (error !== undefined) reject(error); else resolve(snapshot!);
    };
    const abort = () => finish(new Error('Client detached; daemon execution may still be running'));
    const check = () => {
      const attachment = client.getAttachment(session);
      if (signal?.aborted) { abort(); return; }
      if (!attachment || ['blocked', 'closed', 'incompatible'].includes(client.status) || attachment.state.status === 'blocked') {
        finish(new Error('Session connection is unavailable; daemon execution may still be running')); return;
      }
      if (client.status !== 'ready' || attachment.state.status !== 'live') {
        timer ??= setTimeout(() => finish(new Error('Session reconnect timed out; daemon execution may still be running')), 30_000);
        return;
      }
      clearTimeout(timer); timer = undefined;
      const snapshot = attachment.state.snapshot!;
      if (snapshot.run.state === 'idle' || snapshot.run.state === 'interrupted' || (snapshot.run.id && snapshot.run.id !== runId)) finish(undefined, snapshot);
    };
    unsubscribe = client.subscribe(check);
    signal?.addEventListener('abort', abort, { once: true });
    check();
  });
}
