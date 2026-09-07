import net, { type Socket } from 'node:net';
import type {
  ExtensionContext,
  InlineExtension,
  SessionStartEvent,
  UIPromptEndEvent,
  UIPromptStartEvent,
} from '@earendil-works/pi-coding-agent';

export const HERDR_EXTENSION_NAME = '@felan-ai/felan/herdr';
export const HERDR_BLOCKED_EVENT = 'herdr:blocked';

const HERDR_SOURCE = 'herdr:felan';
const HERDR_AGENT = 'felan';
const REPORT_TIMEOUTS_MS = [500, 1_500] as const;

type HerdrAgentState = 'working' | 'blocked' | 'idle';

interface HerdrEnvironment {
  readonly HERDR_ENV?: string;
  readonly HERDR_PANE_ID?: string;
  readonly HERDR_SOCKET_PATH?: string;
}

interface HerdrSessionReference {
  readonly agent_session_id?: string;
}

interface HerdrRequest {
  readonly id: string;
  readonly method: 'pane.report_agent' | 'pane.report_agent_session';
  readonly params: Readonly<Record<string, unknown>>;
}

interface HerdrQueuedState {
  readonly state: HerdrAgentState;
  readonly message?: string;
  readonly seq: number;
}

export interface CreateHerdrExtensionOptions {
  readonly environment?: HerdrEnvironment;
  readonly platform?: NodeJS.Platform;
  readonly sendRequest?: (request: HerdrRequest) => Promise<void>;
  readonly activity?: HerdrActivity;
}

export interface HerdrActivity {
  readonly hasPendingWork: () => boolean;
  readonly subscribe: (listener: () => void) => () => void;
}

export function createHerdrExtension(
  options: CreateHerdrExtensionOptions = {},
): InlineExtension {
  const environment = options.environment ?? process.env;
  const paneId = environment.HERDR_PANE_ID;
  const socketPath = environment.HERDR_SOCKET_PATH;
  const enabled = environment.HERDR_ENV === '1' && Boolean(paneId) && Boolean(socketPath);
  const endpoint = enabled
    ? herdrSocketEndpoint(socketPath!, options.platform ?? process.platform)
    : undefined;
  const sendRequest = options.sendRequest
    ?? (endpoint === undefined ? undefined : (request: HerdrRequest) => sendHerdrRequest(endpoint, request));

  return {
    name: HERDR_EXTENSION_NAME,
    hidden: true,
    factory: (pi) => {
      if (!enabled || !paneId || !sendRequest) return;

      const reporter = new HerdrReporter(paneId, sendRequest);
      let agentActive = false;
      let blockedCount = 0;
      let blockedMessage: string | undefined;
      let lastState: HerdrAgentState | undefined;
      let lastMessage: string | undefined;
      let rootSession = false;
      let promptCount = 0;
      let pendingWork = false;
      let unsubscribeActivity: (() => void) | undefined;

      const publishState = (force = false) => {
        const state = blockedCount > 0 || promptCount > 0
          ? 'blocked'
          : agentActive || pendingWork ? 'working' : 'idle';
        const message = state === 'blocked' ? blockedMessage : undefined;
        if (!force && state === lastState && message === lastMessage) return;
        lastState = state;
        lastMessage = message;
        reporter.queueState(state, message);
      };

      pi.events.on(HERDR_BLOCKED_EVENT, (data) => {
        if (!rootSession || !isRecord(data) || typeof data.active !== 'boolean') return;
        if (data.active) {
          blockedCount += 1;
          blockedMessage = typeof data.label === 'string' ? data.label : undefined;
        } else {
          blockedCount = Math.max(0, blockedCount - 1);
          if (blockedCount === 0) blockedMessage = undefined;
        }
        publishState();
      });

      pi.on('ui_prompt_start', (event: UIPromptStartEvent) => {
        if (!rootSession || !agentActive) return;
        promptCount += 1;
        blockedMessage = event.title;
        publishState();
      });

      pi.on('ui_prompt_end', (_event: UIPromptEndEvent) => {
        if (!rootSession || promptCount === 0) return;
        promptCount -= 1;
        if (promptCount === 0) blockedMessage = undefined;
        publishState();
      });

      pi.on('session_start', async (event, context) => {
        if (context.mode !== 'tui') return;
        rootSession = true;
        pendingWork = options.activity?.hasPendingWork() ?? false;
        reporter.updateSessionReference(context);
        await reporter.reportSession(event.reason);
        agentActive = !context.isIdle();
        publishState(true);
        unsubscribeActivity?.();
        unsubscribeActivity = options.activity?.subscribe(() => {
          if (!rootSession) return;
          pendingWork = options.activity?.hasPendingWork() ?? false;
          publishState();
        });
      });

      pi.on('agent_start', async (_event, context) => {
        if (!rootSession) return;
        reporter.updateSessionReference(context);
        await reporter.reportSession();
        agentActive = true;
        publishState();
      });

      pi.on('agent_settled', (_event, context) => {
        if (!rootSession || !context.isIdle()) return;
        agentActive = false;
        publishState();
      });

      pi.on('session_shutdown', () => {
        unsubscribeActivity?.();
        unsubscribeActivity = undefined;
        rootSession = false;
      });
    },
  };
}

export function herdrSocketEndpoint(socketPath: string, platform: NodeJS.Platform): string {
  return platform === 'win32' ? `\\\\.\\pipe\\${socketPath}` : socketPath;
}

export async function sendHerdrRequest(endpoint: string, request: HerdrRequest): Promise<void> {
  for (const timeoutMs of REPORT_TIMEOUTS_MS) {
    if (await sendHerdrRequestAttempt(endpoint, request, timeoutMs)) return;
  }
}

class HerdrReporter {
  readonly #paneId: string;
  readonly #sendRequest: (request: HerdrRequest) => Promise<void>;
  #sequence = Date.now() * 1_000;
  #sessionReference: HerdrSessionReference = {};
  #queuedState: HerdrQueuedState | undefined;
  #sendInFlight = false;

  constructor(paneId: string, sendRequest: (request: HerdrRequest) => Promise<void>) {
    this.#paneId = paneId;
    this.#sendRequest = sendRequest;
  }

  updateSessionReference(context: ExtensionContext): void {
    let sessionId: string | undefined;
    try {
      const value = context.sessionManager.getSessionId();
      if (typeof value === 'string' && value.length > 0) sessionId = value;
    } catch {}
    this.#sessionReference = sessionId ? { agent_session_id: sessionId } : {};
  }

  async reportSession(sessionStartSource?: SessionStartEvent['reason']): Promise<void> {
    if (!this.#sessionReference.agent_session_id) return;
    await this.#deliver({
      id: this.#requestId('session'),
      method: 'pane.report_agent_session',
      params: {
        pane_id: this.#paneId,
        source: HERDR_SOURCE,
        agent: HERDR_AGENT,
        seq: this.#nextSequence(),
        ...(sessionStartSource === undefined ? {} : { session_start_source: sessionStartSource }),
        ...this.#sessionReference,
      },
    });
  }

  queueState(state: HerdrAgentState, message?: string): void {
    this.#queuedState = {
      state,
      ...(message === undefined ? {} : { message }),
      seq: this.#nextSequence(),
    };
    if (!this.#sendInFlight) void this.#drainStateQueue();
  }

  async #drainStateQueue(): Promise<void> {
    if (this.#sendInFlight) return;
    this.#sendInFlight = true;
    try {
      while (this.#queuedState) {
        const queued = this.#queuedState;
        this.#queuedState = undefined;
        await this.#deliver({
          id: this.#requestId('state'),
          method: 'pane.report_agent',
          params: {
            pane_id: this.#paneId,
            source: HERDR_SOURCE,
            agent: HERDR_AGENT,
            state: queued.state,
            ...(queued.message === undefined ? {} : { message: queued.message }),
            seq: queued.seq,
            ...this.#sessionReference,
          },
        });
      }
    } finally {
      this.#sendInFlight = false;
      if (this.#queuedState) void this.#drainStateQueue();
    }
  }

  async #deliver(request: HerdrRequest): Promise<void> {
    try {
      await this.#sendRequest(request);
    } catch {}
  }

  #nextSequence(): number {
    this.#sequence += 1;
    return this.#sequence;
  }

  #requestId(kind: 'session' | 'state'): string {
    return `${HERDR_SOURCE}:${kind}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
  }
}

function sendHerdrRequestAttempt(
  endpoint: string,
  request: HerdrRequest,
  timeoutMs: number,
): Promise<boolean> {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
