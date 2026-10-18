import { closeSync } from 'node:fs';
import { Socket } from 'node:net';
import koffi from 'koffi';

export class DaemonSecurityError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'DaemonSecurityError';
  }
}

export function requireOwnershipPlatform(): 'darwin' | 'linux' {
  if ((process.platform !== 'darwin' && process.platform !== 'linux') || !['arm64', 'x64'].includes(process.arch)) {
    throw new DaemonSecurityError('platform_blocked', 'Daemon ownership is not available on this platform: Windows requires reviewed token, DACL and handle-lock support; other native ABIs require verification. No fallback is permitted.');
  }
  if (process.getuid!() !== process.geteuid!() || process.getgid!() !== process.getegid!()) {
    throw new DaemonSecurityError('platform_blocked', 'Daemon ownership refuses set-ID execution.');
  }
  return process.platform;
}

let api: ReturnType<typeof loadApi> | undefined;
function loadApi() {
  const platform = requireOwnershipPlatform();
  let libc: ReturnType<typeof koffi.load>;
  try { libc = koffi.load(platform === 'darwin' ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6'); }
  catch { throw new DaemonSecurityError('platform_blocked', 'Native ownership backend unavailable; Linux requires glibc. No lease-lock or TCP fallback is permitted.'); }
  return {
    platform,
    flock: libc.func('int flock(int fd, int operation)'),
    socket: libc.func('int socket(int domain, int type, int protocol)'),
    bind: libc.func('int bind(int fd, const void *address, uint32_t length)'),
    listen: libc.func('int listen(int fd, int backlog)'),
    connect: libc.func('int connect(int fd, const void *address, uint32_t length)'),
    fcntl: libc.func('int fcntl(int fd, int command, ...)'),
    getpeereid: platform === 'darwin' ? libc.func('int getpeereid(int fd, _Out_ uint32_t *uid, _Out_ uint32_t *gid)') : undefined,
    getsockopt: libc.func('int getsockopt(int fd, int level, int option, void *value, void *length)'),
    chmodNoFollow: platform === 'darwin' ? libc.func('int lchmod(const char *path, uint32_t mode)') : libc.func('int fchmodat(int dirfd, const char *path, uint32_t mode, int flags)'),
  };
}
function native() { return api ??= loadApi(); }
function failure(operation: string): never {
  const errno = koffi.errno();
  let code = 'native_failure';
  if (operation === 'connect') {
    if (errno === koffi.os.errno.ECONNREFUSED) code = 'stale_endpoint';
    else if (errno === koffi.os.errno.ENOENT) code = 'unavailable';
  }
  throw new DaemonSecurityError(code, `${operation} failed (errno ${errno}).`);
}

export function tryKernelLock(fd: number): boolean {
  if (native().flock(fd, 2 | 4) === 0) return true;
  if (koffi.errno() === koffi.os.errno.EWOULDBLOCK || koffi.errno() === koffi.os.errno.EAGAIN) return false;
  return failure('flock');
}

export function socketPathLimit(): number { return requireOwnershipPlatform() === 'darwin' ? 103 : 107; }
export function protectSocket(path: string): void {
  const n = native();
  const result: number = n.platform === 'darwin' ? n.chmodNoFollow(path, 0o600) : n.chmodNoFollow(-100, path, 0o600, 0x100);
  if (result !== 0) failure('no-follow socket chmod');
}
function address(path: string): Buffer {
  if (path.includes('\0') || Buffer.byteLength(path) > socketPathLimit()) {
    throw new DaemonSecurityError('invalid_endpoint', `Unix socket path exceeds the ${socketPathLimit()}-byte platform limit or contains NUL.`);
  }
  const bytes = Buffer.from(path);
  const result = Buffer.alloc(bytes.length + 3);
  if (native().platform === 'darwin') { result[0] = result.length; result[1] = 1; }
  else result.writeUInt16LE(1);
  bytes.copy(result, 2);
  return result;
}
function configure(fd: number) {
  const n = native();
  if (n.fcntl(fd, 2, 'int', 1) !== 0) failure('FD_CLOEXEC');
  const flags = n.fcntl(fd, 3);
  if (flags < 0 || n.fcntl(fd, 4, 'int', flags | (n.platform === 'darwin' ? 4 : 2048)) !== 0) failure('O_NONBLOCK');
}
function openSocket(): number {
  const fd: number = native().socket(1, 1, 0);
  if (fd < 0) failure('socket');
  try { configure(fd); return fd; } catch (error) { closeSync(fd); throw error; }
}

export function listenUnix(path: string): number {
  const addr = address(path);
  const fd = openSocket();
  try {
    if (native().bind(fd, addr, addr.length) !== 0) failure('bind');
    if (native().listen(fd, 64) !== 0) failure('listen');
    return fd;
  } catch (error) { closeSync(fd); throw error; }
}

export function peerUid(fd: number): number {
  const n = native();
  if (n.getpeereid) {
    const uid = [0]; const gid = [0];
    if (n.getpeereid(fd, uid, gid) !== 0) failure('getpeereid');
    return uid[0]!;
  }
  const value = Buffer.alloc(12); const length = Buffer.alloc(4); length.writeUInt32LE(12);
  if (n.getsockopt(fd, 1, 17, value, length) !== 0 || length.readUInt32LE() !== 12) failure('SO_PEERCRED');
  return value.readUInt32LE(4);
}

export async function connectUnix(path: string, uid: number, timeoutMs = 2_000): Promise<Socket> {
  const addr = address(path);
  const fd = openSocket();
  try {
    const n = native();
    const result: number = n.connect(fd, addr, addr.length);
    if (result !== 0 && koffi.errno() !== koffi.os.errno.EINPROGRESS) failure('connect');
    const deadline = performance.now() + timeoutMs;
    for (;;) {
      const value = Buffer.alloc(4); const length = Buffer.alloc(4); length.writeUInt32LE(4);
      if (n.getsockopt(fd, n.platform === 'darwin' ? 0xffff : 1, n.platform === 'darwin' ? 0x1007 : 4, value, length) !== 0) failure('SO_ERROR');
      if (value.readInt32LE() !== 0) throw new DaemonSecurityError('unavailable', 'Unix connection failed.');
      try {
        if (peerUid(fd) !== uid) throw new DaemonSecurityError('forbidden', 'Unix server belongs to another OS account.');
        return new Socket({ fd, readable: true, writable: true });
      } catch (error) {
        if (!(error instanceof DaemonSecurityError) || error.code !== 'native_failure') throw error;
        if (performance.now() >= deadline) throw new DaemonSecurityError('unavailable', 'Unix connection timed out.');
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    }
  } catch (error) { closeSync(fd); throw error; }
}
