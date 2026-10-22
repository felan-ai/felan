import type { ProcessAdapter } from '../src/daemon/process-adapter.js';
import { fakeProcessAdapter } from './fixtures/process-provider.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { configField, defineExtensionConfig, type AgentRuntimeProcess, type ExtensionAPI } from '@felan-ai/agent-core';
import { appendFile, chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, truncate, utimes, writeFile } from 'node:fs/promises';
import { renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { JsonLineDecoder, LIMITS, encodeFrame, parseServerEnvelope, type Operation, type OperationParams, type SessionSnapshot } from '@felan-ai/session-protocol';
import { SessionClient, newRequestId } from '../../felan/src/client/client.js';
import { TestHostConfiguration as DaemonConfiguration } from './fixtures/host-services.js';
import { accepted, SessionCommands } from '../src/daemon/commands.js';
import type { AdmittedCommand } from '../src/daemon/admission.js';
import { connectLocalIpc } from '../src/daemon/ipc.js';
import { SessionServer, type BrokerDispatchPort, type SessionServerOptions } from '../src/daemon/server.js';
import { protocolTarget } from '../src/daemon/target.js';
import { gate, serverFixture } from './fixtures/server.js';
import { LegacySessionIndex, legacySessionDirectoryName } from '../src/daemon/legacy-sessions.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const configDefinition = defineExtensionConfig({ id: 'codex', title: 'Synthetic config', fields: { fast: configField.boolean({ default: false, description: 'Synthetic value' }) } });

async function fixture(options: { processAdapter?: ProcessAdapter; onStream?: () => Promise<void>; release?: () => void; broker?: BrokerDispatchPort; now?: () => number; extension?: (pi: ExtensionAPI) => void;
  prepareRoot?: SessionServerOptions['prepareRoot'];
  compaction?: { reserveTokens: number; keepRecentTokens: number }; skill?: boolean;
  composition?: { managerPackage: string; managerVersion: string; providerDigest: string; configDigest: string };
  currentComposition?: () => Promise<{ managerPackage: string; managerVersion: string; providerDigest: string; configDigest: string }> } = {}) {
  const f = await serverFixture({ ...(options.processAdapter ? { processAdapter: options.processAdapter } : {}), now: options.now ?? Date.now, ...(options.onStream ? { onStream: options.onStream } : {}), ...(options.extension ? { extension: options.extension } : {}),
    ...(options.compaction ? { compaction: options.compaction } : {}), ...(options.skill ? { skill: true } : {}) });
  const clients: SessionClient[] = []; const sockets: Awaited<ReturnType<typeof connectLocalIpc>>[] = [];
  const configuration = new DaemonConfiguration({ definitions: [configDefinition], assertCurrent: () => f.registry.assertAdmission() });
  const server = new SessionServer({ registry: f.registry, configuration, models: f.root.runtime.session.modelRuntime, version: 'fixture',
    ...(options.composition ? { composition: options.composition } : {}), ...(options.currentComposition ? { currentComposition: options.currentComposition } : {}),
    ...(options.prepareRoot ? { prepareRoot: options.prepareRoot } : {}),
    ...(options.broker ? { broker: options.broker } : {}), ...(options.now ? { now: options.now } : {}) });
  cleanups.push(async () => { options.release?.(); for (const client of clients) client.close(); for (const socket of sockets) socket.destroy(); server.close(); await f.dispose(); });
  await server.start();
  async function client(kind: 'tui' | 'acp' | 'headless' = 'tui', interactionKinds: OperationParams<'hello'>['interactionKinds'] = []) {
    const client = new SessionClient({ target: { kind: 'isolated', directory: f.directory, namespaceId: f.owner.target.namespaceId, storeRoots: [f.directory] },
      expected: f.owner.identity, clientVersion: 'fixture', kind, interactionKinds, requestTimeoutMs: 1000, retries: 1, reconnectAttempts: 2, reconnectDelayMs: 0 });
    clients.push(client); await client.connect(); return client;
  }
  async function raw() {
    const socket = await connectLocalIpc(f.owner.target); sockets.push(socket);
    const pending = new Map<string, (response: Record<string, unknown>) => void>(); const decoder = new JsonLineDecoder();
    socket.on('data', (bytes: Buffer) => { for (const frame of decoder.push(bytes)) {
      const row = frame as Record<string, unknown>; const resolve = pending.get(String(row.re));
      if (resolve) { pending.delete(String(row.re)); resolve(row); }
    } });
    return { socket, exchange(frame: { id: string; [key: string]: unknown }): Promise<Record<string, unknown>> {
      return new Promise(resolve => { pending.set(frame.id, resolve); socket.write(encodeFrame(frame)); });
    } };
  }
  return { ...f, server, client, raw };
}

it.each([
  { kind: 'tui', offered: ['select'], supported: ['select'], recipient: true },
  { kind: 'tui', offered: [], supported: ['select'], recipient: false },
  { kind: 'tui', offered: ['select'], supported: [], recipient: false },
  { kind: 'acp', offered: ['select'], supported: ['select'], recipient: false },
  { kind: 'headless', offered: ['select'], supported: ['select'], recipient: false },
] as const)('gives root preparation a recipient only for a prompt-capable TUI: %j', async ({ kind, offered, supported, recipient }) => {
  const prepareRoot = vi.fn<NonNullable<SessionServerOptions['prepareRoot']>>(async request => ({ cwd: request.cwd, extensionPaths: [] }));
  const f = await fixture({ prepareRoot, broker: { interactionKinds: [...supported], dispatch: () => { throw new Error('Unexpected interaction'); } } });
  const client = await f.client(kind, [...offered]);
  expect(await client.request('sessions.create', { cwd: f.cwd })).toMatchObject({ outcome: 'accepted' });
  expect(prepareRoot).toHaveBeenCalledExactlyOnceWith({ cwd: f.cwd }, {
    ...(recipient ? { recipient: expect.any(String) } : {}), signal: expect.any(AbortSignal),
  });
});

it('prepares imports with host paths once and checks the prepared cwd before staging', async () => {
  const prepareRoot = vi.fn<NonNullable<SessionServerOptions['prepareRoot']>>(async request => {
    const path = join(request.cwd, 'host-extension.ts'); await writeFile(path, 'export default () => {};');
    return { cwd: request.cwd, extensionPaths: [path] };
  });
  const f = await fixture({ prepareRoot }); const client = await f.client(); const id = newRequestId();
  const params = { path: f.store.session(f.root.sessionId).piPath, cwd: f.cwd };
  const response = await client.request('session.import', params, { id });
  expect(response.outcome).toBe('accepted'); if (response.outcome !== 'accepted') throw new Error('Import failed');
  expect(f.store.session(response.result.sessionId).profile?.extensionPaths).toEqual([join(f.cwd, 'host-extension.ts')]);
  expect(prepareRoot.mock.calls[0]?.[0]).toEqual({ cwd: f.cwd });
  expect(await client.request('session.import', params, { id })).toEqual(response);
  expect(prepareRoot).toHaveBeenCalledOnce();
  prepareRoot.mockResolvedValueOnce({ cwd: f.directory, extensionPaths: [] });
  expect(await client.request('session.import', params)).toMatchObject({ outcome: 'rejected', error: { code: 'target_mismatch' } });
  expect(f.registry.list()).toHaveLength(2);
});

it('deduplicates concurrent local preparation and rejects conflicting creation payloads', async () => {
  const held = gate(); const prepareRoot = vi.fn<NonNullable<SessionServerOptions['prepareRoot']>>(async request => {
    await held.promise; return { cwd: request.cwd, extensionPaths: [] };
  });
  const f = await fixture({ prepareRoot, release: held.resolve }); const first = await f.client(); const second = await f.client(); const third = await f.client(); const id = newRequestId();
  const pending = first.request('sessions.create', { cwd: f.cwd }, { id });
  await vi.waitFor(() => expect(prepareRoot).toHaveBeenCalledOnce());
  const duplicate = second.request('sessions.create', { cwd: f.cwd }, { id });
  expect(await third.request('sessions.create', { cwd: f.directory }, { id })).toMatchObject({ outcome: 'rejected', error: { code: 'request_conflict' } });
  held.resolve(); const response = await pending;
  expect(response.outcome).toBe('accepted'); expect(await duplicate).toEqual(response);
  expect(prepareRoot).toHaveBeenCalledOnce();
});

it('reports provider changes as restart-required while allowing reloadable policy/config changes', async () => {
  const active = { managerPackage: '@felan-ai/felan', managerVersion: '1.0.0', providerDigest: 'a'.repeat(64), configDigest: 'b'.repeat(64) };
  let current = { ...active, configDigest: 'c'.repeat(64) };
  const f = await fixture({ composition: active, currentComposition: async () => current });
  const client = await f.client();
  const reloadable = await client.request('host.status', {});
  expect(reloadable).toMatchObject({ outcome: 'accepted', result: { composition: { configDigest: 'c'.repeat(64) } } });
  if (reloadable.outcome !== 'accepted') return;
  expect(reloadable.result.composition).not.toHaveProperty('restartRequired');
  current = { ...current, providerDigest: 'd'.repeat(64), configDigest: 'e'.repeat(64) };
  expect(await client.request('host.status', {})).toMatchObject({ outcome: 'accepted', result: { composition: {
    providerDigest: active.providerDigest, configDigest: 'e'.repeat(64), restartRequired: true,
  } } });
});

function syntheticShell(f: Awaited<ReturnType<typeof fixture>>) {
  const stopped = gate(); let running = true; const data = new Uint8Array([65, 0, 255, 10]); const input: Uint8Array[] = [];
  const process: AgentRuntimeProcess = { pid: undefined,
    read: async (offset, options) => {
      if (options?.waitMs && offset >= data.byteLength && running) await stopped.promise;
      const output = data.slice(offset, offset + (options?.maxBytes ?? data.byteLength));
      return { output, nextOffset: offset + output.byteLength, running, ...(running ? {} : { exitCode: 0 }) };
    },
    write: async bytes => { input.push(new Uint8Array(bytes)); }, terminate: async () => { running = false; stopped.resolve(); }, dispose: async () => {},
  };
  const start = vi.fn(async () => process);
  f.registry.processes.wrap({ ...f.root.agentRuntime, processes: { startShell: start } }, { session: f.root.sessionId, root: f.root.sessionId });
  return { start, input, finish: () => { running = false; stopped.resolve(); } };
}

async function completedPrompt(f: Awaited<ReturnType<typeof fixture>>, client: SessionClient, text: string) {
  const session = f.root.sessionId; const before = f.root.runtime.session.sessionManager.getEntries().length;
  expect(await client.request('prompt', { text }, { session })).toMatchObject({ outcome: 'accepted' });
  await vi.waitFor(() => {
    expect(f.root.runtime.session.sessionManager.getEntries().length).toBeGreaterThan(before);
    expect(f.store.session(session).run.state).toBe('idle');
    expect(client.getAttachment(session)?.state.snapshot?.revision).toBe(f.store.session(session).revision);
  });
}

async function compactingFixture(options: { extension?: (pi: ExtensionAPI) => void; onStream?: () => Promise<void>; release?: () => void; compactionError?: Error } = {}) {
  const entered = gate(); const release = gate();
  const f = await fixture({ compaction: { reserveTokens: 256, keepRecentTokens: 16 }, onStream: options.onStream,
    release: () => { release.resolve(); options.release?.(); },
    extension: pi => { options.extension?.(pi); pi.on('session_before_compact', async () => { entered.resolve(); await release.promise; }); } });
  const client = await f.client(); const session = f.root.sessionId; await client.attach(session);
  await completedPrompt(f, client, 'earlier context '.repeat(80)); await completedPrompt(f, client, 'retained context '.repeat(80));
  if (options.compactionError) {
    const compact = f.root.runtime.session.compact.bind(f.root.runtime.session);
    vi.spyOn(f.root.runtime.session, 'compact').mockImplementation(async instructions => { await compact(instructions); throw options.compactionError; });
  }
  const result = await client.request('compact', {}, { session });
  expect(result).toMatchObject({ outcome: 'accepted' });
  if (result.outcome !== 'accepted') throw new Error('Compaction did not start');
  await entered.promise;
  return { ...f, createClient: f.client, client, session, release: release.resolve, runId: result.result.runId };
}

it('serves attach, session reads and a prompt turn without copying the whole control state', async () => {
  const f = await fixture(); const client = await f.client(); const session = f.root.sessionId;
  const snapshot = vi.spyOn(f.store, 'snapshot');
  await client.attach(session);
  const tree = await client.request('session.tree', {}, { session });
  if (tree.outcome !== 'accepted') throw new Error('Tree unavailable');
  expect(await client.request('session.history', { revision: tree.result.revision, branch: tree.result.branch }, { session })).toMatchObject({ outcome: 'accepted' });
  expect(await client.request('processes.list', { root: session }, { session })).toMatchObject({ outcome: 'accepted' });
  await completedPrompt(f, client, 'served without full state copies');
  expect(snapshot).not.toHaveBeenCalled();
});

it.each([
  ['history revision', (snapshot: SessionSnapshot) => ({ ...snapshot, history: { ...snapshot.history, revision: snapshot.revision + 1 } })],
  ['history branch', (snapshot: SessionSnapshot) => ({ ...snapshot, history: { ...snapshot.history, branch: 'invalid-branch' } })],
  ['stream offset', (snapshot: SessionSnapshot) => ({ ...snapshot, activeStreams: [{ id: 'stream', message: 'message', kind: 'assistant' as const, text: '😀', offset: 2 }] })],
  ['stream Unicode', (snapshot: SessionSnapshot) => ({ ...snapshot, activeStreams: [{ id: 'stream', message: 'message', kind: 'assistant' as const, text: '\ud83d', offset: 1 }] })],
  ['stream identity', (snapshot: SessionSnapshot) => ({ ...snapshot, activeStreams: [{ id: 'stream', message: 'message', kind: 'assistant' as const, text: 'x', offset: 1 }],
    completionOnlyStreams: [{ id: 'stream', message: 'message', kind: 'assistant' as const, reason: 'limit' as const }] })],
] as const)('rejects an invalid attach snapshot (%s) without closing the connection', async (_name, corrupt) => {
  const f = await fixture(); const client = await f.client(); const session = f.root.sessionId;
  const projection = f.registry.projection(session);
  const snapshot = projection.snapshot(); const spy = vi.spyOn(projection, 'snapshot').mockReturnValue(corrupt(snapshot));
  try {
    expect(await client.attach(session)).toMatchObject({ outcome: 'rejected', error: { code: 'unavailable', message: expect.stringContaining('Invalid attach snapshot:') } });
    expect(f.registry.attachmentCount(session)).toBe(0);
    expect(client.status).toBe('ready');
    expect(await client.request('host.status', {})).toMatchObject({ outcome: 'accepted', result: { active: { attachments: 0 } } });
    spy.mockRestore();
    expect(await client.attach(session)).toMatchObject({ outcome: 'accepted' });
    expect(f.registry.attachmentCount(session)).toBe(1);
    expect(client.status).toBe('ready');
  } finally { spy.mockRestore(); }
});

it('reads history and trees without snapshots and rejects stale revisions, branches and cursors', async () => {
  const f = await fixture(); const client = await f.client(); const session = f.root.sessionId;
  await client.attach(session);
  const projection = f.registry.projection(session); const manager = f.root.runtime.session.sessionManager;
  manager.resetLeaf();
  const snapshot = vi.spyOn(projection, 'snapshot').mockImplementation(() => { throw new Error('Unexpected full snapshot'); });
  try {
    const empty = await client.request('session.tree', {}, { session });
    expect(empty).toMatchObject({ outcome: 'accepted', result: { branch: session } });
    if (empty.outcome !== 'accepted') throw new Error('Empty tree unavailable');
    expect(await client.request('session.history', { revision: empty.result.revision, branch: session }, { session }))
      .toMatchObject({ outcome: 'accepted', result: { branch: session, entries: [] } });
    manager.appendMessage({ role: 'user', content: 'First', timestamp: 0 });
    const branch = manager.appendMessage({ role: 'user', content: 'Second', timestamp: 1 });
    const tree = await client.request('session.tree', { limit: 1 }, { session });
    if (tree.outcome !== 'accepted') throw new Error('Tree unavailable');
    expect(tree.result.branch).toBe(branch);
    expect(tree.result.revision).toBe(f.store.sessionMetadata(session).revision);
    expect(tree.result.entries).toHaveLength(1); expect(tree.result.cursor).toBeDefined();
    const history = await client.request('session.history', { revision: tree.result.revision, branch, limit: 1 }, { session });
    if (history.outcome !== 'accepted') throw new Error('History unavailable');
    expect(history.result.entries[0]?.content).toEqual([{ type: 'text', text: 'Second' }]);
    expect(history.result.cursor).toBeDefined();
    const older = await client.request('session.history', { revision: tree.result.revision, branch, limit: 1, cursor: history.result.cursor }, { session });
    expect(older).toMatchObject({ outcome: 'accepted', result: { entries: [{ content: [{ type: 'text', text: 'First' }] }] } });
    expect(snapshot).not.toHaveBeenCalled();
    snapshot.mockRestore();
    for (const params of [{ revision: tree.result.revision - 1, branch }, { revision: tree.result.revision, branch: session }]) {
      expect(await client.request('session.history', params, { session })).toMatchObject({ outcome: 'rejected', error: { code: 'resync_required' } });
    }
    manager.appendMessage({ role: 'user', content: 'Third', timestamp: 2 });
    expect(await client.request('session.history', { revision: tree.result.revision, branch }, { session }))
      .toMatchObject({ outcome: 'rejected', error: { code: 'resync_required' } });
    expect(await client.request('session.tree', { cursor: tree.result.cursor }, { session }))
      .toMatchObject({ outcome: 'rejected', error: { code: 'resync_required' } });
  } finally { snapshot.mockRestore(); }
});

it('negotiates the same operations for equally capable local TUI and ACP clients', async () => {
  const f = await fixture(); const tui = await f.client('tui'); const acp = await f.client('acp');
  expect(acp.capabilities?.operations).toEqual(tui.capabilities?.operations);
  expect(acp.capabilities?.operations).toEqual(expect.arrayContaining(['set_model', 'session.rename', 'processes.list', 'executions.read']));
  expect(acp.capabilities?.operations).not.toContain('ui.action');
});

function supportedRequests(f: Awaited<ReturnType<typeof fixture>>): Array<{ op: Operation; session?: string; params: Record<string, unknown> }> {
  const session = f.root.sessionId; const revision = f.store.session(session).revision;
  const resource = { root: session, resourceId: 'not-created' };
  return [
    { op: 'host.status', params: {} }, { op: 'sessions.list', params: {} },
    { op: 'sessions.create', params: { cwd: f.cwd } },
    { op: 'attach', session, params: { expected: f.owner.identity } },
    { op: 'detach', session, params: { attachmentId: 'not-attached' } }, { op: 'close', session, params: {} },
    { op: 'prompt', session, params: { text: 'must not execute' } }, { op: 'steer', session, params: { text: 'must not queue' } },
    { op: 'follow_up', session, params: { text: 'must not queue' } }, { op: 'queue.clear', session, params: {} }, { op: 'cancel', session, params: {} },
    { op: 'set_model', session, params: { provider: 'offline', id: 'fixture' } }, { op: 'set_thinking', session, params: { thinking: 'off' } },
    { op: 'compact', session, params: {} }, { op: 'fork', session, params: { from: { kind: 'position', position: 0 } } },
    { op: 'command.invoke', session, params: { name: 'not-registered', arguments: '' } }, { op: 'session.rename', session, params: { name: 'must not rename' } },
    { op: 'session.tree', session, params: {} }, { op: 'session.branch.select', session, params: { entryId: 'not-created' } },
    { op: 'session.entry.label', session, params: { entryId: 'not-created', label: 'must not label' } },
    { op: 'session.clone', session, params: {} }, { op: 'session.import', params: { path: join(f.directory, 'not-created.jsonl'), cwd: f.cwd } },
    { op: 'session.export', session, params: { format: 'jsonl', destination: join(f.directory, 'not-created.jsonl') } },
    { op: 'session.delete', session, params: {} },
    { op: 'session.history', session, params: { revision, branch: 'not-created' } }, { op: 'shell.execute', session, params: { command: 'must-not-run', includeInContext: false } },
    { op: 'config.get', params: { scope: 'global' } }, { op: 'config.set', params: { scope: 'global', values: { autoCompact: true } } },
    { op: 'session.reload', session, params: {} }, { op: 'processes.list', session, params: { root: session } },
    { op: 'processes.read', session, params: { ...resource, offset: 0, limit: 1 } }, { op: 'processes.write', session, params: { ...resource, data: 'AA==' } },
    { op: 'processes.stop', session, params: { ...resource, signal: 'SIGTERM' } },
    { op: 'executions.list', session, params: {} }, { op: 'executions.read', session, params: { executionId: 'not-created' } },
    { op: 'executions.steer', session, params: { executionId: 'not-created', message: 'must not send' } }, { op: 'executions.cancel', session, params: { executionId: 'not-created' } },
  ];
}

describe('session server over private real Unix IPC with fake ownership', () => {

  it('keeps attached clients connected while an explicitly modeled child execution starts and completes', async () => {
    const hold = gate();
    const f = await fixture({ onStream: () => hold.promise, release: hold.resolve });
    const client = await f.client();
    const root = f.root.sessionId;
    await client.attach(root);
    const statuses: string[] = [];
    client.subscribe(() => statuses.push(client.status));
    const host = f.registry.executionHost(root);
    const child = await host.spawnSession({ prompt: 'work', description: 'task', label: 'general', model: { provider: 'offline', id: 'fixture' } });
    if (!child.ok) throw new Error(child.error.message);
    await vi.waitFor(() => expect(host.getExecution(child.value.executionId)?.status).toBe('running'));
    await vi.waitFor(() => expect(client.getAttachment(root)?.state.snapshot?.revision).toBe(f.store.session(root).revision));
    expect(statuses.every(status => status === 'ready')).toBe(true);
    const attachment = await client.attach(child.value.sessionId);
    if (attachment.outcome !== 'accepted') throw new Error('Child attachment failed');
    const events: unknown[] = [];
    const stop = f.registry.subscribe(child.value.sessionId, event => events.push(event));
    cleanups.push(async () => stop());
    hold.resolve();
    await vi.waitFor(() => expect(host.getExecution(child.value.executionId)?.status).toBe('completed'));
    await host.settle();
    expect(await client.request('executions.steer', { executionId: child.value.executionId, message: 'continue' }, { session: root }))
      .toMatchObject({ outcome: 'accepted' });
    await vi.waitFor(() => expect(host.getExecution(child.value.executionId)?.status).toBe('completed'));
    await host.settle();
    await vi.waitFor(() => expect(client.getAttachment(root)?.state.snapshot?.revision).toBe(f.store.session(root).revision));
    await vi.waitFor(() => expect(client.getAttachment(child.value.sessionId)?.state.snapshot?.revision).toBe(f.store.session(child.value.sessionId).revision));
    let revision = attachment.result.snapshot.revision;
    for (const event of events) {
      const envelope = parseServerEnvelope(event);
      if ('rev' in envelope) expect(envelope.rev).toBe(++revision);
    }
    expect(client.status).toBe('ready');
    expect(statuses.every(status => status === 'ready')).toBe(true);
  });

  it('lists and adopts a pre-daemon transcript recorded under a symlinked project path', async () => {
    const f = await fixture(); const client = await f.client(); const id = '019a0000-0000-7000-8000-000000000029';
    const alias = join(f.directory, 'project-alias'); await symlink(f.cwd, alias);
    const directory = join(f.directory, 'agent', 'sessions', legacySessionDirectoryName(alias)); await mkdir(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, `2026-01-01T00-00-00-000Z_${id}.jsonl`); const timestamp = '2026-01-01T00:00:00.000Z';
    await writeFile(path, [{ type: 'session', version: 3, id, timestamp, cwd: alias },
      { type: 'message', id: 'bbbb0001', parentId: null, timestamp, message: { role: 'user', content: 'via alias', timestamp: 1 } },
    ].map(row => JSON.stringify(row) + '\n').join(''), { mode: 0o600 });
    const listed = await client.request('sessions.list', { cwd: f.cwd });
    if (listed.outcome !== 'accepted') throw new Error('List failed');
    expect(listed.result.entries.filter(row => row.session === id)).toEqual([expect.objectContaining({ cwd: f.cwd, preview: 'via alias' })]);
    expect(await client.attach(id)).toMatchObject({ outcome: 'accepted' });
    expect(f.store.session(id)).toMatchObject({ cwd: f.cwd, piPath: path });
  });

  it('lists a pre-daemon per-cwd transcript and adopts it in place under its ID', async () => {
    const f = await fixture(); const client = await f.client(); const id = '019a0000-0000-7000-8000-000000000028';
    const directory = join(f.directory, 'agent', 'sessions', legacySessionDirectoryName(f.cwd)); await mkdir(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, `2026-01-01T00-00-00-000Z_${id}.jsonl`); const timestamp = '2026-01-01T00:00:00.000Z';
    const original = [{ type: 'session', version: 3, id, timestamp, cwd: f.cwd },
      { type: 'model_change', id: 'aaaa0001', parentId: null, timestamp, provider: 'offline', modelId: 'fixture' },
      { type: 'message', id: 'aaaa0002', parentId: 'aaaa0001', timestamp, message: { role: 'user', content: 'from 0.28.3', timestamp: 1 } },
    ].map(row => JSON.stringify(row) + '\n').join('');
    await writeFile(path, original, { mode: 0o600 }); await utimes(path, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
    const rows = async (params: { cwd?: string }) => {
      const response = await client.request('sessions.list', params);
      if (response.outcome !== 'accepted') throw new Error('List failed');
      return response.result.entries.filter(row => row.session === id);
    };
    expect(await rows({ cwd: f.cwd })).toEqual([expect.objectContaining({ root: id, cwd: f.cwd, state: 'open', residency: 'evicted', revision: 0, title: '', preview: 'from 0.28.3' })]);
    expect(await rows({})).toHaveLength(1);
    const alias = join(f.directory, 'alias'); await symlink(f.cwd, alias);
    const aliased = await client.request('sessions.list', { cwd: alias });
    if (aliased.outcome !== 'accepted') throw new Error('List failed');
    expect(aliased.result.entries.map(row => row.session).sort()).toEqual([f.root.sessionId, id].sort());
    expect(await rows({ cwd: f.directory })).toHaveLength(0);
    expect(await client.attach(id)).toMatchObject({ outcome: 'accepted' });
    expect(f.store.session(id)).toMatchObject({ root: id, cwd: f.cwd, piPath: path });
    expect(await rows({})).toEqual([expect.objectContaining({ residency: 'warm', title: '', preview: 'from 0.28.3' })]);
    const listed = await client.request('sessions.list', { cwd: f.cwd });
    expect(listed.outcome === 'accepted' && listed.result.entries.find(row => row.session === f.root.sessionId)).not.toHaveProperty('preview');
    expect(await client.request('prompt', { text: 'from the daemon' }, { session: id })).toMatchObject({ outcome: 'accepted' });
    await vi.waitFor(async () => {
      expect(f.store.session(id).run.state).toBe('idle');
      expect(await readFile(path, 'utf8')).toContain('from the daemon');
    });
    const updated = await readFile(path, 'utf8');
    expect(updated.startsWith(original)).toBe(true);
    const roles = updated.split('\n').filter(Boolean).map(line => JSON.parse(line) as { type: string; message?: { role: string } })
      .filter(row => row.type === 'message').map(row => row.message!.role);
    expect(roles[0]).toBe('user'); expect(roles.slice(-2)).toEqual(['user', 'assistant']);
    expect(await readdir(directory)).toEqual([`2026-01-01T00-00-00-000Z_${id}.jsonl`]);
  });

  it('re-discovers a listed pre-daemon transcript by ID when it is replaced before opening', async () => {
    const f = await fixture(); const client = await f.client(); const id = 'legacy-replaced';
    const header = (session: string) => JSON.stringify({ type: 'session', version: 3, id: session, timestamp: '2026-01-01T00:00:00.000Z', cwd: f.cwd }) + '\n';
    const path = join(f.directory, `2026-01-01T00-00-00-000Z_${id}.jsonl`);
    const replace = async (contents: string) => {
      const next = `${path}.next`; await writeFile(next, contents, { mode: 0o600 });
      await utimes(next, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000)); renameSync(next, path);
    };
    await replace(header(id));
    const listed = await client.request('sessions.list', { cwd: f.cwd });
    expect(listed.outcome === 'accepted' && listed.result.entries.some(row => row.session === id)).toBe(true);
    await replace(header('legacy-impostor'));
    expect(await client.attach(id)).toMatchObject({ outcome: 'rejected', error: { code: 'not_found' } });
    await replace(header(id));
    const resolve = f.profile.resolveResources.bind(f.profile);
    vi.spyOn(f.profile, 'resolveResources').mockImplementationOnce(async request => { await replace(header(id)); return resolve(request); });
    expect(await client.attach(id)).toMatchObject({ outcome: 'accepted' });
    expect(f.store.session(id).piPath).toBe(path);
  });

  it('adopts a recently modified pre-daemon transcript without a quiet window', async () => {
    const f = await fixture(); const client = await f.client(); const id = 'legacy-recent';
    const path = join(f.directory, `2026-01-01T00-00-00-000Z_${id}.jsonl`);
    await writeFile(path, JSON.stringify({ type: 'session', version: 3, id, timestamp: '2026-01-01T00:00:00.000Z', cwd: f.cwd }) + '\n', { mode: 0o600 });
    expect(await client.attach(id)).toMatchObject({ outcome: 'accepted' });
    expect(f.store.session(id).piPath).toBe(path);
    expect(await client.attach('not-a-session')).toMatchObject({ outcome: 'rejected', error: { code: 'not_found' } });
  });

  it('reopens an explicitly closed session when a client attaches again', async () => {
    const f = await fixture(); const client = await f.client(); const session = f.root.sessionId;
    await client.attach(session); await completedPrompt(f, client, 'before close');
    expect(await client.request('close', {}, { session })).toMatchObject({ outcome: 'accepted' });
    expect(f.store.session(session).state).toBe('closed');
    const viewer = await f.client();
    expect(await viewer.attach(session)).toMatchObject({ outcome: 'accepted' });
    expect(f.store.session(session).state).toBe('open');
    expect(await viewer.request('prompt', { text: 'after reopen' }, { session })).toMatchObject({ outcome: 'accepted' });
    await vi.waitFor(() => expect(f.store.session(session).run.state).toBe('idle'));
  });

  it('leaves a closed session closed when reopening it fails', async () => {
    const f = await fixture(); const client = await f.client(); const session = f.root.sessionId;
    await client.attach(session); expect(await client.request('close', {}, { session })).toMatchObject({ outcome: 'accepted' });
    vi.spyOn(f.registry.options.lifecycle, 'resolveResources').mockRejectedValueOnce(new Error('fixture reopen failure'));
    const viewer = await f.client();
    expect(await viewer.attach(session)).toMatchObject({ outcome: 'rejected' });
    expect(f.store.session(session).state).toBe('closed');
    expect(await viewer.attach(session)).toMatchObject({ outcome: 'accepted' });
    expect(f.store.session(session).state).toBe('open');
  });

  it('accepts a model change while a run is active without interrupting it', async () => {
    const entered = gate(); const release = gate();
    const f = await fixture({ onStream: async () => { entered.resolve(); await release.promise; }, release: release.resolve });
    const client = await f.client(); const session = f.root.sessionId; await client.attach(session);
    expect(await client.request('prompt', { text: 'long turn' }, { session })).toMatchObject({ outcome: 'accepted' });
    await entered.promise;
    expect(await client.request('set_model', { provider: 'offline', id: 'fixture' }, { session })).toMatchObject({ outcome: 'accepted' });
    expect(await client.request('set_thinking', { thinking: 'off' }, { session })).toMatchObject({ outcome: 'accepted' });
    expect(f.store.session(session).run.state).toBe('running');
    release.resolve();
    await vi.waitFor(() => expect(f.store.session(session).run.state).toBe('idle'));
  });

  it('invokes catalog commands without a snapshot or selected model and rejects unknown commands', async () => {
    const calls: string[] = [];
    const f = await fixture({ extension: pi => {
      pi.registerCommand('synthetic-command', { description: 'Synthetic command', handler: async args => { calls.push(args); } });
    } });
    const openSession = f.profile.openSession.bind(f.profile);
    const opening = vi.spyOn(f.profile, 'openSession').mockImplementation(async request => {
      const binding = await openSession(request);
      vi.spyOn(binding.runtime.session, 'model', 'get').mockReturnValue(undefined);
      return binding;
    });
    const binding = await f.registry.create({ cwd: f.cwd, target: { kind: 'new' } }); opening.mockRestore();
    const session = binding.sessionId;
    const dispatcher = new SessionCommands({ registry: f.registry, configuration: {} as never,
      models: f.root.runtime.session.modelRuntime, invalidated() {} });
    const projection = f.registry.projection(session);
    expect(() => projection.snapshot()).toThrow('Session has no selected model');
    const snapshot = vi.spyOn(projection, 'snapshot').mockImplementation(() => { throw new Error('Unexpected full snapshot'); });
    try {
      const request = { v: 1 as const, id: newRequestId(), op: 'command.invoke' as const, session,
        params: { name: 'synthetic-command', arguments: 'without-model' } };
      f.store.admit(request, 'owner');
      const result = await dispatcher.prepare({ request } as AdmittedCommand, { origin: { kind: 'automation', source: 'fixture' } });
      expect(await result.response).toMatchObject({ outcome: 'accepted' });
      await vi.waitFor(() => expect(calls).toEqual(['without-model']));
      const unknown = { ...request, id: newRequestId(), params: { name: 'not-registered', arguments: '' } };
      f.store.admit(unknown, 'owner');
      await expect(dispatcher.prepare({ request: unknown } as AdmittedCommand, { origin: { kind: 'automation', source: 'fixture' } }))
        .rejects.toMatchObject({ code: 'unavailable' });
      expect(snapshot).not.toHaveBeenCalled();
    } finally { snapshot.mockRestore(); }
  });

  it('runs extension commands during an active run but keeps skill commands waiting, like Pi', async () => {
    const entered = gate(); const release = gate(); const calls: string[] = [];
    const f = await fixture({ skill: true, onStream: async () => { entered.resolve(); await release.promise; }, release: release.resolve,
      extension: pi => { pi.registerCommand('synthetic-command', { description: 'Synthetic command', handler: async args => { calls.push(args); } }); } });
    const client = await f.client(); const session = f.root.sessionId; await client.attach(session);
    expect(await client.request('prompt', { text: 'long turn' }, { session })).toMatchObject({ outcome: 'accepted' });
    await entered.promise;
    const runId = f.store.session(session).run.id;
    expect(await client.request('command.invoke', { name: 'synthetic-command', arguments: 'mid-run' }, { session }))
      .toMatchObject({ outcome: 'accepted', result: { runId, status: 'started' } });
    await vi.waitFor(() => expect(calls).toEqual(['mid-run']));
    expect(await client.request('command.invoke', { name: 'skill:shared-test-skill', arguments: '' }, { session }))
      .toMatchObject({ outcome: 'rejected', error: { code: 'busy' } });
    expect(f.store.session(session).run).toMatchObject({ state: 'running', id: runId });
    release.resolve();
    await vi.waitFor(() => expect(f.store.session(session).run.state).toBe('idle'));
  });

  it('relaxes strict policy after the last ACP attachment detaches', async () => {
    const f = await fixture(); const session = f.root.sessionId;
    const a = await f.client('acp'); const b = await f.client('acp');
    await a.attach(session, { requirePolicy: 'acp-strict' }); await b.attach(session, { requirePolicy: 'acp-strict' });
    expect(f.registry.getPolicy(session).mode).toBe('acp-strict');
    await a.detach(session);
    expect(f.registry.getPolicy(session).mode).toBe('acp-strict');
    await b.detach(session);
    expect(f.registry.getPolicy(session).mode).toBe('host-default');
    expect(f.store.session(session).policy.effective).toBe('host-default');
  });

  it('starts ACP-created roots with strict policy before any client attachment', async () => {
    const f = await fixture(); const acp = await f.client('acp'); const opened = vi.spyOn(f.profile, 'openSession');
    const response = await acp.request('sessions.create', { cwd: f.cwd, requirePolicy: 'acp-strict', model: { provider: 'offline', id: 'fixture' } });
    if (response.outcome !== 'accepted') throw new Error('Create failed');
    expect(opened.mock.calls.filter(([request]) => request.target.kind === 'new')[0]?.[0].policy.mode).toBe('acp-strict');
    expect(f.registry.getPolicy(response.result.sessionId).mode).toBe('acp-strict'); expect(f.registry.attachmentCount(response.result.sessionId)).toBe(0);
  });

  it('catalogs loaded skills for every client and expands only explicit skill invocations', async () => {
    const f = await fixture({ skill: true }); const client = await f.client(); const session = f.root.sessionId; await client.attach(session);
    expect(client.getAttachment(session)?.state.snapshot?.catalog.commands).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'skill:shared-test-skill', kind: 'skill' }),
    ]));
    expect(await client.request('command.invoke', { name: 'skill:shared-test-skill', arguments: 'literal argument' }, { session })).toMatchObject({ outcome: 'accepted' });
    await vi.waitFor(() => expect(f.store.session(session).run.state).toBe('idle'));
    expect(JSON.stringify(f.root.runtime.session.sessionManager.getEntries())).toContain('Loaded skill instructions from private fixture.');
    const acp = await f.client('acp'); await acp.attach(session, { requirePolicy: 'acp-strict' });
    expect(await acp.request('command.invoke', { name: 'skill:shared-test-skill', arguments: '' }, { session })).toMatchObject({ outcome: 'accepted' });
    await vi.waitFor(() => expect(f.store.session(session).run.state).toBe('idle'));
    expect(f.registry.getPolicy(session).mode).toBe('acp-strict');
    await acp.request('prompt', { text: '/skill:shared-test-skill unexpanded' }, { session });
    await vi.waitFor(() => expect(f.store.session(session).run.state).toBe('idle'));
    const users = f.root.runtime.session.sessionManager.getEntries().filter(entry => entry.type === 'message' && entry.message.role === 'user');
    expect(JSON.stringify(users.at(-1))).toContain('/skill:shared-test-skill unexpanded');
    expect(JSON.stringify(users.at(-1))).not.toContain('Loaded skill instructions');
  });

  it('honors the public setting that disables explicit skill commands', async () => {
    const f = await fixture({ skill: true }); const client = await f.client(); const session = f.root.sessionId;
    f.root.runtime.session.settingsManager.setEnableSkillCommands(false);
    await client.attach(session);
    expect(client.getAttachment(session)?.state.snapshot?.catalog.commands.some(command => command.kind === 'skill')).toBe(false);
    expect(await client.request('command.invoke', { name: 'skill:shared-test-skill', arguments: '' }, { session }))
      .toMatchObject({ outcome: 'rejected', error: { code: 'unavailable' } });
  });

  it('rejects reserved RPC session directories without blocking internal child storage', async () => {
    const f = await fixture(); const client = await f.client(); const resources = f.root.resources;
    for (const sessionDir of [f.store.directory, f.owner.target.runtimeDirectory,
      resources.sessionStorageBase, resources.agentStorageRoot, ...(resources.workerRoots ?? [])]) {
      expect(await client.request('sessions.create', { cwd: f.cwd, sessionDir, model: { provider: 'offline', id: 'fixture' } }))
        .toMatchObject({ outcome: 'rejected', error: { code: 'forbidden' } });
    }
    const child = await f.registry.create({ cwd: f.cwd, sessionDir: join(resources.agentStorageRoot, 'internal-child'),
      rootSessionId: f.root.sessionId, parentSessionId: f.root.sessionId, target: { kind: 'new' }, model: f.root.runtime.session.model! });
    expect(child.parentSessionId).toBe(f.root.sessionId);
  });

  it('lists the newest sessions first across registered and pre-daemon transcripts and pages them with a cursor', async () => {
    const f = await fixture(); const client = await f.client();
    const directory = join(f.directory, 'agent', 'sessions', legacySessionDirectoryName(f.cwd)); await mkdir(directory, { recursive: true, mode: 0o700 });
    const now = Date.now(); const ids: string[] = [];
    for (let index = 0; index < 25; index++) {
      const id = `019a0000-0000-7000-8000-${String(100 + index).padStart(12, '0')}`; const path = join(directory, `legacy-${index}.jsonl`);
      await writeFile(path, [{ type: 'session', version: 3, id, timestamp: '2026-01-01T00:00:00.000Z', cwd: f.cwd },
        { type: 'session_info', name: `Legacy ${index}` }].map(row => JSON.stringify(row) + '\n').join(''), { mode: 0o600 });
      const time = new Date(now - (index + 1) * 60_000); await utimes(path, time, time);
      ids.push(id);
    }
    const summary = vi.spyOn(LegacySessionIndex.prototype, 'summary');
    const listed: { session: string; title: string }[] = []; let cursor: string | undefined; let pages = 0;
    do {
      const response = await client.request('sessions.list', { limit: 10, ...(cursor ? { cursor } : {}) });
      if (response.outcome !== 'accepted') throw new Error('List failed');
      if (pages === 0) expect(summary).toHaveBeenCalledTimes(response.result.entries.filter(row => ids.includes(row.session)).length);
      listed.push(...response.result.entries); cursor = response.result.cursor; pages++;
    } while (cursor);
    summary.mockRestore();
    expect(pages).toBe(3);
    expect(listed.map(row => row.session)).toEqual([f.root.sessionId, ...ids]);
    expect(listed.slice(1).map(row => row.title)).toEqual(ids.map((_, index) => `Legacy ${index}`));
    const scoped = await client.request('sessions.list', { cwd: f.cwd, limit: 3 });
    if (scoped.outcome !== 'accepted') throw new Error('List failed');
    expect(scoped.result.entries.map(row => row.session)).toEqual([f.root.sessionId, ids[0], ids[1]]);
  });

  it('keeps a new client session out of listings and host status until its first message', async () => {
    const f = await fixture(); const client = await f.client();
    const before = await client.request('host.status', {});
    if (before.outcome !== 'accepted') throw new Error('Status failed');
    const created = await client.request('sessions.create', { cwd: f.cwd, model: { provider: 'offline', id: 'fixture' } });
    if (created.outcome !== 'accepted') throw new Error('Create failed');
    const id = created.result.sessionId;
    expect(await client.request('host.status', {})).toMatchObject({ outcome: 'accepted', result: { active: { sessions: before.result.active.sessions } } });
    const listed = await client.request('sessions.list', {});
    expect(listed.outcome === 'accepted' && listed.result.entries.map(row => row.session)).not.toContain(id);
    expect(await client.attach(id)).toMatchObject({ outcome: 'accepted' });
    await client.detach(id);
    expect(await f.registry.evictIdle()).toContain(id);
    expect(f.store.session(id).deletedAt).toBeDefined();
  });

  it('keeps session and process cursors stable across unrelated activity while binding their scope', async () => {
    const f = await fixture(); const client = await f.client(); const session = f.root.sessionId;
    await f.registry.create({ cwd: f.cwd, target: { kind: 'new' }, model: f.root.runtime.session.model! });
    for (const id of ['resource-a', 'resource-b']) f.store.putResource({ id, root: session, session, kind: 'foreground', state: 'exited', updatedAt: Date.now() });
    await client.attach(session);
    const sessions = await client.request('sessions.list', { limit: 1 }); const processes = await client.request('processes.list', { root: session, limit: 1 }, { session });
    if (sessions.outcome !== 'accepted' || processes.outcome !== 'accepted' || !sessions.result.cursor || !processes.result.cursor) throw new Error('Cursor missing');
    await client.request('config.set', { scope: 'global', values: { autoCompact: true } });
    expect(await client.request('sessions.list', { limit: 1, cursor: sessions.result.cursor })).toMatchObject({ outcome: 'accepted' });
    expect(await client.request('processes.list', { root: session, limit: 1, cursor: processes.result.cursor }, { session })).toMatchObject({ outcome: 'accepted' });
    expect(await client.request('sessions.list', { root: session, cursor: sessions.result.cursor })).toMatchObject({ outcome: 'rejected', error: { code: 'resync_required' } });
  });

  it('treats an interrupted idle run as quiescent for cancel and reload and reports a missing run explicitly', async () => {
    const f = await fixture(); const session = f.root.sessionId;
    f.store.updateSession(session, { run: { state: 'interrupted', id: 'old-run' } });
    const client = await f.client(); await client.attach(session);
    expect(await client.request('cancel', { runId: 'different-run' }, { session })).toMatchObject({ outcome: 'rejected', error: { code: 'not_found' } });
    expect(await client.request('cancel', { runId: 'old-run' }, { session })).toMatchObject({ outcome: 'accepted' });
    expect(f.store.session(session).run.state).toBe('interrupted');
    expect(await client.request('session.reload', {}, { session })).toMatchObject({ outcome: 'accepted' });
  });

  it('reloads the root while keeping a queued child execution resident', async () => {
    const f = await fixture(); const session = f.root.sessionId; const client = await f.client(); await client.attach(session);
    const child = await f.registry.create({ cwd: f.cwd, target: { kind: 'new' }, parentSessionId: session, rootSessionId: session,
      execution: { request: { prompt: 'work', description: 'queued' }, createdAt: new Date().toISOString(), deliveryId: 'delivery', completionPending: false } });
    await client.attach(child.sessionId);
    expect(await client.request('prompt', { text: 'bypass queue' }, { session: child.sessionId })).toMatchObject({ outcome: 'rejected', error: { code: 'busy' } });
    const childBinding = f.registry.binding(child.sessionId);
    expect(await client.request('session.reload', {}, { session })).toMatchObject({ outcome: 'accepted' });
    expect(f.registry.binding(child.sessionId)).toBe(childBinding);
    await f.registry.close(child.sessionId);
  });

  it('rejects missing model authorization and missing process capability before durable dispatch', async () => {
    const f = await fixture(); const client = await f.client(); const session = f.root.sessionId; await client.attach(session);
    const setModel = vi.spyOn(f.root.runtime.session, 'setModel');
    vi.spyOn(f.root.runtime.session.modelRuntime, 'checkAuth').mockResolvedValueOnce(undefined);
    const modelId = newRequestId();
    expect(await client.request('set_model', { provider: 'offline', id: 'fixture' }, { session, id: modelId })).toMatchObject({ outcome: 'rejected' });
    expect(setModel).not.toHaveBeenCalled();
    const { processes: _processes, ...runtime } = f.root.agentRuntime;
    f.registry.processes.wrap(runtime, { root: session, session });
    const shellId = newRequestId();
    expect(await client.request('shell.execute', { command: 'must-not-start', includeInContext: false }, { session, id: shellId }))
      .toMatchObject({ outcome: 'rejected', error: { code: 'unavailable' } });
    for (const id of [modelId, shellId]) expect(f.store.snapshot().requests.find(row => row.id === id)?.response?.outcome).toBe('rejected');
  });

  it('settles a finished shell only after a gated non-run stop dispatch releases', async () => {
    const held = gate(); const release = gate(); const f = await fixture({ release: release.resolve }); const shell = syntheticShell(f);
    const client = await f.client(); const session = f.root.sessionId; await client.attach(session);
    const original = f.registry.processes.stopForSession.bind(f.registry.processes);
    const drained = gate(); const runAdmitted = f.registry.runAdmitted.bind(f.registry);
    const observeRun: typeof f.registry.runAdmitted = (request, id, origin, effect) => {
      const work = runAdmitted(request, id, origin, effect); void work.then(drained.resolve, drained.resolve); return work;
    };
    vi.spyOn(f.registry, 'runAdmitted').mockImplementation(observeRun);
    vi.spyOn(f.registry.processes, 'stopForSession').mockImplementation(async (...args) => { await original(...args); held.resolve(); await release.promise; });
    try {
      const run = await client.request('shell.execute', { command: 'synthetic-shell', includeInContext: false }, { session });
      if (run.outcome !== 'accepted') throw new Error('Shell failed');
      const stopping = client.request('processes.stop', { root: session, resourceId: run.result.resourceId, signal: 'SIGTERM' }, { session });
      await held.promise; await drained.promise; expect(f.root.runtime.session.isIdle).toBe(true);
      expect(f.store.session(session).run.state).toBe('running'); release.resolve();
      expect(await stopping).toMatchObject({ outcome: 'accepted' }); await vi.waitFor(() => expect(f.store.session(session).run.state).toBe('idle'));
    } finally { release.resolve(); shell.finish(); }
  });

  it.each(['steer', 'follow_up'] as const)('settles a finished run after gated %s input completes', async op => {
    const streamed = gate(); const finish = gate(); const entered = gate(); const release = gate();
    const f = await fixture({ onStream: async () => { streamed.resolve(); await finish.promise; }, release: () => { finish.resolve(); release.resolve(); },
      extension: pi => { pi.on('input', async event => { if (event.text === 'held-input') { entered.resolve(); await release.promise; return { action: 'handled' }; } return undefined; }); } });
    const client = await f.client(); const session = f.root.sessionId; await client.attach(session);
    await client.request('prompt', { text: 'running' }, { session }); await streamed.promise;
    const pending = client.request(op, { text: 'held-input' }, { session }); await entered.promise; finish.resolve();
    await vi.waitFor(() => expect(f.root.runtime.session.isIdle).toBe(true)); expect(f.store.session(session).run.state).toBe('running');
    release.resolve(); expect(await pending).toMatchObject({ outcome: 'accepted', result: { status: 'handled' } });
    await vi.waitFor(() => expect(f.store.session(session).run.state).toBe('idle'));
  });

  it('counts interruptible processes and pending host questions as active work in host.status', async () => {
    const f = await fixture(); const client = await f.client();
    expect(await client.request('host.status', {})).toMatchObject({ outcome: 'accepted', result: { active: { runs: 0, work: 0 } } });
    const processes = vi.spyOn(f.registry.processes, 'interruptibleCount').mockResolvedValue(1);
    expect(await client.request('host.status', {})).toMatchObject({ outcome: 'accepted', result: { active: { runs: 0, work: 1 } } });
    processes.mockRestore();
    f.store.putInteraction({ id: 'host-question', scope: { kind: 'host' }, request: { kind: 'input', title: 'Continue?' }, state: 'waiting', createdAt: Date.now() });
    expect(await client.request('host.status', {})).toMatchObject({ outcome: 'accepted', result: { active: { runs: 0, work: 1 } } });
  });

  it('reports live attachment totals and detaches explicitly without cancelling the other viewer', async () => {
    const f = await fixture(); const a = await f.client(); const b = await f.client(); const session = f.root.sessionId;
    await a.attach(session); await b.attach(session); const cancel = vi.spyOn(f.registry, 'cancel');
    expect(await a.request('host.status', {})).toMatchObject({ outcome: 'accepted', result: { active: { sessions: 1, runs: 0, attachments: 2 } } });
    expect(await a.detach(session)).toMatchObject({ outcome: 'accepted' });
    expect(f.registry.attachmentCount(session)).toBe(1); expect(cancel).not.toHaveBeenCalled(); expect(f.registry.binding(session)).toBe(f.root);
    expect(await b.request('host.status', {})).toMatchObject({ outcome: 'accepted', result: { active: { attachments: 1 } } });
    expect(b.getAttachment(session)?.state.status).toBe('live');
    expect(await a.request('prompt', { text: 'detached' }, { session })).toMatchObject({ outcome: 'rejected', error: { code: 'forbidden' } });
  });

  it.each(['steer', 'follow_up'] as const)('preserves the native queued %s identity across a retained retry', async op => {
    const f = await fixture(); const client = await f.client(); const session = f.root.sessionId; await client.attach(session);
    const id = newRequestId(); const params = { text: `queued ${op}` };
    const response = await client.request(op, params, { session, id }); expect(response).toMatchObject({ outcome: 'accepted', result: { itemId: expect.any(String) } });
    if (response.outcome !== 'accepted' || !('itemId' in response.result)) throw new Error('Input was not queued');
    await vi.waitFor(() => expect(client.getAttachment(session)?.state.snapshot?.queue).toEqual([
      expect.objectContaining({ id: response.result.itemId, kind: op }),
    ]));
    const retry = await f.client(); expect(await retry.request(op, params, { session, id })).toEqual(response);
    expect(f.registry.projection(session).snapshot().queue).toHaveLength(1);
  });

  it('lists and stops only a scoped retained foreground resource and rejects a foreign root', async () => {
    const f = await fixture(); const shell = syntheticShell(f); const client = await f.client(); const session = f.root.sessionId; await client.attach(session);
    try {
      const response = await client.request('shell.execute', { command: 'synthetic-shell', includeInContext: false }, { session });
      if (response.outcome !== 'accepted') throw new Error('Shell failed');
      const resourceId = response.result.resourceId;
      expect(await client.request('processes.list', { root: session }, { session })).toMatchObject({ outcome: 'accepted', result: {
        entries: expect.arrayContaining([expect.objectContaining({ id: resourceId, root: session, session, kind: 'foreground' })]),
      } });
      expect(await client.request('processes.stop', { root: 'foreign-root', resourceId, signal: 'SIGTERM' }, { session }))
        .toMatchObject({ outcome: 'rejected', error: { code: 'forbidden' } });
      expect(await client.request('processes.stop', { root: session, resourceId, signal: 'SIGTERM' }, { session })).toMatchObject({ outcome: 'accepted' });
      await vi.waitFor(() => expect(f.store.session(session).run.state).toBe('idle'));
      expect(await client.request('processes.read', { root: session, resourceId, offset: 0, limit: 4 }, { session }))
        .toMatchObject({ outcome: 'accepted', result: { state: 'exited', data: 'QQD/Cg==' } });
    } finally { shell.finish(); }
  });

  it('rejects a malformed imported snapshot without registering a session or changing its source', async () => {
    const f = await fixture(); const client = await f.client(); const source = join(f.directory, 'invalid-import.jsonl');
    const bytes = 'not a session header\n'; await writeFile(source, bytes, { mode: 0o600 }); const sessions = f.store.snapshot().sessions;
    expect(await client.request('session.import', { path: source, cwd: f.cwd })).toMatchObject({ outcome: 'rejected', error: { code: 'invalid_request' } });
    expect(f.store.snapshot().sessions).toEqual(sessions); expect(await readFile(source, 'utf8')).toBe(bytes);
  });

  it('creates a new session over the wire once and rejects unavailable overrides or models without opening', async () => {
    const f = await fixture(); const client = await f.client(); const original = await readFile(f.store.session(f.root.sessionId).piPath);
    const open = vi.spyOn(f.profile, 'openSession'); const id = newRequestId();
    const params = { cwd: f.cwd, model: { provider: 'offline', id: 'fixture' }, thinking: 'off' as const };
    const response = await client.request('sessions.create', params, { id });
    expect(response.outcome).toBe('accepted'); if (response.outcome !== 'accepted') throw new Error('Create failed');
    const created = f.store.session(response.result.sessionId);
    expect(created.id).not.toBe(f.root.sessionId); expect(created.root).toBe(created.id); expect(created.cwd).toBe(f.cwd);
    expect(f.registry.binding(created.id)?.runtime.session.model?.id).toBe('fixture');
    expect(client.getAttachment(created.id)).toBeUndefined();
    const retry = await f.client(); expect(await retry.request('sessions.create', params, { id })).toEqual(response);
    expect(open.mock.calls.filter(([request]) => request.target.kind === 'new')).toHaveLength(1); expect(f.store.snapshot().sessions).toHaveLength(2);
    expect(await client.request('sessions.create', { ...params, config: { autoCompact: true } })).toMatchObject({ outcome: 'rejected', error: { code: 'unavailable' } });
    expect(await client.request('sessions.create', { ...params, model: { provider: 'offline', id: 'missing' } })).toMatchObject({ outcome: 'rejected', error: { code: 'not_found' } });
    expect(open.mock.calls.filter(([request]) => request.target.kind === 'new')).toHaveLength(1); expect(await readFile(f.store.session(f.root.sessionId).piPath)).toEqual(original);
  });

  it('performs native compaction over the wire and never repeats it for a retained retry', async () => {
    const f = await fixture({ compaction: { reserveTokens: 256, keepRecentTokens: 16 } }); const client = await f.client(); const session = f.root.sessionId;
    await client.attach(session); await completedPrompt(f, client, 'earlier context '.repeat(80)); await completedPrompt(f, client, 'retained context '.repeat(80));
    const compact = vi.spyOn(f.root.runtime.session, 'compact'); const id = newRequestId(); const params = { method: 'summary', instructions: 'Summarize only the supplied history.' };
    const response = await client.request('compact', params, { session, id });
    expect(response).toMatchObject({ outcome: 'accepted', result: { runId: expect.any(String) } });
    await vi.waitFor(() => {
      expect(f.root.runtime.session.sessionManager.getEntries().filter(entry => entry.type === 'compaction')).toHaveLength(1);
      expect(f.store.session(session).run.state).toBe('idle');
    });
    expect(compact).toHaveBeenCalledExactlyOnceWith(params.instructions);
    const retry = await f.client(); expect(await retry.request('compact', params, { session, id })).toEqual(response);
    expect(compact).toHaveBeenCalledOnce();
    expect(await client.request('compact', { method: 'not-supported' }, { session })).toMatchObject({ outcome: 'rejected', error: { code: 'unavailable' } });
    expect(compact).toHaveBeenCalledOnce();
  });

  it('delivers input held during manual compaction before the daemon run settles', async () => {
    const f = await compactingFixture(); const { client, session } = f;
    const queued = await client.request('steer', { text: 'after compaction' }, { session });
    expect(queued).toMatchObject({ outcome: 'accepted', result: { itemId: expect.any(String) } });
    await vi.waitFor(() => expect(client.getAttachment(session)?.state.snapshot?.queue).toHaveLength(1));
    f.release();
    await vi.waitFor(() => {
      const entries = f.root.runtime.session.sessionManager.getEntries();
      const index = entries.findIndex(entry => entry.type === 'message' && entry.message.role === 'user' && JSON.stringify(entry.message.content).includes('after compaction'));
      expect(index).toBeGreaterThan(-1);
      expect(entries.slice(index + 1).some(entry => entry.type === 'message' && entry.message.role === 'assistant')).toBe(true);
      expect(f.store.session(session).run.state).toBe('idle');
      expect(f.registry.projection(session).snapshot().queue).toEqual([]);
    });
  });

  it.each(['started', 'handled'] as const)('holds late steering until earlier compaction input finishes preflight (%s)', async disposition => {
    const entered = gate(); const release = gate(); const seen: string[] = [];
    const f = await compactingFixture({ release: release.resolve, extension: pi => { pi.on('input', async event => {
      if (!event.text.includes('held')) return undefined;
      seen.push(event.text);
      if (event.text === 'first held') { entered.resolve(); await release.promise; if (disposition === 'handled') return { action: 'handled' }; }
      return undefined;
    }); } });
    const { client, session } = f; const runtime = f.root.runtime.session; const projection = f.registry.projection(session);
    const steer = vi.spyOn(runtime, 'steer');
    for (const text of ['first held', 'second held']) await client.request('steer', { text }, { session });
    f.release(); await entered.promise;
    expect(runtime.isStreaming).toBe(false);
    expect(await client.request('steer', { text: 'late held' }, { session })).toMatchObject({ outcome: 'accepted', result: { itemId: expect.any(String) } });
    expect(steer).not.toHaveBeenCalled(); expect(seen).toEqual(['first held']);
    expect(projection.compactionInputs.map(item => item.prompt.text)).toEqual(['second held', 'late held']);
    release.resolve();
    await vi.waitFor(() => expect(f.store.session(session).run.state).toBe('idle'));
    expect(seen).toEqual(['first held', 'second held', 'late held']);
    const users = projection.snapshot().history.entries.filter(entry => entry.role === 'user').map(entry => JSON.stringify(entry.content));
    for (const text of ['second held', 'late held']) expect(users.some(content => content.includes(text))).toBe(true);
    expect(runtime.getSteeringMessages()).toEqual([]); expect(projection.holdsCompactionInput).toBe(false);
  });

  it('attributes a later held prompt to its origin after the preceding Pi run settles', async () => {
    const f = await compactingFixture(); const { client, session } = f; const runtime = f.root.runtime.session;
    const second = await f.createClient(); await second.attach(session);
    await client.request('steer', { text: 'first held run' }, { session });
    await second.request('follow_up', { text: 'second held run' }, { session });
    const held = f.registry.projection(session).snapshot().queue;
    const prompt = runtime.prompt.bind(runtime);
    vi.spyOn(runtime, 'prompt').mockImplementation(async (text, options) => {
      if (text !== 'first held run') { expect(runtime.isStreaming).toBe(false); return prompt(text, options); }
      await prompt(text, { ...options, preflightResult: undefined }); options?.preflightResult?.('started');
    });
    f.release(); await vi.waitFor(() => expect(f.store.session(session).run.state).toBe('idle'));
    const users = f.registry.projection(session).snapshot().history.entries.filter(entry => entry.role === 'user');
    expect(users.find(entry => JSON.stringify(entry.content).includes('first held run'))?.origin).toEqual(held[0]!.origin);
    expect(users.find(entry => JSON.stringify(entry.content).includes('second held run'))?.origin).toEqual(held[1]!.origin);
  });

  it('delivers compaction steering and follow-up in one run with their origins and attachments', async () => {
    const entered = gate(); const release = gate(); let calls = 0;
    const f = await compactingFixture({ release: release.resolve, onStream: async () => { if (++calls === 4) { entered.resolve(); await release.promise; } } });
    const { client, session } = f; const second = await f.createClient(); await second.attach(session);
    const steer = vi.spyOn(f.root.runtime.session, 'steer'); const followUp = vi.spyOn(f.root.runtime.session, 'followUp');
    const prompt = vi.spyOn(f.root.runtime.session, 'prompt');
    const image = { type: 'image' as const, mimeType: 'image/png' as const, data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1EAAAAASUVORK5CYII=' };
    expect(await client.request('steer', { text: 'first held', attachments: [{ type: 'text', text: 'attached text' }, image] }, { session })).toMatchObject({ outcome: 'accepted' });
    expect(await second.request('follow_up', { text: 'second held' }, { session })).toMatchObject({ outcome: 'accepted' });
    const held = f.registry.projection(session).snapshot().queue;
    expect(held.map(item => item.kind)).toEqual(['steer', 'follow_up']);
    expect(steer).not.toHaveBeenCalled(); expect(followUp).not.toHaveBeenCalled();
    expect(f.store.session(session).projections.find(row => row.value.type === 'queue')?.value).toMatchObject({ ids: held.map(item => item.id) });
    f.release(); await entered.promise;
    expect(f.store.session(session).run).toMatchObject({ id: f.runId, state: 'running', origin: held[0]!.origin });
    await vi.waitFor(() => expect(f.root.runtime.session.getFollowUpMessages()).toEqual(['second held']));
    expect(await client.request('steer', { text: 'native while streaming' }, { session })).toMatchObject({ outcome: 'accepted' });
    expect(steer).toHaveBeenCalledOnce();
    release.resolve();
    await vi.waitFor(() => expect(f.store.session(session).run.state).toBe('idle'));
    const snapshot = f.registry.projection(session).snapshot(); const users = snapshot.history.entries.filter(entry => entry.role === 'user');
    const first = users.find(entry => JSON.stringify(entry.content).includes('first held'))!;
    const last = users.find(entry => JSON.stringify(entry.content).includes('second held'))!;
    expect(prompt).toHaveBeenCalledWith('first held\nattached text', expect.objectContaining({ images: [image], source: 'rpc', expandPromptTemplates: false, streamingBehavior: 'steer' }));
    expect(first.content).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'text', text: expect.stringContaining('first held\nattached text') })]));
    expect(first.origin).toEqual(held[0]!.origin); expect(last.origin).toEqual(held[1]!.origin);
    expect(users.indexOf(first)).toBeLessThan(users.indexOf(last)); expect(snapshot.queue).toEqual([]);
  });

  it('atomically clears native and held compaction input as text and retains the restore result', async () => {
    const f = await compactingFixture(); const { client, session } = f; const runtime = f.root.runtime.session;
    await runtime.steer('native steering'); await runtime.followUp('native follow-up');
    await client.request('steer', { text: 'held steering', attachments: [{ type: 'text', text: 'attached text' },
      { type: 'resource_link', uri: 'https://example.com/resource', name: 'Reference', description: 'attached resource' }] }, { session });
    await client.request('follow_up', { text: 'held follow-up' }, { session });
    const id = newRequestId(); const response = await client.request('queue.clear', {}, { session, id });
    expect(response).toMatchObject({ outcome: 'accepted', result: { steering: ['native steering', 'held steering\nattached text\nReference: https://example.com/resource\nattached resource'],
      followUp: ['native follow-up', 'held follow-up'] } });
    expect(runtime.agent.hasQueuedMessages()).toBe(false);
    await vi.waitFor(() => expect(client.getAttachment(session)?.state.snapshot?.queue).toEqual([]));
    expect(await client.request('queue.clear', {}, { session, id })).toEqual(response);
    f.release(); await vi.waitFor(() => expect(f.store.session(session).run.state).toBe('idle'));
    expect(runtime.sessionManager.getEntries().some(entry => entry.type === 'message' && entry.message.role === 'user' && /held|native/.test(JSON.stringify(entry.message.content)))).toBe(false);
  });

  it.each(['items', 'encoded bytes'] as const)('rejects held input exceeding queue.clear %s without changing either queue', async limit => {
    const f = await compactingFixture(); const { client, session } = f; const runtime = f.root.runtime.session;
    await runtime.steer('native retained'); await client.request('follow_up', { text: 'held retained' }, { session });
    const projection = f.registry.projection(session); const before = projection.snapshot().queue;
    const messages = vi.spyOn(runtime, 'getSteeringMessages').mockReturnValue(limit === 'items'
      ? Array.from({ length: LIMITS.pageEntries - 1 }, () => 'native retained') : ['"'.repeat(LIMITS.pageBytes / 4 - 1024)]);
    try {
      expect(await client.request('steer', { text: 'must not hold', attachments: [{ type: 'text', text: 'x'.repeat(LIMITS.statusTextBytes + 1) }] }, { session }))
        .toMatchObject({ outcome: 'rejected', error: { code: 'busy' } });
      expect(projection.snapshot().queue).toEqual(before);
      expect(projection.compactionInputs.map(item => item.prompt.text)).toEqual(['held retained']);
    } finally { messages.mockRestore(); }
    expect(await client.request('queue.clear', {}, { session })).toMatchObject({ outcome: 'accepted', result: { steering: ['native retained'], followUp: ['held retained'] } });
    f.release(); await vi.waitFor(() => expect(f.store.session(session).run.state).toBe('idle'));
  });

  it('aborts a held prompt when cancellation arrives during its preflight', async () => {
    const entered = gate(); const release = gate(); const finish = gate(); let calls = 0;
    const f = await compactingFixture({ release: () => { release.resolve(); finish.resolve(); },
      onStream: async () => { if (++calls >= 4) await finish.promise; },
      extension: pi => { pi.on('input', async event => { if (event.text === 'cancelled held') { entered.resolve(); await release.promise; } return undefined; }); } });
    const { client, session } = f; const runtime = f.root.runtime.session; const abort = vi.spyOn(runtime, 'abort');
    const starts: SessionSnapshot['run'][] = [];
    runtime.subscribe(event => { if (event.type === 'agent_start') starts.push(f.store.session(session).run); });
    await client.request('steer', { text: 'cancelled held' }, { session });
    await client.request('follow_up', { text: 'discarded held' }, { session });
    f.release(); await entered.promise;
    const cancelled = client.request('cancel', { runId: f.runId }, { session });
    await vi.waitFor(() => expect(abort).toHaveBeenCalledOnce());
    expect(runtime.isStreaming).toBe(false); expect(f.store.session(session).run.state).toBe('cancelling');
    release.resolve(); await vi.waitFor(() => expect(abort).toHaveBeenCalledTimes(2)); finish.resolve();
    expect(await cancelled).toMatchObject({ outcome: 'accepted' });
    expect(starts).toMatchObject([{ id: f.runId, state: 'cancelling' }]);
    const entries = runtime.sessionManager.getEntries();
    expect(entries.some(entry => entry.type === 'message' && entry.message.role === 'user' && JSON.stringify(entry.message.content).includes('discarded held'))).toBe(false);
    expect(f.registry.projection(session).snapshot()).toMatchObject({ queue: [], run: { state: 'idle' } });
    expect(f.registry.projection(session).holdsCompactionInput).toBe(false);
  });

  it.each([1, 2])('discards %i held compaction input(s) on cancellation without starting a prompt', async count => {
    const f = await compactingFixture(); const { client, session } = f;
    for (let index = 0; index < count; index++) await client.request('steer', { text: `discard ${index}` }, { session });
    const prompt = vi.spyOn(f.root.runtime.session, 'prompt');
    const cancelled = client.request('cancel', { runId: f.runId }, { session });
    await vi.waitFor(() => expect(f.store.session(session).run.state).toBe('cancelling'));
    f.release(); expect(await cancelled).toMatchObject({ outcome: 'accepted' });
    expect(prompt).not.toHaveBeenCalled();
    expect(f.registry.projection(session).snapshot()).toMatchObject({ queue: [], run: { state: 'idle' },
      presentation: expect.arrayContaining([{ id: 'queue-discarded', kind: 'notification', level: 'warning',
        text: `${count} queued message${count === 1 ? ' was' : 's were'} discarded because compaction was cancelled.` }]) });
    expect(f.registry.projection(session).presentations().some(item => item.id === 'run-error')).toBe(false);
    expect(f.registry.projection(session).holdsCompactionInput).toBe(false);
  });

  it.each(['close', 'shutdown'] as const)('does not deliver held compaction input during %s', async action => {
    const f = await compactingFixture(); const { client, session } = f;
    await client.request('steer', { text: 'must not start during teardown' }, { session });
    const prompt = vi.spyOn(f.root.runtime.session, 'prompt'); const abort = vi.spyOn(f.root.runtime.session, 'abort');
    const closing = action === 'close' ? client.request('close', {}, { session }) : f.registry.shutdown({ interrupt: true });
    await vi.waitFor(() => expect(abort).toHaveBeenCalled());
    f.release(); await closing;
    expect(prompt).not.toHaveBeenCalled();
  });

  it('continues past handled compaction input and still delivers after compaction fails', async () => {
    const f = await compactingFixture({ compactionError: new Error('compaction failed'),
      extension: pi => { pi.on('input', async event => event.text === 'handled after compaction' ? { action: 'handled' } : undefined); } });
    const { client, session } = f; const runtime = f.root.runtime.session;
    await client.request('steer', { text: 'handled after compaction' }, { session });
    await client.request('follow_up', { text: 'delivered after compaction' }, { session });
    f.release();
    await vi.waitFor(() => {
      expect(f.store.session(session).run.state).toBe('idle');
      expect(runtime.sessionManager.getEntries().some(entry => entry.type === 'message' && entry.message.role === 'user' && JSON.stringify(entry.message.content).includes('delivered after compaction'))).toBe(true);
    });
    expect(f.registry.projection(session).snapshot()).toMatchObject({ queue: [], presentation: expect.arrayContaining([
      expect.objectContaining({ id: 'run-error', level: 'error' }),
    ]) });
  });

  it('stops and discards remaining held input when delivery after compaction rejects', async () => {
    const f = await compactingFixture(); const { client, session } = f;
    await client.request('steer', { text: 'cannot deliver' }, { session });
    await client.request('follow_up', { text: 'must not deliver' }, { session });
    const prompt = vi.spyOn(f.root.runtime.session, 'prompt').mockRejectedValue(new Error('model unavailable'));
    f.release();
    await vi.waitFor(() => expect(f.store.session(session).run.state).toBe('idle'));
    expect(prompt).toHaveBeenCalledOnce(); prompt.mockRestore();
    expect(f.registry.projection(session).snapshot()).toMatchObject({ queue: [], presentation: expect.arrayContaining([
      { id: 'queue-delivery-error', kind: 'notification', level: 'error', text: 'Queued input could not be sent after compaction: model unavailable' },
    ]) });
    expect(f.registry.projection(session).holdsCompactionInput).toBe(false);
  });

  it('retains a started delivery failure while later compaction input is in preflight', async () => {
    const f = await compactingFixture(); const { client, session } = f;
    for (const text of ['first started', 'later preflight', 'must be discarded']) await client.request('steer', { text }, { session });
    const fail = gate(); const entered = gate(); const release = gate();
    const prompt = vi.spyOn(f.root.runtime.session, 'prompt').mockImplementation(async (text, options) => {
      if (text === 'first started') { options?.preflightResult?.('started'); await fail.promise; throw new Error('started run failed'); }
      entered.resolve(); await release.promise; options?.preflightResult?.('handled');
    });
    try {
      f.release(); await entered.promise; fail.resolve();
      await vi.waitFor(() => expect(f.registry.projection(session).presentations()).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'queue-delivery-error', text: 'Queued input could not be sent after compaction: started run failed' }),
      ])));
      expect(prompt).toHaveBeenCalledTimes(2); expect(f.store.session(session).run.state).toBe('running');
      release.resolve(); await vi.waitFor(() => expect(f.store.session(session).run.state).toBe('idle'));
      expect(f.registry.projection(session).snapshot().queue).toEqual([]);
    } finally { fail.resolve(); release.resolve(); prompt.mockRestore(); }
  });

  it.each(['entry', 'position'] as const)('forks before the wire %s selector without source mutation, automatic attachment or duplicate copies', async kind => {
    const f = await fixture(); const client = await f.client(); const session = f.root.sessionId; await client.attach(session);
    await completedPrompt(f, client, 'keep first user'); await completedPrompt(f, client, 'exclude selected user');
    const manager = f.root.runtime.session.sessionManager; const choices = f.root.runtime.session.getUserMessagesForForking(); expect(choices).toHaveLength(2);
    const path = f.store.session(session).piPath; const before = await readFile(path); const leaf = manager.getLeafId();
    const params = { from: kind === 'entry' ? { kind, entryId: choices[1]!.entryId } : { kind, position: 1 } }; const id = newRequestId();
    const response = await client.request('fork', params, { session, id });
    expect(response.outcome).toBe('accepted'); if (response.outcome !== 'accepted') throw new Error('Fork failed');
    const child = f.registry.binding(response.result.sessionId)!;
    expect(child.runtime.session.getUserMessagesForForking().map(row => row.text)).toEqual(['keep first user']);
    expect(f.registry.getPolicy(child.sessionId)).toEqual(f.registry.getPolicy(session));
    expect(await readFile(path)).toEqual(before); expect(manager.getLeafId()).toBe(leaf);
    expect(client.getAttachment(child.sessionId)).toBeUndefined();
    expect(await client.request('fork', params, { session, id })).toEqual(response); expect(f.store.snapshot().sessions).toHaveLength(2);
    const assistant = manager.getEntries().find(entry => entry.type === 'message' && entry.message.role === 'assistant')!;
    for (const from of [{ kind: 'position' as const, position: 2 }, { kind: 'entry' as const, entryId: assistant.id }]) {
      expect((await client.request('fork', { from }, { session })).outcome).toBe('rejected');
    }
    expect(f.store.snapshot().sessions).toHaveLength(2); expect(await readFile(path)).toEqual(before);
  });

  it('selects an existing branch entry over the wire exactly once and rejects a missing target', async () => {
    const f = await fixture(); const client = await f.client(); const session = f.root.sessionId; await client.attach(session);
    await completedPrompt(f, client, 'first branch'); await completedPrompt(f, client, 'second branch');
    const manager = f.root.runtime.session.sessionManager;
    const target = manager.getEntries().find(entry => entry.type === 'message' && entry.message.role === 'assistant')!;
    const navigate = vi.spyOn(f.root.runtime.session, 'navigateTree'); const id = newRequestId();
    const params = { entryId: target.id, summarize: false };
    const response = await client.request('session.branch.select', params, { session, id }); expect(response.outcome).toBe('accepted');
    expect(manager.getLeafId()).toBe(target.id); expect(navigate).toHaveBeenCalledExactlyOnceWith(target.id, { summarize: false });
    const retry = await f.client(); expect(await retry.request('session.branch.select', params, { session, id })).toEqual(response);
    expect(navigate).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(client.getAttachment(session)?.state.status).toBe('live'));
    expect(await client.request('session.branch.select', { entryId: 'not-created' }, { session }))
      .toMatchObject({ outcome: 'rejected', error: { code: 'not_found' } });
    expect(navigate).toHaveBeenCalledOnce(); expect(manager.getLeafId()).toBe(target.id);
  });

  it.each(['html', 'jsonl'] as const)('exports through the actual SDK %s renderer once without changing the session or allowing a managed destination', async format => {
    const f = await fixture(); const client = await f.client(); const session = f.root.sessionId; await client.attach(session);
    await completedPrompt(f, client, 'wire-export-payload');
    const external = await realpath(await mkdtemp(join(tmpdir(), 's7-export-'))); cleanups.push(() => rm(external, { recursive: true, force: true }));
    const destination = join(external, `session.${format}`); const source = f.store.session(session).piPath; const before = await readFile(source);
    const renderer = vi.spyOn(f.root.runtime.session, format === 'html' ? 'exportToHtml' : 'exportToJsonl');
    const id = newRequestId(); const params = { format, destination };
    const response = await client.request('session.export', params, { session, id });
    expect(response).toMatchObject({ outcome: 'accepted', result: { destination } }); expect(renderer).toHaveBeenCalledOnce();
    const rendered = await readFile(destination, 'utf8');
    if (format === 'html') {
      expect(rendered).toContain('<!DOCTYPE html>');
      const encoded = /<script id="session-data" type="application\/json">([A-Za-z0-9+/=]+)<\/script>/.exec(rendered)?.[1];
      expect(encoded).toBeTruthy(); const data: unknown = JSON.parse(Buffer.from(encoded!, 'base64').toString('utf8'));
      expect(data).toMatchObject({ header: { id: session } }); expect(JSON.stringify(data)).toContain('wire-export-payload');
    } else {
      const rows: unknown[] = rendered.trim().split('\n').map(line => JSON.parse(line) as unknown);
      expect(rows[0]).toMatchObject({ type: 'session', id: session, cwd: f.cwd }); expect(JSON.stringify(rows)).toContain('wire-export-payload');
    }
    expect(await readFile(source)).toEqual(before);
    const retry = await f.client(); expect(await retry.request('session.export', params, { session, id })).toEqual(response);
    expect(renderer).toHaveBeenCalledOnce(); expect(await readFile(destination, 'utf8')).toBe(rendered);
    const denied = await client.request('session.export', { ...params, destination: source }, { session });
    expect(denied).toMatchObject({ outcome: 'rejected', error: { code: 'forbidden' } });
    expect(renderer).toHaveBeenCalledOnce(); expect(await readFile(source)).toEqual(before);
  });

  it('rejects every supported non-hello operation before negotiation without any admitted effect', async () => {
    const f = await fixture(); const before = f.store.snapshot(); const bytes = await readFile(f.store.session(f.root.sessionId).piPath);
    const cases = supportedRequests(f);
    expect(new Set(cases.map(row => row.op)).size).toBe(37);
    for (const request of cases) {
      const peer = await f.raw();
      expect(await peer.exchange({ v: 1, id: newRequestId(), ...request })).toMatchObject({ outcome: 'rejected', error: { code: 'forbidden' } });
      peer.socket.destroy();
    }
    expect(f.store.snapshot()).toEqual(before); expect(await readFile(f.store.session(f.root.sessionId).piPath)).toEqual(bytes);
  });

  it('enforces session attachment apart from explicit local-console recovery operations', async () => {
    const f = await fixture(); const before = f.store.snapshot(); const bytes = await readFile(f.store.session(f.root.sessionId).piPath);
    const cases = supportedRequests(f); const tui = await f.raw(); const acp = await f.raw();
    for (const [peer, kind] of [[tui, 'tui'], [acp, 'acp']] as const) {
      expect(await peer.exchange({ v: 1, id: newRequestId(), op: 'hello', params: { clientVersion: 'fixture', protocol: 1, kind,
        interactionKinds: [], target: protocolTarget(f.owner.target) } })).toMatchObject({ outcome: 'accepted' });
    }
    for (const peer of [tui, acp]) {
      for (const request of cases.filter(row => row.session && !['attach', 'session.delete', 'session.reload'].includes(row.op))) {
        expect(await peer.exchange({ v: 1, id: newRequestId(), ...request })).toMatchObject({ outcome: 'rejected', error: { code: 'forbidden' } });
      }
    }
    expect(f.store.snapshot()).toEqual(before); expect(await readFile(f.store.session(f.root.sessionId).piPath)).toEqual(bytes);
  });
  it('negotiates actual capabilities and serves the completed client without a second runtime writer', async () => {
    const f = await fixture(); const a = await f.client(); const b = await f.client(); const id = f.root.sessionId;
    expect(a.identity).toEqual(f.owner.identity);
    expect(a.capabilities?.operations).toEqual(expect.arrayContaining(['prompt', 'fork', 'config.set', 'steer', 'queue.clear']));
    for (const operation of ['queue.update', 'host.stop', 'interaction.answer']) expect(a.capabilities?.operations).not.toContain(operation);
    expect((await a.attach(id)).outcome).toBe('accepted'); expect((await b.attach(id)).outcome).toBe('accepted');
    expect(f.registry.attachmentCount(id)).toBe(2);
    expect((await a.request('sessions.list', {})).outcome).toBe('accepted');
    const renamed = await a.request('session.rename', { name: 'both viewers' }, { session: id });
    expect(renamed.outcome).toBe('accepted');
    await vi.waitFor(() => expect(b.getAttachment(id)?.state.snapshot?.title).toBe('both viewers'));
    expect(a.getAttachment(id)?.state.status).toBe('live'); expect(b.getAttachment(id)?.state.status).toBe('live');
    expect(f.registry.binding(id)).toBe(f.root);
  });

  it('persists outcomes across a detach and a new connection without cancelling or replaying a long turn', async () => {
    const entered = gate(); const release = gate(); let turns = 0;
    const f = await fixture({ onStream: async () => { turns++; entered.resolve(); await release.promise; }, release: release.resolve });
    const a = await f.client(); const id = f.root.sessionId; await a.attach(id);
    const cancel = vi.spyOn(f.registry, 'cancel'); const request = newRequestId();
    const first = await a.request('prompt', { text: 'one effect' }, { session: id, id: request });
    expect(first.outcome).toBe('accepted'); await entered.promise;
    a.close();
    const b = await f.client();
    const retry = await b.request('prompt', { text: 'one effect' }, { session: id, id: request });
    expect(retry).toEqual(first); expect(turns).toBe(1); expect(cancel).not.toHaveBeenCalled();
    await b.attach(id);
    release.resolve();
    await vi.waitFor(() => expect(b.getAttachment(id)?.state.snapshot?.run.state).toBe('idle'));
    expect(b.getAttachment(id)?.state.snapshot?.history.entries.filter(entry => entry.role === 'user')).toHaveLength(1);
  });

  it('serializes global field merges and exposes real model/history/tree operations', async () => {
    const f = await fixture(); const client = await f.client(); const id = f.root.sessionId; await client.attach(id);
    expect((await client.request('config.set', { scope: 'global', values: { autoCompact: true } })).outcome).toBe('accepted');
    expect((await client.request('config.set', { scope: 'global', values: { autoCompact: false } })).outcome).toBe('accepted');
    const configured = await client.request('config.get', { scope: 'global' });
    expect(configured).toMatchObject({ outcome: 'accepted', result: { values: { autoCompact: false } } });
    expect((await client.request('config.set', { scope: 'project', values: { autoCompact: true } })).outcome).toBe('rejected');
    expect((await client.request('set_thinking', { thinking: 'off' }, { session: id })).outcome).toBe('accepted');
    expect((await client.request('set_model', { provider: 'offline', id: 'fixture' }, { session: id })).outcome).toBe('accepted');
    expect((await client.request('prompt', { text: 'history' }, { session: id })).outcome).toBe('accepted');
    await vi.waitFor(() => expect(client.getAttachment(id)?.state.snapshot?.history.entries.filter(entry => entry.role === 'assistant')).toHaveLength(1));
    await vi.waitFor(() => expect(client.getAttachment(id)?.state.snapshot?.run.state).toBe('idle'));
    expect(client.getAttachment(id)?.state.snapshot?.history.entries.filter(entry => entry.role === 'user')).toHaveLength(1);
    const snapshot = client.getAttachment(id)!.state.snapshot!;
    expect((await client.request('session.history', { revision: snapshot.revision, branch: snapshot.branch }, { session: id })).outcome).toBe('accepted');
    expect((await client.request('session.tree', {}, { session: id })).outcome).toBe('accepted');
    expect(await client.request('session.history', { revision: 0, branch: snapshot.branch }, { session: id })).toMatchObject({ outcome: 'rejected', error: { code: 'resync_required' } });
    const page = await client.request('session.history', { revision: snapshot.revision, branch: snapshot.branch, limit: 1 }, { session: id });
    expect(page.outcome).toBe('accepted'); if (page.outcome === 'accepted') expect(page.result.entries).toHaveLength(1);
  });

  it.each([false, true])('clears native input and custom messages during streaming (lost observation: %s)', async lost => {
    const entered = gate(); const release = gate();
    const f = await fixture({ onStream: async () => { entered.resolve(); await release.promise; }, release: release.resolve });
    const client = await f.client(); const session = f.root.sessionId; await client.attach(session);
    await client.request('prompt', { text: 'streaming' }, { session }); await entered.promise;
    await client.request('steer', { text: 'restore me' }, { session });
    await vi.waitFor(() => expect(client.getAttachment(session)?.state.snapshot?.queue).toHaveLength(1));
    const runtime = f.root.runtime.session; const clear = vi.spyOn(runtime.agent, 'clearAllQueues');
    for (let index = 0; index < (lost ? LIMITS.pageEntries : 1); index++) runtime.agent.followUp({ role: 'custom', customType: 'test', content: 'custom', display: lost, timestamp: index });
    expect(f.registry.projection(session).canObserveQueue).toBe(!lost);
    expect(await client.request('queue.clear', {}, { session })).toMatchObject({ outcome: 'accepted', result: { steering: ['restore me'], followUp: [] } });
    expect(clear).toHaveBeenCalledOnce(); expect(runtime.agent.hasQueuedMessages()).toBe(false);
    await vi.waitFor(() => expect(client.getAttachment(session)?.state.snapshot?.queue).toEqual([]));
    release.resolve(); await vi.waitFor(() => expect(f.store.session(session).run.state).toBe('idle'));
    expect(runtime.sessionManager.getEntries().filter(entry => entry.type === 'message' && entry.message.role === 'user')).toHaveLength(1);
  });

  it.each(['items', 'encoded bytes'] as const)('rejects queue.clear exceeding protocol %s without clearing native or held input', async limit => {
    const f = await compactingFixture(); const { client, session } = f; const runtime = f.root.runtime.session;
    await runtime.steer('native retained'); await client.request('follow_up', { text: 'held retained' }, { session });
    const clear = vi.spyOn(runtime, 'clearQueue'); const before = f.registry.projection(session).snapshot().queue;
    const messages = vi.spyOn(runtime, 'getSteeringMessages').mockReturnValue(limit === 'items'
      ? Array.from({ length: LIMITS.pageEntries }, () => 'native retained') : ['"'.repeat(LIMITS.pageBytes / 4)]);
    expect(await client.request('queue.clear', {}, { session })).toMatchObject({ outcome: 'rejected', error: {
      code: 'unavailable', message: 'Queued input exceeds protocol limits; nothing was cleared.',
    } });
    expect(clear).not.toHaveBeenCalled(); messages.mockRestore();
    expect(runtime.getSteeringMessages()).toEqual(['native retained']);
    expect(f.registry.projection(session).snapshot().queue).toEqual(before);
    await client.request('queue.clear', {}, { session });
    f.release(); await vi.waitFor(() => expect(f.store.session(session).run.state).toBe('idle'));
  });

  it('keeps targeted queue edits unavailable and observes actual enqueue IDs', async () => {
    const f = await fixture(); const client = await f.client(); const id = f.root.sessionId; await client.attach(id);
    const queued = await client.request('steer', { text: 'later' }, { session: id });
    expect(queued).toMatchObject({ outcome: 'accepted', result: { itemId: expect.any(String) } });
    await vi.waitFor(() => expect(client.getAttachment(id)?.state.snapshot?.queue).toHaveLength(1));
    if (queued.outcome === 'accepted' && 'itemId' in queued.result) expect(client.getAttachment(id)?.state.snapshot?.queue[0]?.id).toBe(queued.result.itemId);
    const snapshot = client.getAttachment(id)!.state.snapshot!;
    expect(await client.request('queue.update', { kind: 'steer', expectedRevision: snapshot.revision, edits: [{ op: 'remove', id: snapshot.queue[0]!.id }] }, { session: id }))
      .toMatchObject({ outcome: 'rejected', error: { code: 'unsupported_operation' } });
    expect(f.root.runtime.session.agent.hasQueuedMessages()).toBe(true); f.root.runtime.session.clearQueue();
  });

  it.each(['steer', 'follow_up'] as const)('accepts native handled %s input and durably retries without a queue ID or a second effect', async op => {
    const handled = vi.fn();
    const f = await fixture({ extension: pi => { pi.on('input', async event => { handled(event.text); return { action: 'handled' }; }); } });
    const a = await f.client(); const session = f.root.sessionId; await a.attach(session);
    const id = newRequestId(); const params = { text: 'ordinary input, consumed by the extension' };
    const response = await a.request(op, params, { session, id });
    expect(response).toEqual({ v: 1, re: id, outcome: 'accepted', result: { status: 'handled' } });
    expect(f.store.snapshot().requests.find(row => row.id === id)).toMatchObject({ phase: 'terminal', response });
    expect(handled).toHaveBeenCalledExactlyOnceWith(params.text);
    expect(f.root.runtime.session.agent.hasQueuedMessages()).toBe(false);
    expect(f.registry.projection(session).snapshot().queue).toEqual([]);
    a.close();
    const b = await f.client();
    expect(await b.request(op, params, { session, id })).toEqual(response);
    expect(handled).toHaveBeenCalledOnce();
    expect(f.registry.projection(session).snapshot().queue).toEqual([]);
    expect(f.registry.projection(session).snapshot().presentation.some(row => row.id === 'run-error')).toBe(false);
  });

  it('deletes an open idle session over the wire and only its managed transcript', async () => {
    const f = await fixture(); const client = await f.client(); const session = f.root.sessionId; await client.attach(session);
    await completedPrompt(f, client, 'delete me');
    const path = f.store.session(session).piPath; const id = newRequestId();
    const response = await client.request('session.delete', {}, { session, id });
    expect(response.outcome).toBe('accepted'); expect(f.store.session(session).deletedAt).toEqual(expect.any(Number));
    await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await client.request('session.delete', {}, { session, id })).toEqual(response);
    expect(await client.request('prompt', { text: 'must not restore' }, { session })).toMatchObject({ outcome: 'rejected', error: { code: 'not_found' } });
    const viewer = await f.client();
    expect(await viewer.attach(session)).toMatchObject({ outcome: 'rejected', error: { code: 'not_found' } });
    const listed = await client.request('sessions.list', {});
    if (listed.outcome !== 'accepted') throw new Error('Deleted-session inventory failed');
    expect(listed.result.entries.some(row => row.session === session)).toBe(false);
  });

  it('deleting a root tombstones its descendants and removes their transcripts', async () => {
    const f = await fixture(); const client = await f.client(); const session = f.root.sessionId; await client.attach(session);
    await completedPrompt(f, client, 'parent transcript');
    const child = await f.registry.create({ cwd: f.cwd, target: { kind: 'new' }, parentSessionId: session, rootSessionId: session, model: f.root.runtime.session.model! });
    const grandchild = await f.registry.create({ cwd: f.cwd, target: { kind: 'new' }, parentSessionId: child.sessionId, rootSessionId: session, model: f.root.runtime.session.model! });
    const ids = [session, child.sessionId, grandchild.sessionId]; const paths = ids.map(id => f.store.session(id).piPath);
    for (const path of paths.slice(1)) await writeFile(path, '{}\n', { flag: 'a' });
    expect(await client.request('session.delete', {}, { session })).toMatchObject({ outcome: 'accepted' });
    for (const id of ids) expect(f.store.session(id)).toMatchObject({ deletedAt: expect.any(Number), state: 'closed', residency: 'evicted' });
    for (const path of paths) await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' });
    const listed = await client.request('sessions.list', {});
    if (listed.outcome !== 'accepted') throw new Error('Deleted-session inventory failed');
    expect(listed.result.entries.filter(row => ids.includes(row.session))).toEqual([]);
  });

  it('rebuilds a quiescent root through the current service factory and preserves attachment recovery', async () => {
    const f = await fixture(); const client = await f.client(); const session = f.root.sessionId; await client.attach(session);
    const original = f.registry.binding(session); const services = vi.spyOn(f.registry.options, 'services');
    expect(await client.request('session.reload', {}, { session })).toMatchObject({ outcome: 'accepted' });
    expect(services).toHaveBeenCalledOnce(); expect(f.registry.binding(session)).not.toBe(original);
    expect(f.store.session(session).piPath).toBe(original!.runtime.session.sessionManager.getSessionFile());
    await vi.waitFor(() => expect(client.getAttachment(session)?.state.status).toBe('live'));
  });

  it('imports an unregistered legacy file into a new ID without changing or adopting its source', async () => {
    const f = await fixture(); const client = await f.client();
    await chmod(f.root.resources.sessionDir, 0o755);
    const source = join(f.directory, 'external.jsonl'); const oldId = 'unregistered-import-source';
    const bytes = JSON.stringify({ type: 'session', version: 3, id: oldId, cwd: f.cwd }) + '\n'; await writeFile(source, bytes);
    const response = await client.request('session.import', { path: source, cwd: f.cwd });
    expect(response.outcome).toBe('accepted');
    if (response.outcome !== 'accepted') throw new Error('Import failed');
    expect(response.result.sessionId).not.toBe(oldId); expect(await readFile(source, 'utf8')).toBe(bytes);
    expect(f.store.snapshot().sessions.some(row => row.id === oldId)).toBe(false);
    expect((await stat(join(f.root.resources.sessionDir, '.felan-import'))).mode & 0o777).toBe(0o700);
  });

  it('reads verified detached metadata as arbitrary bytes without starting or signaling its process', async () => {
    const f = await fixture({ processAdapter: fakeProcessAdapter() }); const client = await f.client(); const session = f.root.sessionId; await client.attach(session);
    const storage = f.root.agentRuntime.storage('session'); const id = 'bash-20260101000000-abcdef';
    const jobDir = join(storage.root, 'background-bash', id); await storage.mkdir(jobDir, { recursive: true });
    const info = { id, jobDir, infoPath: join(jobDir, 'info.json'), logPath: join(jobDir, 'output.log'), runnerPath: join(jobDir, 'runner.sh'),
      processToken: 'synthetic-token', command: 'never executed', executionMode: 'detached', status: 'completed', exitCode: 0, startedAt: Date.now() };
    await storage.writeFile(info.logPath, new Uint8Array([0, 255, 195, 40]));
    await storage.writeFile(info.infoPath, new TextEncoder().encode(JSON.stringify(info)));
    expect(await client.request('processes.read', { root: session, resourceId: id, offset: 1, limit: 2 }, { session }))
      .toMatchObject({ outcome: 'accepted', result: { data: '/8M=', offset: 1, nextOffset: 3, state: 'exited' } });
    await writeFile(info.infoPath, JSON.stringify({ ...info, processToken: 'foreign' }));
    expect((await client.request('processes.read', { root: session, resourceId: id, offset: 0, limit: 4 }, { session })).outcome).toBe('rejected');
  });

  it('clones a quiescent source without changing its file or attaching to the new root', async () => {
    const f = await fixture(); const client = await f.client(); const id = f.root.sessionId; await client.attach(id);
    const file = f.store.session(id).piPath; const before = await readFile(file);
    const result = await client.request('session.clone', {}, { session: id });
    expect(result.outcome).toBe('accepted');
    if (result.outcome !== 'accepted') throw new Error('Clone failed');
    expect(result.result.sessionId).not.toBe(id); expect(f.store.session(result.result.sessionId).root).toBe(result.result.sessionId);
    expect(await readFile(file)).toEqual(before); expect(client.getAttachment(result.result.sessionId)).toBeUndefined();
  });

  it('uses a retained shell handle for binary reads/stdin and records explicit context exclusion', async () => {
    const f = await fixture(); const shell = syntheticShell(f); const client = await f.client(); const id = f.root.sessionId; await client.attach(id);
    try {
      const run = await client.request('shell.execute', { command: 'synthetic-shell', includeInContext: false }, { session: id });
      expect(run.outcome).toBe('accepted'); if (run.outcome !== 'accepted') throw new Error('Shell failed');
      const resourceId = run.result.resourceId;
      expect(await client.request('processes.read', { root: id, resourceId, offset: 0, limit: 4 }, { session: id }))
        .toMatchObject({ outcome: 'accepted', result: { data: 'QQD/Cg==', offset: 0, nextOffset: 4 } });
      expect(await client.request('processes.write', { root: id, resourceId, data: '/wAD' }, { session: id }))
        .toMatchObject({ outcome: 'accepted', result: { writtenBytes: 3 } });
      expect(shell.input).toEqual([new Uint8Array([255, 0, 3])]);
      shell.finish(); await vi.waitFor(() => expect(f.store.session(id).run.state).toBe('idle'));
      const entry = f.root.runtime.session.sessionManager.getEntries().find(entry => entry.type === 'message' && entry.message.role === 'bashExecution');
      expect(entry?.type === 'message' && entry.message.role === 'bashExecution' && entry.message.excludeFromContext).toBe(true);
      expect(shell.start).toHaveBeenCalledOnce();
    } finally { shell.finish(); }
  });

  it('cancels a foreground shell without waiting on its own cancellation writer', async () => {
    const f = await fixture(); const shell = syntheticShell(f); const client = await f.client(); const id = f.root.sessionId; await client.attach(id);
    try {
      const run = await client.request('shell.execute', { command: 'synthetic-shell', includeInContext: true }, { session: id });
      expect(run.outcome).toBe('accepted'); if (run.outcome !== 'accepted') throw new Error('Shell failed');
      expect(await client.request('cancel', { runId: run.result.runId }, { session: id })).toMatchObject({ outcome: 'accepted' });
      expect(f.store.session(id).run.state).toBe('idle');
    } finally { shell.finish(); }
  });

  it('closes a session with a live foreground process and retains the authoritative close outcome', async () => {
    const f = await fixture(); const shell = syntheticShell(f); const client = await f.client(); const id = f.root.sessionId; await client.attach(id);
    try {
      expect((await client.request('shell.execute', { command: 'synthetic-shell', includeInContext: false }, { session: id })).outcome).toBe('accepted');
      const request = newRequestId(); const closed = await client.request('close', {}, { session: id, id: request });
      expect(closed.outcome).toBe('accepted'); expect(f.store.session(id).state).toBe('closed');
      const retry = await f.client(); expect(await retry.request('close', {}, { session: id, id: request })).toEqual(closed);
      expect(f.registry.binding(id)).toBeUndefined();
    } finally { shell.finish(); }
  });

  it('applies one label edit and selects its branch without revision preconditions', async () => {
    const f = await fixture(); const client = await f.client(); const id = f.root.sessionId; await client.attach(id);
    await client.request('prompt', { text: 'label target' }, { session: id });
    await vi.waitFor(() => expect(client.getAttachment(id)?.state.snapshot?.run.state).toBe('idle'));
    const entry = f.root.runtime.session.sessionManager.getEntries().find(entry => entry.type === 'message' && entry.message.role === 'user')!;
    expect(await client.request('session.entry.label', { entryId: entry.id, label: 'one' }, { session: id }))
      .toMatchObject({ outcome: 'accepted' });
    expect(f.root.runtime.session.sessionManager.getLabel(entry.id)).toBe('one');
    expect(f.root.runtime.session.sessionManager.getEntries().filter(entry => entry.type === 'label')).toHaveLength(1);
    expect(await client.request('session.branch.select', { entryId: entry.id }, { session: id })).toMatchObject({ outcome: 'accepted' });
  });

  it('delivers the committed label outcome before intentionally disconnecting for resnapshot', async () => {
    const f = await fixture(); const client = await f.client(); const session = f.root.sessionId; await client.attach(session);
    await completedPrompt(f, client, 'raw label target');
    const peer = await f.raw();
    await peer.exchange({ v: 1, id: newRequestId(), op: 'hello', params: { clientVersion: 'fixture', protocol: 1, kind: 'tui', interactionKinds: [], target: protocolTarget(f.owner.target) } });
    const attached = await peer.exchange({ v: 1, id: newRequestId(), op: 'attach', session, params: { expected: f.owner.identity } });
    expect(attached.outcome).toBe('accepted');
    const entry = f.root.runtime.session.getUserMessagesForForking()[0]!;
    const closed = new Promise<'closed'>(resolve => peer.socket.once('close', () => resolve('closed')));
    const id = newRequestId(); const response = peer.exchange({ v: 1, id, op: 'session.entry.label', session,
      params: { entryId: entry.entryId, label: 'wire label' } });
    expect(await Promise.race([response, closed])).toMatchObject({ re: id, outcome: 'accepted' });
    expect(await closed).toBe('closed');
  });

  it.each(['tui', 'acp'] as const)('requires explicit strict policy rather than the %s connection kind', async kind => {
    const f = await fixture(); const client = await f.client(kind); const id = f.root.sessionId;
    expect((await client.attach(id)).outcome).toBe('accepted');
    expect(f.registry.getPolicy(id).mode).toBe('host-default');
    await client.detach(id);
    expect((await client.attach(id, { requirePolicy: 'acp-strict' })).outcome).toBe('accepted');
    expect(f.registry.getPolicy(id).mode).toBe('acp-strict');
    expect(client.capabilities?.operations).toContain('command.invoke');
    expect((await client.request('prompt', { text: 'strict' }, { session: id })).outcome).toBe('accepted');
    await vi.waitFor(() => expect(f.store.session(id).run.origin?.kind).toBe(kind));
    client.close(); expect(f.registry.getPolicy(id).mode).toBe('acp-strict');
  });

  it('routes the injected broker port with verified identity and leaves arbitration outside this slice', async () => {
    const called = vi.fn();
    const f = await fixture({ broker: { interactionKinds: ['confirm'], dispatch(command, client) {
      return { response: command.dispatch(() => { called(client); return accepted(command.request, {}); }) };
    } } });
    const client = await f.client();
    expect(await client.request('interaction.answer', { interactionId: 'synthetic', answer: { kind: 'confirm', confirmed: true } }))
      .toMatchObject({ outcome: 'accepted' });
    expect(called).toHaveBeenCalledWith(expect.objectContaining({ principal: f.server.principal, kind: 'tui' }));
  });

  it('dispatches only registered typed commands and does not duplicate them on another connection', async () => {
    const calls: string[] = [];
    const f = await fixture({ extension: pi => { pi.registerCommand('synthetic-command', { description: 'Synthetic command', handler: async args => { calls.push(args); } }); } });
    const a = await f.client(); const b = await f.client(); const id = f.root.sessionId; await a.attach(id);
    expect(a.getAttachment(id)?.state.snapshot?.catalog.commands).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'synthetic-command' })]));
    const request = newRequestId();
    const response = await a.request('command.invoke', { name: 'synthetic-command', arguments: 'literal arguments' }, { session: id, id: request });
    expect(response.outcome).toBe('accepted');
    expect(await b.request('command.invoke', { name: 'synthetic-command', arguments: 'literal arguments' }, { session: id, id: request })).toEqual(response);
    expect(calls).toEqual(['literal arguments']);
    expect(await a.request('command.invoke', { name: 'quit', arguments: '' }, { session: id })).toMatchObject({ outcome: 'rejected', error: { code: 'unavailable' } });
  });

  it('resynchronizes a different attached session when admission prunes its committed resources', async () => {
    let now = Date.now() - 8 * 24 * 60 * 60 * 1000;
    const f = await fixture({ now: () => now });
    const other = await f.registry.create({ cwd: f.cwd, target: { kind: 'new' }, model: f.root.runtime.session.model! });
    f.store.putResource({ id: 'expired', root: other.sessionId, session: other.sessionId, kind: 'foreground', state: 'exited', updatedAt: now });
    now = Date.now();
    const client = await f.client(); await client.attach(other.sessionId);
    expect(client.getAttachment(other.sessionId)?.state.snapshot?.processes).toHaveLength(1);
    const mutator = await f.client();
    expect((await mutator.request('config.set', { scope: 'global', values: { autoCompact: true } })).outcome).toBe('accepted');
    await vi.waitFor(() => expect(client.getAttachment(other.sessionId)?.state.snapshot?.processes).toHaveLength(0));
    expect(client.getAttachment(other.sessionId)?.state.status).toBe('live');
    expect(f.store.snapshot().resources.some(resource => resource.id === 'expired')).toBe(false);
  });

  it('rejects forged targets, unattached commands, raw obsolete CAS and conflicting retries', async () => {
    const f = await fixture(); const peer = await f.raw();
    const hello = await peer.exchange({ v: 1, id: 'hello', op: 'hello', params: { clientVersion: 'fixture', protocol: 1, kind: 'tui', interactionKinds: [], target: protocolTarget(f.owner.target) } });
    expect(hello.outcome).toBe('accepted');
    expect(await peer.exchange({ v: 1, id: newRequestId(), op: 'prompt', session: f.root.sessionId, params: { text: 'not attached' } }))
      .toMatchObject({ outcome: 'rejected', error: { code: 'forbidden' } });
    expect(await peer.exchange({ v: 1, id: newRequestId(), op: 'config.set', params: { scope: 'global', values: { autoCompact: true }, expectedRevision: 1 } }))
      .toMatchObject({ outcome: 'rejected', error: { code: 'invalid_request' } });
    const id = newRequestId();
    expect((await peer.exchange({ v: 1, id, op: 'config.set', params: { scope: 'global', values: { autoCompact: true } } })).outcome).toBe('accepted');
    expect(await peer.exchange({ v: 1, id, op: 'config.set', params: { scope: 'global', values: { autoCompact: false } } }))
      .toMatchObject({ outcome: 'rejected', error: { code: 'request_conflict' } });
    expect(await peer.exchange({ v: 1, id: newRequestId(), op: 'attach', session: f.root.sessionId, params: { expected: { ...f.owner.identity, instanceId: 'forged' } } }))
      .toMatchObject({ outcome: 'rejected', error: { code: 'target_mismatch' } });
    expect(await peer.exchange({ v: 1, id: newRequestId(), op: 'interaction.answer', params: { interactionId: 'none', answer: { kind: 'confirm', confirmed: true } } }))
      .toMatchObject({ outcome: 'rejected', error: { code: 'unavailable' } });
  });

  it('returns the typed mismatch/control identity without performing host management', async () => {
    const f = await fixture(); const peer = await f.raw();
    expect(await peer.exchange({ v: 2, id: 'mismatch', op: 'hello', params: { protocol: 2, clientVersion: 'future' } }))
      .toMatchObject({ control: 1, re: 'mismatch', outcome: 'mismatch', supportedProtocol: 1, identity: f.owner.identity });
    expect(await peer.exchange({ control: 1, id: 'status', op: 'host.status', params: { expected: f.owner.identity } }))
      .toMatchObject({ outcome: 'accepted', state: 'ready' });
    expect(await peer.exchange({ control: 1, id: newRequestId(), op: 'host.stop', params: { expected: f.owner.identity, mode: 'drain' } }))
      .toMatchObject({ outcome: 'rejected', error: { code: 'unavailable' } });
  });
});
