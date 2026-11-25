import type { AgentRuntime, Logger } from '@felan-ai/agent-core';
import { successData } from './attachment.js';
import { readBrowserStreamStatus } from './cli.js';
import type { BrowserSessionScope } from './cli.js';
import type { AgentBrowserInvocation } from './installer.js';

const HOST_CALL_TIMEOUT_MS = 5_000;

export interface BrowserLiveViewStream {
  readonly sessionId: string;
  /** agent-browser binds its WebSocket stream server to 127.0.0.1 in the runtime that runs the CLI. */
  readonly port: number;
}

export interface BrowserLiveViewSession {
  readonly sessionId: string;
}

/**
 * Hosts receive reports only for the Felan-owned browser, never for an attachment from `browser_authorize`.
 * `withdraw` can follow a report that failed, and the daemon may still exit on its idle timeout without a withdrawal.
 * Each call has five seconds before Felan logs it as failed and moves on. When a timed-out call settles later and
 * the session's state has changed meanwhile, Felan repeats the current report or withdrawal, so the last call wins.
 */
export interface BrowserLiveViewService {
  report(stream: BrowserLiveViewStream): void | Promise<void>;
  withdraw(session: BrowserLiveViewSession): void | Promise<void>;
}

interface LiveViewReport {
  readonly port: number;
  delivered: boolean;
  stale: boolean;
}

export class BrowserLiveViewReporter {
  readonly #reports = new Map<string, LiveViewReport>();
  // One queue keeps a withdrawal from overtaking the report it replaces.
  #queue: Promise<void> = Promise.resolve();
  #closed = false;

  constructor(readonly service: BrowserLiveViewService, readonly logger: Logger) {}

  get closed(): boolean {
    return this.#closed;
  }

  needsPort(sessionId: string, commandStdout: string): boolean {
    if (this.#closed) return false;
    const report = this.#reports.get(sessionId);
    return report?.delivered !== true || report.stale || mayHaveStartedBrowser(commandStdout);
  }

  /** A failed command may still have started a new daemon, so the next successful command reads the port again. */
  markStale(sessionId: string): void {
    const report = this.#reports.get(sessionId);
    if (report) report.stale = true;
  }

  report(sessionId: string, port: number): Promise<void> {
    if (this.#closed) return Promise.resolve();
    const current = this.#reports.get(sessionId);
    if (current?.delivered && current.port === port) {
      current.stale = false;
      return Promise.resolve();
    }
    const report: LiveViewReport = { port, delivered: false, stale: false };
    this.#reports.set(sessionId, report);
    return this.#send(sessionId, report);
  }

  withdraw(sessionId: string): Promise<void> {
    if (!this.#reports.delete(sessionId)) return Promise.resolve();
    return this.#send(sessionId, undefined);
  }

  async close(): Promise<void> {
    this.#closed = true;
    await Promise.all([...this.#reports.keys()].map(sessionId => this.withdraw(sessionId)));
    await this.#queue;
  }

  #send(sessionId: string, report: LiveViewReport | undefined): Promise<void> {
    const action = report ? 'report' : 'withdraw';
    const next = this.#queue.then(async () => {
      const call = Promise.resolve().then(() => report
        ? this.service.report({ sessionId, port: report.port })
        : this.service.withdraw({ sessionId }));
      try {
        await withTimeout(call, action);
        if (report) report.delivered = true;
      } catch (error) {
        this.logger.warn({ error: error instanceof Error ? error.message : String(error) }, `Browser live-view ${action} failed`);
        void call.then(() => {
          if (report) report.delivered = true;
          const current = this.#reports.get(sessionId);
          if (current !== report) void this.#send(sessionId, current);
        }, () => {});
      }
    });
    this.#queue = next;
    return next;
  }
}

export async function readBrowserStreamPort(
  runtime: AgentRuntime,
  invocation: AgentBrowserInvocation,
  scope: BrowserSessionScope,
  signal?: AbortSignal,
): Promise<number | undefined> {
  const result = await readBrowserStreamStatus(runtime, invocation, scope, {
    timeoutMs: 15_000,
    ...(signal === undefined ? {} : { signal }),
  });
  const port = successData(result).port;
  return typeof port === 'number' && Number.isInteger(port) && port >= 1 && port <= 65_535 ? port : undefined;
}

// A new daemon binds a new stream port, and every daemon response carries its lifecycle.
function mayHaveStartedBrowser(stdout: string): boolean {
  let lifecycle: unknown;
  try { lifecycle = (JSON.parse(stdout) as { data?: { lifecycle?: unknown } } | null)?.data?.lifecycle; } catch { return true; }
  if (typeof lifecycle !== 'object' || lifecycle === null) return true;
  const { launched, relaunchedBrowser, restartedBackground } = lifecycle as Record<string, unknown>;
  return launched === true || relaunchedBrowser === true || restartedBackground === true;
}

async function withTimeout(value: Promise<void>, action: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      value,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Host ${action} timed out.`)), HOST_CALL_TIMEOUT_MS);
      }),
    ]);
  } finally { clearTimeout(timer); }
}
