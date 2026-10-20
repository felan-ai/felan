import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { afterEach, expect, it, vi } from 'vitest';
import type { AgentRuntime, AgentRuntimeStdioProcess } from '@felan-ai/agent-core';
import { AuthCleanupError, startAuthWorker } from '../src/providers/setup/auth-driver.js';
import { serverFixture, gate } from '../../daemon/test/fixtures/server.js';
import type { AuthWorkerOutput } from '../src/providers/setup/auth-wire.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  try { for (const close of cleanup.splice(0).reverse()) await close(); }
  finally { vi.restoreAllMocks(); }
});

function fakeWorker() {
  const worker = {
    pid: 123,
    readStdout: vi.fn<AgentRuntimeStdioProcess['readStdout']>(async () => { throw new Error('Synthetic read failure.'); }),
    readStderr: vi.fn<AgentRuntimeStdioProcess['readStderr']>(async () => ({ output: new Uint8Array(), nextOffset: 0, running: false, exitCode: 0 })),
    read: vi.fn<AgentRuntimeStdioProcess['read']>(async () => ({ output: new Uint8Array(), nextOffset: 0, running: false, exitCode: 0 })),
    write: vi.fn<AgentRuntimeStdioProcess['write']>(async () => {}),
    closeInput: vi.fn<AgentRuntimeStdioProcess['closeInput']>(async () => {}),
    terminate: vi.fn<AgentRuntimeStdioProcess['terminate']>(async () => {}),
    dispose: vi.fn<AgentRuntimeStdioProcess['dispose']>(async () => {}),
  } satisfies AgentRuntimeStdioProcess;
  const control = new AbortController();
  const runtime = { cwd: '/fixture', processes: { startStdio: vi.fn(async () => worker) } } as unknown as AgentRuntime;
  return { worker, control, start: () => startAuthWorker(runtime, {
    kind: 'start', provider: 'fixture', method: 'api_key', agentDir: '/fixture',
  }, { signal: control.signal, event() {} }) };
}

async function fixture(provider: string) {
  const f = await serverFixture({ now: Date.now }); const control = new AbortController(); const ready = gate();
  const events: AuthWorkerOutput[] = []; let driver: Awaited<ReturnType<typeof startAuthWorker>> | undefined;
  cleanup.push(async () => { control.abort(); await driver?.done.catch(() => {}); await f.dispose(); });
  driver = await startAuthWorker(f.root.agentRuntime, { kind: 'start', provider, method: 'api_key', agentDir: f.owner.target.agentDir }, {
    signal: control.signal, entrypoint: fileURLToPath(new URL('./fixtures/setup-auth-worker.mjs', import.meta.url)),
    event: value => { events.push(value); if (value.kind === 'prompt') ready.resolve(); },
  });
  await ready.promise;
  return { driver, events, control };
}

it('exchanges a secret over owned stdio without reflecting it into output', async () => {
  const f = await fixture('fixture');
  await f.driver.answer('fixture-key', 'synthetic-private-value'); await f.driver.done;
  expect(f.events.map(event => event.kind)).toEqual(['prompt', 'done']);
  expect(JSON.stringify(f.events)).not.toContain('synthetic-private-value');
});

it('joins cancellation of an owned worker even when it ignores graceful signals', async () => {
  const f = await fixture('hold'); f.control.abort();
  await expect(f.driver.done).rejects.toThrow();
});

it('retains the abort listener until worker disposal settles and then joins late forced termination', async () => {
  const f = fakeWorker(); const disposing = gate(); const disposed = gate(); const terminated = gate();
  const original = new Error('Protocol read failed.');
  f.worker.readStdout.mockRejectedValue(original);
  f.worker.dispose.mockImplementation(async () => { disposing.resolve(); await disposed.promise; });
  f.worker.terminate.mockImplementation(async () => { await terminated.promise; });
  const remove = vi.spyOn(f.control.signal, 'removeEventListener');
  let driver: Awaited<ReturnType<typeof startAuthWorker>> | undefined;
  cleanup.push(async () => { f.control.abort(); disposed.resolve(); terminated.resolve(); await driver?.done.catch(() => {}); });
  driver = await f.start();
  let settled = false;
  const result = driver.done.catch(error => error).finally(() => { settled = true; });
  await disposing.promise;
  expect(remove).not.toHaveBeenCalled();
  f.control.abort();
  expect(f.worker.terminate).toHaveBeenCalledExactlyOnceWith('SIGKILL');
  disposed.resolve();
  await disposed.promise; await Promise.resolve();
  expect(settled).toBe(false);
  terminated.resolve();
  expect(await result).toBe(original);
  expect(f.worker.dispose).toHaveBeenCalledOnce();
  expect(remove).toHaveBeenCalledExactlyOnceWith('abort', expect.any(Function));
});

it.each([false, true])('attempts disposal after a failed forced termination (disposal also fails: %s)', async disposalFails => {
  const f = fakeWorker(); const reading = gate(); const releaseRead = gate();
  const terminationError = new Error('Forced termination failed.');
  const disposalError = new Error('Disposal failed.');
  f.worker.readStdout.mockImplementation(async () => { reading.resolve(); await releaseRead.promise; throw new Error('Read interrupted.'); });
  f.worker.terminate.mockRejectedValue(terminationError);
  if (disposalFails) f.worker.dispose.mockRejectedValue(disposalError);
  let driver: Awaited<ReturnType<typeof startAuthWorker>> | undefined;
  cleanup.push(async () => { f.control.abort(); releaseRead.resolve(); await driver?.done.catch(() => {}); });
  driver = await f.start();
  const outcome = driver.done.catch(error => error);
  await reading.promise;
  f.control.abort(); releaseRead.resolve();
  const failure: unknown = await outcome;
  expect(f.worker.terminate).toHaveBeenCalledExactlyOnceWith('SIGKILL');
  expect(f.worker.dispose).toHaveBeenCalledOnce();
  expect(failure).toBeInstanceOf(AuthCleanupError);
  if (!(failure instanceof AuthCleanupError)) throw new Error('Expected cleanup failure.');
  expect(failure.code).toBe('auth_cleanup_failed');
  if (disposalFails) {
    expect(failure.cause).toBeInstanceOf(AggregateError);
    expect((failure.cause as AggregateError).errors).toEqual([disposalError, terminationError]);
  } else expect(failure.cause).toBe(terminationError);
});

it('kills a blocked authentication process after its daemon parent disappears', async () => {
  const f = await serverFixture({ now: Date.now }); let pid: number | undefined;
  const parent = await f.root.agentRuntime.processes!.startStdio!(process.execPath,
    [fileURLToPath(new URL('./fixtures/setup-guard-parent.mjs', import.meta.url))]);
  cleanup.push(async () => {
    if (pid) {
      const command = await readFile(`/proc/${pid}/cmdline`, 'utf8').catch(() => '');
      if (command.includes('/setup-guard-child.mjs')) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    }
    await parent.dispose(); await f.dispose();
  });
  let output = ''; let offset = 0; let exitCode: number | undefined;
  for (;;) {
    const next = await parent.readStdout(offset, { waitMs: 100, maxBytes: 1024 }); offset = next.nextOffset;
    output += Buffer.from(next.output).toString('utf8');
    if (!next.running && !next.output.length) { exitCode = next.exitCode; break; }
  }
  pid = Number(output.trim());
  expect(exitCode).toBe(0);
  expect(Number.isSafeInteger(pid) && pid > 1).toBe(true);
  await vi.waitFor(() => expect(() => process.kill(pid!, 0)).toThrow());
});
