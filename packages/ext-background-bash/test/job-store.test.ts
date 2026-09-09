import type { AgentRuntime, AgentRuntimeStorage } from '@felan-ai/agent-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BackgroundBashJobStore, getBackgroundBashJobsDir } from '../src/job-store.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

afterEach(() => vi.restoreAllMocks());

describe('BackgroundBashJobStore metadata compatibility', () => {
  it('defaults legacy records to detached execution', async () => {
    const storage = new MemoryStorage();
    const cwd = '/workspace/project';
    const jobsDir = getBackgroundBashJobsDir(storage.root, cwd);
    const jobDir = `${jobsDir}/bash-20260101000000-abcdef`;
    storage.files.set(`${jobDir}/meta.json`, encoder.encode(JSON.stringify({
      id: 'bash-20260101000000-abcdef',
      command: 'printf legacy',
      cwd,
      startedAt: 1,
      creatorPid: 2,
    })));

    const job = await new BackgroundBashJobStore(runtime(cwd), storage)
      .readJob('bash-20260101000000-abcdef');

    expect(job?.meta.executionMode).toBe('detached');
    expect(job?.info.executionMode).toBe('detached');
  });

  it('normalizes and preserves promoted output metadata', async () => {
    const storage = new MemoryStorage();
    const cwd = '/workspace/project';
    const jobsDir = getBackgroundBashJobsDir(storage.root, cwd);
    const id = 'bash-20260101000000-abcdef';
    const jobDir = `${jobsDir}/${id}`;
    storage.files.set(`${jobDir}/info.json`, encoder.encode(JSON.stringify({
      id,
      command: 'printf pty',
      cwd,
      startedAt: 1,
      updatedAt: 2,
      status: 'running',
      executionMode: 'pty',
      promotedAt: 3,
      outputTruncated: true,
    })));

    const job = await new BackgroundBashJobStore(runtime(cwd), storage).readJob(id);

    expect(job?.meta).toMatchObject({ executionMode: 'pty', promotedAt: 3, outputTruncated: true });
    expect(job?.status).toMatchObject({ executionMode: 'pty', promotedAt: 3, outputTruncated: true });
  });

  it('does not rewrite a terminal outcome or its timestamps on repeated observations', async () => {
    const storage = new MemoryStorage();
    const store = new BackgroundBashJobStore(runtime('/workspace/project'), storage);
    const job = await store.createJob('exit 7');
    const now = vi.spyOn(Date, 'now').mockReturnValue(job.meta.startedAt + 100);
    const completed = await store.markStatus(job.meta.id, { status: 'failed', exitCode: 7 });
    const completionBytes = await storage.readFile(job.meta.completionPath);
    const infoBytes = await storage.readFile(job.meta.infoPath);

    now.mockReturnValue(job.meta.startedAt + 10_000);
    await expect(store.markStatus(job.meta.id, { status: 'failed', exitCode: 7 })).resolves.toEqual(completed);
    await expect(store.markStatus(job.meta.id, { status: 'failed', exitCode: 9 })).resolves.toEqual(completed);
    await expect(store.markStatus(job.meta.id, { status: 'killed', signal: 'SIGTERM' })).resolves.toEqual(completed);
    expect(await storage.readFile(job.meta.completionPath)).toEqual(completionBytes);
    expect(await storage.readFile(job.meta.infoPath)).toEqual(infoBytes);
  });

  it.each(['completed', 'failed', 'killed', 'unknown'] as const)(
    'preserves the first %s outcome across concurrent store instances',
    async (status) => {
      const storage = new MemoryStorage();
      const store = new BackgroundBashJobStore(runtime('/workspace/project'), storage);
      const otherStore = new BackgroundBashJobStore(
        runtime('/workspace/project'),
        new MemoryStorage(storage.files),
      );
      const job = await store.createJob('exit 7', 'pty');
      vi.spyOn(Date, 'now')
        .mockReturnValueOnce(job.meta.startedAt + 100)
        .mockReturnValue(job.meta.startedAt + 200);

      const [first, second] = await Promise.all([
        store.markStatus(job.meta.id, { status }),
        otherStore.markStatus(job.meta.id, { status: 'failed', exitCode: 9 }),
      ]);

      expect(first?.status).toMatchObject({
        status,
        updatedAt: job.meta.startedAt + 100,
        completedAt: job.meta.startedAt + 100,
      });
      expect(second).toEqual(first);
      expect(await store.readJob(job.meta.id)).toEqual(first);
      expect(JSON.parse(decoder.decode(await storage.readFile(job.meta.completionPath))))
        .toEqual(first?.status);
    },
  );

  it.each(['completed', 'failed', 'killed', 'unknown'] as const)(
    'enriches %s PID metadata without changing terminal timestamps',
    async (status) => {
      const storage = new MemoryStorage();
      const store = new BackgroundBashJobStore(runtime('/workspace/project'), storage);
      const job = await store.createJob('exit 0', 'pty');
      const now = vi.spyOn(Date, 'now').mockReturnValue(job.meta.startedAt + 100);
      const completed = await store.markStatus(job.meta.id, { status });
      const completionBytes = await storage.readFile(job.meta.completionPath);

      now.mockReturnValue(job.meta.startedAt + 10_000);
      const updated = await store.updatePid(job.meta.id, 1234, 1234, {
        executionMode: 'pty',
        promotedAt: job.meta.startedAt + 50,
      });

      expect(updated?.info).toMatchObject({
        pid: 1234,
        processGroupId: 1234,
        executionMode: 'pty',
        promotedAt: job.meta.startedAt + 50,
        status,
        updatedAt: completed?.status.updatedAt,
        completedAt: completed?.status.completedAt,
      });
      expect(JSON.parse(decoder.decode(await storage.readFile(job.meta.infoPath))))
        .toEqual(updated?.info);
      expect(await storage.readFile(job.meta.completionPath)).toEqual(completionBytes);
      expect(await store.readJob(job.meta.id)).toEqual(updated);
    },
  );
});

describe('BackgroundBashJobStore operation ordering', () => {
  it('preserves PID and promotion metadata when completion is queued behind them', async () => {
    const storage = new MemoryStorage();
    const store = new BackgroundBashJobStore(runtime('/workspace/project'), storage);
    const otherStore = new BackgroundBashJobStore(runtime('/workspace/project'), new MemoryStorage(storage.files));
    const job = await store.createJob('exit 0');
    const promotedAt = job.meta.startedAt + 50;

    const [, , completed] = await Promise.all([
      store.markRunning(job.meta.id, 'detached', promotedAt),
      otherStore.updatePid(job.meta.id, 1234, 1234),
      store.markStatus(job.meta.id, { status: 'completed', exitCode: 0 }),
    ]);

    expect(completed?.info).toMatchObject({
      status: 'completed', exitCode: 0, pid: 1234, processGroupId: 1234, promotedAt,
    });
    expect(await otherStore.readJob(job.meta.id)).toEqual(completed);
  });

  it('does not revive completion when PID enrichment and promotion are queued behind it', async () => {
    const storage = new MemoryStorage();
    const store = new BackgroundBashJobStore(runtime('/workspace/project'), storage);
    const otherStore = new BackgroundBashJobStore(runtime('/workspace/project'), new MemoryStorage(storage.files));
    const job = await store.createJob('exit 0', 'pty');
    const now = vi.spyOn(Date, 'now').mockReturnValue(job.meta.startedAt + 100);

    const [completed, enriched, promoted] = await Promise.all([
      store.markStatus(job.meta.id, { status: 'completed', exitCode: 0 }),
      otherStore.updatePid(job.meta.id, 1234),
      store.markRunning(job.meta.id, 'pty', job.meta.startedAt + 50),
    ]);

    expect(enriched?.status).toEqual({ ...completed?.status, pid: 1234 });
    expect(promoted).toEqual(enriched);
    expect(promoted?.meta.promotedAt).toBeUndefined();
    expect(now).toHaveBeenCalledTimes(1);
    expect(JSON.parse(decoder.decode(await storage.readFile(job.meta.infoPath)))).toEqual(enriched?.info);
  });

  it('queues reads and listings behind a write without blocking other jobs', async () => {
    const storage = new MemoryStorage();
    const otherStorage = new MemoryStorage(storage.files);
    const store = new BackgroundBashJobStore(runtime('/workspace/project'), storage);
    const otherStore = new BackgroundBashJobStore(runtime('/workspace/project'), otherStorage);
    const job = await store.createJob('sleep 1');
    const otherJob = await store.createJob('exit 0');
    const entered = deferred();
    const release = deferred();
    const writeFile = storage.writeFile.bind(storage);
    vi.spyOn(storage, 'writeFile').mockImplementation(async (path, content) => {
      if (path === job.meta.infoPath) {
        entered.resolve();
        await release.promise;
      }
      await writeFile(path, content);
    });
    const write = store.updatePid(job.meta.id, 1234);
    await entered.promise;
    const readFile = vi.spyOn(otherStorage, 'readFile');
    const read = otherStore.readJob(job.meta.id);
    const list = otherStore.listJobs();

    try {
      await expect(otherStore.updatePid(otherJob.meta.id, 5678)).resolves.toMatchObject({ meta: { pid: 5678 } });
      expect(readFile).not.toHaveBeenCalledWith(job.meta.infoPath);
    } finally {
      release.resolve();
      await Promise.all([write, read, list]);
    }

    expect(await read).toMatchObject({ meta: { pid: 1234 } });
    expect(await list).toEqual(expect.arrayContaining([
      expect.objectContaining({ meta: expect.objectContaining({ id: job.meta.id, pid: 1234 }) }),
    ]));
  });

  it('continues queued writes after a rejected write', async () => {
    const storage = new MemoryStorage();
    const store = new BackgroundBashJobStore(runtime('/workspace/project'), storage);
    const otherStore = new BackgroundBashJobStore(runtime('/workspace/project'), new MemoryStorage(storage.files));
    const job = await store.createJob('exit 0');
    vi.spyOn(storage, 'writeFile').mockRejectedValueOnce(new Error('storage write failed'));

    const [rejected, fulfilled] = await Promise.allSettled([
      store.markStatus(job.meta.id, { status: 'failed', exitCode: 1 }),
      otherStore.markStatus(job.meta.id, { status: 'completed', exitCode: 0 }),
    ]);

    expect(rejected).toMatchObject({ status: 'rejected', reason: new Error('storage write failed') });
    expect(fulfilled).toMatchObject({ status: 'fulfilled', value: { status: { status: 'completed', exitCode: 0 } } });
    expect(await store.readJob(job.meta.id)).toMatchObject({ status: { status: 'completed', exitCode: 0 } });
  });

  it('discovers detached completion and preserves its timestamps during PID enrichment', async () => {
    const storage = new MemoryStorage();
    const store = new BackgroundBashJobStore(runtime('/workspace/project'), storage);
    const job = await store.createJob('exit 0');
    const completion = {
      id: job.meta.id,
      status: 'completed',
      startedAt: job.meta.startedAt,
      updatedAt: job.meta.startedAt + 100,
      completedAt: job.meta.startedAt + 100,
      exitCode: 0,
      pid: 1234,
    };
    const completionBytes = encoder.encode(JSON.stringify(completion));
    storage.files.set(job.meta.completionPath, completionBytes);
    vi.spyOn(Date, 'now').mockReturnValue(job.meta.startedAt + 10_000);

    const observed = await store.readJob(job.meta.id);
    const enriched = await store.updatePid(job.meta.id, 1234, 1234);

    expect(observed?.status).toEqual({ ...completion, executionMode: 'detached' });
    expect(enriched?.status).toEqual(observed?.status);
    expect(enriched?.meta.processGroupId).toBe(1234);
    expect(JSON.parse(decoder.decode(await storage.readFile(job.meta.infoPath)))).toEqual(enriched?.info);
    expect(await storage.readFile(job.meta.completionPath)).toEqual(completionBytes);
  });

  it('recovers completion when its info write failed', async () => {
    const storage = new MemoryStorage();
    const store = new BackgroundBashJobStore(runtime('/workspace/project'), storage);
    const otherStore = new BackgroundBashJobStore(runtime('/workspace/project'), new MemoryStorage(storage.files));
    const job = await store.createJob('exit 0');
    const writeFile = storage.writeFile.bind(storage);
    vi.spyOn(storage, 'writeFile').mockImplementation(async (path, content) => {
      if (path === job.meta.infoPath) throw new Error('info write failed');
      await writeFile(path, content);
    });

    await expect(store.markStatus(job.meta.id, { status: 'completed', exitCode: 0 }))
      .rejects.toThrow('info write failed');
    const recovered = await otherStore.readJob(job.meta.id);

    expect(recovered?.status).toMatchObject({ status: 'completed', exitCode: 0 });
    expect(JSON.parse(decoder.decode(await storage.readFile(job.meta.infoPath)))).toEqual(recovered?.info);
  });
});

class MemoryStorage implements AgentRuntimeStorage {
  readonly root = '/state';

  constructor(readonly files = new Map<string, Uint8Array>()) {}

  async readFile(path: string): Promise<Uint8Array> {
    const value = this.files.get(path);
    if (!value) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    return value;
  }

  async writeFile(path: string, content: Uint8Array): Promise<void> {
    this.files.set(path, content);
  }

  async listFiles(path: string): Promise<string[]> {
    return [...this.files.keys()]
      .filter((file) => file.startsWith(`${path}/`))
      .map((file) => file.slice(path.length + 1));
  }
  async mkdir(): Promise<void> {}
  async remove(): Promise<void> {}
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function runtime(cwd: string): AgentRuntime {
  return { cwd } as AgentRuntime;
}
