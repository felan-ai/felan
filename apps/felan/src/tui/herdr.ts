import net, { type Socket } from 'node:net';
import type { Execution, Interaction, SessionSnapshot } from '@felan-ai/session-protocol';
import type { TuiSessionController } from './controller.js';

const HERDR_SOURCE = 'herdr:felan';
const HERDR_AGENT = 'felan';
const REPORT_TIMEOUTS_MS = [500, 1_500] as const;

export type HerdrAgentState = 'working' | 'blocked' | 'idle';

export interface HerdrStatus {
  readonly session?: string;
  readonly state: HerdrAgentState;
  readonly message?: string;
}

export interface HerdrRequest {
  readonly id: string;
  readonly method: 'pane.report_agent' | 'pane.report_agent_session';
  readonly params: Readonly<Record<string, unknown>>;
}

interface HerdrEnvironment {
  readonly HERDR_ENV?: string;
  readonly HERDR_PANE_ID?: string;
  readonly HERDR_SOCKET_PATH?: string;
}

/**
 * Herdr identifies a pane by the environment of the process running in it, so only the terminal client can report
 * for its pane; the shared daemon was launched from an arbitrary pane and hosts every client's sessions.
 */
export function createHerdrPane(options: {
  environment?: HerdrEnvironment;
  platform?: NodeJS.Platform;
  isInteractive?: boolean;
  sendRequest?: (request: HerdrRequest) => Promise<void>;
} = {}): HerdrPane | undefined {
  const environment = options.environment ?? process.env;
  const paneId = environment.HERDR_PANE_ID;
  const socketPath = environment.HERDR_SOCKET_PATH;
  const isInteractive = options.isInteractive ?? (process.stdin.isTTY === true && process.stdout.isTTY === true);
  if (!isInteractive || environment.HERDR_ENV !== '1' || !paneId || !socketPath) return undefined;
  const endpoint = herdrSocketEndpoint(socketPath, options.platform ?? process.platform);
  return new HerdrPane(paneId, options.sendRequest ?? (request => sendHerdrRequest(endpoint, request)));
}

/**
 * Keeps the pane in step with the attached session. `executions` lists descendants too: a subagent's own subagents
 * can outlive it, and the root's execution generation changes whenever any execution in its tree does.
 */
export function reportHerdrPane(controller: TuiSessionController, pane: HerdrPane, prompts: () => readonly Interaction[]): () => void {
  let executions: { session: string; rows: readonly Execution[] } | undefined;
  let loaded: string | undefined;
  let loading = false;
  let closed = false;
  const target = () => {
    const session = controller.sessionId; const state = controller.state;
    if (!session || state?.status !== 'live' || !controller.client.capabilities?.operations.includes('executions.list')) return undefined;
    return { session, key: `${session}\0${state.snapshot?.executionsGeneration ?? ''}` };
  };
  const report = () => {
    if (closed) return;
    const rows = executions && executions.session === controller.sessionId ? executions.rows : undefined;
    if (!rows && target()) return;
    pane.update(herdrStatus(controller.snapshot, prompts(), rows ?? []));
  };
  const refresh = async () => {
    if (loading) return;
    loading = true;
    try {
      for (let current = target(); current && current.key !== loaded && !closed; current = target()) {
        loaded = current.key;
        try { executions = { session: current.session, rows: await listExecutions(controller, current.session) }; }
        catch { if (executions?.session !== current.session) executions = { session: current.session, rows: [] }; }
        report();
      }
    } finally { loading = false; }
  };
  const unsubscribe = controller.subscribe(() => { report(); void refresh(); });
  report(); void refresh();
  return () => { closed = true; unsubscribe(); };
}

async function listExecutions(controller: TuiSessionController, session: string): Promise<Execution[]> {
  const rows: Execution[] = []; const cursors = new Set<string>(); let cursor: string | undefined;
  do {
    const response = await controller.client.request('executions.list', { includeDescendants: true, limit: 100, ...(cursor === undefined ? {} : { cursor }) }, { session });
    if (response.outcome !== 'accepted') throw new Error(response.error.message);
    rows.push(...response.result.items);
    cursor = response.result.nextCursor;
    if (cursor !== undefined && (cursors.has(cursor) || rows.length > 4096)) throw new Error('Execution catalog did not advance.');
    if (cursor !== undefined) cursors.add(cursor);
  } while (cursor !== undefined);
  return rows;
}

/**
 * A prompt waiting for the user blocks the session. Queued or running executions anywhere below it, and direct
 * children whose result it has not consumed yet, keep it working, so a delegated workflow ends with one completion
 * rather than one per child.
 */
export function herdrStatus(snapshot: SessionSnapshot | undefined, prompts: readonly Interaction[], executions: readonly Execution[]): HerdrStatus {
  if (!snapshot) return { state: 'idle' };
  const waiting = prompts.find(item => item.state === 'waiting' || item.state === 'deferred');
  if (waiting) {
    const message = interactionLabel(waiting.request);
    return { session: snapshot.session, state: 'blocked', ...(message === undefined ? {} : { message }) };
  }
  const working = ['running', 'waiting', 'cancelling'].includes(snapshot.run.state)
    || executions.some(row => row.state === 'queued' || row.state === 'running' || row.parent === snapshot.session && row.completionPending === true);
  return { session: snapshot.session, state: working ? 'working' : 'idle' };
}

function interactionLabel(request: Interaction['request']): string | undefined {
  switch (request.kind) {
    case 'form': return request.form.title;
    case 'tool_approval': return `Approve ${request.toolName}`;
    case 'dependency': return request.message;
    default: return request.title;
  }
}

export class HerdrPane {
  readonly #paneId: string;
  readonly #sendRequest: (request: HerdrRequest) => Promise<void>;
  #sequence = Date.now() * 1_000;
  #session: string | undefined;
  #sessionPending = false;
  #lastState: string | undefined;
  #queued: { state: HerdrAgentState; message?: string } | undefined;
  #sending = false;

  constructor(paneId: string, sendRequest: (request: HerdrRequest) => Promise<void>) {
    this.#paneId = paneId;
    this.#sendRequest = sendRequest;
  }

  /** Reports only changes; nothing is sent until a session is attached. A newly attached session is announced before its state. */
  update(status: HerdrStatus): void {
    if (status.session && status.session !== this.#session) {
      this.#session = status.session; this.#sessionPending = true; this.#lastState = undefined;
    }
    if (!this.#session) return;
    const key = `${status.state}\0${status.message ?? ''}`;
    if (key === this.#lastState) return;
    this.#lastState = key;
    this.#queued = { state: status.state, ...(status.message === undefined ? {} : { message: status.message }) };
    void this.#drain();
  }

  async #drain(): Promise<void> {
    if (this.#sending) return;
    this.#sending = true;
    try {
      while (this.#sessionPending || this.#queued) {
        if (this.#sessionPending) {
          this.#sessionPending = false;
          await this.#deliver('session', 'pane.report_agent_session', {});
          continue;
        }
        const queued = this.#queued!;
        this.#queued = undefined;
        await this.#deliver('state', 'pane.report_agent', queued);
      }
    } finally {
      this.#sending = false;
    }
  }

  async #deliver(kind: 'session' | 'state', method: HerdrRequest['method'], params: Readonly<Record<string, unknown>>): Promise<void> {
    this.#sequence += 1;
    try {
      await this.#sendRequest({
        id: `${HERDR_SOURCE}:${kind}:${Date.now()}:${Math.random().toString(36).slice(2)}`,
        method,
        params: { pane_id: this.#paneId, source: HERDR_SOURCE, agent: HERDR_AGENT, ...params, seq: this.#sequence,
          ...(this.#session ? { agent_session_id: this.#session } : {}) },
      });
    } catch {}
  }
}

export function herdrSocketEndpoint(socketPath: string, platform: NodeJS.Platform): string {
  return platform === 'win32' ? `\\\\.\\pipe\\${socketPath}` : socketPath;
}

export async function sendHerdrRequest(endpoint: string, request: HerdrRequest): Promise<void> {
  for (const timeoutMs of REPORT_TIMEOUTS_MS) {
    if (await sendHerdrRequestAttempt(endpoint, request, timeoutMs)) return;
  }
}

function sendHerdrRequestAttempt(endpoint: string, request: HerdrRequest, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let socket: Socket;
    try {
      socket = net.createConnection(endpoint);
    } catch {
      resolve(false);
      return;
    }

    let settled = false;
    let timeout: NodeJS.Timeout | undefined;
    const finish = (delivered: boolean) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      socket.destroy();
      resolve(delivered);
    };

    socket.on('error', () => finish(false));
    socket.on('connect', () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on('data', () => finish(true));
    socket.on('end', () => finish(false));
    timeout = setTimeout(() => finish(false), timeoutMs);
    timeout.unref();
  });
}
