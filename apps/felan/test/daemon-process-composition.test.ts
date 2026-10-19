import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import type { DaemonIdentity, Operation, OperationParams, OperationResult, ResponseFor, SessionSnapshot } from '@felan-ai/session-protocol';
import { acquireDaemonOwnership } from '../../daemon/src/daemon/ownership.js';
import { builtinExtensionPackages } from '../src/providers/extensions.js';
import { clientDaemonTarget } from '../src/client-application.js';
import { newRequestId, type AttachmentState } from '../src/client/client.js';

interface ClientView { pid: number; environment: string; status: string; identity: DaemonIdentity; attachment?: AttachmentState; sent: Array<{ op: string; id: string }> }
interface Ready { pid: number; environment: string; identity: DaemonIdentity }
interface Started { id: string; calls: number; pid: number }
interface Wire { id?: number; ok?: boolean; value?: unknown; error?: string; event?: string }
type Exit = { code: number | null; signal: NodeJS.Signals | null };

function deadline<T>(work: Promise<T>, label: string, milliseconds = 5000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`Deadline: ${label}`)), milliseconds); })])
    .finally(() => clearTimeout(timer));
}

class Worker {
  readonly child: ChildProcess;
  readonly exited: Promise<Exit>;
  exit: Exit | undefined;
  private sequence = 0;
  private stderr = '';
  private readonly pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  private readonly events: Wire[] = [];
  private readonly listeners = new Set<() => void>();

  constructor(file: string, argument: unknown, home: string, environment: string) {
    this.child = spawn(process.execPath, [fileURLToPath(new URL(`./fixtures/${file}`, import.meta.url)), JSON.stringify(argument)], {
      cwd: home, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: { PATH: process.env.PATH ?? '', HOME: home, TMPDIR: home, XDG_CACHE_HOME: join(home, 'cache'),
        PI_SKIP_VERSION_CHECK: '1', PI_TELEMETRY: '0', FELAN_PROCESS_ENV: environment },
    });
    const fail = (error: Error) => { for (const pending of this.pending.values()) pending.reject(error); this.pending.clear(); };
    this.child.stdout!.on('data', () => {});
    this.child.stderr!.on('data', (data: Buffer) => { this.stderr = (this.stderr + data.toString()).slice(-16 * 1024); });
    this.child.on('error', fail);
    this.child.on('message', value => {
      if (!value || typeof value !== 'object' || Buffer.byteLength(JSON.stringify(value)) > 2 * 1024 * 1024) {
        fail(new Error('Invalid or oversized worker reply')); return;
      }
      const message = value as Wire;
      if (message.event) {
        if (this.events.length >= 256) { fail(new Error('Worker event limit exceeded')); return; }
        this.events.push(message); for (const listener of this.listeners) listener();
      } else if (message.id !== undefined) {
        const pending = this.pending.get(message.id); this.pending.delete(message.id);
        if (message.ok) pending?.resolve(message.value); else pending?.reject(new Error(message.error ?? 'Worker request failed'));
      }
    });
    this.exited = new Promise(resolve => this.child.once('close', (code, signal) => {
      this.exit = { code, signal }; fail(new Error(`Worker exited: ${code ?? signal}\n${this.stderr}`));
      for (const listener of this.listeners) listener(); resolve(this.exit);
    }));
  }

  call<T = unknown>(op: string, params: Record<string, unknown> = {}): Promise<T> {
    if (this.exit) return Promise.reject(new Error(`Worker already exited: ${JSON.stringify(this.exit)}`));
    const id = ++this.sequence;
    const reply = new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: value => resolve(value as T), reject });
      this.child.send!({ ...params, id, op }, error => { if (error) { this.pending.delete(id); reject(error); } });
    });
    return deadline(reply, `worker ${op}`).finally(() => this.pending.delete(id));
  }

  event<T>(name: string, milliseconds = 5000): Promise<T> {
    let check!: () => void;
    const value = new Promise<T>((resolve, reject) => {
      check = () => {
        const index = this.events.findIndex(event => event.event === name);
        if (index >= 0) { resolve(this.events.splice(index, 1)[0]!.value as T); return; }
        if (this.exit) reject(new Error(`Worker exited before ${name}: ${this.stderr}`));
      };
      this.listeners.add(check); check();
    });
    return deadline(value, name, milliseconds).finally(() => this.listeners.delete(check));
  }

  async kill(): Promise<Exit> {
    if (!this.exit) this.child.kill('SIGKILL');
    return deadline(this.exited, 'worker SIGKILL join');
  }
  async stop(): Promise<void> {
    if (this.exit) return;
    try { await this.call('shutdown'); expect((await deadline(this.exited, 'worker shutdown join')).code).toBe(0); }
    catch (error) { await this.kill(); throw error; }
  }
}

class ProcessFixture {
  readonly workers: Worker[] = [];
  readonly target: ReturnType<typeof clientDaemonTarget>;
  constructor(readonly directory: string) { this.target = clientDaemonTarget({ daemonRuntime: directory }); }
  async start(file: string, role: string, argument: unknown): Promise<{ worker: Worker; ready: Ready }> {
    const home = join(this.directory, role); await mkdir(home, { recursive: true, mode: 0o700 });
    const worker = new Worker(file, argument, home, role); this.workers.push(worker);
    return { worker, ready: await worker.event<Ready>('ready', 10_000) };
  }
  daemon(role: string) { return this.start('daemon-service-process.mjs', role, { target: this.target, journal: join(this.directory, 'provider-calls.jsonl') }); }
  client(role: string) { return this.start('session-client-process.mjs', role, this.target); }
  async calls(): Promise<Array<{ pid: number; id: string }>> {
    return (await readFile(join(this.directory, 'provider-calls.jsonl'), 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
  }
  async dispose(): Promise<void> {
    const errors: unknown[] = [];
    for (const worker of [...this.workers].reverse()) { try { await worker.stop(); } catch (error) { errors.push(error); } }
    if (this.workers.every(worker => worker.exit)) {
      try { const owner = await acquireDaemonOwnership(this.target); await owner.release(); }
      catch (error) { errors.push(error); }
      await rm(this.directory, { recursive: true, force: true });
    } else errors.push(new Error(`Unjoined worker; preserving ${this.directory}`));
    if (errors.length) throw new AggregateError(errors, 'Process composition cleanup failed');
  }
}
const fixtures: ProcessFixture[] = [];
afterEach(async () => { const results = await Promise.allSettled(fixtures.splice(0).map(fixture => fixture.dispose()));
  const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
  if (errors.length) throw new AggregateError(errors, 'Process fixtures failed to clean up'); });

async function fixture(usage = true): Promise<ProcessFixture> {
  const f = new ProcessFixture(await realpath(await mkdtemp(join(usage ? tmpdir() : process.cwd(), '.pc-')))); fixtures.push(f);
  const owner = await acquireDaemonOwnership(f.target);
  try { await writeFile(join(owner.target.agentDir, 'settings.json'), JSON.stringify({ defaultProvider: 'offline', defaultModel: 'fixture',
    builtinExtensions: Object.fromEntries(Object.keys(builtinExtensionPackages).map(key => [key, false])) }), { mode: 0o600 }); }
  finally { await owner.release(); }
  if (!usage) {
    const config = JSON.parse(await readFile(new URL('../src/host.json', import.meta.url), 'utf8'));
    config.services = config.services.filter((service: { id: string }) => service.id !== 'felan.usage');
    const owner = await acquireDaemonOwnership(f.target);
    try { await writeFile(join(owner.target.agentDir, 'host.json'), JSON.stringify(config), { mode: 0o600 }); }
    finally { await owner.release(); }
  }
  await writeFile(join(f.directory, 'provider-calls.jsonl'), '', { mode: 0o600 });
  return f;
}
function request<O extends Operation>(worker: Worker, operation: O, params: OperationParams<O>, session?: string, requestId?: string): Promise<ResponseFor<O>> {
  return worker.call<ResponseFor<O>>('request', { operation, params, ...(session ? { session } : {}), ...(requestId ? { requestId } : {}) });
}
async function accepted<O extends Operation>(worker: Worker, operation: O, params: OperationParams<O>, session?: string): Promise<OperationResult<O>> {
  const response = await request(worker, operation, params, session); expect(response.outcome).toBe('accepted');
  if (response.outcome !== 'accepted') throw new Error(JSON.stringify(response));
  return response.result as OperationResult<O>;
}
async function attach(worker: Worker, session: string): Promise<ClientView> {
  const value = await worker.call<ClientView & { result: ResponseFor<'attach'> }>('attach', { session });
  expect(value.result.outcome).toBe('accepted'); expect(value.attachment?.state.status).toBe('live'); return value;
}
function wait(worker: Worker, wanted: Record<string, unknown>): Promise<ClientView> { return worker.call('wait-state', { wanted }); }
function snapshot(view: ClientView): SessionSnapshot { expect(view.attachment?.state.snapshot).toBeDefined(); return view.attachment!.state.snapshot!; }
function userTexts(value: SessionSnapshot): string[] {
  return value.history.entries.filter(message => message.role === 'user').map(message => message.content.filter(part => part.type === 'text').map(part => part.text).join(''));
}
async function environment(worker: Worker, session: string): Promise<string> {
  const result = await accepted(worker, 'shell.execute', { command: 'printf "%s" "$FELAN_PROCESS_ENV"', includeInContext: false }, session);
  await wait(worker, { runId: result.runId, runState: 'idle' });
  const output = await accepted(worker, 'processes.read', { root: session, resourceId: result.resourceId, offset: 0, limit: 4096 }, session);
  expect(output.state).toBe('exited'); return Buffer.from(output.data, 'base64').toString('utf8');
}

it('runs without felan.usage, owns its launch environment, and completes a shared stream after its sender is killed', async () => {
  const f = await fixture(false); const daemon = await f.daemon('daemon-first');
  const a = await f.client('client-a'); const b = await f.client('client-b');
  expect(new Set([process.pid, daemon.ready.pid, a.ready.pid, b.ready.pid]).size).toBe(4);
  expect(a.ready.environment).toBe('client-a'); expect(b.ready.environment).toBe('client-b');
  const av = await a.worker.call<ClientView>('connect', { identity: daemon.ready.identity });
  const bv = await b.worker.call<ClientView>('connect', { identity: daemon.ready.identity });
  expect(av.identity).toEqual(bv.identity);
  expect(await accepted(a.worker, 'host.status', {})).toMatchObject({ state: 'ready', setupNeeds: [] });
  const created = await accepted(a.worker, 'sessions.create', { cwd: f.directory, model: { provider: 'offline', id: 'fixture' } });
  const session = created.sessionId;
  const aa = await attach(a.worker, session); const ba = await attach(b.worker, session);
  expect(aa.attachment?.id).not.toBe(ba.attachment?.id);
  expect(snapshot(aa).model).toEqual({ provider: 'offline', id: 'fixture' }); expect(snapshot(ba).model).toEqual(snapshot(aa).model);
  expect(await environment(a.worker, session)).toBe('daemon-first');
  expect(await environment(b.worker, session)).toBe('daemon-first');
  const run = await accepted(a.worker, 'prompt', { text: 'survive client process death' }, session);
  const started = await daemon.worker.event<Started>('provider-started'); expect(started.calls).toBe(1);
  await Promise.all([wait(a.worker, { runId: run.runId, runState: 'running', streamText: `FIRST:${started.id}` }),
    wait(b.worker, { runId: run.runId, runState: 'running', streamText: `FIRST:${started.id}` })]);
  expect((await a.worker.kill()).signal).toBe('SIGKILL'); expect(daemon.worker.exit).toBeUndefined();
  await daemon.worker.call('advance', { turn: started.id });
  const progress = await wait(b.worker, { runId: run.runId, runState: 'running', streamText: `SECOND:${started.id}` });
  expect(snapshot(progress).session).toBe(session); expect(progress.identity).toEqual(daemon.ready.identity);
  await daemon.worker.call('finish', { turn: started.id });
  const completed = snapshot(await wait(b.worker, { runId: run.runId, runState: 'idle', historyText: `DONE:${started.id}` }));
  expect(userTexts(completed)).toEqual(['survive client process death']); expect(await f.calls()).toEqual([{ pid: daemon.ready.pid, id: started.id }]);
  expect(await environment(b.worker, session)).toBe('daemon-first');
  await accepted(b.worker, 'close', {}, session); await wait(b.worker, { sessionState: 'closed' });
  expect(await accepted(b.worker, 'host.status', {})).toMatchObject({ state: 'ready' });
  await daemon.worker.stop();
}, 20_000);

it('loses a committed acknowledgement, crashes and restarts the daemon, then returns the retained result without replay', async () => {
  const f = await fixture(); const original = await f.daemon('daemon-before-crash');
  const a = await f.client('client-a'); const b = await f.client('client-b');
  await a.worker.call('connect', { identity: original.ready.identity }); await b.worker.call('connect', { identity: original.ready.identity });
  const { sessionId: session } = await accepted(a.worker, 'sessions.create', { cwd: f.directory, model: { provider: 'offline', id: 'fixture' } });
  await attach(a.worker, session); await attach(b.worker, session);
  const id = newRequestId(); const text = 'one dispatch despite lost acknowledgement';
  await a.worker.call('drop-ack', { requestId: id });
  const [lost, committed, started] = await Promise.all([
    request(a.worker, 'prompt', { text }, session, id), a.worker.event<ResponseFor<'prompt'>>('ack-dropped'), original.worker.event<Started>('provider-started'),
  ]);
  expect(lost.outcome).toBe('indeterminate'); expect(committed.outcome).toBe('accepted');
  if (committed.outcome !== 'accepted') throw new Error('Fixture did not discard an accepted response');
  expect(committed.re).toBe(id);
  await wait(b.worker, { runId: committed.result.runId, runState: 'running', streamText: `FIRST:${started.id}` });
  expect(await f.calls()).toEqual([{ pid: original.ready.pid, id: started.id }]);
  expect((await original.worker.kill()).signal).toBe('SIGKILL');
  const replacement = await f.daemon('daemon-after-crash');
  expect(replacement.ready.identity.instanceId).not.toBe(original.ready.identity.instanceId);
  expect(replacement.ready.identity.namespaceId).toBe(original.ready.identity.namespaceId);
  await expect(a.worker.call('reconnect')).rejects.toThrow(/identity|instance|mismatch/i);
  const blocked = await a.worker.call<ClientView>('state');
  expect(blocked.status).toBe('blocked'); expect(blocked.sent.filter(request => request.op === 'prompt')).toHaveLength(1);
  await a.worker.call('connect', { identity: replacement.ready.identity, replace: true });
  await b.worker.call('connect', { identity: replacement.ready.identity, replace: true });
  const restoredA = await attach(a.worker, session); const restoredB = await attach(b.worker, session);
  expect(snapshot(restoredA).run).toMatchObject({ id: committed.result.runId, state: 'interrupted' });
  expect(snapshot(restoredB).run).toEqual(snapshot(restoredA).run);
  expect(snapshot(restoredA).model).toEqual({ provider: 'offline', id: 'fixture' });
  expect(snapshot(restoredB).model).toEqual(snapshot(restoredA).model);
  expect(userTexts(snapshot(restoredA))).toEqual([text]);
  expect(await replacement.worker.call('stats')).toMatchObject({ calls: 0, live: [] });
  expect(await request(a.worker, 'prompt', { text }, session, id)).toEqual(committed);
  expect(await request(b.worker, 'prompt', { text: 'changed payload' }, session, id)).toMatchObject({ outcome: 'rejected', error: { code: 'request_conflict' } });
  expect(await replacement.worker.call('stats')).toMatchObject({ calls: 0, live: [] });
  expect(await f.calls()).toHaveLength(1);
  const fresh = await accepted(a.worker, 'prompt', { text: 'explicit fresh work' }, session);
  expect(fresh.runId).not.toBe(committed.result.runId);
  const next = await replacement.worker.event<Started>('provider-started');
  await wait(b.worker, { runId: fresh.runId, runState: 'running', streamText: `FIRST:${next.id}` });
  await replacement.worker.call('advance', { turn: next.id }); await replacement.worker.call('finish', { turn: next.id });
  const completed = snapshot(await wait(b.worker, { runId: fresh.runId, runState: 'idle', historyText: `DONE:${next.id}` }));
  expect(userTexts(completed)).toEqual([text, 'explicit fresh work']);
  expect(await f.calls()).toEqual([{ pid: original.ready.pid, id: started.id }, { pid: replacement.ready.pid, id: next.id }]);
  expect(await environment(b.worker, session)).toBe('daemon-after-crash');
  expect((await b.worker.call<ClientView>('state')).environment).toBe('client-b');
  await accepted(b.worker, 'close', {}, session); await replacement.worker.stop();
}, 20_000);

it('resumes at the transcript tip after a restart that follows an explicit older branch selection', async () => {
  const f = await fixture(); const original = await f.daemon('daemon-before-branch-restart');
  const a = await f.client('client-a'); const b = await f.client('client-b');
  await a.worker.call('connect', { identity: original.ready.identity }); await b.worker.call('connect', { identity: original.ready.identity });
  const { sessionId: session } = await accepted(a.worker, 'sessions.create', { cwd: f.directory, model: { provider: 'offline', id: 'fixture' } });
  await attach(a.worker, session); await attach(b.worker, session);
  const completedTurns: Started[] = [];
  async function complete(text: string): Promise<SessionSnapshot> {
    const run = await accepted(a.worker, 'prompt', { text }, session);
    const started = await original.worker.event<Started>('provider-started'); completedTurns.push(started);
    await wait(b.worker, { runId: run.runId, runState: 'running', streamText: `FIRST:${started.id}` });
    await original.worker.call('advance', { turn: started.id }); await original.worker.call('finish', { turn: started.id });
    return snapshot(await wait(b.worker, { runId: run.runId, runState: 'idle', historyText: `DONE:${started.id}` }));
  }
  const first = await complete('keep the first branch');
  const firstAssistant = first.history.entries.find(entry => entry.role === 'assistant');
  expect(firstAssistant).toBeDefined();
  const second = await complete('retain but do not select the later branch');
  expect(userTexts(second)).toEqual(['keep the first branch', 'retain but do not select the later branch']);
  const tree = await accepted(a.worker, 'session.tree', {}, session);
  expect(tree.cursor).toBeUndefined();
  expect(tree.entries).toContainEqual(expect.objectContaining({ id: firstAssistant!.entryId, role: 'assistant' }));
  expect(tree.branch).not.toBe(firstAssistant!.entryId);
  const laterBranch = tree.branch;
  const entryIds = tree.entries.map(entry => entry.id).sort();
  expect(entryIds).toContain(laterBranch);
  await accepted(a.worker, 'session.branch.select', { entryId: firstAssistant!.entryId, summarize: false, expectedRevision: tree.revision }, session);
  const [selectedA, selectedB] = await Promise.all([
    wait(a.worker, { branch: firstAssistant!.entryId, runState: 'idle', historyText: 'keep the first branch' }),
    wait(b.worker, { branch: firstAssistant!.entryId, runState: 'idle', historyText: 'keep the first branch' }),
  ]);
  expect(userTexts(snapshot(selectedA))).toEqual(['keep the first branch']);
  expect(userTexts(snapshot(selectedB))).toEqual(['keep the first branch']);
  const selectedTree = await accepted(b.worker, 'session.tree', {}, session);
  expect(selectedTree.cursor).toBeUndefined(); expect(selectedTree.branch).toBe(firstAssistant!.entryId);
  expect(selectedTree.entries.map(entry => entry.id).sort()).toEqual(entryIds);
  expect(await original.worker.call('stats')).toMatchObject({ calls: 2, live: [] });
  const calls = completedTurns.map(turn => ({ pid: original.ready.pid, id: turn.id }));
  expect(await f.calls()).toEqual(calls);
  await original.worker.call('shutdown', { mode: 'drain' });
  expect((await deadline(original.worker.exited, 'graceful branch restart join')).code).toBe(0);
  const replacement = await f.daemon('daemon-after-branch-restart');
  expect(replacement.ready.identity.instanceId).not.toBe(original.ready.identity.instanceId);
  expect(replacement.ready.identity.namespaceId).toBe(original.ready.identity.namespaceId);
  await a.worker.call('connect', { identity: replacement.ready.identity, replace: true });
  await b.worker.call('connect', { identity: replacement.ready.identity, replace: true });
  const restoredA = await attach(a.worker, session); const restoredB = await attach(b.worker, session);
  for (const restored of [restoredA, restoredB]) {
    expect(restored.identity).toEqual(replacement.ready.identity);
    expect(snapshot(restored).branch).toBe(laterBranch);
    expect(userTexts(snapshot(restored))).toEqual(['keep the first branch', 'retain but do not select the later branch']);
  }
  const restoredTree = await accepted(b.worker, 'session.tree', {}, session);
  expect(restoredTree.cursor).toBeUndefined(); expect(restoredTree.branch).toBe(laterBranch);
  expect(restoredTree.entries.map(entry => entry.id).sort()).toEqual(entryIds);
  expect(restoredTree.entries).toContainEqual(expect.objectContaining({ id: laterBranch }));
  expect(await replacement.worker.call('stats')).toMatchObject({ calls: 0, live: [] });
  expect(await f.calls()).toEqual(calls);
  await replacement.worker.stop();
}, 20_000);

it('keeps a real foreground process alive after its client is killed and lets another client observe and stop it', async () => {
  const f = await fixture(); const daemon = await f.daemon('daemon-process-owner');
  const a = await f.client('client-a'); const b = await f.client('client-b');
  await a.worker.call('connect', { identity: daemon.ready.identity }); await b.worker.call('connect', { identity: daemon.ready.identity });
  const { sessionId: session } = await accepted(a.worker, 'sessions.create', { cwd: f.directory, model: { provider: 'offline', id: 'fixture' } });
  await attach(a.worker, session); await attach(b.worker, session);
  const gate = join(f.directory, 'foreground-gate'); await writeFile(gate, 'hold', { mode: 0o600 });
  const script = `
    const { watch, readFileSync } = require('node:fs');
    const { dirname, basename } = require('node:path');
    const gate = process.argv[1];
    const pid = String(process.pid).padStart(10, '0');
    let advanced = false;
    const watcher = watch(dirname(gate), (_event, filename) => {
      if (String(filename) !== basename(gate) || advanced || readFileSync(gate, 'utf8') !== 'advance') return;
      advanced = true;
      process.stdout.write('AFTER:' + pid + '\\n');
    });
    process.on('SIGTERM', () => {
      watcher.close();
      if (!advanced) process.exit(2);
      process.stdout.write('STOPPED:' + pid + '\\n', () => process.exit(0));
    });
    process.stdout.write('READY:' + pid + '\\n');
  `;
  const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
  const command = `exec ${quote(process.execPath)} -e ${quote(script)} ${quote(gate)}`;
  const run = await accepted(a.worker, 'shell.execute', { command, includeInContext: false }, session);
  const readyBytes = Buffer.byteLength('READY:0000000000\n');
  const readOutput = () => accepted(b.worker, 'processes.read', { root: session, resourceId: run.resourceId, offset: 0, limit: 4096 }, session);
  await wait(b.worker, { runId: run.runId, runState: 'running', process: { id: run.resourceId, state: 'running', minimumOutput: readyBytes } });
  const ready = await readOutput(); expect(ready.state).toBe('running');
  const readyText = Buffer.from(ready.data, 'base64').toString('utf8');
  const match = /^READY:(\d{10})\n$/u.exec(readyText); expect(match).not.toBeNull();
  const pid = Number(match![1]); expect(pid).toBeGreaterThan(0);
  expect([process.pid, daemon.ready.pid, a.ready.pid, b.ready.pid]).not.toContain(pid);
  const before = await accepted(b.worker, 'processes.list', { root: session }, session);
  expect(before.cursor).toBeUndefined(); expect(before.entries).toHaveLength(1);
  expect(before.entries[0]).toMatchObject({ id: run.resourceId, session, root: session, kind: 'foreground', command, state: 'running', controllable: true });
  expect((await a.worker.kill()).signal).toBe('SIGKILL'); expect(daemon.worker.exit).toBeUndefined();
  expect(await readOutput()).toMatchObject({ resourceId: run.resourceId, state: 'running', data: ready.data });
  const nextGate = join(f.directory, 'foreground-gate-next'); await writeFile(nextGate, 'advance', { mode: 0o600 });
  await rename(nextGate, gate);
  const afterText = `${readyText}AFTER:${match![1]}\n`;
  const progress = await wait(b.worker, { runId: run.runId, runState: 'running', process: { id: run.resourceId, state: 'running', minimumOutput: Buffer.byteLength(afterText) } });
  expect(progress.identity).toEqual(daemon.ready.identity);
  const after = await readOutput(); expect(after.state).toBe('running');
  expect(Buffer.from(after.data, 'base64').toString('utf8')).toBe(afterText);
  const retained = await accepted(b.worker, 'processes.list', { root: session }, session);
  expect(retained.entries).toHaveLength(1);
  expect(retained.entries[0]).toMatchObject({ id: run.resourceId, startedAt: before.entries[0]!.startedAt, state: 'running', controllable: true });
  await accepted(b.worker, 'processes.stop', { root: session, resourceId: run.resourceId, signal: 'SIGTERM' }, session);
  const finalText = `${afterText}STOPPED:${match![1]}\n`;
  await wait(b.worker, { runId: run.runId, runState: 'idle', historyText: `STOPPED:${match![1]}`, process: { id: run.resourceId, state: 'exited', minimumOutput: Buffer.byteLength(finalText) } });
  const completed = await readOutput(); expect(completed).toMatchObject({ resourceId: run.resourceId, state: 'exited', exitCode: 0, nextOffset: Buffer.byteLength(finalText) });
  expect(Buffer.from(completed.data, 'base64').toString('utf8')).toBe(finalText);
  const stopped = await accepted(b.worker, 'processes.list', { root: session }, session);
  expect(stopped.entries).toHaveLength(1);
  expect(stopped.entries[0]).toMatchObject({ id: run.resourceId, startedAt: before.entries[0]!.startedAt, state: 'exited', exitCode: 0, controllable: false });
  expect((await b.worker.call<ClientView>('state')).sent.filter(item => item.op === 'shell.execute')).toHaveLength(0);
  expect(await daemon.worker.call('stats')).toMatchObject({ calls: 0, live: [], identity: daemon.ready.identity });
  expect(await f.calls()).toEqual([]);
  await accepted(b.worker, 'close', {}, session); await wait(b.worker, { sessionState: 'closed' });
  await daemon.worker.stop();
}, 20_000);
