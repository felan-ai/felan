import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  HostAgentRuntime,
  type ExtensionContext,
  type FelanExtensionAPI,
  type ToolDefinition,
} from '@felan-ai/agent-core';
import { describe, expect, it } from 'vitest';
import {
  BackgroundBashCoordinator,
  createBackgroundBashExtension,
  type BackgroundBashDetails,
  type BackgroundBashInfo,
  type BackgroundBashJob,
} from '../src/index.js';

const TEST_TIMEOUT_MS = 45_000;
const OPERATION_TIMEOUT_MS = 5_000;
const RESPONSIVE_TIMEOUT_MS = 2_000;
const FOREGROUND_TIMEOUT_SECONDS = 20;
const UNICODE_INPUT = 'Здравей, 世界 🐈\n';
const decoder = new TextDecoder();

type ToolResult = {
  content: Array<{ type: string; text?: string }>;
  details?: unknown;
};
type ListedJob = Pick<BackgroundBashJob, 'meta' | 'status'>;
type WaitDetails = { job: BackgroundBashJob; timedOut: boolean };
type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
type LiveClient = {
  call(name: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult>;
  shutdown(): Promise<void>;
};
type LiveFixture = {
  runtime: HostAgentRuntime;
  owner: LiveClient;
  child: LiveClient;
  abortController(): AbortController;
};

describe('registered Background Bash tools with live host PTYs', () => {
  it.each([
    { mode: 'foreground', params: {}, background: false },
    { mode: 'detached', params: { background: true }, background: true },
    { mode: 'pty', params: { background: true, tty: true }, background: true },
  ])('returns large $mode output through the registered tools', async ({ params, background }) => {
    await withLiveTools(async ({ owner }) => {
      const result = await call(owner, 'bash', {
        command: nodeCommand("process.stdout.write('old line\\n'.repeat(40000) + 'last-one\\nlast-two 🌍\\n'); process.exitCode = 7;"),
        timeout: 10,
        ...params,
      });
      if (background) {
        const { id } = result.details as BackgroundBashDetails;
        expect((await waitForJob(owner, id)).job.status).toMatchObject({ status: 'failed', exitCode: 7 });
        const output = text(await call(owner, 'read_background_bash', { id, lines: 2 }));
        expect(output).toMatch(/\nlast-one\nlast-two 🌍$/u);
        expect(output).not.toContain('old line');
      } else {
        expect(result.details).toMatchObject({ background: false, status: 'failed' });
        expect(text(result)).toContain('last-one\nlast-two 🌍');
        expect(text(result)).not.toContain('exceeds the bounded');
      }
    });
  }, TEST_TIMEOUT_MS);

  it.each([
    { mode: 'background', params: { background: true }, exitCode: 7 },
    { mode: 'promoted', params: { timeout: 0 }, exitCode: 130 },
  ])('keeps a $mode PTY authoritative after five seconds and preserves exit $exitCode', async ({ params, exitCode }) => {
    await withLiveTools(async ({ owner, child }) => {
      const started = await startPty(owner, interactiveCommand(), params);
      await waitForOutput(child, started.id, 'ready');
      await delay(5_500);

      const listed = await call(child, 'list_background_bash', { status: 'all' });
      expect.soft(listedJob(listed, started.id).status.status).toBe('running');
      const running = await call(owner, 'list_background_bash', { status: 'running' });
      expect.soft(jobs(running).map((job) => job.meta.id)).toContain(started.id);
      await waitForOutput(child, started.id, 'late-output');

      await call(child, 'write_background_bash', { id: started.id, chars: UNICODE_INPUT });
      const output = await waitForOutput(owner, started.id, `received:${JSON.stringify(UNICODE_INPUT)}`);
      expect.soft(output).not.toContain('\uFFFD');
      expect.soft(output.split(`received:${JSON.stringify(UNICODE_INPUT)}`)).toHaveLength(2);

      await call(child, 'write_background_bash', {
        id: started.id,
        chars: exitCode === 7 ? 'exit7\n' : '\u0003',
      });
      const finished = await waitForJob(owner, started.id);
      expect.soft(finished.timedOut).toBe(false);
      expect.soft(finished.job.status).toMatchObject({ status: 'failed', exitCode });
      const finalList = await call(child, 'list_background_bash', {});
      expect.soft(listedJob(finalList, started.id).status).toMatchObject({ status: 'failed', exitCode });
      expect(text(await call(child, 'read_background_bash', { id: started.id })))
        .toContain(`received:${JSON.stringify(UNICODE_INPUT)}`);
    });
  }, TEST_TIMEOUT_MS);

  it.each([0, 7])('does not rewrite terminal timestamps after exit %i on repeated list/read/wait', async (exitCode) => {
    await withLiveTools(async ({ runtime, owner, child }) => {
      const started = await startPty(owner, nodeCommand(`process.stdout.write('finished\\n'); process.exitCode = ${exitCode};`));
      const finished = await waitForJob(owner, started.id);
      expect(finished.timedOut).toBe(false);
      const expected = {
        status: exitCode === 0 ? 'completed' : 'failed',
        exitCode,
        completedAt: finished.job.status.completedAt,
        updatedAt: finished.job.status.updatedAt,
      };
      expect(expected.completedAt).toEqual(expect.any(Number));
      expect(expected.updatedAt).toEqual(expect.any(Number));

      for (let attempt = 0; attempt < 3; attempt += 1) {
        await delay(25);
        const listed = await call(child, 'list_background_bash', {});
        expect.soft(listedJob(listed, started.id).status).toMatchObject(expected);

        await delay(25);
        await waitForOutput(owner, started.id, 'finished');
        const persisted = JSON.parse(decoder.decode(
          await runtime.storage('session').readFile(finished.job.meta.completionPath),
        )) as BackgroundBashInfo;
        expect.soft(persisted).toMatchObject(expected);

        await delay(25);
        const repeated = await waitForJob(child, started.id);
        expect.soft(repeated.timedOut).toBe(false);
        expect.soft(repeated.job.status).toMatchObject(expected);
        expect.soft(repeated.job.info).toMatchObject(expected);
      }
    });
  }, TEST_TIMEOUT_MS);

  it.each(['list', 'read', 'input', 'stop'] as const)(
    'keeps a shared-manager %s responsive during a silent foreground PTY read',
    async (operation) => {
      await withLiveTools(async ({ runtime, owner, child, abortController }) => {
        const controller = abortController();
        const foreground = observe(owner.call('bash', {
          command: silentCommand(), tty: true, timeout: FOREGROUND_TIMEOUT_SECONDS,
        }, controller.signal));
        const job = await waitForSilentJob(runtime);
        await delay(100);
        expect(foreground.settled()).toBe(false);

        const result = await within(child.call(
          operation === 'list' ? 'list_background_bash'
            : operation === 'read' ? 'read_background_bash'
              : operation === 'input' ? 'write_background_bash' : 'stop_background_bash',
          operation === 'list' ? {} : {
            id: job.id,
            ...(operation === 'input' ? { chars: UNICODE_INPUT } : {}),
          },
        ), RESPONSIVE_TIMEOUT_MS, `${operation} while a foreground PTY is waiting`);

        if (operation === 'stop') {
          expect((result.details as { job: BackgroundBashJob }).job.status)
            .toMatchObject({ status: 'killed', signal: 'SIGTERM' });
          const outcome = await within(foreground.result, OPERATION_TIMEOUT_MS, 'stopped foreground result');
          expect(outcome).toMatchObject({ result: { details: { background: false, id: job.id, status: 'killed' } } });
        } else {
          expect(foreground.settled()).toBe(false);
          if (operation === 'list') expect(listedJob(result, job.id).status.status).toBe('running');
          else expect(result.details).toMatchObject({ id: job.id, status: 'running' });
          if (operation === 'input') {
            await eventually(async () => decoder.decode(await runtime.readFile('received.txt')),
              (value) => value === UNICODE_INPUT, 'silent PTY receives exact Unicode input');
          }
        }
      });
    },
    TEST_TIMEOUT_MS,
  );

  it('cancels a foreground tool by terminating its PTY, not promoting it', async () => {
    await withLiveTools(async ({ runtime, owner, child, abortController }) => {
      const controller = abortController();
      const foreground = observe(owner.call('bash', {
        command: silentCommand(), tty: true, timeout: FOREGROUND_TIMEOUT_SECONDS,
      }, controller.signal));
      const job = await waitForSilentJob(runtime);
      await delay(100);
      expect(foreground.settled()).toBe(false);

      controller.abort();
      const outcome = await within(foreground.result, OPERATION_TIMEOUT_MS, 'foreground cancellation');
      expect(outcome).toMatchObject({ error: expect.objectContaining({ message: 'Command cancelled' }) });
      const finished = await waitForJob(child, job.id);
      expect(finished.job.status).toMatchObject({ status: 'killed', signal: 'SIGTERM' });
      expect(finished.job.meta.promotedAt).toBeUndefined();
      expect(job.pid).toEqual(expect.any(Number));
      await eventually(() => runtime.shell(`kill -0 ${job.pid} 2>/dev/null`, { shellFlavor: 'posix' }),
        (result) => result.code !== 0, 'cancelled PTY exits');
    });
  }, TEST_TIMEOUT_MS);

  it('cancels only a background wait and leaves the PTY available for input and a real exit', async () => {
    await withLiveTools(async ({ owner, child, abortController }) => {
      const started = await startPty(owner, interactiveCommand());
      await waitForOutput(owner, started.id, 'ready');
      const controller = abortController();
      const waiting = observe(child.call('wait_background_bash', {
        id: started.id, timeout: FOREGROUND_TIMEOUT_SECONDS,
      }, controller.signal));
      await delay(100);
      expect(waiting.settled()).toBe(false);

      controller.abort();
      const outcome = await within(waiting.result, RESPONSIVE_TIMEOUT_MS, 'background wait cancellation');
      expect(outcome).toMatchObject({ error: expect.objectContaining({ message: expect.stringMatching(/abort|cancel/iu) }) });
      expect(listedJob(await call(owner, 'list_background_bash', {}), started.id).status.status).toBe('running');
      await call(owner, 'write_background_bash', { id: started.id, chars: UNICODE_INPUT });
      await waitForOutput(child, started.id, `received:${JSON.stringify(UNICODE_INPUT)}`);
      await call(owner, 'write_background_bash', { id: started.id, chars: 'exit7\n' });
      expect((await waitForJob(child, started.id)).job.status).toMatchObject({ status: 'failed', exitCode: 7 });
    });
  }, TEST_TIMEOUT_MS);

  it('does not close the shared coordinator when a child extension shuts down', async () => {
    await withLiveTools(async ({ owner, child }) => {
      const ownerJob = await startPty(owner, interactiveCommand());
      const childJob = await startPty(child, interactiveCommand());
      await Promise.all([ownerJob, childJob].map((job) => waitForOutput(owner, job.id, 'ready')));

      await within(child.shutdown(), OPERATION_TIMEOUT_MS, 'child shutdown');

      for (const job of [ownerJob, childJob]) {
        expect(listedJob(await call(owner, 'list_background_bash', {}), job.id).status.status).toBe('running');
        await call(owner, 'write_background_bash', { id: job.id, chars: UNICODE_INPUT });
        await waitForOutput(owner, job.id, `received:${JSON.stringify(UNICODE_INPUT)}`);
        await call(owner, 'write_background_bash', { id: job.id, chars: 'exit7\n' });
        expect((await waitForJob(owner, job.id)).job.status).toMatchObject({ status: 'failed', exitCode: 7 });
      }
      const next = await startPty(owner, nodeCommand("process.stdout.write('after-child-shutdown\\n')"));
      expect((await waitForJob(owner, next.id)).job.status).toMatchObject({ status: 'completed', exitCode: 0 });
      await waitForOutput(owner, next.id, 'after-child-shutdown');
    });
  }, TEST_TIMEOUT_MS);
});

async function withLiveTools(run: (fixture: LiveFixture) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'felan live bash tools-'));
  const cwd = join(root, 'workspace');
  const sessionStorageRoot = join(root, 'session-storage');
  let coordinator: BackgroundBashCoordinator | undefined;
  const clients: LiveClient[] = [];
  const controllers = new Set<AbortController>();
  const pending = new Set<Promise<unknown>>();
  const errors: unknown[] = [];
  try {
    await Promise.all([cwd, sessionStorageRoot, join(root, 'owner-storage'), join(root, 'child-storage')]
      .map((path) => mkdir(path, { recursive: true })));
    const runtime = new HostAgentRuntime(cwd, {
      sessionStorageRoot, agentStorageRoot: join(root, 'owner-storage'),
    });
    coordinator = new BackgroundBashCoordinator(runtime);
    const owner = await createClient(runtime, coordinator, true, pending, controllers);
    clients.push(owner);
    const child = await createClient(new HostAgentRuntime(cwd, {
      sessionStorageRoot, agentStorageRoot: join(root, 'child-storage'),
    }), coordinator, false, pending, controllers);
    clients.push(child);
    await run({
      runtime, owner, child,
      abortController() {
        const controller = new AbortController();
        controllers.add(controller);
        return controller;
      },
    });
  } catch (error) {
    errors.push(error);
  } finally {
    for (const controller of controllers) controller.abort();
    const cleanup: Array<{ label: string; run(): Promise<unknown> }> = [
      {
        label: 'extension shutdown',
        async run() {
          const shutdowns = await Promise.allSettled(clients.map((client) => client.shutdown()));
          const failures = shutdowns.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
          if (failures.length > 0) throw new AggregateError(failures, 'Extension shutdown failed');
        },
      },
      { label: 'PTY cleanup', run: () => coordinator?.shutdown() ?? Promise.resolve() },
      { label: 'pending tool cleanup', run: () => Promise.allSettled([...pending]) },
      { label: 'temporary directory cleanup', run: () => rm(root, { recursive: true, force: true }) },
    ];
    for (const operation of cleanup) {
      try {
        await within(operation.run(), OPERATION_TIMEOUT_MS, operation.label);
      } catch (error) {
        errors.push(error);
      }
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, 'Live tool test and cleanup failed');
}

async function createClient(
  runtime: HostAgentRuntime,
  coordinator: BackgroundBashCoordinator,
  ownsCoordinator: boolean,
  pending: Set<Promise<unknown>>,
  controllers: Set<AbortController>,
): Promise<LiveClient> {
  const tools = new Map<string, ToolDefinition>();
  const handlers = new Map<string, Handler[]>();
  const ctx = { mode: 'print', cwd: runtime.cwd } as unknown as ExtensionContext;
  let activeTools: string[] = [];
  let callId = 0;
  let shutdown: Promise<void> | undefined;
  const pi = {
    runtime,
    registerTool(tool: ToolDefinition) { tools.set(tool.name, tool); },
    registerMessageRenderer() {},
    sendMessage() {},
    getActiveTools: () => activeTools,
    setActiveTools: (names: string[]) => { activeTools = names; },
    on(name: string, handler: Handler) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
  } as unknown as FelanExtensionAPI;
  const emit = async (name: string, event: unknown) => {
    for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
  };
  await createBackgroundBashExtension(coordinator, ownsCoordinator)(pi);
  await within(emit('session_start', {}), OPERATION_TIMEOUT_MS, 'live extension activation');
  expect([...tools.keys()]).toEqual([
    'bash', 'list_background_bash', 'read_background_bash', 'wait_background_bash',
    'stop_background_bash', 'write_background_bash',
  ]);
  return {
    call(name, params, signal) {
      const tool = tools.get(name);
      if (!tool) throw new Error(`Tool was not registered: ${name}`);
      const controller = new AbortController();
      controllers.add(controller);
      const callSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
      const result = Promise.resolve().then(() => tool.execute(`live-${++callId}`, params, callSignal, undefined, ctx));
      pending.add(result);
      const finish = () => {
        pending.delete(result);
        controllers.delete(controller);
      };
      void result.then(finish, finish);
      return result;
    },
    shutdown: () => shutdown ??= emit('session_shutdown', { reason: 'shutdown' }),
  };
}

function call(client: LiveClient, name: string, params: Record<string, unknown>): Promise<ToolResult> {
  return within(client.call(name, params), OPERATION_TIMEOUT_MS, name);
}

async function startPty(client: LiveClient, command: string, params: Record<string, unknown> = { background: true }): Promise<BackgroundBashDetails> {
  const result = await call(client, 'bash', { command, tty: true, ...params });
  expect(result.details).toMatchObject({ background: true, tty: true, id: expect.any(String) });
  return result.details as BackgroundBashDetails;
}

async function waitForJob(client: LiveClient, id: string): Promise<WaitDetails> {
  return (await call(client, 'wait_background_bash', { id, timeout: 3 })).details as WaitDetails;
}

function jobs(result: ToolResult): ListedJob[] {
  return (result.details as { jobs: ListedJob[] }).jobs;
}

function listedJob(result: ToolResult, id: string): ListedJob {
  const job = jobs(result).find((entry) => entry.meta.id === id);
  expect(job, `registered list contains ${id}`).toBeDefined();
  return job!;
}

function text(result: ToolResult): string {
  return result.content.filter((item) => item.type === 'text').map((item) => item.text ?? '').join('\n');
}

async function waitForOutput(client: LiveClient, id: string, expected: string): Promise<string> {
  return eventually(async () => text(await client.call('read_background_bash', { id })),
    (output) => output.includes(expected), `PTY output contains ${JSON.stringify(expected)}`);
}

async function waitForSilentJob(runtime: HostAgentRuntime): Promise<BackgroundBashInfo> {
  await eventually(() => runtime.readFile('silent-ready.txt'), (bytes) => bytes.length > 0, 'silent PTY starts');
  return eventually(async () => {
    const storage = runtime.storage('session');
    const paths = await storage.listFiles('', { recursive: true, pattern: '**/info.json' });
    return Promise.all(paths.map(async (path) => JSON.parse(decoder.decode(await storage.readFile(path))) as BackgroundBashInfo));
  }, (records) => records.some((job) => job.executionMode === 'pty' && job.pid !== undefined), 'PTY record is persisted')
    .then((records) => records.find((job) => job.executionMode === 'pty' && job.pid !== undefined)!);
}

function nodeCommand(script: string): string {
  const executable = process.platform === 'win32' ? process.execPath.replaceAll('\\', '/') : process.execPath;
  return `exec ${shellQuote(executable)} -e ${shellQuote(script)}`;
}

function interactiveCommand(): string {
  return nodeCommand(`
    setTimeout(() => process.exit(99), 25000);
    setTimeout(() => process.stdout.write('late-output\\n'), 5200);
    process.stdin.setEncoding('utf8');
    let pending = '';
    process.stdin.on('data', chunk => {
      pending += chunk;
      let newline;
      while ((newline = pending.indexOf('\\n')) !== -1) {
        const line = pending.slice(0, newline + 1);
        pending = pending.slice(newline + 1);
        if (line === 'exit7\\n') process.exit(7);
        process.stdout.write('received:' + JSON.stringify(line) + '\\n');
      }
    });
    process.stdout.write('ready\\n');
  `);
}

function silentCommand(): string {
  return `stty -echo; ${nodeCommand(`
    const fs = require('node:fs');
    setTimeout(() => process.exit(99), 25000);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => fs.appendFileSync('received.txt', chunk));
    fs.writeFileSync('silent-ready.txt', String(process.pid));
  `)}`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function observe<T>(promise: Promise<T>) {
  let settled = false;
  const result = promise.then(
    (value) => { settled = true; return { result: value }; },
    (error: unknown) => { settled = true; return { error }; },
  );
  return { result, settled: () => settled };
}

async function within<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} exceeded ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function eventually<T>(read: () => Promise<T>, ready: (value: T) => boolean, label: string): Promise<T> {
  const deadline = Date.now() + OPERATION_TIMEOUT_MS;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await within(read(), Math.max(1, deadline - Date.now()), label);
      if (ready(value)) return value;
    } catch (error) {
      lastError = error;
    }
    await delay(Math.min(25, Math.max(0, deadline - Date.now())));
  }
  throw new Error(`${label} exceeded ${OPERATION_TIMEOUT_MS}ms`, { cause: lastError });
}
