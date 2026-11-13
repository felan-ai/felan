import { constants, fstatSync, lstatSync, mkdirSync, openSync, closeSync, realpathSync } from 'node:fs';
import { userInfo } from 'node:os';
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import type { DaemonIdentity, DaemonTarget as ProtocolDaemonTarget } from '@felan-ai/session-protocol';
import { accountPrincipal, assertPrivatePath, DaemonSecurityError, isWritableByOthers, protectPrivateDirectory, requireOwnershipPlatform, socketPathLimit } from './native-ownership.js';

export type DaemonTarget =
  | { readonly kind: 'production'; readonly agentDir: string; readonly storeRoots: readonly string[] }
  | { readonly kind: 'isolated'; readonly directory: string; readonly namespaceId: string; readonly storeRoots?: readonly string[] };

export interface PathIdentity { readonly path: string; readonly dev: bigint; readonly ino: bigint; readonly mode: bigint; readonly uid: bigint; readonly links: bigint }
export interface ResolvedDaemonTarget {
  readonly kind: DaemonTarget['kind'];
  readonly namespaceId: string;
  readonly uid: number;
  readonly principal: string;
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
export function assertPathIdentity(pin: PathIdentity): void {
  try {
    const current = pathIdentity(pin.path);
    if (current.dev === pin.dev && current.ino === pin.ino) return;
  } catch { /* Missing paths are ownership loss, not permission to recreate them. */ }
  throw new DaemonSecurityError('ownership_lost', 'A daemon-owned path was replaced or removed. Stop this instance before recovery.');
}
export function privateDirectory(path: string, principal: string): string {
  if (!isAbsolute(path) || path.includes('\0')) throw new DaemonSecurityError('unsafe_path', 'Daemon directories must be absolute paths without NUL.');
  const parent = dirname(path);
  if (parent !== path && !exists(parent)) privateDirectory(parent, principal);
  let created = false;
  try { mkdirSync(path, { mode: 0o700 }); created = true; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  if (created) protectPrivateDirectory(path, principal);
  assertPrivatePath(path, lstatSync(path, { bigint: true }), principal, 'directory');
  return canonicalRealpath(path);
}
/** Creates a store directory without imposing permissions on an existing user directory. */
export function storeDirectory(path: string): string {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  return canonicalRealpath(path);
}
function exists(path: string): boolean { try { lstatSync(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; } }
function canonicalRealpath(path: string): string { return process.platform === 'win32' ? realpathSync.native(path) : realpathSync(path); }

export function pinPathChain(path: string, principal: string): PathIdentity[] {
  const windows = requireOwnershipPlatform() === 'win32';
  // Windows drive roots can grant create rights to other accounts without granting delete rights over this private subtree.
  // Check the immediate parent's write policy and pin every ancestor; full private DACL checks apply to runtime paths themselves.
  const pins: PathIdentity[] = [];
  for (let at = path;; at = dirname(at)) {
    const stat = lstatSync(at, { bigint: true });
    if (!stat.isDirectory() || (windows ? at === dirname(path) && isWritableByOthers(at, stat)
      : (stat.uid !== 0n && stat.uid !== BigInt(principal)) || ((stat.mode & 0o022n) !== 0n && !(stat.uid === 0n && (stat.mode & 0o1000n) !== 0n)))) {
      throw new DaemonSecurityError('unsafe_path', 'Daemon path has an untrusted or writable non-sticky ancestor.');
    }
    pins.push(pathIdentity(at));
    if (dirname(at) === at) break;
  }
  return pins;
}

export function pinPathAncestry(path: string): PathIdentity[] {
  const pins: PathIdentity[] = [];
  for (let at = path;; at = dirname(at)) {
    pins.push(pathIdentity(at));
    if (dirname(at) === at) break;
  }
  return pins;
}

export function openPrivateFile(path: string, principal: string): number {
  const fd = openSync(path, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  try {
    const stat = fstatSync(fd, { bigint: true });
    assertPrivatePath(path, stat, principal, 'file');
    const pin = pathIdentity(path);
    if (stat.dev !== pin.dev || stat.ino !== pin.ino) throw new DaemonSecurityError('unsafe_path', 'Daemon file changed while opening.');
    return fd;
  } catch (error) { closeSync(fd); throw error; }
}

/** @internal */
export function realAccountLocation(): { uid: number; principal: string; home: string; directory: string } {
  const platform = requireOwnershipPlatform();
  const account = userInfo();
  const home = canonicalRealpath(account.homedir);
  const principal = accountPrincipal();
  if (platform === 'win32') return { uid: -1, principal, home, directory: join(home, 'AppData', 'Local', 'felan-daemon-v1') };
  const temp = realpathSync(platform === 'darwin' ? '/private/tmp' : '/tmp');
  return { uid: account.uid, principal, home, directory: join(temp, `felan-${account.uid}-daemon-v1`) };
}

export function resolveDaemonTarget(target: DaemonTarget): ResolvedDaemonTarget {
  if (!target || (target.kind !== 'production' && target.kind !== 'isolated')) throw new DaemonSecurityError('invalid_target', 'An explicit production or isolated target is required.');
  if (target.kind === 'production' && !Array.isArray(target.storeRoots)) throw new DaemonSecurityError('invalid_target', 'Production targets require an explicit store-root array.');
  if (target.storeRoots !== undefined && (!Array.isArray(target.storeRoots) || target.storeRoots.some(root => typeof root !== 'string'))) throw new DaemonSecurityError('invalid_target', 'Store roots must be an array of absolute paths.');
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
  agentDir = canonicalProspectivePath(agentDir);
  const allRoots = [...new Set([agentDir, ...roots.map(canonicalProspectivePath)])].sort();
  const rootSet = allRoots.filter((root, i) => !allRoots.some((parent, j) => j !== i && pathInside(parent, root)));
  runtimeDirectory = canonicalProspectivePath(runtimeDirectory);
  if (fixtureDirectory && runtimeDirectory !== join(fixtureDirectory, 'runtime')) throw new DaemonSecurityError('invalid_target', 'The isolated runtime directory must not be a symlink.');
  if (fixtureDirectory && [agentDir, runtimeDirectory, ...rootSet].some(path => !pathInside(fixtureDirectory, path))) throw new DaemonSecurityError('invalid_target', 'Isolated agent, runtime and stores must remain inside the canonical fixture directory.');
  if (!fixtureDirectory && !pathInside(account.directory, runtimeDirectory)) throw new DaemonSecurityError('invalid_target', 'Production runtime cannot be redirected outside the account coordinator.');
  if (rootSet.some(root => pathsOverlap(root, account.directory))) throw new DaemonSecurityError('invalid_target', 'Store roots cannot overlap the account coordinator.');
  if (exists(runtimeDirectory)) assertPrivatePath(runtimeDirectory, lstatSync(runtimeDirectory, { bigint: true }), account.principal, 'directory');
  const nearest = (path: string) => { while (!exists(path)) path = dirname(path); return path; };
  const pins = [...pinPathChain(nearest(runtimeDirectory), account.principal), ...rootSet.flatMap(root => pinPathAncestry(nearest(root)))];
  const endpoint = join(runtimeDirectory, process.platform === 'win32' ? 'ipc-endpoint.json' : 'ipc.sock');
  if (process.platform !== 'win32' && Buffer.byteLength(endpoint) > socketPathLimit()) throw new DaemonSecurityError('invalid_endpoint', `Use a shorter explicit runtime directory: endpoint exceeds ${socketPathLimit()} bytes.`);
  return Object.freeze({ kind: target.kind, uid: account.uid, principal: account.principal, namespaceId, accountDirectory: account.directory, runtimeDirectory, endpoint, agentDir, rootSet: Object.freeze(rootSet), pins: Object.freeze(pins) });
}

export function prepareDaemonTarget(target: ResolvedDaemonTarget): ResolvedDaemonTarget {
  for (const pin of target.pins) assertPathIdentity(pin);
  for (const root of [target.agentDir, ...target.rootSet]) storeDirectory(root);
  privateDirectory(target.runtimeDirectory, target.principal);
  for (const pin of target.pins) assertPathIdentity(pin);
  return Object.freeze({ ...target, pins: Object.freeze([...pinPathChain(target.runtimeDirectory, target.principal), ...target.rootSet.flatMap(pinPathAncestry)]) });
}

export function canonicalProspectivePath(path: string): string {
  if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0') || Buffer.byteLength(path) > 4096) throw new DaemonSecurityError('invalid_target', 'Target paths must be bounded absolute paths without NUL.');
  let at = resolve(path); const tail: string[] = [];
  while (!exists(at)) {
    const parent = dirname(at);
    if (parent === at) throw new DaemonSecurityError('invalid_target', 'Target filesystem root does not exist.');
    tail.unshift(basename(at)); at = parent;
  }
  return join(canonicalRealpath(at), ...tail);
}

export function identityFor(target: ResolvedDaemonTarget, instanceId: string): DaemonIdentity {
  return { namespaceId: target.namespaceId, instanceId, agentDir: target.agentDir, rootSet: [...target.rootSet] };
}
export function protocolTarget(target: ResolvedDaemonTarget): ProtocolDaemonTarget {
  return target.kind === 'production' ? { kind: 'production' } : { kind: 'isolated', runtimeDir: target.runtimeDirectory, fixtureRoot: dirname(target.runtimeDirectory) };
}
/** Store roots are excluded: a daemon may own more roots than a client declared. */
export function assertTargetIdentity(target: ResolvedDaemonTarget, expected: DaemonIdentity, actual: DaemonIdentity): void {
  if ([expected, actual].some(identity => identity.namespaceId !== target.namespaceId || identity.agentDir !== target.agentDir) || expected.instanceId !== actual.instanceId) {
    throw new DaemonSecurityError('target_mismatch', 'Daemon namespace, agent directory or instance differs from the pinned target.');
  }
}
