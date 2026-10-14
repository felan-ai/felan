import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import { acquireDaemonOwnership, namespaceLockName, type DaemonOwnership } from '../src/daemon/ownership.js';
import { realAccountLocation, resolveDaemonTarget, type DaemonTarget } from '../src/daemon/target.js';

const supported = ['darwin', 'linux'].includes(process.platform);
const roots: string[] = [];
const owners: DaemonOwnership[] = [];
const children: ChildProcessWithoutNullStreams[] = [];
const fixture = new URL('./fixtures/daemon-owner.mjs', import.meta.url);

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit'); child.kill('SIGCONT'); child.stdin.write('stop\n');
      await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 1_000))]);
      if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
    }
  }
  for (const owner of owners.splice(0)) await owner.release();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function target(): Promise<Extract<DaemonTarget, { kind: 'isolated' }>> {
  const directory = await mkdtemp(join(tmpdir(), 's103-')); roots.push(directory);
  return { kind: 'isolated', directory, namespaceId: randomUUID() };
}
async function acquire(input: DaemonTarget) { const owner = await acquireDaemonOwnership(input); owners.push(owner); return owner; }
function start(input: DaemonTarget) {
  const child = spawn(process.execPath, [fixture.pathname, JSON.stringify(input)], { stdio: 'pipe', env: { PATH: process.env.PATH, HOME: '/deliberately-not-the-os-home', FELAN_AGENT_DIR: '/not-the-production-account', ...(process.env.S103_DAEMON_BUILD ? { S103_DAEMON_BUILD: process.env.S103_DAEMON_BUILD } : {}) } });
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

  it('admits exactly one owner under simultaneous launches, including while SIGSTOP-paused', async () => {
    const input = await target();
    const launched = Array.from({ length: 5 }, () => start(input));
    const responses = await Promise.all(launched.map(child => child.line().then(line => JSON.parse(line))));
    expect(responses.filter(response => response.ready)).toHaveLength(1);
    expect(responses.filter(response => response.error === 'owner_running')).toHaveLength(4);
    const winner = launched[responses.findIndex(response => response.ready)]!;
    winner.child.kill('SIGSTOP');
    const contender = start(input); expect(JSON.parse(await contender.line()).error).toBe('owner_running');
    winner.child.kill('SIGCONT'); winner.child.stdin.write('check\n'); expect(await winner.line()).toBe('current');
  });

  it('covers custom stores, canonical aliases and ancestor/descendant overlaps across namespaces', async () => {
    const input = await target(); const store = join(input.directory, 'shared');
    const owner = await acquire({ ...input, storeRoots: [store] });
    const alias = join(input.directory, 'alias'); await symlink(store, alias);
    await expect(acquireDaemonOwnership({ ...input, namespaceId: randomUUID(), storeRoots: [alias] })).rejects.toMatchObject({ code: 'root_conflict' });
    await expect(acquireDaemonOwnership({ ...input, namespaceId: randomUUID(), storeRoots: [join(store, 'nested')] })).rejects.toMatchObject({ code: 'root_conflict' });
    owner.assertCurrent();
    expect(owner.assertOwnsPath(join(alias, 'new-data.json'))).toBe(join(await realpath(store), 'new-data.json'));
    expect(() => owner.assertOwnsPath(join(input.directory, 'outside'))).toThrow(/outside/);
    const external = await target(); await symlink(external.directory, join(store, 'escape'));
    expect(() => owner.assertOwnsPath(join(store, 'escape', 'file'))).toThrow(/outside/);
  });

  it('owns session directories on first use, keeps them addressable after restart and ignores store permissions', async () => {
    const input = await target(); const sessions = join(input.directory, 'custom-sessions');
    const owner = await acquire(input); await chmod(owner.target.agentDir, 0o775);
    expect(() => owner.assertOwnsPath(join(sessions, 'a.jsonl'))).toThrow(/outside/);
    await Promise.all([owner.ownRoot(sessions), owner.ownRoot(sessions)]);
    const canonical = join(await realpath(sessions), 'a.jsonl');
    expect(owner.assertOwnsPath(join(sessions, 'a.jsonl'))).toBe(canonical);
    const outside = await target();
    await expect(owner.ownRoot(outside.directory)).rejects.toMatchObject({ code: 'root_not_owned' });
    owner.assertCurrent(); await owner.release(); owners.splice(owners.indexOf(owner), 1);
    const restarted = await acquire(input);
    expect(restarted.assertOwnsPath(join(sessions, 'a.jsonl'))).toBe(canonical);
    await restarted.ownRoot(sessions); restarted.assertCurrent();
  });

  it('fences replaced store directories and supports idempotent concurrent release', async () => {
    const input = await target(); const owner = await acquire(input);
    await rename(owner.target.agentDir, `${owner.target.agentDir}.old`); await mkdir(owner.target.agentDir, { mode: 0o700 });
    expect(() => owner.assertCurrent()).toThrow(/fenced/);
    await Promise.all([owner.release(), owner.release()]);
  });

  it.each(['replace', 'delete'] as const)('fences admission on store-lock %s without treating it as kernel unlock', async action => {
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

  it('refuses unsafe runtime, root permissions and symlinked lock files without altering them', async () => {
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

  it('rejects isolated agent/runtime symlinks that escape the fixture even with no custom stores', async () => {
    const input = await target(); const outside = await target();
    await symlink(outside.directory, join(input.directory, 'runtime'));
    expect(() => resolveDaemonTarget(input)).toThrow(/must not be a symlink/);
    await unlink(join(input.directory, 'runtime'));
    await symlink(outside.directory, join(input.directory, 'agent'));
    expect(() => resolveDaemonTarget({ ...input, storeRoots: [] })).toThrow(/inside the canonical fixture/);
  });

  it('releases kernel lifetime locks on abrupt owner death and never uses a stored PID', async () => {
    const input = await target(); const first = start(input); const identity = JSON.parse(await first.line()).ready;
    first.child.stdin.write('spawn-descendant\n'); expect(await first.line()).toBe('spawned');
    const exited = once(first.child, 'exit'); first.child.kill('SIGKILL'); await exited;
    const second = start(input); const next = JSON.parse(await second.line());
    expect(next.ready.instanceId).not.toBe(identity.instanceId);
    await new Promise(resolve => setTimeout(resolve, 1_100));
  });
});
