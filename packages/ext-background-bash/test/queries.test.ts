import { mkdtemp, mkdir, rm, symlink, writeFile, access, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalRuntimeStorage, HostAgentRuntime, type AgentRuntime, type AgentRuntimeStorage, type AgentRuntimeListFilesOptions } from '@felan-ai/agent-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BackgroundBashJobStore, getBackgroundBashJobsDir, type BackgroundBashPage } from '../src/job-store.js';
import { BackgroundBashManager } from '../src/process-manager.js';
import { formatProcessListResult, PROCESS_LIST_RESULT_BYTES } from '../src/list-result.js';
import { BackgroundBashRetention, RETENTION_INTERVAL, TERMINAL_MAX_AGE_MS } from '../src/retention.js';
import { removeRetainedJob } from '../src/retention-removal.js';

const encoder = new TextEncoder();
const temporaryPaths: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporaryPaths.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe('bounded process queries', () => {
  it('reads ten records from huge history using only immediate directory names', async () => {
    const { store, storage } = fixture(10_000);
    const page = await store.query();
    expect(page.jobs).toHaveLength(10);
    expect(page).toMatchObject({ hasMore: true, scanned: 10, nextCursor: id(9_990) });
    expect(storage.readFile).toHaveBeenCalledTimes(20);
    expect(storage.listFiles).toHaveBeenCalledWith(store.jobsDir, { recursive: false, includeDirectories: true });
    expect(storage.remove).not.toHaveBeenCalled();
  });

  it('pages stably through same-second IDs, concurrent insertions and deletions', async () => {
    const { store, storage } = fixture(27);
    const first = await store.query({ limit: 7 });
    seed(storage, store.jobsDir, 99);
    storage.files.delete(`${store.jobsDir}/${id(19)}/info.json`);
    const result = first.jobs.map(job => job.meta.id);
    let cursor = first.nextCursor;
    while (cursor) {
      const page = await store.query({ limit: 7, cursor });
      result.push(...page.jobs.map(job => job.meta.id));
      cursor = page.nextCursor;
    }
    expect(new Set(result).size).toBe(result.length);
    expect(result).toEqual(Array.from({ length: 27 }, (_, n) => id(26 - n)).filter(value => value !== id(19)));
  });

  it('advances empty bounded search pages without skipping matches', async () => {
    const { store } = fixture(250);
    let cursor: string | undefined;
    const found: string[] = [];
    const scanned: number[] = [];
    do {
      const page = await store.query({ search: 'command 4', ...(cursor ? { cursor } : {}) });
      found.push(...page.jobs.map(job => job.meta.id));
      scanned.push(page.scanned);
      cursor = page.nextCursor;
    } while (cursor);
    expect(scanned[0]).toBe(100);
    expect(found).toEqual([49, 48, 47, 46, 45, 44, 43, 42, 41, 40, 4].map(id));
  });

  it('finds old running jobs only through explicit bounded status pages', async () => {
    const { store, storage } = fixture(250);
    seed(storage, store.jobsDir, 0, 'running');
    const first = await store.query({ status: 'running' });
    expect(first).toMatchObject({ jobs: [], hasMore: true, scanned: 100 });
    expect(storage.readFile).toHaveBeenCalledTimes(200);
    const second = await store.query({ status: 'running', cursor: first.nextCursor! });
    const last = await store.query({ status: 'running', cursor: second.nextCursor! });
    expect(last.jobs.map(job => job.meta.id)).toEqual([id(0)]);
    expect(last).toMatchObject({ scanned: 50, hasMore: false });
  });

  it('keeps list(all) compatibility without reading terminal metadata twice', async () => {
    const { runtime, storage } = fixture(30);
    const manager = new BackgroundBashManager(runtime);
    const listed = await manager.list('all');
    expect(listed).toHaveLength(30);
    expect(storage.readFile).toHaveBeenCalledTimes(60);
  });

  it('rejects invalid boundaries before touching storage', async () => {
    const { store, storage } = fixture(3);
    for (const options of [{ cursor: '../outside' }, { limit: 0 }, { limit: 101 }, { search: 'a'.repeat(257) }]) {
      await expect(store.query(options)).rejects.toThrow();
    }
    await expect(store.readJob('../../outside')).resolves.toBeUndefined();
    expect(storage.readFile).not.toHaveBeenCalled();
  });
});

describe('compact process tool output', () => {
  it('bounds the entire JSON result even with huge escaped commands and signals', async () => {
    const { store, storage } = fixture(100);
    const command = '\u0000\\"\n🌍'.repeat(10_000);
    for (let n = 0; n < 100; n++) seed(storage, store.jobsDir, n, 'failed', command);
    const page = await store.query({ limit: 100 });
    page.jobs[0]!.status.signal = command;
    const result = formatProcessListResult(page);
    expect(encoder.encode(JSON.stringify(result)).length).toBeLessThanOrEqual(PROCESS_LIST_RESULT_BYTES);
    expect(result.content[0]!.text).toContain('Output clipped');
    expect(result.details.jobs[0]).toMatchObject({ meta: { id: id(99), command: expect.any(String) }, status: { status: 'failed' }, commandTruncated: true });
    expect(result.details.jobs[0]!.meta.command.length).toBeGreaterThan(0);
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });

  it('discloses pagination in text and details even for empty filtered pages', async () => {
    const page: BackgroundBashPage = { jobs: [], scanned: 100, hasMore: true, nextCursor: id(9) };
    const result = formatProcessListResult(page);
    expect(result.content[0]!.text).toContain(`cursor: ${id(9)}`);
    expect(result.details).toMatchObject({ hasMore: true, nextCursor: id(9) });
  });
});

describe('incremental terminal retention', () => {
  it('retains the latest 1000 terminal jobs and processes no more than 32 records per trigger', async () => {
    const { store, storage, runtime } = fixture(1_030);
    const retention = maintenance(runtime, storage, store.jobsDir);
    for (let batch = 0; batch < 33; batch++) {
      storage.readFile.mockClear();
      for (let n = 0; n < RETENTION_INTERVAL; n++) await retention.recordMutation();
      expect(storage.readFile.mock.calls.length).toBeLessThanOrEqual(64);
    }
    expect(storage.remove).toHaveBeenCalledTimes(30);
    expect([...storage.files.keys()].filter(path => path.endsWith('/info.json'))).toHaveLength(1_000);
    expect(storage.files.has(`${store.jobsDir}/${id(30)}/info.json`)).toBe(true);
  });

  it('triggers at 32 mutations, expiring only verified inactive terminal records', async () => {
    const { store, storage, runtime } = fixture(0);
    for (let n = 0; n < 7; n++) seed(storage, store.jobsDir, n, n === 1 ? 'unknown' : n === 2 ? 'running' : 'completed', undefined, Date.now() - TERMINAL_MAX_AGE_MS - 1);
    storage.files.delete(`${store.jobsDir}/${id(3)}/completion.json`);
    patch(storage, store.jobsDir, 4, { pid: 123 });
    patch(storage, store.jobsDir, 5, { pid: -1 });
    storage.files.set(`${store.jobsDir}/${id(6)}/completion.json`, encoder.encode('{"id":"../outside","status":"completed"}'));
    const retention = maintenance(runtime, storage, store.jobsDir);
    for (let n = 0; n < RETENTION_INTERVAL - 1; n++) await retention.recordMutation();
    expect(storage.readFile).not.toHaveBeenCalled();
    await retention.recordMutation();
    expect(storage.remove).toHaveBeenCalledExactlyOnceWith(`${store.jobsDir}/${id(0)}`, { recursive: true });
  });

  it('protects recent completions even beyond the count limit', async () => {
    const { store, storage, runtime } = fixture(0);
    for (let n = 0; n < 1_010; n++) seed(storage, store.jobsDir, n, 'completed', undefined, Date.now());
    const retention = maintenance(runtime, storage, store.jobsDir);
    for (let n = 0; n < 32 * RETENTION_INTERVAL; n++) await retention.recordMutation();
    expect(storage.remove).not.toHaveBeenCalled();
  });

  it('preserves surviving process-group children after the recorded runner exits', async () => {
    const { store, storage, runtime } = fixture(0);
    seed(storage, store.jobsDir, 0, 'completed', undefined, Date.now() - TERMINAL_MAX_AGE_MS - 1);
    patch(storage, store.jobsDir, 0, { pid: 123, processGroupId: 123 });
    vi.mocked(runtime.shell).mockImplementation(async command => ({
      code: command.startsWith('ps -p ') ? 1 : 0, stdout: command.startsWith('ps -p ') ? '' : '123\n456\n', stderr: '', killed: false,
    }));
    const retention = maintenance(runtime, storage, store.jobsDir);
    for (let n = 0; n < RETENTION_INTERVAL; n++) await retention.recordMutation();
    expect(storage.remove).not.toHaveBeenCalled();
    vi.mocked(runtime.shell).mockImplementation(async command => ({
      code: command.startsWith('ps -p ') ? 1 : 0, stdout: command.startsWith('ps -p ') ? '' : '456\n', stderr: '', killed: false,
    }));
    for (let n = 0; n < RETENTION_INTERVAL; n++) await retention.recordMutation();
    expect(storage.remove).toHaveBeenCalledExactlyOnceWith(`${store.jobsDir}/${id(0)}`, { recursive: true });
  });

  it('runs natural-operation maintenance on writes, never on recent reads', async () => {
    const { store, storage } = fixture(0);
    seed(storage, store.jobsDir, 0, 'completed', undefined, Date.now() - TERMINAL_MAX_AGE_MS - 1);
    for (let n = 0; n < 35; n++) await store.query();
    expect(storage.remove).not.toHaveBeenCalled();
    for (let n = 0; n < 32; n++) await store.createJob('running fixture');
    for (let n = 0; n < 32; n++) await store.createJob('another running fixture');
    expect(storage.remove).toHaveBeenCalledExactlyOnceWith(`${store.jobsDir}/${id(0)}`, { recursive: true });
  });

  it('does not follow a symlinked workspace ancestor inside the session root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'process-retention-'));
    temporaryPaths.push(root);
    const cwd = join(root, 'workspace');
    const sessionRoot = join(root, 'session');
    await mkdir(cwd);
    const runtime = new HostAgentRuntime(cwd, { sessionStorageRoot: sessionRoot, agentStorageRoot: join(root, 'agent') });
    const jobsDir = getBackgroundBashJobsDir(sessionRoot, cwd);
    const target = join(sessionRoot, 'other-jobs');
    await mkdir(target, { recursive: true });
    await mkdir(join(jobsDir, '..'), { recursive: true });
    await symlink(target, jobsDir, 'dir');
    const jobDir = join(target, id(0));
    await mkdir(jobDir);
    const old = Date.now() - TERMINAL_MAX_AGE_MS - 1;
    await writeFile(join(jobDir, 'info.json'), JSON.stringify({ id: id(0), command: 'fixture', cwd, status: 'completed', startedAt: old, completedAt: old }));
    await writeFile(join(jobDir, 'completion.json'), JSON.stringify({ id: id(0), status: 'completed', completedAt: old }));
    const storage = createLocalRuntimeStorage(sessionRoot);
    const retention = new BackgroundBashRetention(runtime, storage, jobsDir, async () => [id(0)], async (_id, operation) => operation());
    for (let n = 0; n < RETENTION_INTERVAL; n++) await retention.recordMutation();
    await expect(access(jobDir)).resolves.toBeUndefined();
  });

  it('removes only known flat files using no-follow descriptor-relative operations', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'process-retention-safe-')));
    temporaryPaths.push(root);
    const runtime = new HostAgentRuntime(root, { sessionStorageRoot: root, agentStorageRoot: join(root, 'agent') });
    const jobsDir = getBackgroundBashJobsDir(root, root);
    const jobDir = join(jobsDir, id(0));
    await mkdir(jobDir, { recursive: true });
    await writeFile(join(jobDir, 'info.json'), '{}');
    const outside = join(root, 'unrelated');
    await writeFile(outside, 'preserve');
    await symlink(outside, join(jobDir, 'output.log'));
    await expect(removeRetainedJob(runtime, root, jobDir)).resolves.toBe(false);
    await expect(access(outside)).resolves.toBeUndefined();
    await rm(join(jobDir, 'output.log'));
    await mkdir(join(jobDir, 'unexpected'));
    await expect(removeRetainedJob(runtime, root, jobDir)).resolves.toBe(false);
    await rm(join(jobDir, 'unexpected'), { recursive: true });
    await expect(removeRetainedJob(runtime, root, join(root, '..', 'outside'))).resolves.toBe(false);
    await expect(removeRetainedJob(runtime, root, jobDir)).resolves.toBe(true);
    await expect(access(jobDir)).rejects.toThrow();
  });

  it('retains jobs when the optional no-follow removal runtime is unavailable', async () => {
    const { runtime, store, storage } = fixture(0);
    seed(storage, store.jobsDir, 0, 'completed', undefined, Date.now() - TERMINAL_MAX_AGE_MS - 1);
    vi.mocked(runtime.exec).mockRejectedValue(new Error('python3 unavailable'));
    const retention = maintenance(runtime, storage, store.jobsDir);
    for (let n = 0; n < RETENTION_INTERVAL; n++) await retention.recordMutation();
    expect(storage.remove).not.toHaveBeenCalled();
  });
});

function id(n: number): string { return `bash-20260101000000-${n.toString(16).padStart(6, '0')}`; }

function fixture(count: number) {
  const storage = new FixtureStorage();
  const runtime = {
    cwd: '/fixture/workspace', storage: () => storage,
    shell: vi.fn(async () => ({ code: 0, stdout: '', stderr: '', killed: false })),
    exec: vi.fn(async (_command: string, args: readonly string[]) => {
      await storage.remove(join(args[2]!, args[3]!), { recursive: true });
      return { code: 0, stdout: '', stderr: '', killed: false };
    }),
  } as unknown as AgentRuntime;
  const store = new BackgroundBashJobStore(runtime, storage);
  for (let n = 0; n < count; n++) seed(storage, store.jobsDir, n);
  return { store, runtime, storage };
}

function seed(storage: FixtureStorage, jobsDir: string, n: number, status = 'completed', command = `command ${n}`, completedAt = Date.now() - 60 * 60 * 1_000) {
  const info = { id: id(n), command, cwd: '/fixture/workspace', status, startedAt: completedAt - 1, updatedAt: completedAt, completedAt };
  storage.files.set(`${jobsDir}/${id(n)}/info.json`, encoder.encode(JSON.stringify(info)));
  storage.files.set(`${jobsDir}/${id(n)}/completion.json`, encoder.encode(JSON.stringify(info)));
}

function patch(storage: FixtureStorage, jobsDir: string, n: number, value: object) {
  const path = `${jobsDir}/${id(n)}/info.json`;
  storage.files.set(path, encoder.encode(JSON.stringify({ ...JSON.parse(new TextDecoder().decode(storage.files.get(path))), ...value })));
}

function maintenance(runtime: AgentRuntime, storage: FixtureStorage, jobsDir: string) {
  return new BackgroundBashRetention(runtime, storage, jobsDir,
    async () => (await storage.listFiles(jobsDir, { recursive: false, includeDirectories: true })).sort().reverse(),
    async (_id, operation) => operation());
}

class FixtureStorage implements AgentRuntimeStorage {
  readonly root = `/fixture/state-${Math.random()}`;
  readonly files = new Map<string, Uint8Array>();
  readFile = vi.fn(async (path: string) => {
    const bytes = this.files.get(path);
    if (!bytes) throw new Error('missing');
    return bytes;
  });
  writeFile = vi.fn(async (path: string, bytes: Uint8Array) => { this.files.set(path, bytes); });
  appendFile = this.writeFile;
  mkdir = vi.fn(async () => {});
  listFiles = vi.fn(async (path: string, options?: AgentRuntimeListFilesOptions) => {
    expect(options).toMatchObject({ recursive: false, includeDirectories: true });
    return [...new Set([...this.files.keys()].filter(value => value.startsWith(`${path}/`)).map(value => value.slice(path.length + 1).split('/')[0]!))];
  });
  remove = vi.fn(async (path: string, _options?: { recursive?: boolean }) => {
    for (const key of this.files.keys()) if (key.startsWith(`${path}/`)) this.files.delete(key);
  });
}
