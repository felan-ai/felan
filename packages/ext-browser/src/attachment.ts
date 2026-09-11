import type { AgentRuntime, ExtensionContext } from '@felan-ai/agent-core';
import type {
  BrowserAuthorizationConnection,
  BrowserAuthorizationHost,
  BrowserAuthorizationLease,
} from './authorization.js';
import { createBrowserAttachmentScope, runBrowserCli } from './cli.js';
import type { BrowserCliResult, BrowserSessionScope } from './cli.js';
import type { AgentBrowserInvocation } from './installer.js';

type AttachmentState = 'pending' | 'authorized' | 'blocked' | 'revoked';

export interface BrowserAttachment {
  readonly root: BrowserSessionScope;
  readonly scope: BrowserSessionScope;
  readonly origin: string;
  readonly controller: AbortController;
  readonly rejectedLeases: Set<BrowserAuthorizationLease>;
  state: AttachmentState;
  authorization: Promise<AuthorizationResult>;
  invocation?: AgentBrowserInvocation;
  lease?: BrowserAuthorizationLease;
  endpoint?: string;
  targetId?: string;
  daemonPid?: number;
  attempted: boolean;
  started: boolean;
  verified: boolean;
  nativeOperation?: Promise<BrowserCliResult>;
  cleanup?: Promise<boolean>;
  cleanupVerified: boolean;
  removeLeaseListener?: () => void;
}

export interface AuthorizationResult {
  readonly state: 'authorized' | 'cancelled' | 'unavailable' | 'idle' | 'blocked' | 'revoked';
  readonly message?: string;
  readonly reused?: boolean;
}

export class BrowserAttachments {
  readonly #attempts = new Map<string, BrowserAttachment>();
  readonly #history = new Set<BrowserAttachment>();
  #closed = false;

  constructor(
    readonly runtime: AgentRuntime,
    readonly host: BrowserAuthorizationHost | undefined,
    readonly getInvocation: (signal?: AbortSignal) => Promise<AgentBrowserInvocation>,
  ) {}

  current(root: BrowserSessionScope): BrowserAttachment | undefined {
    if (this.#closed) throw new Error('Browser session is closed.');
    const attempt = this.#attempts.get(scopeKey(root));
    if (!attempt) return undefined;
    this.assertActive(attempt);
    return attempt;
  }

  assertActive(attempt: BrowserAttachment): void {
    if (this.#closed || this.#attempts.get(scopeKey(attempt.root)) !== attempt
      || attempt.state !== 'authorized' || attempt.controller.signal.aborted || attempt.lease?.signal.aborted
      || this.#uncleanPrevious(attempt.root, attempt)) {
      throw new Error('Existing-browser authorization is inactive or quarantined; authorize again before using browser.');
    }
  }

  async status(root: BrowserSessionScope): Promise<AuthorizationResult> {
    const attempt = this.#attempts.get(scopeKey(root));
    if (!attempt) return { state: 'idle' };
    if (this.#uncleanPrevious(root, attempt)) return { state: 'unavailable', message: 'Previous browser cleanup is unconfirmed.' };
    if (attempt.state === 'authorized') {
      try {
        await this.verify(attempt);
        return { state: 'authorized' };
      } catch {
        return { state: 'blocked', message: 'Existing-browser authorization is no longer active.' };
      }
    }
    if (attempt.state === 'revoked' && !attempt.cleanupVerified) {
      return { state: 'unavailable', message: 'Browser access is blocked, but cleanup is unconfirmed.' };
    }
    return { state: attempt.state === 'revoked' ? 'revoked' : 'blocked' };
  }

  async authorize(
    root: BrowserSessionScope,
    origin: string,
    context: ExtensionContext,
    signal?: AbortSignal,
  ): Promise<AuthorizationResult> {
    if (this.#closed || signal?.aborted) return { state: 'cancelled' };
    if (!this.host) return { state: 'unavailable', message: 'Existing-browser authorization is unavailable in this host.' };
    const key = scopeKey(root);
    const previous = this.#attempts.get(key);
    if (previous?.state === 'pending') {
      if (previous.origin !== origin) return { state: 'unavailable', message: 'Another browser authorization request is already in progress.' };
      try {
        return await (signal ? abortable(previous.authorization, signal) : previous.authorization);
      } catch { return { state: 'cancelled', message: 'This authorization request was cancelled.' }; }
    }
    if (previous?.state === 'authorized') {
      if (previous.origin !== origin) return { state: 'unavailable', message: 'Revoke the current browser authorization before authorizing a different origin.' };
      try {
        await this.verify(previous, signal);
        return { state: 'authorized', reused: true };
      } catch {
        return { state: 'unavailable', message: 'Existing-browser authorization was lost. Request authorization again.' };
      }
    }
    if ((previous && !previous.cleanupVerified) || this.#uncleanPrevious(root, previous)) {
      return { state: 'unavailable', message: 'Previous browser cleanup is unconfirmed. Revoke again before requesting authorization.' };
    }

    const attempt: BrowserAttachment = {
      root: { ...root },
      scope: createBrowserAttachmentScope(this.runtime, context.sessionManager.getSessionId()),
      origin,
      controller: new AbortController(),
      rejectedLeases: new Set(),
      state: 'pending',
      authorization: Promise.resolve({ state: 'unavailable' }),
      attempted: false,
      started: false,
      verified: false,
      cleanupVerified: false,
    };
    this.#attempts.set(key, attempt);
    this.#history.add(attempt);
    attempt.authorization = this.#authorize(attempt, context, signal);
    return attempt.authorization;
  }

  async #authorize(attempt: BrowserAttachment, context: ExtensionContext, signal?: AbortSignal): Promise<AuthorizationResult> {
    const authorizationSignal = attempt.controller.signal;
    const onAbort = () => attempt.controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    const timeout = setTimeout(() => attempt.controller.abort(), 120_000);
    try {
      const outcome = await abortable(this.host!.authorize({
        origin: attempt.origin,
        signal: authorizationSignal,
        extensionContext: context,
        attach: (connection, lease) => this.#attach(attempt, connection, lease, authorizationSignal),
      }), authorizationSignal);
      if (outcome.status === 'authorized' && attempt.verified && this.#isCurrent(attempt) && !authorizationSignal.aborted) {
        await this.#observe(attempt, authorizationSignal);
        authorizationSignal.throwIfAborted();
        if (!this.#isCurrent(attempt)) throw new Error('Authorization request is no longer active.');
        attempt.state = 'authorized';
        return { state: 'authorized' };
      }
      await this.invalidate(attempt);
      return outcome.status === 'cancelled'
        ? { state: 'cancelled', message: 'Existing-browser authorization was cancelled.' }
        : { state: 'unavailable', message: 'Chrome authorization did not complete a verified attachment.' };
    } catch {
      const cancelled = signal?.aborted || this.#closed || attempt.state === 'revoked';
      await this.invalidate(attempt);
      return cancelled
        ? { state: 'cancelled', message: 'Existing-browser authorization was cancelled.' }
        : { state: 'unavailable', message: 'Chrome authorization could not be completed.' };
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  async #attach(
    attempt: BrowserAttachment,
    connection: BrowserAuthorizationConnection,
    lease: BrowserAuthorizationLease | undefined,
    signal: AbortSignal,
  ) {
    if (attempt.attempted || !this.#isCurrent(attempt) || signal.aborted) {
      if (lease && lease !== attempt.lease) await this.#rejectLease(attempt, lease);
      return { ready: false, reason: 'Chrome attachment is no longer available for this request.' };
    }
    attempt.attempted = true;
    if (!lease || typeof lease.close !== 'function' || !lease.signal || lease.signal.aborted) {
      if (lease) await this.#rejectLease(attempt, lease);
      return { ready: false, reason: 'The host must provide a revocable single-connection browser lease.' };
    }
    attempt.lease = lease;
    const onDisconnect = () => { void this.invalidate(attempt); };
    lease.signal.addEventListener('abort', onDisconnect, { once: true });
    attempt.removeLeaseListener = () => lease.signal.removeEventListener('abort', onDisconnect);
    try {
      attempt.endpoint = validateConnection(connection);
      attempt.invocation = await this.getInvocation(signal);
      signal.throwIfAborted();
      if (!this.#isCurrent(attempt)) throw new Error('Authorization request is no longer active.');
      attempt.started = true;
      attempt.nativeOperation = runBrowserCli(this.runtime, attempt.invocation, [
        'open', attempt.origin, '--cdp', attempt.endpoint, '--pin-tab', '--no-auto-dialog', '--no-webmcp',
      ], attempt.scope, { internalAttachment: true, timeoutMs: 120_000, signal });
      const result = await attempt.nativeOperation;
      successData(result);
      await this.#observe(attempt, signal);
      signal.throwIfAborted();
      if (!this.#isCurrent(attempt)) throw new Error('Authorization request is no longer active.');
      attempt.verified = true;
      return { ready: true };
    } catch {
      await this.invalidate(attempt);
      return { ready: false, reason: 'Chrome did not complete the verified existing-browser connection.' };
    }
  }

  async verify(attempt: BrowserAttachment, signal?: AbortSignal): Promise<void> {
    try {
      this.assertActive(attempt);
      await this.#observe(attempt, signal);
      this.assertActive(attempt);
    } catch {
      await this.invalidate(attempt);
      throw new Error('Existing-browser authorization was lost or its target changed. No further browser action is permitted.');
    }
  }

  async #observe(attempt: BrowserAttachment, signal?: AbortSignal): Promise<void> {
    const combined = AbortSignal.any([attempt.controller.signal, ...(signal ? [signal] : [])]);
    const read = async (args: string[]) => {
      combined.throwIfAborted();
      if (!attempt.invocation || !this.#isCurrent(attempt)) throw new Error('Attachment is inactive.');
      await this.host?.checkExecution?.();
      combined.throwIfAborted();
      if (!this.#isCurrent(attempt)) throw new Error('Attachment is inactive.');
      const result = await runBrowserCli(this.runtime, attempt.invocation, args, attempt.scope, {
        signal: combined, timeoutMs: 15_000, internalAttachment: true,
        ...(args[0] === 'session' || attempt.endpoint === undefined ? {} : { attachmentEndpoint: attempt.endpoint }),
      });
      combined.throwIfAborted();
      return successData(result);
    };
    const info = await read(['session', 'info']);
    const runtime = info.runtime;
    if (info.active !== true || !isRecord(runtime) || runtime.browserLaunched !== true
      || !Number.isSafeInteger(info.pid) || Number(info.pid) <= 0 || runtime.backgroundPid !== info.pid
      || (info.runtimeError !== undefined && info.runtimeError !== null)
      || (attempt.daemonPid !== undefined && info.pid !== attempt.daemonPid)) {
      throw new Error('Browser daemon identity changed.');
    }
    const connection = await read(['get', 'cdp-url']);
    if (connection.cdpUrl !== attempt.endpoint) throw new Error('Browser connection identity changed.');
    const pages = await read(['tab', 'list']);
    if (!Array.isArray(pages.tabs)) throw new Error('Browser target observation is invalid.');
    const active = pages.tabs.filter((tab: unknown) => isRecord(tab) && tab.active === true);
    const tab = active[0] as Record<string, unknown> | undefined;
    if (active.length !== 1 || !tab || typeof tab.targetId !== 'string' || !tab.targetId
      || (attempt.targetId !== undefined && tab.targetId !== attempt.targetId)
      || originOf(tab.url) !== attempt.origin) throw new Error('Pinned browser target changed.');
    const location = await read(['get', 'url']);
    if (originOf(location.url) !== attempt.origin) throw new Error('Browser left its authorized origin.');
    attempt.daemonPid = Number(info.pid);
    attempt.targetId = tab.targetId;
  }

  async invalidate(attempt: BrowserAttachment): Promise<boolean> {
    if (attempt.state !== 'revoked') attempt.state = 'blocked';
    attempt.controller.abort();
    return this.#cleanup(attempt);
  }

  async revoke(root: BrowserSessionScope): Promise<AuthorizationResult> {
    const attempts = [...this.#history].filter(attempt => scopeKey(attempt.root) === scopeKey(root));
    if (attempts.length === 0) return { state: 'revoked' };
    const outcomes = await Promise.all(attempts.map(async attempt => {
      attempt.state = 'revoked';
      attempt.controller.abort();
      return this.#retryCleanup(attempt);
    }));
    return outcomes.every(Boolean)
      ? { state: 'revoked', message: 'Existing-browser authorization revoked. Request authorization before using this browser again.' }
      : { state: 'unavailable', message: 'Browser access is blocked, but cleanup is unconfirmed. Retry revoke; do not reconnect.' };
  }

  async #retryCleanup(attempt: BrowserAttachment): Promise<boolean> {
    if (attempt.cleanup && !attempt.cleanupVerified) {
      const previous = attempt.cleanup;
      await previous;
      if (!attempt.cleanupVerified && attempt.cleanup === previous) delete attempt.cleanup;
    }
    return this.#cleanup(attempt);
  }

  async #rejectLease(attempt: BrowserAttachment, lease: BrowserAuthorizationLease): Promise<void> {
    attempt.rejectedLeases.add(lease);
    attempt.cleanupVerified = false;
    if (attempt.state !== 'revoked') attempt.state = 'blocked';
    attempt.controller.abort();
    await this.#retryCleanup(attempt);
    if (!attempt.cleanupVerified) {
      const current = this.#attempts.get(scopeKey(attempt.root));
      if (current && current !== attempt) await this.invalidate(current);
    }
  }

  #cleanup(attempt: BrowserAttachment): Promise<boolean> {
    if (attempt.cleanup) return attempt.cleanup;
    attempt.removeLeaseListener?.();
    attempt.cleanup = (async () => {
      let clean = !attempt.lease || await closeLease(attempt.lease);
      for (const lease of attempt.rejectedLeases) {
        if (await closeLease(lease)) attempt.rejectedLeases.delete(lease);
        else clean = false;
      }
      if (attempt.nativeOperation) {
        try {
          await abortable(attempt.nativeOperation.then(() => {}, () => {}), AbortSignal.timeout(15_000));
        } catch { clean = false; }
      }
      if (attempt.started && attempt.invocation) {
        try {
          await this.host?.checkExecution?.();
          const result = await runBrowserCli(this.runtime, attempt.invocation, ['close'], attempt.scope, {
            timeoutMs: 15_000, internalAttachment: true,
          });
          successData(result);
          const deadline = AbortSignal.timeout(5_000);
          for (;;) {
            deadline.throwIfAborted();
            await this.host?.checkExecution?.();
            const status = successData(await runBrowserCli(this.runtime, attempt.invocation, ['session', 'info'], attempt.scope, {
              timeoutMs: 5_000, internalAttachment: true, signal: deadline,
            }));
            if (status.active === false && status.pid === null && status.runtime === null
              && (status.runtimeError === undefined || status.runtimeError === null)) break;
            if (status.active !== true || (status.runtime !== null
              && (!isRecord(status.runtime) || status.runtime.browserLaunched !== false))) {
              clean = false;
              break;
            }
            // Native close acknowledges before its delayed daemon shutdown notification.
            await abortable(new Promise(resolve => setTimeout(resolve, 50)), deadline);
          }
        } catch { clean = false; }
      }
      attempt.cleanupVerified = clean && attempt.rejectedLeases.size === 0;
      return attempt.cleanupVerified;
    })();
    return attempt.cleanup;
  }

  async close(): Promise<boolean> {
    this.#closed = true;
    const outcomes = await Promise.all([...this.#history].map(async attempt => {
      attempt.state = 'blocked';
      attempt.controller.abort();
      return this.#retryCleanup(attempt);
    }));
    return outcomes.every(Boolean);
  }

  #isCurrent(attempt: BrowserAttachment): boolean {
    return !this.#closed && this.#attempts.get(scopeKey(attempt.root)) === attempt
      && !attempt.controller.signal.aborted && !attempt.lease?.signal.aborted
      && !this.#uncleanPrevious(attempt.root, attempt)
      && (attempt.state === 'pending' || attempt.state === 'authorized');
  }

  #uncleanPrevious(root: BrowserSessionScope, current?: BrowserAttachment): boolean {
    return [...this.#history].some(attempt => attempt !== current
      && scopeKey(attempt.root) === scopeKey(root) && !attempt.cleanupVerified);
  }
}

function validateConnection(connection: BrowserAuthorizationConnection): string {
  const { port, webSocketPath } = connection ?? {};
  if (!Number.isInteger(port) || port < 1 || port > 65_535 || typeof webSocketPath !== 'string'
    || webSocketPath.length > 4_096
    || !/^\/(?:devtools\/browser(?:\/(?!\.{1,2}$)[A-Za-z0-9._-]+)?|felan-browser\/(?!\.{1,2}$)[A-Za-z0-9._-]+)$/u.test(webSocketPath)) {
    throw new Error('Chrome authorization returned an invalid connection.');
  }
  return `ws://127.0.0.1:${port}${webSocketPath}`;
}

function scopeKey(scope: BrowserSessionScope): string {
  return `${scope.namespace}/${scope.session}`;
}

function originOf(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  try { return new URL(value).origin; } catch { return undefined; }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function successData(result: BrowserCliResult): Record<string, unknown> {
  if (result.code !== 0 || result.killed || result.outputTruncated) throw new Error('Browser command did not complete.');
  let response: unknown;
  try { response = JSON.parse(result.stdout); } catch { throw new Error('Browser response was invalid JSON.'); }
  if (!isRecord(response) || response.success !== true) throw new Error('Browser response was not successful.');
  return isRecord(response.data) ? response.data : {};
}

async function closeLease(lease: BrowserAuthorizationLease): Promise<boolean> {
  try {
    await abortable(lease.close(), AbortSignal.timeout(5_000));
    return lease.signal.aborted;
  } catch { return false; }
}

async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void promise.catch(() => {});
    throw new Error('Browser operation was cancelled.');
  }
  let onAbort!: () => void;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(new Error('Browser operation was cancelled.'));
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) onAbort();
      }),
    ]);
  } finally { signal.removeEventListener('abort', onAbort); }
}
