import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { closeSync, existsSync, linkSync, lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import { tmpdir, userInfo } from 'node:os';
import { join, parse } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { accountPrincipal, assertPrivatePath, isWritableByOthers, lockStillHeld, protectPrivateDirectory, requireOwnershipPlatform, socketPathLimit, tryLockFile } from '../src/daemon/native-ownership.js';
import { canonicalProspectivePath, pinPathChain, privateDirectory, realAccountLocation, resolveDaemonTarget } from '../src/daemon/target.js';
import { replaceFile, syncDirectory } from '../src/daemon/durability.js';

const roots: string[] = [];
const descriptors = new Set<number>();
const children: ChildProcessWithoutNullStreams[] = [];
const nativeModule = new URL('../dist/daemon/native-ownership.js', import.meta.url).href;
const childSource = `
  import { closeSync, openSync } from 'node:fs';
  import { accountPrincipal, lockStillHeld, tryLockFile } from ${JSON.stringify(nativeModule)};
  const [mode, path] = process.argv.slice(1);
  let fd;
  try {
    fd = mode === 'read' ? openSync(path, 'r') : tryLockFile(path, accountPrincipal());
    process.stdout.write(JSON.stringify({ locked: fd !== undefined, current: fd !== undefined && lockStillHeld(fd) }) + '\\n');
  } catch (error) { process.stdout.write(JSON.stringify({ error: error.code }) + '\\n'); }
  if (mode === 'hold' && fd !== undefined) {
    process.stdin.resume();
    process.stdin.once('data', () => setTimeout(() => { closeSync(fd); process.stdin.pause(); }, 100));
  }
  else if (fd !== undefined) closeSync(fd);
`;

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; }
  }
  for (const fd of descriptors) closeSync(fd);
  descriptors.clear();
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

function fixture(): string {
  const root = canonicalProspectivePath(mkdtempSync(join(tmpdir(), 'native-windows-'))); roots.push(root);
  protectPrivateDirectory(root, accountPrincipal());
  return root;
}
function grant(path: string, rights: string): void {
  const result = spawnSync('icacls.exe', [path, '/grant', `*S-1-1-0:${rights}`], { windowsHide: true, encoding: 'utf8' });
  expect(result.error).toBeUndefined(); expect(result.status).toBe(0);
}
async function childLock(path: string, mode = 'lock') {
  const child = spawn(process.execPath, ['--input-type=module', '-e', childSource, mode, path], { windowsHide: true, stdio: 'pipe' });
  children.push(child);
  const result = await new Promise<{ locked?: boolean; current?: boolean; error?: string }>((resolve, reject) => {
    let pending = '';
    const timer = setTimeout(() => reject(new Error('Lock child response timeout')), 5_000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', () => { clearTimeout(timer); if (!pending.includes('\n')) reject(new Error('Lock child exited without a response')); });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      pending += chunk;
      if (pending.includes('\n')) { clearTimeout(timer); resolve(JSON.parse(pending.slice(0, pending.indexOf('\n')))); }
    });
  });
  if (mode !== 'hold' && child.exitCode === null && child.signalCode === null) await once(child, 'exit');
  return { child, result };
}
function lock(path: string): number {
  const fd = tryLockFile(path, accountPrincipal()); expect(fd).toBeDefined();
  descriptors.add(fd!); return fd!;
}

describe.runIf(process.platform === 'win32')('native Windows ownership', () => {
  it('uses the token SID and profile, not HOME or USERPROFILE', () => {
    expect(requireOwnershipPlatform()).toBe('win32');
    const sid = accountPrincipal(); expect(sid).toMatch(/^S-1-5-(?:\d+-)*\d+$/); expect(accountPrincipal()).toBe(sid);
    const before = realAccountLocation(); const home = process.env.HOME; const profile = process.env.USERPROFILE;
    try {
      process.env.HOME = 'C:\\not-the-account'; process.env.USERPROFILE = 'C:\\not-the-profile';
      expect(realAccountLocation()).toEqual(before);
      expect(before).toMatchObject({ uid: -1, principal: sid, home: canonicalProspectivePath(userInfo().homedir) });
      expect(before.directory).toBe(join(before.home, 'AppData', 'Local', 'felan-daemon-v1'));
    } finally {
      if (home === undefined) delete process.env.HOME; else process.env.HOME = home;
      if (profile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = profile;
    }
    expect(() => socketPathLimit()).toThrow(/Unix socket/);
  });

  it('protects new directories and accepts their inherited file DACLs', () => {
    const root = fixture(); const directory = privateDirectory(join(root, 'private'), accountPrincipal());
    const file = join(directory, 'state'); writeFileSync(file, 'private');
    expect(() => assertPrivatePath(directory, lstatSync(directory, { bigint: true }), accountPrincipal(), 'directory')).not.toThrow();
    expect(() => assertPrivatePath(file, lstatSync(file, { bigint: true }), accountPrincipal(), 'file')).not.toThrow();
    expect(isWritableByOthers(directory, lstatSync(directory, { bigint: true }))).toBe(false);
    expect(isWritableByOthers(file, lstatSync(file, { bigint: true }))).toBe(false);
  });

  it('rejects an applicable Everyone allow ACE and distinguishes read access from write access', () => {
    const root = fixture(); const directory = privateDirectory(join(root, 'private'), accountPrincipal());
    grant(directory, '(OI)(CI)R');
    expect(() => assertPrivatePath(directory, lstatSync(directory, { bigint: true }), accountPrincipal(), 'directory')).toThrow(/owner-only/);
    expect(() => privateDirectory(directory, accountPrincipal())).toThrow(/owner-only/);
    expect(isWritableByOthers(directory, lstatSync(directory, { bigint: true }))).toBe(false);
    grant(directory, '(OI)(CI)W');
    expect(isWritableByOthers(directory, lstatSync(directory, { bigint: true }))).toBe(true);
    const child = join(directory, 'child');
    privateDirectory(child, accountPrincipal());
    expect(() => pinPathChain(child, accountPrincipal())).toThrow(/ancestor/);
  });

  it('ignores inherit-only ACEs on the checked object', () => {
    const root = fixture(); grant(root, '(OI)(CI)(IO)F');
    expect(() => assertPrivatePath(root, lstatSync(root, { bigint: true }), accountPrincipal(), 'directory')).not.toThrow();
    expect(isWritableByOthers(root, lstatSync(root, { bigint: true }))).toBe(false);
    const file = join(root, 'inherited'); writeFileSync(file, 'not private');
    expect(() => assertPrivatePath(file, lstatSync(file, { bigint: true }), accountPrincipal(), 'file')).toThrow(/owner-only/);
  });

  it('rejects junctions and multiply linked private files', () => {
    const root = fixture(); const directory = privateDirectory(join(root, 'private'), accountPrincipal());
    const alias = join(root, 'alias'); symlinkSync(directory, alias, 'junction');
    expect(() => assertPrivatePath(alias, lstatSync(alias, { bigint: true }), accountPrincipal(), 'directory')).toThrow();
    const file = join(root, 'file'); writeFileSync(file, 'private'); linkSync(file, join(root, 'link'));
    expect(() => assertPrivatePath(file, lstatSync(file, { bigint: true }), accountPrincipal(), 'file')).toThrow(/one link/);
  });

  it('holds exclusive-share locks across processes and releases them on close and process death', async () => {
    const path = join(fixture(), 'lifetime.lock'); const fd = lock(path);
    expect(lockStillHeld(fd)).toBe(true);
    expect((await childLock(path)).result).toEqual({ locked: false, current: false });
    expect((await childLock(path, 'read')).result.error).toBe('EBUSY');
    closeSync(fd); descriptors.delete(fd); expect(lockStillHeld(fd)).toBe(false);
    const held = await childLock(path, 'hold'); expect(held.result).toEqual({ locked: true, current: true });
    expect(tryLockFile(path, accountPrincipal())).toBeUndefined();
    const exited = once(held.child, 'exit'); held.child.kill('SIGKILL'); await exited;
    expect(lockStillHeld(lock(path))).toBe(true);
  });

  it('expands native paths and preserves prospective path components at the drive root', () => {
    const root = fixture(); const drive = parse(root).root; const missing = join(drive, `felan-missing-${Date.now()}`, 'child');
    expect(canonicalProspectivePath(missing)).toBe(missing);
    const absentDrive = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'].map(letter => `${letter}:\\`).find(path => !existsSync(path));
    expect(absentDrive).toBeDefined();
    expect(() => canonicalProspectivePath(join(absentDrive!, 'missing'))).toThrow(/filesystem root/);
    const target = resolveDaemonTarget({ kind: 'isolated', directory: root, namespaceId: 'windows-native' });
    expect(target.uid).toBe(-1); expect(target.principal).toBe(accountPrincipal());
    expect(target.endpoint).toBe(join(root, 'runtime', 'ipc-endpoint.json'));
  });

  it('skips directory fsync and bounds replacement retries while another process holds the target open', async () => {
    const root = fixture(); expect(() => syncDirectory(root)).not.toThrow();
    const source = join(root, 'source'); const target = join(root, 'target'); writeFileSync(source, 'new');
    const held = await childLock(target, 'hold'); expect(held.result.locked).toBe(true);
    const start = performance.now(); expect(() => replaceFile(source, target)).toThrow();
    expect(performance.now() - start).toBeGreaterThanOrEqual(1_900); expect(performance.now() - start).toBeLessThan(4_000);
    const exited = once(held.child, 'exit'); held.child.stdin.write('release\n');
    replaceFile(source, target); await exited; expect(readFileSync(target, 'utf8')).toBe('new');
  });
});
