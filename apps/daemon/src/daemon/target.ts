import { constants, fstatSync, lstatSync, mkdirSync, openSync, closeSync, realpathSync, statfsSync, type BigIntStats } from 'node:fs';
import { userInfo } from 'node:os';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import type { DaemonIdentity, DaemonTarget as ProtocolDaemonTarget } from '@felan-ai/session-protocol';
import { DaemonSecurityError, requireOwnershipPlatform, socketPathLimit } from './native-ownership.js';

export type DaemonTarget =
  | { readonly kind: 'production'; readonly agentDir: string; readonly storeRoots: readonly string[] }
  | { readonly kind: 'isolated'; readonly directory: string; readonly namespaceId: string; readonly storeRoots?: readonly string[] };

export interface PathIdentity { readonly path: string; readonly dev: bigint; readonly ino: bigint; readonly mode: bigint; readonly uid: bigint; readonly links: bigint }
export interface ResolvedDaemonTarget {
  readonly kind: DaemonTarget['kind'];
  readonly namespaceId: string;
  readonly uid: number;
  readonly accountDirectory: string;
  readonly runtimeDirectory: string;
  readonly endpoint: string;
  readonly agentDir: string;
  readonly rootSet: readonly string[];
  readonly pins: readonly PathIdentity[];
}

export function pathInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}
export function pathsOverlap(a: string, b: string): boolean { return pathInside(a, b) || pathInside(b, a); }
export function pathIdentity(path: string): PathIdentity {
  const stat = lstatSync(path, { bigint: true });
  return { path, dev: stat.dev, ino: stat.ino, mode: stat.mode, uid: stat.uid, links: stat.isDirectory() ? 0n : stat.nlink };
}
function sameIdentity(a: PathIdentity, b: PathIdentity): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.uid === b.uid && a.links === b.links;
}
export function assertPathIdentity(pin: PathIdentity): void {
  try { if (sameIdentity(pin, pathIdentity(pin.path))) return; } catch { /* Missing paths are ownership loss, not permission to recreate them. */ }
  throw new DaemonSecurityError('ownership_lost', 'A daemon-owned path was replaced, removed or had its permissions changed. Stop this instance before recovery.');
}
export function assertPrivateStat(stat: BigIntStats, uid: number, directory: boolean): void {
  if ((directory ? !stat.isDirectory() : !stat.isFile()) || stat.uid !== BigInt(uid) || (stat.mode & 0o077n) !== 0n || (!directory && stat.nlink !== 1n)) {
    throw new DaemonSecurityError('unsafe_path', 'Daemon path must be owner-only, non-symlink and owned by the real OS account (regular files require one link).');
  }
}
export function privateDirectory(path: string, uid: number): string {
  if (!isAbsolute(path) || path.includes('\0')) throw new DaemonSecurityError('unsafe_path', 'Daemon directories must be absolute paths without NUL.');
  const parent = dirname(path);
  if (parent !== path && !exists(parent)) privateDirectory(parent, uid);
  try { mkdirSync(path, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  assertPrivateStat(lstatSync(path, { bigint: true }), uid, true);
  return realpathSync(path);
}
function exists(path: string): boolean { try { lstatSync(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; } }

export function pinPathChain(path: string, uid: number): PathIdentity[] {
  const pins: PathIdentity[] = [];
  for (let at = path;; at = dirname(at)) {
    const stat = lstatSync(at, { bigint: true });
    if (!stat.isDirectory() || (stat.uid !== 0n && stat.uid !== BigInt(uid)) || ((stat.mode & 0o022n) !== 0n && !(stat.uid === 0n && (stat.mode & 0o1000n) !== 0n))) {
      throw new DaemonSecurityError('unsafe_path', 'Daemon path has an untrusted or writable non-sticky ancestor.');
    }
    pins.push(pathIdentity(at));
    if (dirname(at) === at) break;
  }
  return pins;
}

export function openPrivateFile(path: string, uid: number): number {
  const fd = openSync(path, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  try {
    const stat = fstatSync(fd, { bigint: true });
    assertPrivateStat(stat, uid, false);
    const pin = pathIdentity(path);
    if (stat.dev !== pin.dev || stat.ino !== pin.ino) throw new DaemonSecurityError('unsafe_path', 'Daemon file changed while opening.');
    return fd;
  } catch (error) { closeSync(fd); throw error; }
}

export function realAccountLocation(): { uid: number; home: string; directory: string } {
  const platform = requireOwnershipPlatform();
  const account = userInfo();
  const home = realpathSync(account.homedir);
  const temp = realpathSync(platform === 'darwin' ? '/private/tmp' : '/tmp');
  return { uid: account.uid, home, directory: join(temp, `felan-${account.uid}-daemon-v1`) };
}

function canonicalStore(path: string, uid: number): string {
  const canonical = canonicalProspectivePath(path);
  let existing = canonical;
  while (!exists(existing)) existing = dirname(existing);
  const type = Number(statfsSync(existing).type);
  const localTypes = requireOwnershipPlatform() === 'darwin' ? [0x1a, 0x11] : [0xef53, 0x58465342, 0x9123683e, 0x01021994, 0x794c7630, 0x2fc12fc1];
  if (!localTypes.includes(type >>> 0)) throw new DaemonSecurityError('filesystem_blocked', 'Store filesystem has no verified local lock/identity semantics. Network and unknown filesystems are blocked.');
  pinPathChain(existing, uid);
  if (exists(canonical)) assertPrivateStat(lstatSync(canonical, { bigint: true }), uid, true);
  return canonical;
}

export function resolveDaemonTarget(target: DaemonTarget): ResolvedDaemonTarget {
  if (!target || (target.kind !== 'production' && target.kind !== 'isolated')) throw new DaemonSecurityError('invalid_target', 'An explicit production or isolated target is required.');
  if (target.kind === 'production' && !Array.isArray(target.storeRoots)) throw new DaemonSecurityError('invalid_target', 'Production targets require an explicit store-root array.');
  if (target.storeRoots !== undefined && (!Array.isArray(target.storeRoots) || target.storeRoots.length > 64 || target.storeRoots.some(root => typeof root !== 'string' || Buffer.byteLength(root) > 4096))) throw new DaemonSecurityError('invalid_target', 'Store roots must be a bounded array of absolute paths.');
  const account = realAccountLocation();
  let agentDir: string; let runtimeDirectory: string; let namespaceId: string; let roots: readonly string[]; let fixtureDirectory: string | undefined;
  if (target.kind === 'isolated') {
    if (typeof target.namespaceId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(target.namespaceId) || target.namespaceId === 'production') throw new DaemonSecurityError('invalid_target', 'An isolated target requires a non-production namespace ID.');
    // Resolve existing ancestors before creating anything, so an alias cannot redirect a fixture into production.
    const directory = canonicalProspectivePath(target.directory);
    fixtureDirectory = directory;
    if (pathsOverlap(directory, canonicalProspectivePath(join(account.home, '.felan'))) || pathsOverlap(directory, account.directory) || directory === parse(directory).root) throw new DaemonSecurityError('invalid_target', 'An isolated target cannot contain or use production paths.');
    agentDir = join(directory, 'agent'); runtimeDirectory = join(directory, 'runtime'); namespaceId = target.namespaceId;
    roots = target.storeRoots ?? [join(agentDir, 'storage')];
    if (roots.some(root => !pathInside(directory, canonicalProspectivePath(root)))) throw new DaemonSecurityError('invalid_target', 'All isolated stores must remain inside the explicit fixture directory.');
  } else {
    agentDir = target.agentDir; runtimeDirectory = join(account.directory, 'production'); namespaceId = 'production'; roots = target.storeRoots;
  }
  agentDir = canonicalStore(agentDir, account.uid);
  const allRoots = [...new Set([agentDir, ...roots.map(root => canonicalStore(root, account.uid))])].sort();
  const rootSet = allRoots.filter((root, i) => !allRoots.some((parent, j) => j !== i && pathInside(parent, root)));
  runtimeDirectory = canonicalProspectivePath(runtimeDirectory);
  if (fixtureDirectory && runtimeDirectory !== join(fixtureDirectory, 'runtime')) throw new DaemonSecurityError('invalid_target', 'The isolated runtime directory must not be a symlink.');
  if (fixtureDirectory && [agentDir, runtimeDirectory, ...rootSet].some(path => !pathInside(fixtureDirectory, path))) throw new DaemonSecurityError('invalid_target', 'Isolated agent, runtime and stores must remain inside the canonical fixture directory.');
  if (!fixtureDirectory && !pathInside(account.directory, runtimeDirectory)) throw new DaemonSecurityError('invalid_target', 'Production runtime cannot be redirected outside the account coordinator.');
  if (rootSet.some(root => pathsOverlap(root, account.directory))) throw new DaemonSecurityError('invalid_target', 'Store roots cannot overlap the account coordinator.');
  if (exists(runtimeDirectory)) assertPrivateStat(lstatSync(runtimeDirectory, { bigint: true }), account.uid, true);
  const pins = [runtimeDirectory, ...rootSet].flatMap(path => {
    while (!exists(path)) path = dirname(path);
    return pinPathChain(path, account.uid);
  });
  const endpoint = join(runtimeDirectory, 'ipc.sock');
  if (Buffer.byteLength(endpoint) > socketPathLimit()) throw new DaemonSecurityError('invalid_endpoint', `Use a shorter explicit runtime directory: endpoint exceeds ${socketPathLimit()} bytes.`);
  return Object.freeze({ kind: target.kind, uid: account.uid, namespaceId, accountDirectory: account.directory, runtimeDirectory, endpoint, agentDir, rootSet: Object.freeze(rootSet), pins: Object.freeze(pins) });
}

export function prepareDaemonTarget(target: ResolvedDaemonTarget): ResolvedDaemonTarget {
  for (const pin of target.pins) assertPathIdentity(pin);
  for (const root of [target.agentDir, ...target.rootSet, target.runtimeDirectory]) privateDirectory(root, target.uid);
  for (const pin of target.pins) assertPathIdentity(pin);
  return Object.freeze({ ...target, pins: Object.freeze([...pinPathChain(target.runtimeDirectory, target.uid), ...target.rootSet.flatMap(root => pinPathChain(root, target.uid))]) });
}

export function canonicalProspectivePath(path: string): string {
  if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0') || Buffer.byteLength(path) > 4096) throw new DaemonSecurityError('invalid_target', 'Target paths must be bounded absolute paths without NUL.');
  let at = resolve(path); const tail: string[] = [];
  while (!exists(at)) { tail.unshift(at.slice(dirname(at).length + (dirname(at) === sep ? 0 : 1))); at = dirname(at); }
  return join(realpathSync(at), ...tail);
}

export function identityFor(target: ResolvedDaemonTarget, instanceId: string): DaemonIdentity {
  return { namespaceId: target.namespaceId, instanceId, agentDir: target.agentDir, rootSet: [...target.rootSet] };
}
export function protocolTarget(target: ResolvedDaemonTarget): ProtocolDaemonTarget {
  return target.kind === 'production' ? { kind: 'production' } : { kind: 'isolated', runtimeDir: target.runtimeDirectory, fixtureRoot: dirname(target.runtimeDirectory) };
}
export function assertTargetIdentity(target: ResolvedDaemonTarget, expected: DaemonIdentity, actual: DaemonIdentity): void {
  const canonical = identityFor(target, expected.instanceId);
  if (JSON.stringify(canonical) !== JSON.stringify({ namespaceId: actual.namespaceId, instanceId: actual.instanceId, agentDir: actual.agentDir, rootSet: actual.rootSet }) || JSON.stringify(canonical) !== JSON.stringify({ namespaceId: expected.namespaceId, instanceId: expected.instanceId, agentDir: expected.agentDir, rootSet: expected.rootSet })) {
    throw new DaemonSecurityError('target_mismatch', 'Daemon namespace, canonical roots or instance differs from the pinned target.');
  }
}
