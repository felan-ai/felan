import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HostAgentRuntime, type AgentRuntimeStorage } from '@felan-ai/agent-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FOREGROUND_MAX_BYTES, FOREGROUND_MAX_LINES, runForegroundCommand } from '../src/foreground.js';
import { getBackgroundBashRoot, type BackgroundBashInfo } from '../src/job-store.js';
import { BackgroundBashManager } from '../src/process-manager.js';

const roots: string[] = [];
const running: Array<{ manager: BackgroundBashManager; id: string }> = [];
const decoder = new TextDecoder();
const TEST_TIMEOUT_MS = 15_000;
/** The SIGTERM alone waits 5 seconds, and a Windows host spawns a Git Bash shell for every probe and signal. */
const SIGKILL_TEST_TIMEOUT_MS = 30_000;
const SESSION = 'session-a';
const MAX_SHORT_COMMAND_CALLS = 5;

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.allSettled(running.splice(0).map(({ manager, id }) => manager.stop(id, 'SIGKILL')));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('runForegroundCommand', () => {
  // A Windows host starts the job through storage writes, which takes more calls.
  it.skipIf(process.platform === 'win32').each(['echo hi', 'sleep 0.3; echo hi'])('makes at most five runtime calls for a short command: %s', async (command) => {
    const { runtime, storage, manager, calls } = await createCountingRuntime();
    const result = await runForegroundCommand(manager, runtime, storage, command, { timeoutMs: 5_000, noticeSession: SESSION });

    expect(result).toEqual({ kind: 'exited', output: 'hi', exitCode: 0, truncated: false });
    // Each runtime shell or session-storage call is a network round trip on a remote runtime.
    expect(calls.total, JSON.stringify(calls.byName)).toBeLessThanOrEqual(MAX_SHORT_COMMAND_CALLS);
    expect(await jobFiles(storage, runtime.cwd)).toEqual([]);
    expect(await storage.listFiles(join(getBackgroundBashRoot(storage.root, runtime.cwd), 'notices'), { recursive: true })).toEqual([]);
  });

  it('starts a command too long for one launch call through storage writes', async () => {
    const { runtime, storage, manager, calls } = await createCountingRuntime();
    const result = await runForegroundCommand(manager, runtime, storage, `: ${'x'.repeat(70_000)}; echo hi`, { timeoutMs: 5_000, noticeSession: SESSION });

    expect(result).toEqual({ kind: 'exited', output: 'hi', exitCode: 0, truncated: false });
    expect(calls.byName.writeFile).toBeGreaterThan(0);
    expect(await jobFiles(storage, runtime.cwd)).toEqual([]);
  });

  // A Windows host waits through storage reads, so no wait call prints the log there.
  it.skipIf(process.platform === 'win32')('returns the log a wait call printed before the deadline cut it off after deleting the job', async () => {
    const { runtime, storage, manager } = await createRuntime();
    const shell = runtime.shell.bind(runtime);
    vi.spyOn(runtime, 'shell').mockImplementation(async (script, options) => {
      const result = await shell(script, options);
      if (!result.stdout.startsWith('done\n')) return result;
      return { ...result, stdout: result.stdout.replace(/\n[a-f0-9]{32}:removed\n$/u, ''), killed: true, code: 143 };
    });

    await expect(runForegroundCommand(manager, runtime, storage, "printf 'kept\\n'", { timeoutMs: 5_000, noticeSession: SESSION }))
      .resolves.toEqual({ kind: 'exited', output: 'kept', exitCode: 0, truncated: false });
    expect(await jobFiles(storage, runtime.cwd)).toEqual([]);
  });

  it('returns short output and its exit code and removes the job it waited on', async () => {
    const { runtime, storage, manager } = await createRuntime();
    const result = await runForegroundCommand(manager, runtime, storage, "printf 'first\\nsecond\\n'; exit 3", { timeoutMs: 5_000, noticeSession: SESSION });

    expect(result).toEqual({ kind: 'exited', output: 'first\nsecond', exitCode: 3, truncated: false });
    expect(await jobFiles(storage, runtime.cwd)).toEqual([]);
    expect(await manager.pendingNotices(SESSION)).toEqual([]);
  });

  it('returns when the shell exits even while a background descendant keeps its output open', async () => {
    const { runtime, storage, manager } = await createRuntime();
    const started = Date.now();
    const result = await runForegroundCommand(manager, runtime, storage, '(sleep 3) & echo started', { timeoutMs: 5_000, noticeSession: SESSION });

    expect(result).toEqual({ kind: 'exited', output: 'started', exitCode: 0, truncated: false });
    expect(Date.now() - started).toBeLessThan(2_500);
  });

  it('keeps the full output of a truncated result in the unlisted job log', async () => {
    const { runtime, storage, manager } = await createRuntime();
    const output = Array.from({ length: 3000 }, (_, index) => `line ${index + 1}`).join('\n') + '\n';
    const result = await runForegroundCommand(manager, runtime, storage, 'i=1; while [ $i -le 3000 ]; do echo "line $i"; i=$((i+1)); done', { timeoutMs: 5_000, noticeSession: SESSION });

    expect(result).toMatchObject({ kind: 'exited', exitCode: 0, truncated: true, output: output.trimEnd().split('\n').slice(-FOREGROUND_MAX_LINES).join('\n') });
    if (result.kind !== 'exited') throw new Error('Expected an exited command');
    expect(decoder.decode(await storage.readFile(result.fullOutputPath!))).toBe(output);
    expect(await manager.list()).toEqual([]);
    expect(await manager.pendingNotices(SESSION)).toEqual([]);
  });

  it('limits bytes without splitting multi-byte UTF-8 characters', async () => {
    const { runtime, storage, manager } = await createRuntime();
    const result = await runForegroundCommand(manager, runtime, storage, nodeCommand("process.stdout.write('界'.repeat(60000))"), { timeoutMs: 5_000, noticeSession: SESSION });

    expect(result).toMatchObject({ kind: 'exited', exitCode: 0, truncated: true, output: '界'.repeat(Math.floor(FOREGROUND_MAX_BYTES / 3)) });
    if (result.kind !== 'exited') throw new Error('Expected an exited command');
    expect(decoder.decode(await storage.readFile(result.fullOutputPath!))).toBe('界'.repeat(60000));
  });

  it('keeps decoded replacement characters within the byte limit for invalid UTF-8', async () => {
    const { runtime, storage, manager } = await createRuntime();
    const result = await runForegroundCommand(manager, runtime, storage, nodeCommand(`process.stdout.write(Buffer.alloc(${3 * FOREGROUND_MAX_BYTES}, 0xff))`), { timeoutMs: 5_000, noticeSession: SESSION });

    expect(result).toMatchObject({ kind: 'exited', exitCode: 0, truncated: true, output: '\uFFFD'.repeat(Math.floor(FOREGROUND_MAX_BYTES / 3)) });
  });

  it('hands back a listed detached job at the deadline that keeps running and owes its notice', async () => {
    const { runtime, storage, manager } = await createRuntime();
    const result = await runForegroundCommand(manager, runtime, storage, "printf 'before\\n'; while [ ! -f continue ]; do sleep 0.02; done; printf 'after\\n'", { timeoutMs: 300, noticeSession: SESSION });

    expect(result.kind).toBe('timeout');
    if (result.kind !== 'timeout') throw new Error('Expected a timeout');
    running.push({ manager, id: result.job.meta.id });
    expect(result.job.status.status).toBe('running');
    const info = JSON.parse(decoder.decode(await storage.readFile(result.job.meta.infoPath))) as BackgroundBashInfo;
    expect(info).toMatchObject({ executionMode: 'detached', promotedAt: expect.any(Number), notice: 'pending', noticeSession: SESSION });
    expect(info.foreground).toBeUndefined();
    expect((await manager.list('running')).map(job => job.meta.id)).toEqual([result.job.meta.id]);
    expect((await manager.pendingNotices(SESSION)).map(job => job.meta.id)).toEqual([result.job.meta.id]);

    await runtime.writeFile('continue', new Uint8Array());
    const finished = await manager.wait(result.job.meta.id, 5);
    expect(finished).toMatchObject({ timedOut: false, job: { status: { status: 'completed', exitCode: 0 } } });
    expect(await manager.tail(result.job.meta.id)).toBe('before\nafter');
  });

  it('escalates to SIGKILL when a cancelled command ignores SIGTERM', async () => {
    const { runtime, storage, manager } = await createRuntime();
    const controller = new AbortController();
    const result = runForegroundCommand(manager, runtime, storage, "trap '' TERM; printf '%s' \"$$\" > shell.pid; while :; do sleep 0.05; done", { timeoutMs: 20_000, noticeSession: SESSION, signal: controller.signal });
    // The command writes its PID after it starts ignoring SIGTERM, so the cancel cannot arrive before the trap.
    const pid = await vi.waitFor(async () => {
      const written = decoder.decode(await runtime.readFile('shell.pid'));
      expect(written).toMatch(/^\d+$/u);
      return written;
    }, { timeout: 10_000, interval: 20 });
    controller.abort();

    await expect(result).rejects.toThrow('Command cancelled');
    expect(await jobFiles(storage, runtime.cwd)).toEqual([]);
    expect((await runtime.shell(`kill -0 ${pid} 2>/dev/null`, { shellFlavor: 'posix' })).code).not.toBe(0);
  }, SIGKILL_TEST_TIMEOUT_MS);

  it.each(['before', 'during'])('stops and removes the job when aborted %s the wait', async (when) => {
    const { runtime, storage, manager } = await createRuntime();
    const controller = new AbortController();
    if (when === 'before') controller.abort();
    else setTimeout(() => controller.abort(), 200);

    await expect(runForegroundCommand(manager, runtime, storage, "printf '%s' \"$$\" > shell.pid; exec sleep 30", { timeoutMs: 5_000, noticeSession: SESSION, signal: controller.signal }))
      .rejects.toThrow('Command cancelled');

    expect(await jobFiles(storage, runtime.cwd)).toEqual([]);
    const pid = await runtime.readFile('shell.pid').then(bytes => decoder.decode(bytes), () => undefined);
    if (pid) expect((await runtime.shell(`kill -0 ${pid} 2>/dev/null`, { shellFlavor: 'posix' })).code).not.toBe(0);
  });
}, TEST_TIMEOUT_MS);

async function createRuntime(): Promise<{ runtime: HostAgentRuntime; storage: AgentRuntimeStorage; manager: BackgroundBashManager }> {
  const root = await mkdtemp(join(tmpdir(), 'felan-foreground-'));
  roots.push(root);
  const cwd = join(root, 'workspace');
  const sessionStorageRoot = join(root, 'session-storage');
  const agentStorageRoot = join(root, 'agent-storage');
  await Promise.all([cwd, sessionStorageRoot, agentStorageRoot].map((path) => mkdir(path, { recursive: true })));
  const runtime = new HostAgentRuntime(cwd, { sessionStorageRoot, agentStorageRoot });
  return { runtime, storage: runtime.storage('session'), manager: new BackgroundBashManager(runtime) };
}

/** Counts every `runtime.shell` call and every session-storage method call made by the manager. */
async function createCountingRuntime() {
  const { runtime } = await createRuntime();
  const calls = { total: 0, byName: {} as Record<string, number> };
  const count = (name: string) => { calls.total += 1; calls.byName[name] = (calls.byName[name] ?? 0) + 1; };
  const storage = runtime.storage('session');
  const counted = new Proxy(storage, {
    get(target, key, receiver) {
      const value: unknown = Reflect.get(target, key, receiver);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => { count(String(key)); return (value as (...items: unknown[]) => unknown).apply(target, args); };
    },
  });
  vi.spyOn(runtime, 'storage').mockReturnValue(counted);
  const shell = runtime.shell.bind(runtime);
  vi.spyOn(runtime, 'shell').mockImplementation((script, options) => { count('shell'); return shell(script, options); });
  return { runtime, storage: counted, manager: new BackgroundBashManager(runtime), calls };
}

async function jobFiles(storage: AgentRuntimeStorage, cwd: string): Promise<string[]> {
  return storage.listFiles(join(getBackgroundBashRoot(storage.root, cwd), 'jobs'), { recursive: true });
}

function nodeCommand(source: string): string {
  return `'${process.execPath.replaceAll("'", "'\\''")}' -e '${source.replaceAll("'", "'\\''")}'`;
}
