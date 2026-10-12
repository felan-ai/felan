import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import type { DaemonIdentity } from '@felan-ai/session-protocol';
import { DaemonSecurityError, tryKernelLock } from './native-ownership.js';
import { assertPathIdentity, assertPrivateStat, canonicalProspectivePath, identityFor, openPrivateFile, pathIdentity, pathInside, pathsOverlap, pinPathChain, prepareDaemonTarget, privateDirectory, resolveDaemonTarget, type DaemonTarget, type PathIdentity, type ResolvedDaemonTarget } from './target.js';

interface Claim {
  kind: 'production' | 'isolated'; namespaceId: string; instanceId: string; lock: string;
  roots: string[]; nodes: NodeIdentity[]; ancestors: NodeIdentity[]; lockNode: NodeIdentity;
}
interface NodeIdentity { dev: string; ino: string }
interface Ledger { version: 1; claims: Claim[] }
const LEDGER_LIMIT = 1_048_576;

function readLedger(directory: string, uid: number): Ledger {
  const path = join(directory, 'claims.json');
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, claims: [] }; throw error; }
  try {
    const stat = fstatSync(fd, { bigint: true }); assertPrivateStat(stat, uid, false);
    if (stat.size > BigInt(LEDGER_LIMIT)) throw new Error('oversize');
    const value: unknown = JSON.parse(readFileSync(fd, 'utf8'));
    if (!value || typeof value !== 'object' || !('version' in value) || value.version !== 1 || !('claims' in value) || !Array.isArray(value.claims) || value.claims.length > 1024) throw new Error('schema');
    for (const c of value.claims) {
      if (!c || (c.kind !== 'production' && c.kind !== 'isolated') || typeof c.namespaceId !== 'string' || typeof c.instanceId !== 'string' || typeof c.lock !== 'string' || !/^(production|isolated-[a-f0-9]{64})\.lock$/.test(c.lock) || !validNode(c.lockNode) || !Array.isArray(c.roots) || c.roots.length > 128 || c.roots.some((r: unknown) => typeof r !== 'string' || !r.startsWith('/') || r.includes('\0')) || !Array.isArray(c.nodes) || c.nodes.length !== c.roots.length || !c.nodes.every(validNode) || !Array.isArray(c.ancestors) || c.ancestors.length > 4096 || !c.ancestors.every(validNode)) throw new Error('schema');
    }
    return value as Ledger;
  } catch {
    throw new DaemonSecurityError('ownership_blocked', 'Account claim ledger is invalid or unsafe. Recovery requires operator inspection, never automatic deletion.');
  } finally { closeSync(fd); }
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

function retainDistinctClaims(claims: Claim[]): Claim[] {
  const retained: Claim[] = [];
  const production = new Map<string, number>();
  for (const claim of claims) {
    if (claim.kind !== 'production') { retained.push(claim); continue; }
    const stores = claim.roots.map((root, i) => JSON.stringify([root, claim.nodes[i]!.dev, claim.nodes[i]!.ino])).sort();
    const key = JSON.stringify([claim.namespaceId, claim.lock, stores]);
    const index = production.get(key);
    if (index === undefined) { production.set(key, retained.length); retained.push(claim); continue; }
    const ancestors = [...new Map([...retained[index]!.ancestors, ...claim.ancestors].map(n => [`${n.dev}:${n.ino}`, n])).values()];
    if (ancestors.length > 4096) throw new DaemonSecurityError('ownership_blocked', 'Production store ancestry history is full.');
    retained[index] = { ...claim, ancestors };
  }
  return retained;
}

function prepareIsolation(target: ResolvedDaemonTarget): PathIdentity | undefined {
  if (target.kind !== 'isolated') return undefined;
  const root = dirname(target.runtimeDirectory);
  privateDirectory(root, target.uid);
  const rootNode = node(pathIdentity(root));
  const path = join(root, '.felan-isolated.json');
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    if (readdirSync(root).length !== 0) throw new DaemonSecurityError('invalid_target', 'A new isolated target must be an empty private directory, not an existing store. Reuse requires its matching isolation marker.');
    fd = openSync(path, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { writeFileSync(fd, JSON.stringify({ version: 1, namespaceId: target.namespaceId, ...rootNode })); fsyncSync(fd); }
    finally { closeSync(fd); }
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  }
  try {
    const stat = fstatSync(fd, { bigint: true }); assertPrivateStat(stat, target.uid, false);
    if (stat.size > 4096n) throw new Error('oversize');
    const marker = JSON.parse(readFileSync(fd, 'utf8')) as { version?: unknown; namespaceId?: unknown; dev?: unknown; ino?: unknown };
    if (marker.version !== 1 || marker.namespaceId !== target.namespaceId || marker.dev !== rootNode.dev || marker.ino !== rootNode.ino) throw new Error('mismatch');
    const pin = pathIdentity(path);
    if (stat.dev !== pin.dev || stat.ino !== pin.ino) throw new Error('replacement');
    return pin;
  } catch { throw new DaemonSecurityError('invalid_target', 'Isolated target marker does not match this namespace and canonical directory identity.'); }
  finally { closeSync(fd); }
}

function saveLedger(directory: string, uid: number, ledger: Ledger): void {
  const bytes = JSON.stringify(ledger);
  if (Buffer.byteLength(bytes) > LEDGER_LIMIT) throw new DaemonSecurityError('ownership_blocked', 'Account claim ledger is full.');
  const temp = join(directory, `claims-${randomUUID()}.tmp`);
  const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
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
  const file = join(target.accountDirectory, 'claims.lock');
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

export class DaemonOwnership {
  readonly identity: DaemonIdentity;
  private lost: DaemonSecurityError | undefined;
  private released = false;
  private releasePromise: Promise<void> | undefined;
  private timer: NodeJS.Timeout;
  private listeners = new Set<(error: DaemonSecurityError) => void>();
  private extraPins: PathIdentity[] = [];

  constructor(readonly target: ResolvedDaemonTarget, readonly instanceId: string, private readonly fds: number[], private readonly pins: readonly PathIdentity[]) {
    const identity = identityFor(target, instanceId); Object.freeze(identity.rootSet);
    this.identity = Object.freeze(identity);
    this.timer = setInterval(() => { try { this.assertCurrent(); } catch { /* assertCurrent synchronously fences and notifies. */ } }, 25);
    this.timer.unref();
  }
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
  watchPath(path: string): () => void {
    this.assertCurrent(); const pin = pathIdentity(path); this.extraPins.push(pin);
    return () => { this.extraPins = this.extraPins.filter(item => item !== pin); };
  }
  assertOwnsPath(path: string): string {
    this.assertCurrent();
    const canonical = canonicalProspectivePath(path);
    if (!this.target.rootSet.some(root => pathInside(root, canonical))) throw new DaemonSecurityError('root_not_owned', 'This store is outside the daemon launch root set. Restart with the root explicitly declared before opening it.');
    this.assertCurrent();
    return canonical;
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
      if (this.target.kind === 'isolated') {
        for (const pin of this.pins.filter(p => p.path === this.target.accountDirectory || p.path.startsWith(`${this.target.accountDirectory}/`))) assertPathIdentity(pin);
        coordinator = await coordination(this.target);
        const ledger = readLedger(this.target.accountDirectory, this.target.uid);
        ledger.claims = ledger.claims.filter(c => c.instanceId !== this.instanceId);
        saveLedger(this.target.accountDirectory, this.target.uid, ledger);
      }
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
    const ledger = readLedger(target.accountDirectory, target.uid);
    const guardedRoots = [...target.rootSet, target.kind === 'isolated' ? dirname(target.runtimeDirectory) : target.runtimeDirectory];
    const candidateNodes = existingNodes(guardedRoots);
    const candidateAncestors = target.pins.map(node);
    const lock = namespaceLockName(target);
    for (const claim of ledger.claims) {
      let pin: PathIdentity;
      try { pin = pathIdentity(join(target.accountDirectory, claim.lock)); }
      catch { throw new DaemonSecurityError('ownership_blocked', 'A registered lifetime lock disappeared; operator recovery is required.'); }
      if (String(pin.dev) !== claim.lockNode.dev || String(pin.ino) !== claim.lockNode.ino) throw new DaemonSecurityError('ownership_blocked', 'A registered lock identity changed; operator recovery is required.');
    }
    const lifetime = openPrivateFile(join(target.accountDirectory, lock), target.uid);
    held.push(lifetime);
    if (!tryKernelLock(lifetime)) throw new DaemonSecurityError('owner_running', 'This OS account/namespace already has a daemon. Attach using its pinned roots; do not delete locks.');
    const kept: Claim[] = [];
    for (const claim of ledger.claims) {
      const overlap = claim.roots.some(root => guardedRoots.some(other => pathsOverlap(root, other))) || nodesIntersect(claim.nodes, candidateAncestors) || nodesIntersect(candidateNodes, claim.ancestors);
      if (target.kind === 'isolated' && claim.kind === 'production' && overlap) throw new DaemonSecurityError('target_mismatch', 'Isolated targets cannot claim a current or previously registered production store.');
      if (claim.lock === lock) {
        if (claim.kind === 'production') kept.push(claim);
        continue;
      }
      const path = join(target.accountDirectory, claim.lock);
      let fd: number;
      try { fd = openSync(path, constants.O_RDWR | constants.O_NOFOLLOW); }
      catch { throw new DaemonSecurityError('ownership_blocked', 'A registered lifetime lock disappeared; operator recovery is required.'); }
      let active: boolean;
      try { assertPrivateStat(fstatSync(fd, { bigint: true }), target.uid, false); active = !tryKernelLock(fd); } finally { closeSync(fd); }
      if (active && overlap) throw new DaemonSecurityError('root_conflict', 'Another daemon owns an overlapping canonical store root.');
      if (active || claim.kind === 'production') kept.push(claim);
    }
    const isolationPin = prepareIsolation(target);
    target = prepareDaemonTarget(target);
    const nodes = guardedRoots.map(root => node(pathIdentity(root)));
    const ancestors = [...new Map(guardedRoots.flatMap(root => pinPathChain(root, target.uid)).map(pin => { const n = node(pin); return [`${n.dev}:${n.ino}`, n] as const; })).values()];
    if (ancestors.length > 4096) throw new DaemonSecurityError('invalid_target', 'Too many store ancestor identities.');
    for (const claim of kept) {
      if (claim.lock !== lock && (nodesIntersect(claim.nodes, ancestors) || nodesIntersect(nodes, claim.ancestors))) throw new DaemonSecurityError('root_conflict', 'A store inode or ancestor is already registered under another path.');
    }
    for (const root of target.rootSet) {
      const fd = openPrivateFile(join(root, '.felan-store.lock'), target.uid); held.push(fd);
      if (!tryKernelLock(fd)) throw new DaemonSecurityError('root_conflict', 'The canonical store has a live kernel ownership lock.');
    }
    const instanceId = randomUUID();
    const lockPin = pathIdentity(join(target.accountDirectory, lock));
    const claims = retainDistinctClaims([...kept, { kind: target.kind, namespaceId: target.namespaceId, instanceId, lock, lockNode: node(lockPin), roots: guardedRoots, nodes, ancestors }]);
    if (claims.length > 1024) throw new DaemonSecurityError('ownership_blocked', 'Account claim ledger is full.');
    for (const pin of coordinator.pins) assertPathIdentity(pin);
    saveLedger(target.accountDirectory, target.uid, { version: 1, claims });
    const lockPins = [join(target.accountDirectory, lock), ...target.rootSet.map(root => join(root, '.felan-store.lock'))].map(pathIdentity);
    return new DaemonOwnership(target, instanceId, held, [...coordinator.pins, ...target.pins, ...lockPins, ...(isolationPin ? [isolationPin] : [])]);
  } catch (error) { for (const fd of held.reverse()) closeSync(fd); throw error; }
  finally { closeSync(coordinator.fd); }
}
