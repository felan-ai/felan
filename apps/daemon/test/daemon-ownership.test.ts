import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, readFile, rename, rm, stat, symlink, unlink, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { acquireDaemonOwnership, namespaceLockName, type DaemonOwnership } from '../src/daemon/ownership.js';
import { canonicalProspectivePath, realAccountLocation, resolveDaemonTarget, type DaemonTarget } from '../src/daemon/target.js';

const windows = process.platform === 'win32';
const supported = ['darwin', 'linux', 'win32'].includes(process.platform);
const roots: string[] = [];
const owners: DaemonOwnership[] = [];
const children: ChildProcessWithoutNullStreams[] = [];
const fixture = new URL('./fixtures/daemon-owner.mjs', import.meta.url);
const ownershipFixture = `
  import { spawn } from 'node:child_process';
  import { acquireDaemonOwnership } from ${JSON.stringify(new URL('../dist/daemon/ownership.js', import.meta.url).href)};
  const target = JSON.parse(process.argv[1]);
  if (target.kind !== 'isolated') throw new Error('Fixture refuses production');
  let owner;
  try {
    owner = await acquireDaemonOwnership(target);
    process.stdout.write(JSON.stringify({ ready: owner.identity }) + '\\n');
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', async command => {
      if (command.trim() === 'stop') { await owner.release(); process.exit(0); }
      if (command.trim() === 'check') { owner.assertCurrent(); process.stdout.write('current\\n'); }
      if (command.trim() === 'spawn-descendant') {
        spawn(process.execPath, ['-e', 'setTimeout(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true }).unref();
        process.stdout.write('spawned\\n');
      }
    });
  } catch (error) {
    await owner?.release();
    process.stdout.write(JSON.stringify({ error: error.code ?? 'fixture_failure' }) + '\\n');
    process.exitCode = 1;
  }
`;

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      // The child may exit before the write lands; the exit wait and SIGKILL below cover that case.
      child.stdin.on('error', () => {});
      const exited = once(child, 'exit'); if (!windows) child.kill('SIGCONT'); child.stdin.write('stop\n');
      await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 1_000))]);
      if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
    }
  }
  for (const owner of owners.splice(0)) await owner.release();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function target(): Promise<Extract<DaemonTarget, { kind: 'isolated' }>> {
  const directory = canonicalProspectivePath(await mkdtemp(join(tmpdir(), 's103-'))); roots.push(directory);
  return { kind: 'isolated', directory, namespaceId: randomUUID() };
}
async function acquire(input: DaemonTarget) { const owner = await acquireDaemonOwnership(input); owners.push(owner); return owner; }
function start(input: DaemonTarget) {
  const args = windows ? ['--input-type=module', '-e', ownershipFixture, JSON.stringify(input)] : [fileURLToPath(fixture), JSON.stringify(input)];
  const child = spawn(process.execPath, args, { stdio: 'pipe', windowsHide: true, env: { ...(windows ? process.env : { PATH: process.env.PATH }), HOME: '/deliberately-not-the-os-home', FELAN_AGENT_DIR: '/not-the-production-account', ...(process.env.S103_DAEMON_BUILD ? { S103_DAEMON_BUILD: process.env.S103_DAEMON_BUILD } : {}) } });
  children.push(child);
  const lines: string[] = []; let pending = ''; const waiters: ((line: string) => void)[] = [];
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    pending += chunk;
    for (;;) { const end = pending.indexOf('\n'); if (end < 0) break; const line = pending.slice(0, end); pending = pending.slice(end + 1); const waiter = waiters.shift(); if (waiter) waiter(line); else lines.push(line); }
  });
  return { child, line: () => lines.length ? Promise.resolve(lines.shift()!) : new Promise<string>((resolve, reject) => { waiters.push(resolve); const timer = setTimeout(() => reject(new Error('fixture response timeout')), 5_000); timer.unref(); }) };
}

describe.skipIf(!supported)('kernel-backed daemon ownership', () => {
  it('resolves the real account independently of HOME and refuses production paths in isolated targets', async () => {
    const account = realAccountLocation();
    const input = await target();
    const child = start(input); const ready = JSON.parse(await child.line()); expect(ready.ready).toBeDefined();
    expect(resolveDaemonTarget(input).accountDirectory).toBe(account.directory);
    expect(() => resolveDaemonTarget({ ...input, directory: join(account.home, '.felan', 'test') })).toThrow(/production/);
    expect(() => resolveDaemonTarget({ ...input, storeRoots: [join(account.home, '.felan')] })).toThrow(/inside/);
    expect(() => resolveDaemonTarget({ ...input, namespaceId: 'production' })).toThrow(/namespace/);
    const a = resolveDaemonTarget({ kind: 'production', agentDir: join(input.directory, 'a'), storeRoots: [] });
    const b = resolveDaemonTarget({ kind: 'production', agentDir: join(input.directory, 'b'), storeRoots: [] });
    expect(namespaceLockName(a)).toBe('production.lock'); expect(namespaceLockName(b)).toBe(namespaceLockName(a));
  });

  it('admits exactly one owner under simultaneous launches', async () => {
    const input = await target();
    const launched = Array.from({ length: 5 }, () => start(input));
    const responses = await Promise.all(launched.map(child => child.line().then(line => JSON.parse(line))));
    expect(responses.filter(response => response.ready)).toHaveLength(1);
    expect(responses.filter(response => response.error === 'owner_running')).toHaveLength(4);
  });

  // Windows has no SIGSTOP/SIGCONT process suspension.
  it.skipIf(windows)('refuses a contender while the owner is SIGSTOP-paused', async () => {
    const input = await target(); const winner = start(input);
    expect(JSON.parse(await winner.line()).ready).toBeDefined();
    winner.child.kill('SIGSTOP');
    const contender = start(input); expect(JSON.parse(await contender.line()).error).toBe('owner_running');
    winner.child.kill('SIGCONT'); winner.child.stdin.write('check\n'); expect(await winner.line()).toBe('current');
  });

  it('covers custom stores, canonical aliases and ancestor/descendant overlaps across namespaces', async () => {
    const input = await target(); const store = join(input.directory, 'shared');
    const owner = await acquire({ ...input, storeRoots: [store] });
    const alias = join(input.directory, 'alias'); await symlink(store, alias, windows ? 'junction' : 'dir');
    await expect(acquireDaemonOwnership({ ...input, namespaceId: randomUUID(), storeRoots: [alias] })).rejects.toMatchObject({ code: 'root_conflict' });
    await expect(acquireDaemonOwnership({ ...input, namespaceId: randomUUID(), storeRoots: [join(store, 'nested')] })).rejects.toMatchObject({ code: 'root_conflict' });
    owner.assertCurrent();
    expect(owner.assertOwnsPath(join(alias, 'new-data.json'))).toBe(join(canonicalProspectivePath(store), 'new-data.json'));
    expect(() => owner.assertOwnsPath(join(input.directory, 'outside'))).toThrow(/outside/);
    const external = await target(); await symlink(external.directory, join(store, 'escape'), windows ? 'junction' : 'dir');
    expect(() => owner.assertOwnsPath(join(store, 'escape', 'file'))).toThrow(/outside/);
  });

  it('owns session directories on first use, keeps them addressable after restart and ignores store permissions', async () => {
    const input = await target(); const sessions = join(input.directory, 'custom-sessions');
    const owner = await acquire(input); await chmod(owner.target.agentDir, 0o775);
    expect(() => owner.assertOwnsPath(join(sessions, 'a.jsonl'))).toThrow(/outside/);
    await Promise.all([owner.ownRoot(sessions), owner.ownRoot(sessions)]);
    const canonical = join(canonicalProspectivePath(sessions), 'a.jsonl');
    expect(owner.assertOwnsPath(join(sessions, 'a.jsonl'))).toBe(canonical);
    const outside = await target();
    await expect(owner.ownRoot(outside.directory)).rejects.toMatchObject({ code: 'root_not_owned' });
    owner.assertCurrent(); await owner.release(); owners.splice(owners.indexOf(owner), 1);
    const restarted = await acquire(input);
    expect(restarted.assertOwnsPath(join(sessions, 'a.jsonl'))).toBe(canonical);
    await restarted.ownRoot(sessions); restarted.assertCurrent();
  });

  // Windows exclusive-share handles prohibit replacing a directory containing a held lock.
  it.skipIf(windows)('fences replaced store directories and supports idempotent concurrent release', async () => {
    const input = await target(); const owner = await acquire(input);
    await rename(owner.target.agentDir, `${owner.target.agentDir}.old`); await mkdir(owner.target.agentDir, { mode: 0o700 });
    expect(() => owner.assertCurrent()).toThrow(/fenced/);
    await Promise.all([owner.release(), owner.release()]);
  });

  // Windows exclusive-share handles prohibit renaming or deleting a held lock.
  it.skipIf(windows).each(['replace', 'delete'] as const)('fences admission on store-lock %s without treating it as kernel unlock', async action => {
    const input = await target(); const owner = await acquire(input); const file = join(owner.target.agentDir, '.felan-store.lock');
    let lost = 0; owner.onLost(() => lost++);
    if (action === 'replace') { await rename(file, `${file}.old`); await writeFile(file, '', { mode: 0o600 }); }
    else await unlink(file);
    expect(() => owner.assertCurrent()).toThrow(/fenced/); expect(lost).toBe(1);
    await expect(acquireDaemonOwnership(input)).rejects.toMatchObject({ code: 'owner_running' });
    if (action === 'replace') { await unlink(file); await rename(`${file}.old`, file); }
    else await writeFile(file, '', { mode: 0o600 });
    expect(() => owner.assertCurrent()).toThrow(/fenced/);
  });

  // Windows coordinator files live under AppData\\Local, outside POSIX temp reapers.
  it.skipIf(windows)('keeps pinned lock files fresh so temp reapers cannot fence a long-lived owner', async () => {
    const input = await target(); await (await acquireDaemonOwnership(input)).release();
    const resolved = resolveDaemonTarget(input);
    const namespace = join(resolved.accountDirectory, namespaceLockName(resolved)); const store = join(resolved.agentDir, '.felan-store.lock');
    const stale = new Date(Date.now() - 10 * 86_400_000);
    const age = async (path: string) => Date.now() - (await stat(path)).mtimeMs;
    await utimes(namespace, stale, stale); await utimes(store, stale, stale);
    const owner = await acquire(input);
    await vi.waitFor(async () => expect(await age(namespace)).toBeLessThan(60_000));
    for (const lock of [namespace, store, join(resolved.accountDirectory, 'claims.lock')]) expect(await age(lock)).toBeLessThan(60_000);
    await utimes(namespace, stale, stale); await utimes(store, stale, stale);
    expect(await age(namespace)).toBeGreaterThan(86_400_000);
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.now() + 2 * 60 * 60_000);
      await vi.waitFor(async () => {
        expect(await age(namespace)).toBeLessThan(60_000); expect(await age(store)).toBeLessThan(60_000);
      });
    } finally { vi.useRealTimers(); }
    owner.assertCurrent();
  });

  // Windows privacy uses DACLs rather than chmod modes; native-windows.test.ts covers it.
  it.skipIf(windows)('refuses unsafe runtime, root permissions and symlinked lock files without altering them', async () => {
    const input = await target(); await mkdir(join(input.directory, 'runtime'), { mode: 0o777 }); await chmod(join(input.directory, 'runtime'), 0o777);
    await expect(acquireDaemonOwnership(input)).rejects.toThrow(/owner-only/);
    expect((await lstat(join(input.directory, 'runtime'))).mode & 0o777).toBe(0o777);
    await rm(join(input.directory, 'runtime'), { recursive: true });
    const initialized = await acquire(input); await initialized.release();
    const agent = join(input.directory, 'agent'); const sentinel = join(input.directory, 'sentinel');
    const lock = join(agent, '.felan-store.lock'); await rename(lock, `${lock}.original`);
    await writeFile(sentinel, 'unchanged', { mode: 0o600 }); await symlink(sentinel, lock);
    await expect(acquireDaemonOwnership(input)).rejects.toThrow();
    expect(await readFile(sentinel, 'utf8')).toBe('unchanged');
    await unlink(lock); await rename(`${lock}.original`, lock);
  });

  it('uses an existing nonempty directory as an isolated target without touching its files', async () => {
    const input = await target(); await writeFile(join(input.directory, 'existing-store'), 'leave alone');
    const owner = await acquire(input); await owner.release();
    expect(await readFile(join(input.directory, 'existing-store'), 'utf8')).toBe('leave alone');
  });

  it('keeps principal strings stable and supports idempotent concurrent release', async () => {
    const owner = await acquire(await target());
    expect(windows ? /^S-1-/.test(owner.target.principal) : owner.target.principal === String(owner.target.uid)).toBe(true);
    expect(owner.target.endpoint).toBe(join(owner.target.runtimeDirectory, windows ? 'ipc-endpoint.json' : 'ipc.sock'));
    owner.assertCurrent(); await Promise.all([owner.release(), owner.release()]);
  });

  it('rejects isolated agent/runtime symlinks that escape the fixture even with no custom stores', async () => {
    const input = await target(); const outside = await target();
    await symlink(outside.directory, join(input.directory, 'runtime'), windows ? 'junction' : 'dir');
    expect(() => resolveDaemonTarget(input)).toThrow(/must not be a symlink/);
    await unlink(join(input.directory, 'runtime'));
    await symlink(outside.directory, join(input.directory, 'agent'), windows ? 'junction' : 'dir');
    expect(() => resolveDaemonTarget({ ...input, storeRoots: [] })).toThrow(/inside the canonical fixture/);
  });

  it('releases kernel lifetime locks on abrupt owner death and never uses a stored PID', async () => {
    const input = await target(); const first = start(input); const identity = JSON.parse(await first.line()).ready;
    first.child.stdin.write('spawn-descendant\n'); expect(await first.line()).toBe('spawned');
    const exited = once(first.child, 'exit'); first.child.kill('SIGKILL'); await exited;
    const second = start(input); const next = JSON.parse(await second.line());
    expect(next.ready.instanceId).not.toBe(identity.instanceId);
  });
});
