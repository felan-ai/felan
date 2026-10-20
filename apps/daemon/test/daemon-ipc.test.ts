import { spawn } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { closeSync, fstatSync, mkdirSync, openSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { createServer, Server } from 'node:net';
import type { Socket } from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import koffi from 'koffi';
import { acquireDaemonOwnership, type DaemonOwnership } from '../src/daemon/ownership.js';
import { connectLocalIpc, listenLocalIpc, probeDaemon, serveReadiness, type LocalIpcListener } from '../src/daemon/ipc.js';
import { BoundedDaemonLogs, spawnDetachedDaemon } from '../src/daemon/supervisor.js';
import { resolveDaemonTarget, type DaemonTarget } from '../src/daemon/target.js';
import { connectUnix, listenUnix, protectSocket, socketPathLimit } from '../src/daemon/native-ownership.js';
import * as nativeOwnership from '../src/daemon/native-ownership.js';
import type { DaemonIdentity } from '@felan-ai/session-protocol';

const supported = ['darwin', 'linux'].includes(process.platform);
const roots: string[] = [];
const owners: DaemonOwnership[] = [];
const listeners: LocalIpcListener[] = [];
const detached: { target: Extract<DaemonTarget, { kind: 'isolated' }>; identity: DaemonIdentity }[] = [];
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
afterEach(async () => {
  vi.restoreAllMocks();
  for (const { target } of detached.splice(0)) {
    await writeFile(join(target.directory, 'fixture-stop'), '', { mode: 0o600 });
    let released = false;
    for (let i = 0; i < 100; i++) {
      try { const owner = await acquireDaemonOwnership(target); await owner.release(); released = true; break; }
      catch (error) { if ((error as { code: string }).code !== 'owner_running') throw error; await sleep(20); }
    }
    expect(released, 'test-owned detached fixture must release its locks').toBe(true);
  }
  for (const listener of listeners.splice(0)) listener.close();
  for (const owner of owners.splice(0)) await owner.release();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 's103-ipc-')); roots.push(directory);
  const target = { kind: 'isolated' as const, directory, namespaceId: randomUUID() };
  const owner = await acquireDaemonOwnership(target); owners.push(owner);
  return { target, owner };
}
async function serve(owner: DaemonOwnership) {
  const listener = await listenLocalIpc(owner, socket => serveReadiness(owner, '0.0.0-fixture', socket)); listeners.push(listener); return listener;
}
function descriptorCount() { return readdirSync(process.platform === 'linux' ? '/proc/self/fd' : '/dev/fd').length; }
function socketFd(socket: Socket) { return (socket as Socket & { _handle: { fd: number } })._handle.fd; }
function replaceOwnedRoot(owner: DaemonOwnership) {
  renameSync(owner.target.agentDir, `${owner.target.agentDir}.old`);
  mkdirSync(owner.target.agentDir, { mode: 0o700 });
}

describe.skipIf(!supported)('owner-only local daemon IPC and startup', () => {
  it('authenticates native same-UID peers, protects socket permissions and pins the full target', async () => {
    const { owner } = await fixture(); await serve(owner);
    expect((await lstat(owner.target.runtimeDirectory)).mode & 0o777).toBe(0o700);
    expect((await lstat(owner.target.endpoint)).mode & 0o777).toBe(0o600);
    expect((await probeDaemon(owner.target, owner.identity)).identity).toEqual(owner.identity);
    await expect(probeDaemon(owner.target, { ...owner.identity, instanceId: randomUUID() })).rejects.toThrow();
    await expect(probeDaemon(owner.target, { ...owner.identity, namespaceId: 'forged' })).rejects.toThrow();
  });

  it('classifies a vanished native endpoint as unavailable and closes its socket descriptor', async () => {
    const { owner } = await fixture();
    const before = descriptorCount();
    await expect(connectUnix(owner.target.endpoint, owner.target.uid)).rejects.toMatchObject({ code: 'unavailable' });
    expect(descriptorCount()).toBe(before);
  });

  it('replaces a stale endpoint and removes only its owned endpoint when closed', async () => {
    const { owner } = await fixture();
    const fd = listenUnix(owner.target.endpoint); protectSocket(owner.target.endpoint); closeSync(fd);
    const listener = await serve(owner);
    expect((await probeDaemon(owner.target, owner.identity)).state).toBe('ready');
    listener.close();
    await expect(lstat(owner.target.endpoint)).rejects.toMatchObject({ code: 'ENOENT' });
    await new Promise(resolve => setImmediate(resolve));
    const replacement = openSync(join(owner.target.runtimeDirectory, 'replacement'), 'w', 0o600);
    try { listener.close(); expect(fstatSync(replacement).isFile()).toBe(true); }
    finally { closeSync(replacement); }
  });

  it('limits admission to 64 live connections and reuses capacity after a close', async () => {
    const { owner } = await fixture(); const delivered: Socket[] = []; const clients: Socket[] = [];
    listeners.push(await listenLocalIpc(owner, socket => delivered.push(socket)));
    try {
      for (let i = 0; i < 64; i++) { const client = await connectLocalIpc(owner.target); client.on('error', () => {}); clients.push(client); }
      await vi.waitFor(() => expect(delivered).toHaveLength(64));
      const rejected = await connectLocalIpc(owner.target); rejected.on('error', () => {}); clients.push(rejected);
      await new Promise<void>(resolve => rejected.once('close', () => resolve()));
      expect(delivered).toHaveLength(64);
      clients[0]!.destroy();
      await vi.waitFor(() => expect(delivered[0]!.destroyed).toBe(true));
      const replacement = await connectLocalIpc(owner.target); replacement.on('error', () => {}); clients.push(replacement);
      await vi.waitFor(() => expect(delivered).toHaveLength(65));
    } finally { for (const client of clients) client.destroy(); }
  });

  it.each(['mismatch', 'failure'] as const)('rejects a peer UID %s without closing the listener', async reason => {
    const { owner } = await fixture(); await serve(owner);
    const check = vi.spyOn(nativeOwnership, 'peerUid').mockImplementationOnce(() => {
      if (reason === 'failure') throw new Error('peer lookup failed');
      return owner.target.uid + 1;
    });
    const client = await connectLocalIpc(owner.target); client.on('error', () => {});
    try {
      await new Promise<void>(resolve => client.once('close', () => resolve()));
      expect(check).toHaveBeenCalledOnce();
      expect((await probeDaemon(owner.target, owner.identity)).state).toBe('ready');
    } finally { client.destroy(); }
  });

  it('fails closed when an accepted socket has no native descriptor', async () => {
    const { owner } = await fixture(); let delivered = 0;
    const emit = Server.prototype.emit;
    const intercept = vi.spyOn(Server.prototype, 'emit').mockImplementation(function (this: Server, event, ...args) {
      if (event === 'connection') {
        const socket = args[0] as Socket;
        Object.defineProperty((socket as Socket & { _handle: object })._handle, 'fd', { value: undefined });
      }
      return emit.call(this, event, ...args);
    });
    listeners.push(await listenLocalIpc(owner, () => delivered++));
    const client = await connectLocalIpc(owner.target); client.on('error', () => {});
    try {
      await new Promise<void>(resolve => client.once('close', () => resolve()));
      expect(delivered).toBe(0);
    } finally { client.destroy(); intercept.mockRestore(); }
  });

  it('receives non-blocking, close-on-exec descriptors from libuv', async () => {
    const { owner } = await fixture();
    let resolveAccepted!: (socket: Socket) => void;
    const accepted = new Promise<Socket>(resolve => { resolveAccepted = resolve; });
    listeners.push(await listenLocalIpc(owner, resolveAccepted));
    const client = await connectLocalIpc(owner.target);
    try {
      const fd = socketFd(await accepted);
      const libc = koffi.load(process.platform === 'darwin' ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6');
      const fcntl = libc.func('int fcntl(int fd, int command, ...)');
      expect(fcntl(fd, 1) & 1).toBe(1);
      expect(fcntl(fd, 3) & (process.platform === 'darwin' ? 4 : 2048)).not.toBe(0);
    } finally { client.destroy(); }
  });

  it.each(['replace', 'delete'] as const)('stops admission and drops existing connections on endpoint %s', async action => {
    const { owner } = await fixture(); let accepted: Socket | undefined;
    listeners.push(await listenLocalIpc(owner, socket => { accepted = socket; }));
    const socket = await connectLocalIpc(owner.target);
    let tearingDown = false;
    const errors: { error: NodeJS.ErrnoException; duringTeardown: boolean }[] = [];
    socket.on('error', error => errors.push({ error, duringTeardown: tearingDown }));
    const closed = new Promise<void>(resolve => socket.once('close', () => resolve()));
    try {
      await vi.waitFor(() => expect(accepted).toBeDefined());
      tearingDown = true;
      if (action === 'replace') { await rename(owner.target.endpoint, `${owner.target.endpoint}.old`); await writeFile(owner.target.endpoint, 'replacement', { mode: 0o600 }); }
      else await unlink(owner.target.endpoint);
      expect(() => owner.assertCurrent()).toThrow(/fenced/);
      await closed;
      expect(socket.destroyed).toBe(true);
      expect(accepted!.destroyed).toBe(true);
      for (const { error, duringTeardown } of errors) {
        expect(duringTeardown).toBe(true);
        expect(error.code).toBe('ECONNRESET');
      }
      if (action === 'replace') expect(await readFile(owner.target.endpoint, 'utf8')).toBe('replacement');
    } finally { socket.destroy(); }
  });

  it('closes the native listener when ownership is lost while installing its path watch', async () => {
    const { owner } = await fixture();
    const watch = owner.watchPath.bind(owner);
    vi.spyOn(owner, 'watchPath').mockImplementation(path => { replaceOwnedRoot(owner); return watch(path); });
    const before = descriptorCount();
    await expect(listenLocalIpc(owner, () => {})).rejects.toMatchObject({ code: 'ownership_lost' });
    expect(descriptorCount()).toBe(before);
    await expect(connectUnix(owner.target.endpoint, owner.target.uid)).rejects.toMatchObject({ code: 'stale_endpoint' });
  });

  it('closes the native listener on subscription failure without unlinking a replacement endpoint', async () => {
    const { owner } = await fixture();
    vi.spyOn(owner, 'onLost').mockImplementation(() => {
      renameSync(owner.target.endpoint, `${owner.target.endpoint}.old`);
      writeFileSync(owner.target.endpoint, 'replacement', { mode: 0o600 });
      throw new Error('subscription failed');
    });
    const before = descriptorCount();
    await expect(listenLocalIpc(owner, () => {})).rejects.toThrow('subscription failed');
    expect(descriptorCount()).toBe(before);
    expect(await readFile(owner.target.endpoint, 'utf8')).toBe('replacement');
    await expect(connectUnix(`${owner.target.endpoint}.old`, owner.target.uid)).rejects.toMatchObject({ code: 'stale_endpoint' });
  });

  it('closes an accepted socket if ownership is lost before connection delivery', async () => {
    const { owner } = await fixture(); let delivered = 0;
    listeners.push(await listenLocalIpc(owner, () => delivered++));
    const peerUid = nativeOwnership.peerUid;
    const check = vi.spyOn(nativeOwnership, 'peerUid').mockImplementation(fd => {
      replaceOwnedRoot(owner);
      return peerUid(fd);
    });
    const before = descriptorCount();
    const client = await connectLocalIpc(owner.target);
    const errors: NodeJS.ErrnoException[] = []; client.on('error', error => errors.push(error));
    const clientClosed = new Promise<void>(resolve => client.once('close', () => resolve()));
    try {
      await clientClosed;
      expect(check).toHaveBeenCalledOnce();
      expect(delivered).toBe(0);
      expect(client.destroyed).toBe(true);
      expect(descriptorCount()).toBe(before - 1);
      for (const error of errors) expect(error.code).toBe('ECONNRESET');
    } finally { client.destroy(); }
  });

  it('does not unlink a live endpoint and rejects a symlink or a public socket', async () => {
    const { owner } = await fixture();
    const server = createServer(socket => socket.end());
    await new Promise<void>(resolve => server.listen(owner.target.endpoint, resolve)); await chmod(owner.target.endpoint, 0o600);
    try { await expect(listenLocalIpc(owner, () => {})).rejects.toMatchObject({ code: 'endpoint_live' }); expect((await lstat(owner.target.endpoint)).isSocket()).toBe(true); }
    finally { await new Promise<void>(resolve => server.close(() => resolve())); }
    await writeFile(owner.target.endpoint, 'not-a-socket', { mode: 0o600 });
    await expect(listenLocalIpc(owner, () => {})).rejects.toMatchObject({ code: 'unsafe_endpoint' });
    expect(await readFile(owner.target.endpoint, 'utf8')).toBe('not-a-socket');
  });

  it('rejects overlong endpoints before bind, without silently switching to TCP or another directory', async () => {
    const directory = await mkdtemp(join(tmpdir(), 's103-long-')); roots.push(directory);
    const tooLong = join(directory, 'x'.repeat(socketPathLimit())); await mkdir(tooLong, { mode: 0o700 });
    expect(() => resolveDaemonTarget({ kind: 'isolated', directory: tooLong, namespaceId: randomUUID() })).toThrow(/endpoint exceeds/);
  });

  it('binds the actual platform socket-length boundary and checks the kernel peer UID', async () => {
    const directory = await mkdtemp(join(tmpdir(), 's103-limit-')); roots.push(directory);
    const canonical = await realpath(directory);
    const path = join(canonical, 's'.repeat(socketPathLimit() - Buffer.byteLength(canonical) - 1));
    expect(Buffer.byteLength(path)).toBe(socketPathLimit());
    expect(() => listenUnix(`${path}s`)).toThrow(/platform limit/);
    const fd = listenUnix(path); protectSocket(path);
    const server = createServer(socket => socket.end());
    await new Promise<void>(resolve => server.listen({ fd, exclusive: true }, resolve));
    try {
      const client = await connectUnix(path, process.getuid!());
      try { expect(nativeOwnership.peerUid(socketFd(client))).toBe(process.getuid!()); }
      finally { client.destroy(); }
      expect((await lstat(path)).mode & 0o777).toBe(0o600);
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); await unlink(path); }
  });

  it('keeps separate diagnostic files bounded', async () => {
    const { owner } = await fixture(); const logs = new BoundedDaemonLogs(owner, 256);
    try { logs.write('stdout', 'a'.repeat(2048)); logs.write('stderr', 'safe\u0000diagnostic'); }
    finally { logs.close(); }
    expect((await lstat(join(owner.target.runtimeDirectory, 'stdout.log'))).size).toBe(256);
    expect(await readFile(join(owner.target.runtimeDirectory, 'stderr.log'), 'utf8')).toBe('safe?diagnostic\n');
  });

  it('rejects forged readiness, early exits and readiness timeouts without trusting PID or files', async () => {
    const directory = await mkdtemp(join(tmpdir(), 's103-bad-')); roots.push(directory);
    const target = { kind: 'isolated' as const, directory, namespaceId: randomUUID() };
    const entrypoint = join(directory, 'child.mjs');
    await writeFile(entrypoint, 'process.stderr.write("synthetic-secret-must-not-escape"); process.exit(7);');
    await expect(spawnDetachedDaemon({ target, entrypoint })).rejects.toThrow(/exit 7/);
    const identity = { namespaceId: 'forged', instanceId: randomUUID(), agentDir: join(directory, 'agent'), rootSet: [join(directory, 'agent')] };
    await writeFile(entrypoint, `import {writeSync} from 'node:fs'; writeSync(3, ${JSON.stringify(JSON.stringify({ control: 1, re: 'launch', identity, daemonVersion: 'fake', supportedProtocol: 1, state: 'ready', outcome: 'accepted' }) + '\n')});`);
    await expect(spawnDetachedDaemon({ target, entrypoint })).rejects.toThrow();
    await writeFile(entrypoint, 'setTimeout(() => {}, 300);');
    await expect(spawnDetachedDaemon({ target, entrypoint, timeoutMs: 100 })).rejects.toMatchObject({ code: 'readiness_timeout' });
    await sleep(350);
  });

  it('survives launcher/client exit, retains shared launch environment and requires live readiness', async () => {
    const directory = await mkdtemp(join(tmpdir(), 's103-det-')); roots.push(directory);
    const target = { kind: 'isolated' as const, directory, namespaceId: randomUUID() };
    const supervisor = process.env.S103_DAEMON_BUILD ? pathToFileURL(join(process.env.S103_DAEMON_BUILD, 'supervisor.js')).href : new URL('../dist/daemon/supervisor.js', import.meta.url).href;
    const entrypoint = new URL('./fixtures/daemon-detached.mjs', import.meta.url).pathname;
    const source = `import {spawnDetachedDaemon} from ${JSON.stringify(supervisor)}; const receipt = await spawnDetachedDaemon({target:${JSON.stringify(target)},entrypoint:${JSON.stringify(entrypoint)}}); console.log(JSON.stringify(receipt));`;
    const launcher = spawn(process.execPath, ['--input-type=module', '-e', source], { env: { PATH: process.env.PATH, HOME: directory, S103_SHARED_MARKER: 'synthetic-shared-launch', ...(process.env.S103_DAEMON_BUILD ? { S103_DAEMON_BUILD: process.env.S103_DAEMON_BUILD } : {}) }, stdio: 'pipe' });
    let out = ''; let err = ''; launcher.stdout.on('data', bytes => out += bytes); launcher.stderr.on('data', bytes => err += bytes);
    const code = await new Promise<number | null>(resolve => launcher.once('exit', resolve));
    expect(code, err).toBe(0);
    const receipt = JSON.parse(out); detached.push({ target, identity: receipt.identity });
    expect((await probeDaemon(resolveDaemonTarget(target), receipt.identity)).state).toBe('ready');
    for (let i = 0; i < 50; i++) { try { expect(JSON.parse(await readFile(join(directory, 'launch-env.json'), 'utf8')).shared).toBe(true); break; } catch (error) { if (i === 49) throw error; await sleep(10); } }
    const socket = await connectLocalIpc(resolveDaemonTarget(target)); socket.destroy(); await sleep(30);
    expect((await probeDaemon(resolveDaemonTarget(target), receipt.identity)).state).toBe('ready');
  }, 15_000);
});
