import { createHash, randomBytes } from 'node:crypto';
import { createServer, request, type ClientRequest, type IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { BrowserAuthorizationConnection, BrowserAuthorizationLease } from '@felan-ai/ext-browser';

const WEB_SOCKET_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const TOKEN_SOURCE = "[!#$%&'*+.^_`|~0-9A-Za-z-]+";
const TOKEN = new RegExp(`^${TOKEN_SOURCE}$`, 'u');
const QUOTED_STRING = String.raw`"(?:[\t\x20-\x21\x23-\x5B\x5D-\x7E]|\\[\t\x20-\x7E])*"`;
const EXTENSION_SOURCE = `(${TOKEN_SOURCE})(?:[ \\t]*;[ \\t]*${TOKEN_SOURCE}(?:[ \\t]*=[ \\t]*(?:${TOKEN_SOURCE}|${QUOTED_STRING}))?)*`;
const EXTENSION_LIST = new RegExp(`^${EXTENSION_SOURCE}(?:[ \\t]*,[ \\t]*${EXTENSION_SOURCE})*$`, 'u');

export interface ChromeConnectionLease extends BrowserAuthorizationLease {
  readonly connection: BrowserAuthorizationConnection;
  readonly connected: boolean;
}

interface NegotiationHeaders {
  readonly protocol?: string;
  readonly extensions?: string;
}

export async function createChromeConnectionLease(
  upstream: BrowserAuthorizationConnection,
  signal: AbortSignal,
): Promise<ChromeConnectionLease> {
  if (!upstream || !Number.isInteger(upstream.port) || upstream.port < 1 || upstream.port > 65_535
    || typeof upstream.webSocketPath !== 'string' || upstream.webSocketPath.length > 4_096
    || !/^\/devtools\/browser(?:\/(?!\.{1,2}$)[A-Za-z0-9._-]+)?$/u.test(upstream.webSocketPath)) {
    throw new Error('Chrome connection is invalid.');
  }
  if (signal.aborted) throw new Error('Chrome connection was cancelled.');

  const { port, webSocketPath } = upstream;
  const localPath = `/felan-browser/${randomBytes(32).toString('hex')}`;
  const controller = new AbortController();
  const sockets = new Map<Duplex, Promise<void>>();
  const server = createServer({ requestTimeout: 0, maxHeaderSize: 8_192 }, (_request, response) => {
    response.writeHead(400, { Connection: 'close', 'Content-Length': '0' });
    response.end();
  });
  let downstream: Duplex | undefined;
  let upstreamSocket: Duplex | undefined;
  let pendingRequest: ClientRequest | undefined;
  let requestClosed: Promise<void> | undefined;
  let consumed = false;
  let connected = false;
  let closing = false;
  let startupFailed = false;
  let stopped: Promise<void> | undefined;
  let resolveListening!: () => void;
  let resolveClosed!: () => void;
  const listening = new Promise<void>((resolve) => { resolveListening = resolve; });
  const closed = new Promise<void>((resolve) => { resolveClosed = resolve; });
  const onAbort = () => { void close(); };

  function stopListening(): Promise<void> {
    stopped ??= new Promise<void>((resolve) => {
      const stop = () => server.close(() => resolve());
      if (server.listening) stop();
      else void listening.then(stop);
    });
    return stopped;
  }

  function close(): Promise<void> {
    if (closing) return closed;
    closing = true;
    connected = false;
    signal.removeEventListener('abort', onAbort);
    const completions = [stopListening(), ...sockets.values()];
    if (requestClosed) completions.push(requestClosed);
    pendingRequest?.destroy();
    for (const socket of sockets.keys()) socket.destroy();
    controller.abort(new Error('Chrome connection closed.'));
    void Promise.all(completions).then(() => resolveClosed());
    return closed;
  }

  function trackSocket(socket: Duplex): void {
    if (sockets.has(socket)) return;
    const isOwned = () => socket === downstream || socket === upstreamSocket;
    sockets.set(socket, new Promise<void>((resolve) => {
      socket.once('close', () => {
        sockets.delete(socket);
        resolve();
        if (isOwned()) void close();
      });
    }));
    socket.on('error', () => {
      if (isOwned()) void close();
      else socket.destroy();
    });
    socket.once('end', () => { if (isOwned()) void close(); });
    if (closing || (consumed && !isOwned())) socket.destroy();
  }

  server.on('connection', trackSocket);
  server.on('clientError', (_error, socket) => socket.destroy());
  server.once('listening', resolveListening);
  server.on('error', () => {
    startupFailed = true;
    resolveListening();
    void close();
  });
  server.on('upgrade', (incoming, socket, head) => {
    const key = singleHeader(incoming, 'sec-websocket-key');
    const negotiation = negotiationHeaders(incoming);
    if (closing || consumed || incoming.method !== 'GET' || incoming.url !== localPath
      || !validUpgradeHeaders(incoming) || !singleHeader(incoming, 'host')
      || 'origin' in incoming.headers || singleHeader(incoming, 'sec-websocket-version') !== '13'
      || 'transfer-encoding' in incoming.headers
      || ('content-length' in incoming.headers && singleHeader(incoming, 'content-length') !== '0')
      || !key || !/^[A-Za-z0-9+/]{22}==$/u.test(key) || Buffer.from(key, 'base64').toString('base64') !== key
      || !negotiation) {
      socket.destroy();
      return;
    }

    // Spend the slot before any asynchronous work, including a failed or denied handshake.
    consumed = true;
    downstream = socket;
    // Keep reading until approval so buffered client data cannot hide a peer's FIN.
    const onPreApprovalData = () => { void close(); };
    socket.once('data', onPreApprovalData);
    socket.resume();
    void stopListening();
    for (const other of sockets.keys()) if (other !== socket) other.destroy();

    try {
      pendingRequest = request({
        hostname: '127.0.0.1',
        port,
        path: webSocketPath,
        method: 'GET',
        agent: false,
        timeout: 0,
        maxHeaderSize: 8_192,
        headers: {
          Connection: 'Upgrade',
          Upgrade: 'websocket',
          'Sec-WebSocket-Version': '13',
          'Sec-WebSocket-Key': key,
          ...forwardNegotiation(negotiation),
        },
      });
      requestClosed = new Promise<void>((resolve) => pendingRequest!.once('close', resolve));
      pendingRequest.on('socket', (remote) => {
        upstreamSocket = remote;
        trackSocket(remote);
      });
      pendingRequest.on('error', () => { void close(); });
      pendingRequest.on('response', (response) => {
        response.destroy();
        void close();
      });
      pendingRequest.on('upgrade', (response, remote, upstreamHead) => {
        remote.pause();
        const accepted = negotiationHeaders(response);
        const accept = singleHeader(response, 'sec-websocket-accept');
        if (closing || response.statusCode !== 101 || !validUpgradeHeaders(response)
          || 'content-length' in response.headers || 'transfer-encoding' in response.headers
          || accept !== createHash('sha1').update(key + WEB_SOCKET_GUID).digest('base64')
          || !accepted || !validNegotiation(negotiation, accepted)) {
          remote.destroy();
          void close();
          return;
        }
        const headers = [
          'HTTP/1.1 101 Switching Protocols',
          'Upgrade: websocket',
          'Connection: Upgrade',
          `Sec-WebSocket-Accept: ${accept}`,
          ...Object.entries(forwardNegotiation(accepted)).map(([name, value]) => `${name}: ${value}`),
          '',
          '',
        ].join('\r\n');
        socket.pause();
        socket.removeListener('data', onPreApprovalData);
        connected = true;
        if (head.length) socket.unshift(head);
        if (upstreamHead.length) remote.unshift(upstreamHead);
        if (socket.write(headers)) remote.pipe(socket);
        else socket.once('drain', () => { if (!closing) remote.pipe(socket); });
        socket.pipe(remote);
      });
      pendingRequest.end();
    } catch {
      void close();
    }
  });

  signal.addEventListener('abort', onAbort, { once: true });
  try {
    server.listen(0, '127.0.0.1');
  } catch {
    startupFailed = true;
    resolveListening();
    void close();
  }
  await listening;
  const address = server.address();
  if (signal.aborted || closing || startupFailed || !address || typeof address === 'string') {
    await close();
    throw new Error(signal.aborted ? 'Chrome connection was cancelled.' : 'Chrome connection is unavailable.');
  }
  return Object.freeze({
    connection: Object.freeze({ port: address.port, webSocketPath: localPath }),
    signal: controller.signal,
    get connected() { return connected; },
    close,
  });
}

function singleHeader(message: IncomingMessage, name: string): string | undefined {
  const values = message.headersDistinct[name];
  return values?.length === 1 ? values[0] : undefined;
}

function tokens(value: string): string[] | undefined {
  const values = value.split(',').map(token => token.trim());
  return values.every(token => TOKEN.test(token)) ? values : undefined;
}

function validUpgradeHeaders(message: IncomingMessage): boolean {
  return message.httpVersion === '1.1' && singleHeader(message, 'upgrade')?.toLowerCase() === 'websocket'
    && (tokens(singleHeader(message, 'connection') ?? '')?.some(token => token.toLowerCase() === 'upgrade') ?? false);
}

function extensionNames(value: string): string[] | undefined {
  if (!EXTENSION_LIST.test(value)) return undefined;
  return [...value.matchAll(new RegExp(EXTENSION_SOURCE, 'gu'))].map(match => match[1]!);
}

function negotiationHeaders(message: IncomingMessage): NegotiationHeaders | undefined {
  const protocol = singleHeader(message, 'sec-websocket-protocol');
  const extensions = singleHeader(message, 'sec-websocket-extensions');
  if (('sec-websocket-protocol' in message.headers && (!protocol || !tokens(protocol)))
    || ('sec-websocket-extensions' in message.headers && (!extensions || !extensionNames(extensions)))) return undefined;
  return { ...(protocol ? { protocol } : {}), ...(extensions ? { extensions } : {}) };
}

function validNegotiation(requested: NegotiationHeaders, accepted: NegotiationHeaders): boolean {
  if (accepted.protocol && !tokens(requested.protocol ?? '')?.includes(accepted.protocol)) return false;
  const offered = extensionNames(requested.extensions ?? '') ?? [];
  return !accepted.extensions || extensionNames(accepted.extensions)!.every(name => offered.includes(name));
}

function forwardNegotiation(headers: NegotiationHeaders): Record<string, string> {
  return {
    ...(headers.protocol ? { 'Sec-WebSocket-Protocol': headers.protocol } : {}),
    ...(headers.extensions ? { 'Sec-WebSocket-Extensions': headers.extensions } : {}),
  };
}
