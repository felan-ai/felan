import { closeSync, constants, fsyncSync, futimesSync, lstatSync, lutimesSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join } from 'node:path';
import type { DaemonIdentity } from '@felan-ai/session-protocol';
import { DaemonSecurityError, tryKernelLock } from './native-ownership.js';
import { assertPathIdentity, assertPrivateStat, canonicalProspectivePath, identityFor, openPrivateFile, pathIdentity, pathInside, pathsOverlap, pinPathAncestry, pinPathChain, prepareDaemonTarget, privateDirectory, resolveDaemonTarget, storeDirectory, type DaemonTarget, type PathIdentity, type ResolvedDaemonTarget } from './target.js';

interface Claim {
  kind: 'production' | 'isolated'; namespaceId: string; instanceId: string; lock: string;
  roots: string[]; nodes: NodeIdentity[]; ancestors: NodeIdentity[]; lockNode: NodeIdentity;
}
interface NodeIdentity { dev: string; ino: string }
interface Ledger { version: 1; claims: Claim[] }
const STORE_LOCK = '.felan-store.lock';
const CLAIMS_LOCK = 'claims.lock';
const KNOWN_ROOTS = 'daemon-store-roots.json';
/**
 * Temp reapers (macOS tmp_cleaner, systemd-tmpfiles) delete files whose atime, mtime and ctime are all days old.
 * Holding a flock never updates them, and deleting a pinned lock permanently fences the running owner.
 */
const TIMESTAMP_REFRESH_MS = 60 * 60_000;

/** Claims are only advisory hints about live daemons, so an unreadable ledger is rebuilt rather than trusted. */
function readLedger(directory: string): Ledger {
  let fd: number;
  try { fd = openSync(join(directory, 'claims.json'), constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch { return { version: 1, claims: [] }; }
  try {
    const value: unknown = JSON.parse(readFileSync(fd, 'utf8'));
    if (!value || typeof value !== 'object' || !('version' in value) || value.version !== 1 || !('claims' in value) || !Array.isArray(value.claims)) return { version: 1, claims: [] };
    return { version: 1, claims: value.claims.filter(validClaim) };
  } catch { return { version: 1, claims: [] }; }
  finally { closeSync(fd); }
}

function validClaim(c: Claim): boolean {
  return !!c && (c.kind === 'production' || c.kind === 'isolated') && typeof c.namespaceId === 'string' && typeof c.instanceId === 'string'
    && typeof c.lock === 'string' && /^(production|isolated-[a-f0-9]{64})\.lock$/.test(c.lock) && validNode(c.lockNode)
    && Array.isArray(c.roots) && c.roots.every((r: unknown) => typeof r === 'string' && r.startsWith('/') && !r.includes('\0'))
    && Array.isArray(c.nodes) && c.nodes.length === c.roots.length && c.nodes.every(validNode) && Array.isArray(c.ancestors) && c.ancestors.every(validNode);
}

function validNode(value: unknown): value is NodeIdentity {
  if (!value || typeof value !== 'object' || !('dev' in value) || !('ino' in value)) return false;
  return typeof value.dev === 'string' && /^\d{1,32}$/.test(value.dev) && typeof value.ino === 'string' && /^\d{1,32}$/.test(value.ino);
}
function node(pin: PathIdentity): NodeIdentity { return { dev: String(pin.dev), ino: String(pin.ino) }; }
function nodesIntersect(a: readonly NodeIdentity[], b: readonly NodeIdentity[]): boolean {
  const keys = new Set(a.map(n => `${n.dev}:${n.ino}`));
  return b.some(n => keys.has(`${n.dev}:${n.ino}`));
}
function existingNodes(paths: readonly string[]): NodeIdentity[] {
  return paths.flatMap(path => {
    try { return [node(pathIdentity(path))]; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  });
}
function uniqueNodes(pins: readonly PathIdentity[]): NodeIdentity[] {
  return [...new Map(pins.map(pin => { const n = node(pin); return [`${n.dev}:${n.ino}`, n] as const; })).values()];
}

/** A claim is live only while another process still holds its registered lifetime lock. */
function claimActive(target: ResolvedDaemonTarget, claim: Claim): boolean {
  let fd: number;
  try { fd = openSync(join(target.accountDirectory, claim.lock), constants.O_RDWR | constants.O_NOFOLLOW); }
  catch { return false; }
  try {
    const pin = pathIdentity(join(target.accountDirectory, claim.lock));
    if (String(pin.dev) !== claim.lockNode.dev || String(pin.ino) !== claim.lockNode.ino) return false;
    return !tryKernelLock(fd);
  } finally { closeSync(fd); }
}

function saveLedger(directory: string, uid: number, ledger: Ledger): void {
  const temp = join(directory, `claims-${randomUUID()}.tmp`);
  const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, JSON.stringify(ledger)); fsyncSync(fd); } finally { closeSync(fd); }
  try {
    assertPrivateStat(lstatSync(directory, { bigint: true }), uid, true);
    renameSync(temp, join(directory, 'claims.json'));
    const dir = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { fsyncSync(dir); } finally { closeSync(dir); }
  } finally { try { unlinkSync(temp); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; } }
}

async function coordination(target: ResolvedDaemonTarget): Promise<{ fd: number; pins: PathIdentity[] }> {
  privateDirectory(target.accountDirectory, target.uid);
  const pins = pinPathChain(target.accountDirectory, target.uid);
  const file = join(target.accountDirectory, CLAIMS_LOCK);
  const fd = openPrivateFile(file, target.uid);
  const pin = pathIdentity(file); pins.push(pin);
  try {
    const deadline = performance.now() + 5_000;
    while (!tryKernelLock(fd)) {
      if (performance.now() >= deadline) throw new DaemonSecurityError('ownership_busy', 'Account claim coordinator is busy; retry without removing its lock.');
      await new Promise(resolve => setTimeout(resolve, 10));
      for (const p of pins) assertPathIdentity(p);
    }
    for (const p of pins) assertPathIdentity(p);
    return { fd, pins };
  } catch (error) { closeSync(fd); throw error; }
}

export function namespaceLockName(target: ResolvedDaemonTarget): string {
  return target.kind === 'production' ? 'production.lock' : `isolated-${createHash('sha256').update(target.namespaceId).digest('hex')}.lock`;
}

function storeRootAllowed(target: ResolvedDaemonTarget, root: string): boolean {
  if (pathsOverlap(root, target.accountDirectory) || pathsOverlap(root, target.runtimeDirectory)) return false;
  return target.kind !== 'isolated' || pathInside(dirname(target.runtimeDirectory), root);
}

/** Session directories used before stay addressable after restart; they are locked again when a session opens there. */
function readKnownRoots(target: ResolvedDaemonTarget): string[] {
  let value: unknown;
  try { value = JSON.parse(readFileSync(join(target.agentDir, KNOWN_ROOTS), 'utf8')); } catch { return []; }
  if (!Array.isArray(value)) return [];
  return value.flatMap(root => {
    if (typeof root !== 'string' || !isAbsolute(root)) return [];
    try { const canonical = canonicalProspectivePath(root); return storeRootAllowed(target, canonical) ? [canonical] : []; } catch { return []; }
  });
}

function writeKnownRoots(agentDir: string, roots: readonly string[]): void {
  const path = join(agentDir, KNOWN_ROOTS); const temp = `${path}.${randomUUID()}.tmp`;
  try { writeFileSync(temp, JSON.stringify(roots), { flag: 'wx', mode: 0o600 }); renameSync(temp, path); }
  finally { try { unlinkSync(temp); } catch { /* Already renamed. */ } }
}

function lockStoreRoot(root: string): number {
  const fd = openSync(join(root, STORE_LOCK), constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  if (tryKernelLock(fd)) return fd;
  closeSync(fd);
  throw new DaemonSecurityError('root_conflict', 'The canonical store has a live kernel ownership lock.');
}

export class DaemonOwnership {
  readonly identity: DaemonIdentity;
  private lost: DaemonSecurityError | undefined;
  private released = false;
  private releasePromise: Promise<void> | undefined;
  private timer: NodeJS.Timeout;
  private listeners = new Set<(error: DaemonSecurityError) => void>();
  private extraPins: PathIdentity[] = [];
  private current: ResolvedDaemonTarget;
  private readonly owning = new Map<string, Promise<void>>();
  private refreshedAt = 0;

  constructor(target: ResolvedDaemonTarget, readonly instanceId: string, private readonly fds: number[], private readonly pins: readonly PathIdentity[],
    private readonly lockedRoots: string[] = [...target.rootSet]) {
    this.current = target;
    const identity = identityFor(target, instanceId); Object.freeze(identity.rootSet);
    this.identity = Object.freeze(identity);
    this.timer = setInterval(() => { try { this.assertCurrent(); this.refreshTimestamps(); } catch { /* assertCurrent synchronously fences and notifies. */ } }, 25);
    this.timer.unref();
  }
  get target(): ResolvedDaemonTarget { return this.current; }
  assertCurrent(): void {
    if (this.lost) throw this.lost;
    if (this.released) throw new DaemonSecurityError('ownership_lost', 'Daemon ownership has been released.');
    try {
      for (const pin of [...this.pins, ...this.extraPins]) assertPathIdentity(pin);
      for (const fd of this.fds) if (!tryKernelLock(fd)) throw new Error('kernel lock lost');
    }
    catch {
      this.lost = new DaemonSecurityError('ownership_lost', 'Daemon lock or path identity changed; admission is permanently fenced for this instance.');
      clearInterval(this.timer);
      for (const listener of this.listeners) { try { listener(this.lost); } catch { /* One observer must not suppress the remaining fences. */ } }
      throw this.lost;
    }
  }
  /** Wall-clock throttling refreshes on the first tick after sleep, when reapers may run immediately. */
  private refreshTimestamps(): void {
    const now = Date.now(); const elapsed = now - this.refreshedAt;
    if (elapsed >= 0 && elapsed < TIMESTAMP_REFRESH_MS) return;
    this.refreshedAt = now;
    const time = new Date(now);
    for (const fd of this.fds) futimesSync(fd, time, time);
    lutimesSync(join(this.current.accountDirectory, CLAIMS_LOCK), time, time);
  }
  watchPath(path: string): () => void {
    this.assertCurrent(); const pin = pathIdentity(path); this.extraPins.push(pin);
    return () => { this.extraPins = this.extraPins.filter(item => item !== pin); };
  }
  assertOwnsPath(path: string): string {
    this.assertCurrent();
    const canonical = canonicalProspectivePath(path);
    if (!this.current.rootSet.some(root => pathInside(root, canonical))) throw new DaemonSecurityError('root_not_owned', 'This path is outside the daemon store roots.');
    this.assertCurrent();
    return canonical;
  }
  /** Adds a session directory to the owned stores, locking it against other daemons. */
  ownRoot(directory: string): Promise<void> {
    this.assertCurrent();
    const root = canonicalProspectivePath(directory);
    if (this.lockedRoots.some(owned => pathInside(owned, root))) return Promise.resolve();
    let pending = this.owning.get(root);
    if (!pending) {
      pending = this.lockRoot(root).finally(() => this.owning.delete(root));
      this.owning.set(root, pending);
    }
    return pending;
  }
  private async lockRoot(root: string): Promise<void> {
    if (!storeRootAllowed(this.current, root)) throw new DaemonSecurityError('root_not_owned', 'Session stores cannot use daemon runtime paths or leave an isolated fixture.');
    storeDirectory(root);
    const coordinator = await coordination(this.current);
    try {
      this.assertCurrent();
      const ledger = readLedger(this.current.accountDirectory);
      if (ledger.claims.some(claim => claim.instanceId !== this.instanceId && claim.roots.some(other => pathsOverlap(other, root)) && claimActive(this.current, claim))) {
        throw new DaemonSecurityError('root_conflict', 'Another daemon owns an overlapping canonical store root.');
      }
      this.fds.push(lockStoreRoot(root));
      this.lockedRoots.push(root);
      const own = ledger.claims.find(claim => claim.instanceId === this.instanceId);
      if (own) { own.roots.push(root); own.nodes.push(node(pathIdentity(root))); saveLedger(this.current.accountDirectory, this.current.uid, ledger); }
    } finally { closeSync(coordinator.fd); }
    if (this.current.rootSet.includes(root)) return;
    const rootSet = Object.freeze([...this.current.rootSet, root]);
    this.current = Object.freeze({ ...this.current, rootSet });
    writeKnownRoots(this.current.agentDir, rootSet.filter(known => known !== this.current.agentDir));
  }
  onLost(listener: (error: DaemonSecurityError) => void): () => void {
    this.listeners.add(listener);
    if (this.lost) listener(this.lost);
    return () => this.listeners.delete(listener);
  }
  release(): Promise<void> { return this.releasePromise ??= this.releaseOnce(); }
  private async releaseOnce(): Promise<void> {
    // Call only after all owned writers have settled, including after loss.
    this.released = true; clearInterval(this.timer);
    let coordinator: Awaited<ReturnType<typeof coordination>> | undefined;
    try {
      for (const pin of this.pins.filter(p => p.path === this.current.accountDirectory || p.path.startsWith(`${this.current.accountDirectory}/`))) assertPathIdentity(pin);
      coordinator = await coordination(this.current);
      const ledger = readLedger(this.current.accountDirectory);
      ledger.claims = ledger.claims.filter(c => c.instanceId !== this.instanceId);
      saveLedger(this.current.accountDirectory, this.current.uid, ledger);
    } finally {
      for (const fd of this.fds.splice(0).reverse()) closeSync(fd);
      if (coordinator) closeSync(coordinator.fd);
      this.listeners.clear();
    }
  }
}

export async function acquireDaemonOwnership(input: DaemonTarget): Promise<DaemonOwnership> {
  let target = resolveDaemonTarget(input);
  const coordinator = await coordination(target);
  const held: number[] = [];
  try {
    const guardedRoots = [...target.rootSet, target.kind === 'isolated' ? dirname(target.runtimeDirectory) : target.runtimeDirectory];
    const candidateNodes = existingNodes(guardedRoots);
    const candidateAncestors = target.pins.map(node);
    const lock = namespaceLockName(target);
    const lifetime = openPrivateFile(join(target.accountDirectory, lock), target.uid);
    held.push(lifetime);
    if (!tryKernelLock(lifetime)) throw new DaemonSecurityError('owner_running', 'This OS account/namespace already has a daemon. Attach using its pinned roots; do not delete locks.');
    const live = readLedger(target.accountDirectory).claims.filter(claim => claim.lock !== lock && claimActive(target, claim));
    for (const claim of live) {
      if (claim.roots.some(root => guardedRoots.some(other => pathsOverlap(root, other))) || nodesIntersect(claim.nodes, candidateAncestors) || nodesIntersect(candidateNodes, claim.ancestors)) {
        throw new DaemonSecurityError('root_conflict', 'Another daemon owns an overlapping canonical store root.');
      }
    }
    target = prepareDaemonTarget(target);
    const nodes = guardedRoots.map(root => node(pathIdentity(root)));
    const ancestors = uniqueNodes(guardedRoots.flatMap(pinPathAncestry));
    for (const claim of live) {
      if (nodesIntersect(claim.nodes, ancestors) || nodesIntersect(nodes, claim.ancestors)) throw new DaemonSecurityError('root_conflict', 'A store inode or ancestor is already registered under another path.');
    }
    for (const root of target.rootSet) held.push(lockStoreRoot(root));
    const instanceId = randomUUID();
    const lockPin = pathIdentity(join(target.accountDirectory, lock));
    for (const pin of coordinator.pins) assertPathIdentity(pin);
    saveLedger(target.accountDirectory, target.uid, { version: 1, claims: [...live, { kind: target.kind, namespaceId: target.namespaceId, instanceId, lock, lockNode: node(lockPin), roots: guardedRoots, nodes, ancestors }] });
    const lockPins = [join(target.accountDirectory, lock), ...target.rootSet.map(root => join(root, STORE_LOCK))].map(pathIdentity);
    const lockedRoots = [...target.rootSet];
    const known = [...new Set(readKnownRoots(target))].filter(root => !lockedRoots.some(owned => pathInside(owned, root)));
    const owned = known.length ? Object.freeze({ ...target, rootSet: Object.freeze([...target.rootSet, ...known]) }) : target;
    return new DaemonOwnership(owned, instanceId, held, [...coordinator.pins, ...target.pins, ...lockPins], lockedRoots);
  } catch (error) { for (const fd of held.reverse()) closeSync(fd); throw error; }
  finally { closeSync(coordinator.fd); }
}
