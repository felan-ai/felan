import { DAEMON_VERSION } from '@felan-ai/daemon';
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

export async function createDaemonClient(options: DaemonClientOptions, kind: 'acp' | 'headless', interactionKinds: SessionClientOptions['interactionKinds'] = [], capabilities: SessionClientOptions['capabilities'] = []): Promise<SessionClient> {
  const target = clientDaemonTarget(options);
  const expectedComposition = options.createClient ? undefined : await resolveClientHostComposition(target);
  return (options.createClient ?? (settings => new SessionClient(settings)))({
    target, clientVersion: FELAN_VERSION, expectedDaemonVersion: DAEMON_VERSION, ...(expectedComposition ? { expectedComposition } : {}),
    kind, interactionKinds, capabilities, launch: { entrypoint: resolveInstalledDaemonEntrypoint() },
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
  let bytes = Buffer.byteLength(JSON.stringify(entries));
  const seen = new Set<string>();
  while (cursor) {
    if (seen.has(cursor) || seen.size >= 400) throw new Error('Session history exceeds the client page limit');
    seen.add(cursor);
    const page = accepted(await client.request('session.history', { revision: snapshot.history.revision, branch: snapshot.history.branch, cursor, limit: LIMITS.pageEntries }, { session }));
    if (page.revision !== snapshot.history.revision || page.branch !== snapshot.history.branch) throw new Error('Session changed while loading history; retry the attachment');
    bytes += Buffer.byteLength(JSON.stringify(page.entries));
    entries = [...page.entries, ...entries];
    if (entries.length > 100_000 || bytes > 64 * 1024 * 1024) throw new Error('Session history exceeds the client display limit');
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
      if (client.status === 'ready' && attachment.state.status === 'live' && attachment.state.snapshot) finish(undefined, attachment.state.snapshot);
    };
    unsubscribe = client.subscribe(check);
    signal?.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => finish(new Error('Session recovery timed out')), 30_000);
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
