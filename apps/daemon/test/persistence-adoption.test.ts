import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, writeFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { SessionManager } from '@felan-ai/agent-core';
import { acquireDaemonOwnership, type DaemonOwnership } from '../src/daemon/ownership.js';
import { DaemonControlStore } from '../src/daemon/control-store.js';
import { adoptLegacySession, inspectLegacySession, LEGACY_WRITER_WARNING, type LegacyAdoptionOptions } from '../src/daemon/legacy-adoption.js';

const roots: string[] = []; const owners: DaemonOwnership[] = []; const stores: DaemonControlStore[] = [];
const children: ChildProcess[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; }
  for (const store of stores.splice(0)) store.close();
  for (const owner of owners.splice(0)) await owner.release();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 's104-adopt-')); roots.push(directory);
  const owner = await acquireDaemonOwnership({ kind: 'isolated', directory, namespaceId: randomUUID() }); owners.push(owner);
  const store = new DaemonControlStore(owner); stores.push(store);
  const sessionDir = join(owner.target.agentDir, 'sessions'); await mkdir(sessionDir, { mode: 0o700 });
  const source = join(sessionDir, 'legacy.jsonl');
  const bytes = '{"type":"session","version":3,"id":"old/id","cwd":"/fixture","timestamp":"2025-01-01T00:00:00.000Z"}\n{"type":"message","id":"entry","message":{"role":"user","content":[{"type":"text","text":"history"}]}}\n';
  await writeFile(source, bytes);
  const identity = inspectLegacySession(owner, source);
  const request = { source, expectedFingerprint: identity.fingerprint, expectedSession: identity.session, expectedCwd: identity.cwd, backupConfirmed: true as const, quiescenceConfirmed: true as const, warningAcknowledged: true as const };
  const options: LegacyAdoptionOptions = { managedDirectory: join(owner.target.agentDir, 'managed'), allSessionDirectories: [sessionDir], checkKnownWriters: async () => 'none_known' };
  return { owner, store, source, bytes, request, options, sessionDir };
}

describe.skipIf(!['darwin', 'linux'].includes(process.platform))('explicit legacy adoption', () => {
  it('lists the unchanged legacy identity and copies bytes outside every Pi scan root with an opaque filename', async () => {
    const { owner, store, source, bytes, request, options, sessionDir } = await fixture();
    expect(inspectLegacySession(owner, source).session).toBe('old/id');
    expect(store.snapshot().adoptions).toEqual([]);
    const adopted = await adoptLegacySession(store, request, options);
    expect(adopted.phase).toBe('complete'); expect(adopted.destination).not.toContain('old/id');
    expect(await readFile(source, 'utf8')).toBe(bytes); expect(await readFile(adopted.destination, 'utf8')).toBe(bytes);
    const listed = await SessionManager.list('/fixture', sessionDir);
    expect(listed.map(item => item.id)).toEqual(['old/id']);
    const resumed = SessionManager.open(adopted.destination, options.managedDirectory);
    expect(resumed.getSessionId()).toBe('old/id'); expect(resumed.getCwd()).toBe('/fixture');
    expect(await adoptLegacySession(store, request, options)).toEqual(adopted);
    store.close(); const reloaded = new DaemonControlStore(owner); stores.push(reloaded); reloaded.recover();
    expect(reloaded.snapshot().adoptions).toEqual([adopted]);
    expect(LEGACY_WRITER_WARNING).toMatch(/cannot prove/);
  });
  it('requires backup, quiescence and residual-risk acknowledgement; refuses live and uncertain writers', async () => {
    const { store, request, options } = await fixture();
    for (const field of ['backupConfirmed', 'quiescenceConfirmed', 'warningAcknowledged'] as const) await expect(adoptLegacySession(store, { ...request, [field]: false } as never, options)).rejects.toThrow(/Explicit/);
    for (const status of ['live', 'unknown'] as const) await expect(adoptLegacySession(store, request, { ...options, checkKnownWriters: async () => status })).rejects.toThrow(/blocks adoption/);
    expect(store.snapshot().adoptions).toEqual([]);
  });
  it('rejects changed source fingerprints, session IDs and cwd without a takeover', async () => {
    const { store, request, options } = await fixture();
    for (const patch of [{ expectedFingerprint: '0'.repeat(64) }, { expectedSession: 'different' }, { expectedCwd: '/elsewhere' }]) await expect(adoptLegacySession(store, { ...request, ...patch }, options)).rejects.toThrow(/changed/);
    expect(store.snapshot().adoptions).toEqual([]);
  });
  it('rejects default/custom scan overlap and symlink aliases to scan roots', async () => {
    const { owner, store, request, options, sessionDir } = await fixture();
    await expect(adoptLegacySession(store, request, { ...options, managedDirectory: join(sessionDir, 'managed') })).rejects.toThrow(/outside every/);
    const custom = join(owner.target.agentDir, 'custom'); await mkdir(custom); const alias = join(owner.target.agentDir, 'custom-alias'); await symlink(custom, alias);
    await expect(adoptLegacySession(store, request, { ...options, managedDirectory: join(alias, 'managed'), allSessionDirectories: [sessionDir, custom] })).rejects.toThrow(/outside every/);
  });
  it('rechecks source after asynchronous writer detection and ownership after every await', async () => {
    const { store, source, request, options, owner } = await fixture();
    await expect(adoptLegacySession(store, request, { ...options, checkKnownWriters: async () => { await writeFile(source, '{"changed":true}\n'); return 'none_known'; } })).rejects.toThrow(/invalid|changed/);
    expect(store.snapshot().adoptions).toEqual([]);
    await owner.release();
    await expect(adoptLegacySession(store, request, options)).rejects.toThrow(/released/);
  });
  it('retains an unexecutable copy intent if a writer appears before completion; retry is explicit', async () => {
    const { store, source, bytes, request, options } = await fixture(); let calls = 0;
    await expect(adoptLegacySession(store, request, { ...options, checkKnownWriters: async () => ++calls === 1 ? 'none_known' : 'live' })).rejects.toThrow(/remains staged/);
    const pending = store.snapshot().adoptions[0]!; expect(pending.phase).toBe('copy_intent');
    expect(await readFile(pending.destination, 'utf8')).toBe(bytes); expect(await readFile(source, 'utf8')).toBe(bytes);
    expect((await adoptLegacySession(store, request, options)).phase).toBe('complete');
  });
  it('never overwrites a mismatched managed copy, including on retry', async () => {
    const { store, request, options } = await fixture();
    const adopted = await adoptLegacySession(store, request, options);
    await writeFile(adopted.destination, '{"damaged":true}\n');
    await expect(adoptLegacySession(store, request, options)).rejects.toThrow(/invalid/);
    expect(await readFile(adopted.destination, 'utf8')).toBe('{"damaged":true}\n');
  });
  it('rejects a missing managed ancestor redirected into a Pi scan root during a writer check', async () => {
    const { owner, store, request, options, sessionDir } = await fixture();
    const future = join(owner.target.agentDir, 'future');
    await expect(adoptLegacySession(store, request, { ...options, managedDirectory: join(future, 'managed'), checkKnownWriters: async () => {
      await symlink(sessionDir, future); return 'none_known';
    } })).rejects.toThrow(/canonical destination/);
    expect(store.snapshot().adoptions).toEqual([]);
    expect((await SessionManager.list('/fixture', sessionDir)).map(item => item.id)).toEqual(['old/id']);
  });
  it('rejects an ancestor replacement during the final writer check', async () => {
    const { owner, store, request, options, sessionDir } = await fixture();
    const future = join(owner.target.agentDir, 'future'); let calls = 0;
    await expect(adoptLegacySession(store, request, { ...options, managedDirectory: join(future, 'managed'), checkKnownWriters: async () => {
      if (++calls === 2) { fs.renameSync(future, `${future}-old`); await symlink(sessionDir, future); }
      return 'none_known';
    } })).rejects.toThrow(/replaced|changed/);
    const persisted = JSON.parse(await readFile(join(store.directory, 'control.json'), 'utf8'));
    expect(persisted.data.adoptions[0]?.phase).toBe('copy_intent');
    expect((await SessionManager.list('/fixture', sessionDir)).map(item => item.id)).toEqual(['old/id']);
  });
  it('syncs a staged file and every new parent again after a failed install-directory fsync', async () => {
    const { store, request, options, owner } = await fixture();
    const outer = join(owner.target.agentDir, 'outer'); const managed = join(outer, 'managed');
    const original = fs.fsyncSync; let fail = true; const synced: string[] = [];
    fs.fsyncSync = (fd: number) => {
      const stat = fs.fstatSync(fd);
      for (const [name, path] of [['managed', managed], ['outer', outer], ['agent', owner.target.agentDir]] as const) {
        if (!fs.existsSync(path)) continue;
        const candidate = fs.statSync(path);
        if (stat.dev === candidate.dev && stat.ino === candidate.ino) {
          if (name === 'managed' && fail && fs.readdirSync(managed).some(file => file.endsWith('.jsonl'))) throw Object.assign(new Error('injected install-directory EIO'), { code: 'EIO' });
          synced.push(name);
        }
      }
      if (stat.isFile()) synced.push('file');
      return original(fd);
    }; syncBuiltinESMExports();
    try {
      await expect(adoptLegacySession(store, request, { ...options, managedDirectory: managed })).rejects.toThrow(/install-directory EIO/);
      expect(store.snapshot().adoptions[0]?.phase).toBe('copy_intent');
      fail = false; synced.length = 0;
      expect((await adoptLegacySession(store, request, { ...options, managedDirectory: managed })).phase).toBe('complete');
      const finalFile = synced.lastIndexOf('file', synced.lastIndexOf('managed'));
      expect(finalFile).toBeGreaterThanOrEqual(0); expect(synced.lastIndexOf('managed')).toBeGreaterThan(finalFile);
      expect(synced.lastIndexOf('outer')).toBeGreaterThan(synced.lastIndexOf('managed'));
      expect(synced.lastIndexOf('agent')).toBeGreaterThan(synced.lastIndexOf('outer'));
    } finally { fs.fsyncSync = original; syncBuiltinESMExports(); }
  });
  it('retries an actually killed installation only after syncing the staged file and directory', async () => {
    const directory = await mkdtemp(join(tmpdir(), 's104-kill-')); roots.push(directory);
    const target = { kind: 'isolated' as const, directory, namespaceId: randomUUID() };
    const child = spawn(process.execPath, [new URL('./fixtures/persistence-crash.mjs', import.meta.url).pathname, directory, target.namespaceId, 'unused', 'adoption-installed'], { stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH } }); children.push(child);
    let stderr = ''; child.stderr.on('data', data => { stderr += String(data); });
    const [code, signal] = await once(child, 'exit'); expect({ code, signal, stderr }).toEqual({ code: null, signal: 'SIGKILL', stderr: '' });
    const owner = await acquireDaemonOwnership(target); owners.push(owner);
    const store = new DaemonControlStore(owner); stores.push(store); store.recover();
    const pending = store.snapshot().adoptions[0]!; expect(pending.phase).toBe('copy_intent');
    const original = fs.fsyncSync; const synced = new Set<string>();
    fs.fsyncSync = (fd: number) => {
      const stat = fs.fstatSync(fd);
      for (const path of [pending.destination, join(owner.target.agentDir, 'managed')]) {
        const candidate = fs.statSync(path); if (stat.dev === candidate.dev && stat.ino === candidate.ino) synced.add(path);
      }
      return original(fd);
    }; syncBuiltinESMExports();
    try {
      const adopted = await adoptLegacySession(store, { source: pending.source, expectedFingerprint: pending.fingerprint, expectedSession: pending.session, expectedCwd: pending.cwd, backupConfirmed: true, quiescenceConfirmed: true, warningAcknowledged: true }, { managedDirectory: join(owner.target.agentDir, 'managed'), allSessionDirectories: [join(owner.target.agentDir, 'sessions')], checkKnownWriters: async () => 'none_known' });
      expect(adopted.phase).toBe('complete'); expect(synced.size).toBe(2);
    } finally { fs.fsyncSync = original; syncBuiltinESMExports(); }
  });
});
