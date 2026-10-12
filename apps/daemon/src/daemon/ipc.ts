import { closeSync, lstatSync, unlinkSync } from 'node:fs';
import type { Socket } from 'node:net';
import { randomUUID } from 'node:crypto';
import { CONTROL_VERSION, PROTOCOL_VERSION, JsonLineDecoder, encodeFrame, parseControlRequest, parseControlResponse, type ControlResponse, type DaemonIdentity } from '@felan-ai/session-protocol';
import { acceptUnix, connectUnix, DaemonSecurityError, listenUnix, protectSocket } from './native-ownership.js';
import { assertPathIdentity, assertTargetIdentity, pathIdentity, pinPathChain, type ResolvedDaemonTarget } from './target.js';
import type { DaemonOwnership } from './ownership.js';

function endpointExists(path: string): boolean { try { lstatSync(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; } }
function validateSocket(target: ResolvedDaemonTarget) {
  const stat = lstatSync(target.endpoint, { bigint: true });
  if (!stat.isSocket() || stat.uid !== BigInt(target.uid) || (stat.mode & 0o077n) !== 0n) throw new DaemonSecurityError('unsafe_endpoint', 'Endpoint must be an owner-only Unix socket, never a symlink or other file.');
  for (const pin of pinPathChain(target.runtimeDirectory, target.uid)) assertPathIdentity(pin);
  return pathIdentity(target.endpoint);
}

export interface LocalIpcListener { close(): void }
export async function listenLocalIpc(owner: DaemonOwnership, onConnection: (socket: Socket) => void): Promise<LocalIpcListener> {
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
  let timer: NodeJS.Timeout | undefined;
  let unwatch = () => {};
  let unsubscribe = () => {};
  function close() {
    unsubscribe();
    if (closed) { unwatch(); return; }
    closed = true; clearInterval(timer); closeSync(fd);
    for (const socket of connections) socket.destroy();
    connections.clear();
    try {
      owner.assertCurrent();
      if (pin) { assertPathIdentity(pin); unwatch(); unlinkSync(target.endpoint); }
    } catch { /* Never remove a replacement endpoint or clean up after ownership loss. */ }
    finally { unwatch(); }
  }
  function acceptConnections() {
    try {
      owner.assertCurrent();
      for (let i = 0; i < 32; i++) {
        let socket: Socket | undefined;
        try { socket = acceptUnix(fd, target.uid); }
        catch (error) { if (error instanceof DaemonSecurityError && error.code === 'forbidden') continue; throw error; }
        if (!socket) break;
        connections.add(socket); socket.on('error', () => {}); socket.once('close', () => connections.delete(socket!));
        owner.assertCurrent();
        if (connections.size > 64) { socket.destroy(); continue; }
        onConnection(socket);
      }
    } catch { close(); }
  }
  try {
    protectSocket(target.endpoint); pin = validateSocket(target);
    unwatch = owner.watchPath(target.endpoint);
    unsubscribe = owner.onLost(close);
    owner.assertCurrent(); assertPathIdentity(pin);
    timer = setInterval(acceptConnections, 5);
    return { close };
  } catch (error) { close(); throw error; }
}

export async function connectLocalIpc(target: ResolvedDaemonTarget): Promise<Socket> {
  const pins = [...pinPathChain(target.runtimeDirectory, target.uid), validateSocket(target)];
  const socket = await connectUnix(target.endpoint, target.uid);
  try { for (const pin of pins) assertPathIdentity(pin); return socket; }
  catch (error) { socket.destroy(); throw error; }
}

export function readinessResponse(owner: DaemonOwnership, version: string, re: string, state: 'ready' | 'blocked' = 'ready'): ControlResponse {
  owner.assertCurrent();
  return { control: CONTROL_VERSION, re, identity: owner.identity, daemonVersion: version, supportedProtocol: PROTOCOL_VERSION, state, outcome: 'accepted' };
}

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

export async function probeDaemon(target: ResolvedDaemonTarget, expected: DaemonIdentity, timeoutMs = 2_000, allowBlocked = false): Promise<ControlResponse> {
  const socket = await connectLocalIpc(target);
  try {
    const id = randomUUID(); const response = readControlFrame(socket, timeoutMs);
    socket.write(encodeFrame({ control: CONTROL_VERSION, id, op: 'host.status', params: { expected } }));
    const ready = await response;
    assertTargetIdentity(target, expected, ready.identity);
    if (ready.re !== id || ready.outcome !== 'accepted' || ready.state !== 'ready' && !(allowBlocked && ready.state === 'blocked') || ready.supportedProtocol !== PROTOCOL_VERSION) throw new DaemonSecurityError('invalid_readiness', 'Daemon is not ready for this protocol.');
    return ready;
  } finally { socket.destroy(); }
}
