import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer, Socket, type Server } from 'node:net';
import { randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { CONTROL_VERSION, PROTOCOL_VERSION, JsonLineDecoder, encodeFrame, parseControlRequest, parseControlResponse, type ControlResponse, type DaemonIdentity } from '@felan-ai/session-protocol';
import { assertPrivatePath, connectUnix, DaemonSecurityError, listenUnix, peerUid, protectSocket, tryLockExistingFile } from './native-ownership.js';
import { windowsProcessElevated } from './native-windows.js';
import { assertPathIdentity, assertTargetIdentity, pathIdentity, pinPathChain, type ResolvedDaemonTarget } from './target.js';
import { replaceFile, syncDescriptor, syncDirectory } from './durability.js';
import { clientHandshake, serverHandshake } from './ipc-handshake.js';
import { namespaceLockName, type DaemonOwnership } from './ownership.js';

function endpointExists(path: string): boolean { try { lstatSync(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; } }
function validateSocket(target: ResolvedDaemonTarget) {
  const stat = lstatSync(target.endpoint, { bigint: true });
  if (!stat.isSocket() || stat.uid !== BigInt(target.uid) || (stat.mode & 0o077n) !== 0n) throw new DaemonSecurityError('unsafe_endpoint', 'Endpoint must be an owner-only Unix socket, never a symlink or other file.');
  for (const pin of pinPathChain(target.runtimeDirectory, target.principal)) assertPathIdentity(pin);
  return pathIdentity(target.endpoint);
}

export interface LocalIpcListener { close(): void }
export async function listenLocalIpc(owner: DaemonOwnership, onConnection: (socket: Socket) => void): Promise<LocalIpcListener> {
  if (process.platform === 'win32') return listenWindowsIpc(owner, onConnection);
  owner.assertCurrent();
  const target = owner.target;
  if (endpointExists(target.endpoint)) {
    const stale = validateSocket(target);
    try {
      const live = await connectUnix(target.endpoint, target.uid, 200);
      live.destroy();
      throw new DaemonSecurityError('endpoint_live', 'A live endpoint exists; never unlink it to force startup.');
    } catch (error) {
      if (!(error instanceof DaemonSecurityError) || error.code !== 'stale_endpoint') throw error;
    }
    owner.assertCurrent(); assertPathIdentity(stale); unlinkSync(target.endpoint);
  }
  owner.assertCurrent();
  const fd = listenUnix(target.endpoint);
  let closed = false;
  const connections = new Set<Socket>();
  let pin: ReturnType<typeof pathIdentity> | undefined;
  let server: Server | undefined;
  let transferred = false;
  let unwatch = () => {};
  let unsubscribe = () => {};
  function close() {
    unsubscribe();
    if (closed) { unwatch(); return; }
    closed = true;
    // Once listen({ fd }) adopts the descriptor, only libuv may close it.
    if (transferred) server!.close(); else closeSync(fd);
    for (const socket of connections) socket.destroy();
    connections.clear();
    try {
      owner.assertCurrent();
      if (pin) { assertPathIdentity(pin); unwatch(); unlinkSync(target.endpoint); }
    } catch { /* Never remove a replacement endpoint or clean up after ownership loss. */ }
    finally { unwatch(); }
  }
  function acceptConnection(socket: Socket) {
    socket.on('error', () => {}); socket.once('close', () => connections.delete(socket));
    if (closed) { socket.destroy(); return; }
    try {
      owner.assertCurrent();
      // libuv's uv__accept sets O_NONBLOCK and FD_CLOEXEC before Node emits a connection.
      const peerFd = (socket as Socket & { _handle?: { fd?: number } })._handle?.fd;
      if (typeof peerFd !== 'number' || !Number.isInteger(peerFd) || peerFd < 0) { socket.destroy(); return; }
      try { if (peerUid(peerFd) !== target.uid) { socket.destroy(); return; } }
      catch { socket.destroy(); return; }
      owner.assertCurrent();
      if (connections.size >= 64) { socket.destroy(); return; }
      connections.add(socket);
      onConnection(socket);
    } catch { socket.destroy(); close(); }
  }
  try {
    protectSocket(target.endpoint); pin = validateSocket(target);
    unwatch = owner.watchPath(target.endpoint);
    unsubscribe = owner.onLost(close);
    owner.assertCurrent(); assertPathIdentity(pin);
    await new Promise<void>((resolve, reject) => {
      server = createServer(acceptConnection);
      server.on('error', error => { reject(error); close(); });
      server.listen({ fd, exclusive: true, backlog: 64 }, resolve);
      transferred = true;
    });
    owner.assertCurrent(); assertPathIdentity(pin);
    return { close };
  } catch (error) { close(); throw error; }
}

export async function connectLocalIpc(target: ResolvedDaemonTarget): Promise<Socket> {
  if (process.platform === 'win32') {
    const endpoint = readWindowsEndpoint(target);
    const locks = pinPathChain(target.accountDirectory, target.principal);
    assertPrivatePath(target.accountDirectory, lstatSync(target.accountDirectory, { bigint: true }), target.principal, 'directory');
    const lock = join(target.accountDirectory, namespaceLockName(target)); const pin = pathIdentity(lock);
    const stat = lstatSync(lock, { bigint: true });
    if (!stat.isFile() || stat.nlink !== 1n) throw new DaemonSecurityError('unsafe_path', 'Namespace lifetime lock must be a regular file with one link.');
    const fd = tryLockExistingFile(lock);
    if (fd !== undefined) { closeSync(fd); throw new DaemonSecurityError('stale_endpoint', 'No daemon holds the namespace lifetime lock.'); }
    endpoint.pins.push(...locks, pin);
    for (const pin of endpoint.pins) assertPathIdentity(pin);
    if (endpoint.elevated && !windowsProcessElevated()) throw new DaemonSecurityError('elevation_mismatch', 'The running daemon was started from an Administrator terminal. Stop it from an elevated terminal with `felan daemon stop` or run Felan elevated.');
    const socket = await connectWindowsEndpoint(endpoint, 2_000);
    try { for (const pin of endpoint.pins) assertPathIdentity(pin); return socket; }
    catch (error) { socket.destroy(); throw error; }
  }
  const pins = [...pinPathChain(target.runtimeDirectory, target.principal), validateSocket(target)];
  const socket = await connectUnix(target.endpoint, target.uid);
  try { for (const pin of pins) assertPathIdentity(pin); return socket; }
  catch (error) { socket.destroy(); throw error; }
}

interface WindowsEndpoint { pipe: string; secret: Buffer; elevated: boolean; pins: ReturnType<typeof pinPathChain> }
function readWindowsEndpoint(target: ResolvedDaemonTarget): WindowsEndpoint {
  const pins = pinPathChain(target.runtimeDirectory, target.principal);
  assertPrivatePath(target.runtimeDirectory, lstatSync(target.runtimeDirectory, { bigint: true }), target.principal, 'directory');
  const stat = lstatSync(target.endpoint, { bigint: true });
  assertPrivatePath(target.endpoint, stat, target.principal, 'file');
  const pin = pathIdentity(target.endpoint); pins.push(pin);
  const fd = openSync(target.endpoint, constants.O_RDONLY | constants.O_NOFOLLOW);
  const bytes = Buffer.alloc(4_097); let size = 0;
  try {
    const opened = fstatSync(fd, { bigint: true });
    assertPrivatePath(target.endpoint, opened, target.principal, 'file');
    if (opened.dev !== pin.dev || opened.ino !== pin.ino) throw new DaemonSecurityError('ownership_lost', 'IPC endpoint changed while opening.');
    while (size < bytes.length) { const count = readSync(fd, bytes, size, bytes.length - size, null); if (!count) break; size += count; }
  } finally { closeSync(fd); }
  for (const p of pins) assertPathIdentity(p);
  let value: unknown;
  try { if (size > 4_096) throw new Error('oversize'); value = JSON.parse(bytes.subarray(0, size).toString('utf8')); }
  catch { throw new DaemonSecurityError('unsafe_endpoint', 'Malformed or oversized IPC endpoint.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 4
    || !('version' in value) || value.version !== 1 || !('pipe' in value) || typeof value.pipe !== 'string' || !/^\\\\\.\\pipe\\felan-daemon-[a-f0-9]{32}$/.test(value.pipe)
    || !('secret' in value) || typeof value.secret !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(value.secret)
    || !('elevated' in value) || typeof value.elevated !== 'boolean') throw new DaemonSecurityError('unsafe_endpoint', 'Invalid IPC endpoint fields.');
  const secret = Buffer.from(value.secret, 'base64');
  if (secret.length !== 32 || secret.toString('base64') !== value.secret) throw new DaemonSecurityError('unsafe_endpoint', 'Invalid IPC endpoint secret.');
  return { pipe: value.pipe, secret, elevated: value.elevated, pins };
}

async function connectWindowsEndpoint(endpoint: WindowsEndpoint, timeoutMs: number): Promise<Socket> {
  const socket = new Socket();
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => finish(new DaemonSecurityError('unavailable', 'Named pipe connection timed out.')), timeoutMs);
      function finish(error?: Error) {
        clearTimeout(timeout); socket.off('error', onError); socket.off('connect', onConnect); socket.off('close', onClose);
        if (error) reject(error); else resolve();
      }
      function onConnect() { finish(); }
      function onClose() { finish(new DaemonSecurityError('unavailable', 'Named pipe closed before connecting.')); }
      function onError(error: NodeJS.ErrnoException) { finish(new DaemonSecurityError(['ENOENT', 'ECONNREFUSED'].includes(error.code ?? '') ? 'stale_endpoint' : 'unavailable', 'Named pipe connection failed.')); }
      socket.once('error', onError); socket.once('connect', onConnect); socket.once('close', onClose);
      socket.connect(endpoint.pipe);
    });
    await clientHandshake(socket, endpoint.secret, timeoutMs);
    return socket;
  } catch (error) { socket.destroy(); throw error; }
}

const windowsListeners = new WeakMap<DaemonOwnership, object>();
async function listenWindowsIpc(owner: DaemonOwnership, onConnection: (socket: Socket) => void): Promise<LocalIpcListener> {
  owner.assertCurrent();
  if (windowsListeners.has(owner)) throw new DaemonSecurityError('endpoint_live', 'This owner already has an IPC listener.');
  const registration = {}; windowsListeners.set(owner, registration);
  const release = () => { if (windowsListeners.get(owner) === registration) windowsListeners.delete(owner); };
  try { return await bindWindowsIpc(owner, onConnection, release); }
  catch (error) { release(); throw error; }
}

async function bindWindowsIpc(owner: DaemonOwnership, onConnection: (socket: Socket) => void, release: () => void): Promise<LocalIpcListener> {
  owner.assertCurrent(); const target = owner.target;
  if (endpointExists(target.endpoint)) {
    const stale = readWindowsEndpoint(target);
    // The lifetime lock excludes a live daemon. Never send a handshake to a stale pipe another account may own.
    owner.assertCurrent(); for (const pin of stale.pins) assertPathIdentity(pin); unlinkSync(target.endpoint);
  }
  const secret = randomBytes(32); const connections = new Set<Socket>();
  let closed = false; let ready = false; let server: Server | undefined; let pin: ReturnType<typeof pathIdentity> | undefined;
  let unwatch = () => {}; let unsubscribe = () => {};
  function close() {
    unsubscribe();
    if (closed) { unwatch(); return; }
    closed = true; server?.close();
    for (const socket of connections) socket.destroy();
    connections.clear();
    try { owner.assertCurrent(); if (pin) { assertPathIdentity(pin); unwatch(); unlinkSync(target.endpoint); } }
    catch { /* Never remove a replacement endpoint or clean up after ownership loss. */ }
    finally { unwatch(); release(); }
  }
  function acceptConnection(socket: Socket) {
    socket.on('error', () => {}); socket.once('close', () => connections.delete(socket));
    if (closed || !ready) { socket.destroy(); return; }
    try {
      owner.assertCurrent();
      if (connections.size >= 64) { socket.destroy(); return; }
      connections.add(socket);
      void serverHandshake(socket, secret).then(() => {
        if (closed || socket.destroyed) { socket.destroy(); return; }
        try { owner.assertCurrent(); onConnection(socket); } catch { socket.destroy(); close(); }
      }, () => { socket.destroy(); });
    } catch { socket.destroy(); close(); }
  }
  try {
    let pipe = '';
    for (let attempt = 0; attempt < 4; attempt++) {
      owner.assertCurrent(); pipe = `\\\\.\\pipe\\felan-daemon-${randomBytes(16).toString('hex')}`;
      const candidate = createServer(acceptConnection);
      try {
        await new Promise<void>((resolve, reject) => {
          candidate.once('error', reject); candidate.listen({ path: pipe, backlog: 64 }, () => { candidate.off('error', reject); resolve(); });
        });
        server = candidate; server.on('error', close); break;
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE' || attempt === 3) throw error; }
    }
    owner.assertCurrent();
    if (endpointExists(target.endpoint)) throw new DaemonSecurityError('endpoint_live', 'An endpoint appeared while binding; never replace it to force startup.');
    assertPrivatePath(target.runtimeDirectory, lstatSync(target.runtimeDirectory, { bigint: true }), target.principal, 'directory');
    const temp = `${target.endpoint}.${randomUUID()}.tmp`;
    const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    let tempPin: ReturnType<typeof pathIdentity> | undefined;
    try {
      try {
        tempPin = pathIdentity(temp); const opened = fstatSync(fd, { bigint: true });
        assertPrivatePath(temp, opened, target.principal, 'file');
        if (opened.dev !== tempPin.dev || opened.ino !== tempPin.ino) throw new DaemonSecurityError('ownership_lost', 'IPC endpoint changed while creating.');
        writeFileSync(fd, JSON.stringify({ version: 1, pipe, secret: secret.toString('base64'), elevated: windowsProcessElevated() })); syncDescriptor(fd);
      }
      finally { closeSync(fd); }
      owner.assertCurrent(); assertPathIdentity(tempPin);
      if (endpointExists(target.endpoint)) throw new DaemonSecurityError('endpoint_live', 'An endpoint appeared before publication; never replace it to force startup.');
      replaceFile(temp, target.endpoint); pin = { ...tempPin, path: target.endpoint }; assertPathIdentity(pin); syncDirectory(target.runtimeDirectory);
    } finally { if (tempPin && endpointExists(temp)) { assertPathIdentity(tempPin); unlinkSync(temp); } }
    unwatch = owner.watchPath(target.endpoint); unsubscribe = owner.onLost(close);
    owner.assertCurrent(); assertPathIdentity(pin); ready = true;
    return { close };
  } catch (error) { close(); throw error; }
}

export function readinessResponse(owner: DaemonOwnership, version: string, re: string): ControlResponse {
  owner.assertCurrent();
  return { control: CONTROL_VERSION, re, identity: owner.identity, daemonVersion: version, supportedProtocol: PROTOCOL_VERSION, state: 'ready', outcome: 'accepted' };
}

/** @internal */
export function serveReadiness(owner: DaemonOwnership, version: string, socket: Socket): void {
  const decoder = new JsonLineDecoder(); let bytes = 0;
  const timeout = setTimeout(() => socket.destroy(), 2_000);
  socket.once('close', () => clearTimeout(timeout));
  socket.on('data', (chunk: Buffer) => {
    try {
      owner.assertCurrent(); bytes += chunk.length;
      if (bytes > 16_384) throw new Error('oversize');
      for (const frame of decoder.push(chunk)) {
        const request = parseControlRequest(frame);
        if (request.op !== 'host.status') throw new Error('readiness is read-only');
        assertTargetIdentity(owner.target, request.params.expected, owner.identity);
        socket.end(encodeFrame(readinessResponse(owner, version, request.id)));
      }
    } catch { socket.destroy(); }
  });
}

export async function readControlFrame(socket: Socket, timeoutMs: number): Promise<ControlResponse> {
  return new Promise((resolve, reject) => {
    const decoder = new JsonLineDecoder(); let bytes = 0;
    const timeout = setTimeout(() => finish(new DaemonSecurityError('readiness_timeout', 'Daemon did not become ready before the deadline.')), timeoutMs);
    function finish(error?: Error, response?: ControlResponse) {
      clearTimeout(timeout); socket.off('data', onData); socket.off('error', onError); socket.off('end', onEnd);
      if (error) reject(error); else resolve(response!);
    }
    function onError() { finish(new DaemonSecurityError('unavailable', 'Daemon readiness connection failed.')); }
    function onEnd() { finish(new DaemonSecurityError('unavailable', 'Daemon closed before readiness.')); }
    function onData(chunk: Buffer) {
      try {
        bytes += chunk.length; if (bytes > 16_384) throw new Error('oversize');
        const frames = decoder.push(chunk);
        if (frames.length > 1) throw new Error('multiple readiness frames');
        if (frames.length === 1) finish(undefined, parseControlResponse(frames[0]));
      } catch { finish(new DaemonSecurityError('invalid_readiness', 'Malformed or oversized daemon readiness response.')); }
    }
    socket.on('data', onData); socket.once('error', onError); socket.once('end', onEnd);
  });
}

export async function probeDaemon(target: ResolvedDaemonTarget, expected: DaemonIdentity, timeoutMs = 2_000): Promise<ControlResponse> {
  const socket = await connectLocalIpc(target);
  try {
    const id = randomUUID(); const response = readControlFrame(socket, timeoutMs);
    socket.write(encodeFrame({ control: CONTROL_VERSION, id, op: 'host.status', params: { expected } }));
    const ready = await response;
    assertTargetIdentity(target, expected, ready.identity);
    if (ready.re !== id || ready.outcome !== 'accepted' || ready.state !== 'ready' || ready.supportedProtocol !== PROTOCOL_VERSION) throw new DaemonSecurityError('invalid_readiness', 'Daemon is not ready for this protocol.');
    return ready;
  } finally { socket.destroy(); }
}
