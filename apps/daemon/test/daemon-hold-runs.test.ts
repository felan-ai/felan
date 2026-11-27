import { afterEach, expect, it, vi } from 'vitest';
import { Type } from 'typebox';
import { RUN_HOLD_EVENT, type AssistantMessage, type Context, type ExtensionAPI, type RunHoldEvent } from '@felan-ai/agent-core';
import { SessionClient } from '../../felan/src/client/client.js';
import { TestHostConfiguration as DaemonConfiguration } from './fixtures/host-services.js';
import { createRegistryInteractionBroker } from '../src/daemon/broker.js';
import { HostLifecycle } from '../src/daemon/lifecycle.js';
import { SessionServer } from '../src/daemon/server.js';
import { holdDaemonRuns, settleDaemonWork } from '../src/daemon/service.js';
import { gate, serverFixture } from './fixtures/server.js';

/** Windows runners pause for seconds, so waits on state get a bound well above any expected delay. */
const WAIT = { timeout: 20_000 };
/** Longer than any single wait, so a wait that runs out reports its own assertion. */
const TEST_TIMEOUT_MS = 60_000;
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { vi.useRealTimers(); vi.restoreAllMocks(); for (const dispose of cleanup.splice(0).reverse()) await dispose(); });

/**
 * A daemon whose model answers each session's first request with a `wait` tool call on the gate named in its prompt, and its
 * second with text. The `wait` tool returns when the test opens that gate.
 */
async function fixture(options: { holdTimeoutMs?: number; extension?: (pi: ExtensionAPI) => void; refuse?: string } = {}) {
  const gates = new Map<string, ReturnType<typeof gate>>();
  const open = (name: string) => { let found = gates.get(name); if (!found) { found = gate(); gates.set(name, found); } return found; };
  const started: string[] = []; const requests: Array<{ prompt: string; turn: number }> = [];
  const respond = (context: Context): AssistantMessage['content'] => {
    const prompt = context.messages.filter(message => message.role === 'user').map(message => typeof message.content === 'string' ? message.content
      : message.content.map(part => part.type === 'text' ? part.text : '').join('')).join('\n');
    const turn = context.messages.filter(message => message.role === 'assistant').length;
    requests.push({ prompt, turn });
    const name = /gate:(\S+)/u.exec(prompt)?.[1];
    return turn === 0 && name ? [{ type: 'toolCall', id: `wait-${name}`, name: 'wait', arguments: { gate: name } }] : [{ type: 'text', text: `done ${turn}` }];
  };
  const f = await serverFixture({ now: Date.now, respond, extension: pi => {
    pi.registerTool({ name: 'wait', label: 'wait', description: 'Waits until the test opens a gate.', parameters: Type.Object({ gate: Type.String() }),
      async execute(_id, params: { gate: string }) {
        started.push(params.gate); await open(params.gate).promise;
        return { content: [{ type: 'text', text: `passed ${params.gate}` }], details: {} };
      } });
    options.extension?.(pi);
    if (options.refuse) {
      // Refuses holds for the session whose prompt names the gate, as an extension that keeps state in memory does.
      let context: { sessionManager: { getEntries(): unknown[] } } | undefined;
      pi.on('session_start', (_event, ctx) => { context = ctx; });
      pi.events.on(RUN_HOLD_EVENT, event => {
        if (JSON.stringify(context?.sessionManager.getEntries() ?? []).includes(`gate:${options.refuse}`)) (event as RunHoldEvent).refuse('test');
      });
    }
  } });
  const broker = createRegistryInteractionBroker(f.registry);
  const connector = { claiming: true, beginDrain: vi.fn(() => { connector.claiming = false; }), endDrain: vi.fn(() => { connector.claiming = true; }) };
  const complete = vi.fn(async () => {});
  let server!: SessionServer;
  const lifecycle = new HostLifecycle({ target: f.owner.target, identity: f.owner.identity,
    ...(options.holdTimeoutMs ? { holdTimeoutMs: options.holdTimeoutMs } : {}),
    beginDrain: () => { connector.beginDrain(); f.registry.beginDrain(); },
    endDrain: () => { f.registry.endDrain(); connector.endDrain(); },
    holdAdmission: () => { connector.beginDrain(); f.registry.holdAdmission(); },
    activity: () => server.activity(),
    holdRuns: signal => holdDaemonRuns(f.registry, server, signal),
    settle: (mode, signal) => settleDaemonWork(f.registry, broker, mode, signal), complete });
  server = new SessionServer({ registry: f.registry, models: f.root.runtime.session.modelRuntime, version: 'fixture', broker,
    configuration: new DaemonConfiguration({ definitions: [], assertCurrent: () => f.owner.assertCurrent() }),
    management: { lifecycle, logs: () => ({ entries: [] }) } });
  const clients: SessionClient[] = [];
  cleanup.push(async () => { for (const item of gates.values()) item.resolve(); for (const client of clients) client.close(); server.close(); await f.dispose(); });
  await server.start();
  const client = new SessionClient({ target: { kind: 'isolated', directory: f.directory, namespaceId: f.owner.target.namespaceId, storeRoots: [f.directory] },
    clientVersion: 'fixture', kind: 'tui', expected: f.owner.identity });
  clients.push(client); await client.connect();
  /** Starts a daemon run in a new session whose first step waits on `name`. */
  async function run(name: string) {
    const created = await client.request('sessions.create', { cwd: f.cwd, model: { provider: 'offline', id: 'fixture' } });
    if (created.outcome !== 'accepted') throw new Error(JSON.stringify(created));
    const session = created.result.sessionId;
    await client.attach(session);
    expect(await client.request('prompt', { text: `gate:${name}` }, { session })).toMatchObject({ outcome: 'accepted' });
    await vi.waitFor(() => expect(started).toContain(name), WAIT);
    return session;
  }
  const hold = (params: { stepTimeoutMs?: number } = {}) => server.requestManagement({ v: 1, id: requestIdNow(), op: 'host.restart', params: { expected: f.owner.identity, mode: 'hold', ...params } });
  const requestsFor = (name: string) => requests.filter(request => request.prompt.includes(`gate:${name}`));
  /** Creates a session that runs nothing until the test starts a run in it. */
  async function idle() {
    const created = await client.request('sessions.create', { cwd: f.cwd, model: { provider: 'offline', id: 'fixture' } });
    if (created.outcome !== 'accepted') throw new Error(JSON.stringify(created));
    return created.result.sessionId;
  }
  /** Spawns a child execution of `parent` whose first step waits on `name`. */
  async function child(parent: string, name: string) {
    const spawned = await f.registry.executionHost(parent).spawnSession({ prompt: `gate:${name}`, description: name, label: 'general',
      model: { provider: 'offline', id: 'fixture' }, notifyOnCompletion: true });
    if (!spawned.ok) throw new Error(spawned.error.message);
    return spawned.value.executionId;
  }
  return { ...f, client, lifecycle, server, connector, complete, run, idle, child, hold, open, requestsFor, started };
}

function requestIdNow(): string {
  const time = Date.now().toString(16).padStart(12, '0');
  const random = crypto.randomUUID();
  return `${time.slice(0, 8)}-${time.slice(8)}-7${random.slice(15, 18)}-8${random.slice(20, 23)}-${random.slice(-12)}`;
}

it('holds an active run after its tool results are saved and before its next model request, and records how to continue it', async () => {
  const f = await fixture();
  expect(await f.client.control('host.status')).toMatchObject({ stopModes: ['drain', 'force', 'hold'], holdsRuns: true });
  const session = await f.run('a');
  let answered = false;
  const response = f.hold().then(value => { answered = true; return value; });
  await vi.waitFor(() => expect(f.server.admissionClosed()).toBe(true), WAIT);
  expect(f.connector.claiming).toBe(false);
  // The step is still in its tool call, so the hold waits and records nothing yet.
  expect(answered).toBe(false); expect(f.store.heldRuns()).toEqual([]);
  f.open('a').resolve();
  expect(await response).toMatchObject({ outcome: 'accepted', result: { state: 'draining', held: { action: 'restart', runs: 1 } } });
  const manager = f.registry.binding(session)!.runtime.session.sessionManager;
  const last = manager.getEntries().at(-1)!;
  expect(last.type === 'message' && last.message.role).toBe('toolResult');
  const run = f.store.sessionMetadata(session).run;
  expect(run.state).toBe('running');
  expect(f.store.heldRuns()).toEqual([expect.objectContaining({ version: 1, session, root: session, run: expect.objectContaining({ id: run.id }), leaf: last.id, queue: [] })]);
  expect(f.requestsFor('a')).toHaveLength(1);
  expect(await f.client.request('host.status', {})).toMatchObject({ outcome: 'accepted', result: { state: 'draining', holdsRuns: true,
    held: { runs: 1 }, active: { runs: 1, work: 0 } } });
  expect(f.complete).not.toHaveBeenCalled();
});

it('continues held runs in the same daemon when no restart arrives before the hold expires', async () => {
  const f = await fixture({ holdTimeoutMs: 200 });
  const session = await f.run('a');
  const response = f.hold();
  f.open('a').resolve();
  expect(await response).toMatchObject({ outcome: 'accepted', result: { held: { runs: 1 } } });
  const run = f.store.sessionMetadata(session).run;
  await vi.waitFor(() => expect(f.lifecycle.state).toBe('ready'), WAIT);
  await vi.waitFor(() => expect(f.store.sessionMetadata(session).run).toMatchObject({ id: run.id, state: 'idle' }), WAIT);
  expect(f.requestsFor('a').map(request => request.turn)).toEqual([0, 1]);
  expect(f.store.heldRuns()).toEqual([]);
  expect(f.connector.claiming).toBe(true);
});

it('cancels the attempt after stepTimeoutMs: held runs continue, admission reopens and nothing is interrupted', async () => {
  const f = await fixture();
  const parked = await f.run('a'); const busy = await f.run('b');
  const response = f.hold({ stepTimeoutMs: 300 });
  f.open('a').resolve();
  const cancelled = await response;
  expect(cancelled).toMatchObject({ outcome: 'rejected', error: { code: 'hold_cancelled' } });
  expect(cancelled.outcome === 'rejected' && cancelled.error.message).toContain('300 ms');
  expect(f.lifecycle.state).toBe('ready'); expect(f.lifecycle.held).toBeUndefined();
  expect(f.server.admissionClosed()).toBe(false); expect(f.connector.claiming).toBe(true);
  expect(f.store.heldRuns()).toEqual([]);
  // The run that held continues at once; the one still in its tool call finishes its step normally.
  await vi.waitFor(() => expect(f.store.sessionMetadata(parked).run.state).toBe('idle'), WAIT);
  expect(f.store.sessionMetadata(busy).run.state).toBe('running');
  expect(await f.client.request('sessions.create', { cwd: f.cwd })).toMatchObject({ outcome: 'accepted' });
  f.open('b').resolve();
  await vi.waitFor(() => expect(f.store.sessionMetadata(busy).run.state).toBe('idle'), WAIT);
  for (const name of ['a', 'b']) expect(f.requestsFor(name).map(request => request.turn)).toEqual([0, 1]);
  expect(f.complete).not.toHaveBeenCalled();
});

it('waits three minutes for runs to hold when the request names no limit', async () => {
  const f = await fixture();
  vi.spyOn(f.server, 'activity').mockResolvedValue({ runs: 1, work: 1, workByKind: { sessions: 1, processes: 0, interactions: 0, providers: 0 } });
  vi.spyOn(f.registry, 'holdRuns').mockImplementation(signal => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })));
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  let settled = false;
  const response = f.hold().then(value => { settled = true; return value; });
  await vi.advanceTimersByTimeAsync(179_999);
  expect(settled).toBe(false); expect(f.server.admissionClosed()).toBe(true);
  await vi.advanceTimersByTimeAsync(1);
  expect(await response).toMatchObject({ outcome: 'rejected', error: { code: 'hold_cancelled' } });
  expect(f.lifecycle.state).toBe('ready');
});

it('accepts stepTimeoutMs only with mode hold', async () => {
  const f = await fixture();
  expect(await f.server.requestManagement({ v: 1, id: requestIdNow(), op: 'host.restart', params: { expected: f.owner.identity, mode: 'drain', stepTimeoutMs: 1_000 } }))
    .toMatchObject({ outcome: 'rejected', error: { code: 'invalid_request' } });
  expect(f.lifecycle.state).toBe('ready');
});

it('lets a run whose extension refuses the hold take its next step instead of holding it', async () => {
  const reasons: string[] = [];
  const f = await fixture({ extension: pi => { pi.events.on(RUN_HOLD_EVENT, event => { reasons.push('asked'); (event as RunHoldEvent).refuse('state is kept in memory'); }); } });
  const session = await f.run('a');
  const response = f.hold({ stepTimeoutMs: 60_000 });
  f.open('a').resolve();
  // The refused run finishes, so the daemon is idle and holds no runs.
  expect(await response).toMatchObject({ outcome: 'accepted', result: { held: { runs: 0 } } });
  expect(reasons).toContain('asked');
  expect(f.requestsFor('a').map(request => request.turn)).toEqual([0, 1]);
  expect(f.store.sessionMetadata(session).run.state).toBe('idle');
  expect(f.store.heldRuns()).toEqual([]);
});

it('stops a held daemon without interrupting its held runs and leaves them running for the next daemon', async () => {
  const f = await fixture();
  const session = await f.run('a');
  const response = f.hold();
  f.open('a').resolve();
  expect(await response).toMatchObject({ outcome: 'accepted' });
  const run = f.store.sessionMetadata(session).run;
  expect(await f.client.control('host.restart', 'drain')).toMatchObject({ outcome: 'accepted' });
  await vi.waitFor(() => expect(f.complete).toHaveBeenCalledExactlyOnceWith('restart'), WAIT);
  expect(f.store.sessionMetadata(session)).toMatchObject({ residency: 'evicted', run: { id: run.id, state: 'running' } });
  expect(f.store.heldRuns()).toEqual([expect.objectContaining({ session, run: expect.objectContaining({ id: run.id }) })]);
  expect(f.requestsFor('a')).toHaveLength(1);
});

it('forgets a held run that is cancelled while the daemon is held', async () => {
  const f = await fixture();
  const session = await f.run('a');
  const response = f.hold();
  f.open('a').resolve();
  expect(await response).toMatchObject({ outcome: 'accepted' });
  expect(await f.client.request('cancel', {}, { session })).toMatchObject({ outcome: 'accepted' });
  await vi.waitFor(() => expect(f.store.sessionMetadata(session).run.state).toBe('idle'), WAIT);
  expect(f.store.heldRuns()).toEqual([]);
  expect(f.requestsFor('a')).toHaveLength(1);
});

it('lets a drain that arrives while the hold still waits replace it; the runs finish under the drain', async () => {
  const f = await fixture();
  const parked = await f.run('a'); const busy = await f.run('b');
  const response = f.hold();
  f.open('a').resolve();
  await vi.waitFor(() => expect(f.registry.binding(parked)!.runtime.session.sessionManager.getEntries().at(-1)).toMatchObject({ message: { role: 'toolResult' } }), WAIT);
  expect(await f.client.control('host.restart', 'drain')).toMatchObject({ outcome: 'accepted', state: 'draining' });
  expect(await response).toMatchObject({ outcome: 'rejected', error: { code: 'busy' } });
  expect(f.store.heldRuns()).toEqual([]);
  // The drain waits for both runs: the parked one takes its next step, the other finishes its tool call first.
  await vi.waitFor(() => expect(f.store.sessionMetadata(parked).run.state).toBe('idle'), WAIT);
  f.open('b').resolve();
  await vi.waitFor(() => expect(f.complete).toHaveBeenCalledExactlyOnceWith('restart'), WAIT);
  for (const [id, name] of [[parked, 'a'], [busy, 'b']] as const) {
    expect(f.store.sessionMetadata(id).run.state).toBe('idle');
    expect(f.requestsFor(name).map(request => request.turn)).toEqual([0, 1]);
  }
});

it('delivers a subagent completion to its idle parent while a hold waits, so the stop after held finishes', async () => {
  const f = await fixture({ refuse: 'c' });
  const root = await f.idle();
  const delivered: string[] = [];
  f.registry.executionHost(root).attachParent({ deliverCompletion: async notice => { delivered.push(notice.executionId); return 'delivered'; } });
  const child = await f.child(root, 'c');
  await vi.waitFor(() => expect(f.started).toContain('c'), WAIT);
  const response = f.hold();
  // The child refuses the hold, so it takes its next step and finishes while the hold waits; its parent is idle.
  f.open('c').resolve();
  expect(await response).toMatchObject({ outcome: 'accepted', result: { held: { runs: 0 } } });
  await vi.waitFor(() => expect(delivered).toEqual([child]), WAIT);
  expect(await f.client.control('host.restart', 'drain')).toMatchObject({ outcome: 'accepted' });
  await vi.waitFor(() => expect(f.complete).toHaveBeenCalledExactlyOnceWith('restart'), WAIT);
  expect(f.store.sessionMetadata(child).execution).toMatchObject({ outcome: 'completed', completionPending: false });
}, TEST_TIMEOUT_MS);

it('holds a run that starts while the daemon is held and reaches its step end during the stop', async () => {
  const f = await fixture();
  const late = await f.idle();
  const session = await f.run('a');
  const response = f.hold();
  f.open('a').resolve();
  expect(await response).toMatchObject({ outcome: 'accepted', result: { held: { runs: 1 } } });
  // An extension starts a run in an idle session, as a background command's finish notice does.
  void f.registry.binding(late)!.runtime.session.sendCustomMessage({ customType: 'notice', content: 'gate:late', display: false }, { triggerTurn: true });
  await vi.waitFor(() => expect(f.started).toContain('late'), WAIT);
  expect(await f.client.control('host.restart', 'drain')).toMatchObject({ outcome: 'accepted' });
  f.open('late').resolve();
  await vi.waitFor(() => expect(f.complete).toHaveBeenCalledExactlyOnceWith('restart'), WAIT);
  expect(f.store.heldRuns().map(record => record.session).sort()).toEqual([session, late].sort());
  for (const id of [session, late]) expect(f.store.sessionMetadata(id).run.state).toBe('running');
  expect(f.requestsFor('late')).toHaveLength(1);
}, TEST_TIMEOUT_MS);

it('lets a run that parks after held continue when its record cannot be written', async () => {
  const f = await fixture({ holdTimeoutMs: 60_000 });
  const late = await f.idle();
  const session = await f.run('a');
  const response = f.hold();
  f.open('a').resolve();
  expect(await response).toMatchObject({ outcome: 'accepted', result: { held: { runs: 1 } } });
  vi.spyOn(f.store, 'putHeldRuns').mockImplementation(() => { throw new Error('disk full'); });
  void f.registry.binding(late)!.runtime.session.sendCustomMessage({ customType: 'notice', content: 'gate:late', display: false }, { triggerTurn: true });
  await vi.waitFor(() => expect(f.started).toContain('late'), WAIT);
  f.open('late').resolve();
  // Without a record the run cannot wait for the next daemon, so it takes its next step instead of staying parked.
  await vi.waitFor(() => expect(f.store.sessionMetadata(late).run.state).toBe('idle'), WAIT);
  expect(f.requestsFor('late').map(request => request.turn)).toEqual([0, 1]);
  expect(f.store.heldRuns().map(record => record.session)).toEqual([session]);
}, TEST_TIMEOUT_MS);

it('releases the parked runs when their records cannot be deleted as the hold ends', async () => {
  const f = await fixture({ holdTimeoutMs: 200 });
  const session = await f.run('a');
  const response = f.hold();
  f.open('a').resolve();
  expect(await response).toMatchObject({ outcome: 'accepted', result: { held: { runs: 1 } } });
  vi.spyOn(f.store, 'deleteHeldRuns').mockImplementationOnce(() => { throw new Error('disk full'); });
  // The failed delete keeps admission closed, but the run is no longer held and takes its next step.
  await vi.waitFor(() => expect(f.store.sessionMetadata(session).run.state).toBe('idle'), WAIT);
  expect(f.requestsFor('a').map(request => request.turn)).toEqual([0, 1]);
}, TEST_TIMEOUT_MS);
