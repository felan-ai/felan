import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

const DEFAULT_CALLBACK_TIMEOUT_MS = 5 * 60 * 1_000;

export interface OAuthCallbackResult {
  readonly code: string;
  readonly iss?: string;
}

export interface OAuthCallbackReservation {
  readonly redirectUri: string;
  wait(): Promise<OAuthCallbackResult>;
  release(): void;
}

interface PendingCallback {
  readonly path: string;
  readonly promise: Promise<OAuthCallbackResult>;
  readonly resolve: (result: OAuthCallbackResult) => void;
  readonly reject: (error: Error) => void;
  readonly cleanup: () => void;
}

interface ParsedRedirectUri {
  readonly url: URL;
  readonly listenHost: string;
  readonly port: number;
  readonly path: string;
  readonly key: string;
}

const brokers = new Map<string, EndpointBroker>();

export async function reserveOAuthCallback(
  redirectUri: string,
  state: string,
  signal: AbortSignal,
  timeoutMs = DEFAULT_CALLBACK_TIMEOUT_MS,
): Promise<OAuthCallbackReservation> {
  if (!/^[A-Za-z0-9_-]{32,256}$/u.test(state)) throw new Error('OAuth state is invalid');
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) throw new Error('OAuth callback timeout must be positive');
  const endpoint = parseRedirectUri(redirectUri);

  for (;;) {
    let broker = brokers.get(endpoint.key);
    if (!broker) {
      broker = new EndpointBroker(endpoint);
      brokers.set(endpoint.key, broker);
    }
    await broker.ready;
    if (broker.accepting) return broker.reserve(endpoint, state, signal, timeoutMs);
    await broker.closed;
  }
}

class EndpointBroker {
  readonly ready: Promise<void>;
  readonly closed: Promise<void>;
  readonly #endpoint: ParsedRedirectUri;
  readonly #server: Server;
  readonly #pending = new Map<string, PendingCallback>();
  #accepting = true;
  #resolveClosed!: () => void;

  constructor(endpoint: ParsedRedirectUri) {
    this.#endpoint = endpoint;
    this.#server = createServer((request, response) => this.#handle(request, response));
    this.closed = new Promise((resolve) => {
      this.#resolveClosed = resolve;
    });
    this.ready = new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        this.#accepting = false;
        brokers.delete(endpoint.key);
        reject(new Error(`Could not start OAuth callback listener on ${endpoint.listenHost}:${endpoint.port}`, {
          cause: error,
        }));
        this.#resolveClosed();
      };
      this.#server.once('error', onError);
      this.#server.listen(endpoint.port, endpoint.listenHost, () => {
        this.#server.removeListener('error', onError);
        this.#server.on('error', (error) => this.#failAll(error));
        resolve();
      });
    });
  }

  get accepting(): boolean {
    return this.#accepting;
  }

  reserve(
    endpoint: ParsedRedirectUri,
    state: string,
    signal: AbortSignal,
    timeoutMs: number,
  ): OAuthCallbackReservation {
    if (!this.#accepting) throw new Error('OAuth callback listener is closing');
    if (this.#pending.has(state)) throw new Error('OAuth callback state is already reserved');
    signal.throwIfAborted();

    let resolve!: (result: OAuthCallbackResult) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<OAuthCallbackResult>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    const onAbort = () => this.#remove(state, abortReason(signal));
    const timer = setTimeout(() => {
      this.#remove(state, new Error('OAuth callback timed out'));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    };
    this.#pending.set(state, {
      path: endpoint.path,
      promise,
      resolve,
      reject,
      cleanup,
    });
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();

    let released = false;
    return {
      redirectUri: endpoint.url.toString(),
      wait: () => promise,
      release: () => {
        if (released) return;
        released = true;
        this.#remove(state, new Error('OAuth callback cancelled'));
      },
    };
  }

  #handle(request: IncomingMessage, response: ServerResponse): void {
    setCallbackHeaders(response);
    if (request.method !== 'GET' || !request.url) {
      respond(response, 405, 'OAuth callback requires GET.');
      return;
    }

    let url: URL;
    try {
      url = new URL(request.url, this.#endpoint.url.origin);
    } catch {
      respond(response, 400, 'Invalid OAuth callback.');
      return;
    }
    const state = url.searchParams.get('state');
    const pending = state ? this.#pending.get(state) : undefined;
    if (!state || !pending || url.pathname !== pending.path) {
      respond(response, 400, 'Invalid or expired OAuth callback.');
      return;
    }

    const providerError = url.searchParams.get('error');
    const code = url.searchParams.get('code');
    if (providerError) {
      this.#remove(state, new Error('OAuth authorization was denied'));
      respond(response, 400, 'OAuth authorization was not completed. You can close this window.');
      return;
    }
    if (!code) {
      this.#remove(state, new Error('OAuth callback did not include an authorization code'));
      respond(response, 400, 'OAuth callback did not include a code. You can close this window.');
      return;
    }

    this.#pending.delete(state);
    pending.cleanup();
    pending.resolve({
      code,
      ...(url.searchParams.get('iss') === null ? {} : { iss: url.searchParams.get('iss')! }),
    });
    respond(response, 200, 'OAuth authentication completed. You can close this window.');
    this.#closeIfIdle();
  }

  #remove(state: string, error: Error): void {
    const pending = this.#pending.get(state);
    if (!pending) return;
    this.#pending.delete(state);
    pending.cleanup();
    pending.reject(error);
    void pending.promise.catch(() => {});
    this.#closeIfIdle();
  }

  #failAll(error: Error): void {
    for (const state of [...this.#pending.keys()]) {
      this.#remove(state, new Error('OAuth callback listener failed', { cause: error }));
    }
    this.#closeIfIdle();
  }

  #closeIfIdle(): void {
    if (!this.#accepting || this.#pending.size > 0) return;
    this.#accepting = false;
    setImmediate(() => {
      if (this.#pending.size > 0) {
        this.#accepting = true;
        return;
      }
      this.#server.close(() => {
        if (brokers.get(this.#endpoint.key) === this) brokers.delete(this.#endpoint.key);
        this.#resolveClosed();
      });
    });
  }
}

function parseRedirectUri(value: string): ParsedRedirectUri {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new Error('OAuth redirectUri must be an absolute URL', { cause: error });
  }
  const hostname = url.hostname.toLowerCase();
  const listenHost = hostname === '[::1]' || hostname === '::1'
    ? '::1'
    : hostname;
  if (
    url.protocol !== 'http:'
    || (listenHost !== '127.0.0.1' && listenHost !== '::1' && listenHost !== 'localhost')
  ) {
    throw new Error('OAuth redirectUri must use HTTP on localhost or a loopback address');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('OAuth redirectUri must not contain credentials, a query, or a fragment');
  }
  if (!url.port) throw new Error('OAuth redirectUri must include an explicit port');
  const port = Number.parseInt(url.port, 10);
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw new Error('OAuth redirectUri must include a valid port');
  }
  const path = url.pathname || '/';
  return {
    url,
    listenHost,
    port,
    path,
    key: `${listenHost}:${port}`,
  };
}

function setCallbackHeaders(response: ServerResponse): void {
  response.setHeader('cache-control', 'no-store');
  response.setHeader('content-security-policy', "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
  response.setHeader('content-type', 'text/plain; charset=utf-8');
  response.setHeader('referrer-policy', 'no-referrer');
  response.setHeader('x-content-type-options', 'nosniff');
  response.setHeader('x-frame-options', 'DENY');
}

function respond(response: ServerResponse, status: number, message: string): void {
  response.statusCode = status;
  response.end(message);
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('OAuth callback aborted');
}
