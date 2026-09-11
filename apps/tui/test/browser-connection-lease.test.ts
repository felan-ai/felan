import { createHash } from 'node:crypto';
import http, { createServer, type IncomingMessage } from 'node:http';
import { createConnection, type Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import type { BrowserAuthorizationConnection } from '@felan-ai/ext-browser';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createChromeConnectionLease, type ChromeConnectionLease } from '../src/browser/connection-lease.js';

const WEB_SOCKET_KEY = Buffer.from('0123456789abcdef').toString('base64');
const WEB_SOCKET_ACCEPT = createHash('sha1').update(`${WEB_SOCKET_KEY}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(cleanup.splice(0).reverse().map(dispose => dispose()));
});

describe('one-use Chrome connection lease', () => {
  it('only opens an unpredictable loopback listener before a valid upgrade', async () => {
    const peer = await fakePeer();
    const lease = await createLease(peer.connection);
    expect(lease.connection.port).toBeGreaterThan(0);
    expect(lease.connection.port).not.toBe(peer.connection.port);
    expect(lease.connection.webSocketPath).toMatch(/^\/felan-browser\/[a-f0-9]{64}$/u);
    expect(lease.connection.webSocketPath).not.toMatch(/^\/devtools\//u);
    expect(lease.connection.webSocketPath).not.toBe(peer.connection.webSocketPath);
    expect(lease.connected).toBe(false);
    expect(lease.signal.aborted).toBe(false);
    const idle = await client(lease.connection);
    await delay(30);
    expect(peer.connections).toHaveLength(0);
    await lease.close();
    await idle.closed;
    expect(lease.signal.aborted).toBe(true);
  });

  it.each([
    ['wrong path', (value: string) => value.replace(/\/felan-browser\/[a-f0-9]+/u, '/felan-browser/wrong')],
    ['path query', (value: string) => value.replace(' HTTP/1.1', '?extra=1 HTTP/1.1')],
    ['absolute URL', (value: string) => value.replace('GET /', 'GET http://example.invalid/')],
    ['Origin', (value: string) => value.replace('\r\n\r\n', '\r\nOrigin: https://example.invalid\r\n\r\n')],
    ['empty Origin', (value: string) => value.replace('\r\n\r\n', '\r\noRiGiN:\r\n\r\n')],
    ['POST', (value: string) => value.replace('GET ', 'POST ')],
    ['HTTP/1.0', (value: string) => value.replace('HTTP/1.1', 'HTTP/1.0')],
    ['wrong version', (value: string) => value.replace('Version: 13', 'Version: 12')],
    ['missing version', (value: string) => value.replace('Sec-WebSocket-Version: 13\r\n', '')],
    ['duplicate version', (value: string) => value.replace('Version: 13', 'Version: 13\r\nSec-WebSocket-Version: 13')],
    ['bad key', (value: string) => value.replace(WEB_SOCKET_KEY, 'not-a-key')],
    ['noncanonical key', (value: string) => value.replace(WEB_SOCKET_KEY, `${WEB_SOCKET_KEY.slice(0, -3)}h==`)],
    ['missing key', (value: string) => value.replace(`Sec-WebSocket-Key: ${WEB_SOCKET_KEY}\r\n`, '')],
    ['duplicate key', (value: string) => value.replace(WEB_SOCKET_KEY, `${WEB_SOCKET_KEY}\r\nSec-WebSocket-Key: ${WEB_SOCKET_KEY}`)],
    ['wrong upgrade', (value: string) => value.replace('Upgrade: websocket', 'Upgrade: other')],
    ['missing Connection upgrade', (value: string) => value.replace('Connection: Upgrade', 'Connection: close')],
    ['missing Host', (value: string) => value.replace(/Host: [^\r]+\r\n/u, '')],
    ['body', (value: string) => value.replace('\r\n\r\n', '\r\nContent-Length: 1\r\n\r\nx')],
    ['transfer encoding', (value: string) => value.replace('\r\n\r\n', '\r\nTransfer-Encoding: chunked\r\n\r\n')],
    ['bad protocol', (value: string) => value.replace('\r\n\r\n', '\r\nSec-WebSocket-Protocol: not a token\r\n\r\n')],
    ['bad extension', (value: string) => value.replace('\r\n\r\n', '\r\nSec-WebSocket-Extensions: extension; bad="\r\n\r\n')],
  ])('rejects %s without dialing or consuming the lease', async (_name, change) => {
    const peer = await fakePeer();
    const lease = await createLease(peer.connection);
    const rejected = await client(lease.connection);
    rejected.socket.write(change(upgradeRequest(lease.connection)));
    await rejected.closed;
    expect(peer.connections).toHaveLength(0);
    expect(lease.signal.aborted).toBe(false);
    expect(lease.connected).toBe(false);

    const accepted = await client(lease.connection);
    accepted.socket.write(upgradeRequest(lease.connection));
    await nextUpgrade(peer);
    expect(peer.connections).toHaveLength(1);
  });

  it('spends the slot synchronously and keeps one handshake open through delayed approval', async () => {
    const peer = await fakePeer();
    const lease = await createLease(peer.connection);
    const first = await client(lease.connection);
    const competing = await client(lease.connection);
    first.socket.write(upgradeRequest(lease.connection));
    competing.socket.write(upgradeRequest(lease.connection));
    const upstream = await nextUpgrade(peer);
    await competing.closed;
    await delay(2_100);
    expect(lease.signal.aborted).toBe(false);
    expect(lease.connected).toBe(false);
    expect(upstream.stream.socket.destroyed).toBe(false);
    await expectRefused(lease.connection);
    expect(peer.connections).toHaveLength(1);
    expect(peer.upgrades).toHaveLength(1);

    approve(upstream);
    await vi.waitFor(() => expect(first.bytes.toString()).toContain('101 Switching Protocols'));
    expect(lease.connected).toBe(true);
    await expectRefused(lease.connection);
    expect(peer.connections).toHaveLength(1);
  });

  it('relays only safe handshake headers and unchanged head bytes and streams with backpressure', async () => {
    const peer = await fakePeer();
    const lease = await createLease(peer.connection);
    const local = await client(lease.connection);
    const localHead = Buffer.from([0x81, 0x80, 0, 0xff, 0, 0x42, 0x13]);
    const remoteHead = Buffer.from([0xff, 0, 0x81, 0x42, 0x80, 0]);
    const extensions = 'permessage-deflate; client_max_window_bits, x-example; value="a,b"';
    local.socket.write(Buffer.concat([
      Buffer.from(upgradeRequest(lease.connection, [
        'Cookie: fake-cookie',
        'Authorization: fake-authorization',
        'X-Private: fake-private-data',
        'Sec-WebSocket-Protocol: cdp, other',
        `Sec-WebSocket-Extensions: ${extensions}`,
      ])),
      localHead,
    ]));
    const upstream = await nextUpgrade(peer);
    expect(upstream.request.url).toBe(peer.connection.webSocketPath);
    expect(upstream.request.headers).toEqual({
      host: `127.0.0.1:${peer.connection.port}`,
      connection: 'Upgrade',
      upgrade: 'websocket',
      'sec-websocket-version': '13',
      'sec-websocket-key': WEB_SOCKET_KEY,
      'sec-websocket-protocol': 'cdp, other',
      'sec-websocket-extensions': extensions,
    });
    expect(upstream.head).toHaveLength(0);
    expect(upstream.stream.bytes).toHaveLength(0);
    approve(upstream, [
      'Sec-WebSocket-Protocol: cdp',
      'Sec-WebSocket-Extensions: permessage-deflate; server_no_context_takeover, x-example; value="c,d"',
      'X-Private: ws://127.0.0.1/private-endpoint',
      'Set-Cookie: fake-private-cookie',
    ], remoteHead);
    await vi.waitFor(() => {
      expect(body(local.bytes)).toEqual(remoteHead);
      expect(upstream.stream.bytes).toEqual(localHead);
    });
    const responseHeaders = local.bytes.subarray(0, local.bytes.indexOf('\r\n\r\n')).toString();
    expect(responseHeaders).toContain(`Sec-WebSocket-Accept: ${WEB_SOCKET_ACCEPT}`);
    expect(responseHeaders).toContain('Sec-WebSocket-Protocol: cdp');
    expect(responseHeaders).toContain('Sec-WebSocket-Extensions: permessage-deflate; server_no_context_takeover, x-example; value="c,d"');
    expect(responseHeaders).not.toMatch(/private|cookie|127\.0\.0\.1|\/devtools/iu);

    const toRemote = Buffer.alloc(2 * 1_024 * 1_024, 0xa7);
    const toLocal = Buffer.alloc(2 * 1_024 * 1_024, 0x9c);
    upstream.stream.socket.pause();
    local.socket.write(toRemote);
    await delay(20);
    upstream.stream.socket.resume();
    const expectedRemote = Buffer.concat([localHead, toRemote]);
    await vi.waitFor(() => expect(upstream.stream.bytes.length).toBe(expectedRemote.length));
    expect(upstream.stream.bytes.equals(expectedRemote)).toBe(true);
    local.socket.pause();
    upstream.stream.socket.write(toLocal);
    await delay(20);
    local.socket.resume();
    const expectedLocal = Buffer.concat([remoteHead, toLocal]);
    await vi.waitFor(() => expect(body(local.bytes).length).toBe(expectedLocal.length));
    expect(body(local.bytes).equals(expectedLocal)).toBe(true);
    expect(lease.connected).toBe(true);
  });

  it.each([
    ['denied', 'HTTP/1.1 403 Forbidden\r\nContent-Length: 21\r\n\r\nprivate-upstream-data'],
    ['redirected', 'HTTP/1.1 302 Found\r\nLocation: ws://127.0.0.1/private-upstream\r\nContent-Length: 0\r\n\r\n'],
    ['malformed', 'not-http private-upstream-data\r\n\r\n'],
    ['missing accept', switchingProtocols().replace(`Sec-WebSocket-Accept: ${WEB_SOCKET_ACCEPT}\r\n`, '')],
    ['wrong accept', switchingProtocols().replace(WEB_SOCKET_ACCEPT, 'private-upstream-data')],
    ['duplicate accept', switchingProtocols([`Sec-WebSocket-Accept: ${WEB_SOCKET_ACCEPT}`])],
    ['wrong upgrade', switchingProtocols().replace('Upgrade: websocket', 'Upgrade: other')],
    ['missing upgrade', switchingProtocols().replace('Upgrade: websocket\r\n', '')],
    ['wrong Connection', switchingProtocols().replace('Connection: Upgrade', 'Connection: close')],
    ['wrong HTTP version', switchingProtocols().replace('HTTP/1.1', 'HTTP/1.0')],
    ['unsolicited protocol', switchingProtocols(['Sec-WebSocket-Protocol: private-upstream-data'])],
    ['unsolicited extension', switchingProtocols(['Sec-WebSocket-Extensions: private-upstream-data'])],
    ['body length', switchingProtocols(['Content-Length: 0'])],
  ])('aborts on a %s upstream response without forwarding details or reconnecting', async (_name, response) => {
    const peer = await fakePeer();
    const lease = await createLease(peer.connection);
    const local = await client(lease.connection);
    local.socket.write(upgradeRequest(lease.connection));
    const upstream = await nextUpgrade(peer);
    upstream.stream.socket.write(response);
    await vi.waitFor(() => expect(lease.signal.aborted).toBe(true));
    await lease.close();
    await Promise.all([local.closed, upstream.stream.closed]);
    expect(local.bytes).toHaveLength(0);
    expect(lease.connected).toBe(false);
    expect(lease.signal.reason).toEqual(new Error('Chrome connection closed.'));
    await expectRefused(lease.connection);
    expect(peer.connections).toHaveLength(1);
  });

  it('cancels a pending approval synchronously and disposes both sockets without exposing the reason', async () => {
    const peer = await fakePeer();
    const controller = new AbortController();
    const lease = await createLease(peer.connection, controller.signal);
    const local = await client(lease.connection);
    local.socket.write(upgradeRequest(lease.connection));
    const upstream = await nextUpgrade(peer);
    controller.abort(new Error('private reason ws://127.0.0.1/private-path'));
    expect(lease.signal.aborted).toBe(true);
    expect(lease.connected).toBe(false);
    expect(lease.signal.reason).toEqual(new Error('Chrome connection closed.'));
    await lease.close();
    await Promise.all([local.closed, upstream.stream.closed]);
    expect(local.bytes).toHaveLength(0);
    expect(upstream.stream.socket.destroyed).toBe(true);
    await expectRefused(lease.connection);
    expect(peer.connections).toHaveLength(1);
  });

  it('closes a listener whose startup is cancelled', async () => {
    const peer = await fakePeer();
    const controller = new AbortController();
    const listen = vi.spyOn(http.Server.prototype, 'listen');
    const result = createChromeConnectionLease(peer.connection, controller.signal);
    controller.abort(new Error('private cancellation details'));
    await expect(result).rejects.toThrow('Chrome connection was cancelled.');
    expect(listen).toHaveBeenCalledOnce();
    expect((listen.mock.contexts[0] as http.Server).listening).toBe(false);
    expect(peer.connections).toHaveLength(0);
  });

  it('returns one completion promise and synchronously revokes an explicitly closed connection', async () => {
    const peer = await fakePeer();
    const source = new AbortController();
    const lease = await createLease(peer.connection, source.signal);
    const local = await client(lease.connection);
    local.socket.write(upgradeRequest(lease.connection));
    const upstream = await nextUpgrade(peer);
    approve(upstream);
    await vi.waitFor(() => expect(lease.connected).toBe(true));
    let reentrant: Promise<void> | undefined;
    lease.signal.addEventListener('abort', () => { reentrant = lease.close(); });
    const first = lease.close();
    expect(lease.signal.aborted).toBe(true);
    expect(lease.connected).toBe(false);
    expect(source.signal.aborted).toBe(false);
    expect(lease.close()).toBe(first);
    expect(reentrant).toBe(first);
    await first;
    await Promise.all([local.closed, upstream.stream.closed]);
    expect(lease.close()).toBe(first);
    await expectRefused(lease.connection);
    expect(peer.connections).toHaveLength(1);
  });

  it.each(['upstream', 'downstream'] as const)('revokes on %s disconnect after approval', async (side) => {
    const peer = await fakePeer();
    const lease = await createLease(peer.connection);
    const local = await client(lease.connection);
    local.socket.write(upgradeRequest(lease.connection));
    const upstream = await nextUpgrade(peer);
    approve(upstream);
    await vi.waitFor(() => expect(lease.connected).toBe(true));
    (side === 'upstream' ? upstream.stream.socket : local.socket).end();
    await vi.waitFor(() => expect(lease.signal.aborted).toBe(true));
    expect(lease.connected).toBe(false);
    await lease.close();
    await Promise.all([local.closed, upstream.stream.closed]);
    await expectRefused(lease.connection);
    expect(peer.connections).toHaveLength(1);
  });

  it.each(['upstream', 'downstream'] as const)('revokes on %s disconnect during approval', async (side) => {
    const peer = await fakePeer();
    const lease = await createLease(peer.connection);
    const local = await client(lease.connection);
    local.socket.write(upgradeRequest(lease.connection));
    const upstream = await nextUpgrade(peer);
    (side === 'upstream' ? upstream.stream.socket : local.socket).destroy();
    await vi.waitFor(() => expect(lease.signal.aborted).toBe(true));
    await lease.close();
    await Promise.all([local.closed, upstream.stream.closed]);
    expect(lease.connected).toBe(false);
    await expectRefused(lease.connection);
    expect(peer.connections).toHaveLength(1);
  });

  it('revokes on buffered data followed by FIN while approval is pending', async () => {
    const peer = await fakePeer();
    const lease = await createLease(peer.connection);
    const local = await client(lease.connection);
    local.socket.write(Buffer.concat([
      Buffer.from(upgradeRequest(lease.connection)),
      Buffer.from([0x81, 0x80, 0, 0xff]),
    ]));
    const upstream = await nextUpgrade(peer);
    expect(lease.signal.aborted).toBe(false);
    local.socket.end(Buffer.alloc(1_024, 0xa7));
    await vi.waitFor(() => expect(lease.signal.aborted).toBe(true));
    await Promise.all([local.closed, upstream.stream.closed]);
    expect(lease.connected).toBe(false);
    expect(local.bytes).toHaveLength(0);
    expect(upstream.stream.bytes).toHaveLength(0);
    await expectRefused(lease.connection);
    expect(peer.connections).toHaveLength(1);
  });

  it('fails closed if the upstream resets before sending an upgrade response', async () => {
    const peer = await fakePeer(socket => socket.resetAndDestroy());
    const lease = await createLease(peer.connection);
    const local = await client(lease.connection);
    local.socket.write(upgradeRequest(lease.connection));
    await local.closed;
    await lease.close();
    expect(lease.signal.reason).toEqual(new Error('Chrome connection closed.'));
    expect(local.bytes).toHaveLength(0);
    await expectRefused(lease.connection);
    expect(peer.connections).toHaveLength(1);
    expect(peer.upgrades).toHaveLength(0);
  });

  it('validates input and pre-aborted signals before listening or dialing', async () => {
    const peer = await fakePeer();
    const listen = vi.spyOn(http.Server.prototype, 'listen');
    const invalid: unknown[] = [
      null, undefined, {},
      ...[0, -1, 65_536, 1.5, NaN, Infinity, '12345'].map(port => ({ ...peer.connection, port })),
      ...[
        undefined, 42, '', '/devtools/browser/', '/devtools/browser/.', '/devtools/browser/..',
        '/devtools/page/id', '/devtools/browser/id/other', '/devtools/browser/id?private=value',
        '/devtools/browser/id#private', '/devtools/browser/id\r\nX-Private: value',
        '/devtools/browser/%2e%2e', '/devtools/browser/' + 'x'.repeat(4_096),
        'ws://127.0.0.1/devtools/browser/id', '//example.invalid/devtools/browser/id',
      ].map(webSocketPath => ({ ...peer.connection, webSocketPath })),
    ];
    for (const connection of invalid) {
      await expect(createChromeConnectionLease(connection as BrowserAuthorizationConnection, new AbortController().signal))
        .rejects.toThrow('Chrome connection is invalid.');
    }
    const controller = new AbortController();
    controller.abort(new Error('private abort reason'));
    await expect(createChromeConnectionLease(peer.connection, controller.signal))
      .rejects.toThrow('Chrome connection was cancelled.');
    expect(listen).not.toHaveBeenCalled();
    expect(peer.connections).toHaveLength(0);
  });

  it.each(['/devtools/browser', '/devtools/browser/safe-id_1.2'])('preserves the validated upstream path %s', async (path) => {
    const peer = await fakePeer();
    const unused = await fakePeer();
    const input = { port: peer.connection.port, webSocketPath: path };
    const lease = await createLease(input);
    input.port = unused.connection.port;
    input.webSocketPath = '/devtools/browser/changed';
    const local = await client(lease.connection);
    local.socket.write(upgradeRequest(lease.connection));
    const upstream = await nextUpgrade(peer);
    expect(upstream.request.url).toBe(path);
    expect(unused.connections).toHaveLength(0);
  });
});

interface ObservedSocket {
  readonly socket: Duplex;
  readonly bytes: Buffer;
  readonly closed: Promise<void>;
}

interface FakeUpgrade {
  readonly request: IncomingMessage;
  readonly stream: ObservedSocket;
  readonly head: Buffer;
}

async function fakePeer(onConnection?: (socket: Socket) => void) {
  const connections: Socket[] = [];
  const upgrades: FakeUpgrade[] = [];
  const server = createServer();
  server.on('connection', (socket) => {
    connections.push(socket);
    socket.on('error', () => {});
    socket.on('end', () => socket.end());
    onConnection?.(socket);
  });
  server.on('upgrade', (request, socket, head) => {
    upgrades.push({ request, stream: observe(socket), head });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fake peer did not listen');
  cleanup.push(async () => {
    for (const socket of connections) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  return {
    connection: { port: address.port, webSocketPath: '/devtools/browser/fake-upstream' },
    connections,
    upgrades,
  };
}

async function createLease(connection: BrowserAuthorizationConnection, signal = new AbortController().signal): Promise<ChromeConnectionLease> {
  const lease = await createChromeConnectionLease(connection, signal);
  cleanup.push(() => lease.close());
  return lease;
}

function observe(socket: Duplex): ObservedSocket {
  const chunks: Buffer[] = [];
  const closed = new Promise<void>(resolve => socket.once('close', resolve));
  socket.on('data', (chunk: Buffer) => chunks.push(chunk));
  socket.on('error', () => {});
  return { socket, get bytes() { return Buffer.concat(chunks); }, closed };
}

async function client(connection: BrowserAuthorizationConnection): Promise<ObservedSocket> {
  const socket = createConnection({ host: '127.0.0.1', port: connection.port });
  const result = observe(socket);
  cleanup.push(async () => { socket.destroy(); await result.closed; });
  await new Promise<void>((resolve) => {
    socket.once('connect', resolve);
    socket.once('error', () => resolve());
  });
  return result;
}

function upgradeRequest(connection: BrowserAuthorizationConnection, extraHeaders: string[] = []): string {
  return [
    `GET ${connection.webSocketPath} HTTP/1.1`,
    `Host: 127.0.0.1:${connection.port}`,
    'Connection: Upgrade',
    'Upgrade: websocket',
    'Sec-WebSocket-Version: 13',
    `Sec-WebSocket-Key: ${WEB_SOCKET_KEY}`,
    ...extraHeaders,
    '', '',
  ].join('\r\n');
}

function switchingProtocols(extraHeaders: string[] = []): string {
  return [
    'HTTP/1.1 101 Switching Protocols',
    'Connection: Upgrade',
    'Upgrade: websocket',
    `Sec-WebSocket-Accept: ${WEB_SOCKET_ACCEPT}`,
    ...extraHeaders,
    '', '',
  ].join('\r\n');
}

function approve(upgrade: FakeUpgrade, headers: string[] = [], head = Buffer.alloc(0)): void {
  upgrade.stream.socket.write(Buffer.concat([Buffer.from(switchingProtocols(headers)), head]));
}

async function nextUpgrade(peer: Awaited<ReturnType<typeof fakePeer>>): Promise<FakeUpgrade> {
  await vi.waitFor(() => expect(peer.upgrades).toHaveLength(1));
  return peer.upgrades[0]!;
}

async function expectRefused(connection: BrowserAuthorizationConnection): Promise<void> {
  const reconnect = await client(connection);
  reconnect.socket.write(upgradeRequest(connection));
  await reconnect.closed;
  expect(reconnect.bytes).toHaveLength(0);
}

function body(bytes: Buffer): Buffer {
  const end = bytes.indexOf('\r\n\r\n');
  return end < 0 ? Buffer.alloc(0) : bytes.subarray(end + 4);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}
