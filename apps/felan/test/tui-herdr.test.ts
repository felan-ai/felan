import { createServer, type Server } from 'node:net';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { Execution, Interaction, SessionSnapshot } from '@felan-ai/session-protocol';
import { HerdrPane, createHerdrPane, herdrSocketEndpoint, herdrStatus, reportHerdrPane, sendHerdrRequest, type HerdrRequest } from '../src/tui/herdr.js';
import { snapshot } from './client-fixtures.js';

const environment = { HERDR_ENV: '1', HERDR_PANE_ID: 'w1:p1', HERDR_SOCKET_PATH: '/tmp/herdr.sock' };
const session = (overrides: Partial<SessionSnapshot> = {}): SessionSnapshot => ({ ...snapshot(), ...overrides });
const interaction = (request: Interaction['request'], state: 'waiting' | 'deferred' = 'waiting'): Interaction => ({ id: `i-${request.kind}`,
  scope: { kind: 'session', session: 'session', root: 'session' }, request, createdAt: 1, ...(state === 'deferred' ? { state, expiresAt: 2 } : { state }) }) as Interaction;
const execution = (overrides: Partial<Execution>): Execution => ({ id: 'agent', state: 'completed', ...overrides });

function recorder() {
  const requests: HerdrRequest[] = [];
  return { requests, send: vi.fn(async (request: HerdrRequest) => { requests.push(request); }),
    sent: () => requests.map(request => request.method === 'pane.report_agent_session'
      ? `session ${String(request.params.agent_session_id)}` : `${String(request.params.state)}${request.params.message ? ` ${String(request.params.message)}` : ''}`) };
}

describe('Herdr pane reporting', () => {
  it('is enabled only for an interactive terminal with the complete Herdr environment', () => {
    expect(createHerdrPane({ environment, isInteractive: true })).toBeInstanceOf(HerdrPane);
    expect(createHerdrPane({ environment, isInteractive: false })).toBeUndefined();
    expect(createHerdrPane({ environment: { HERDR_ENV: '1', HERDR_PANE_ID: 'w1:p1' }, isInteractive: true })).toBeUndefined();
    expect(createHerdrPane({ environment: { ...environment, HERDR_ENV: '0' }, isInteractive: true })).toBeUndefined();
  });

  it('derives working from the run and pending subagent work, and blocked from prompts waiting for the user', () => {
    expect(herdrStatus(undefined, [], [])).toEqual({ state: 'idle' });
    expect(herdrStatus(session(), [], [execution({})])).toEqual({ session: 'session', state: 'idle' });
    for (const state of ['running', 'waiting', 'cancelling'] as const) expect(herdrStatus(session({ run: { state, id: 'run' } }), [], []).state).toBe('working');
    expect(herdrStatus(session({ run: { state: 'interrupted' } }), [], []).state).toBe('idle');
    expect(herdrStatus(session(), [], [execution({ state: 'queued' })]).state).toBe('working');
    expect(herdrStatus(session(), [], [execution({ parent: 'child', state: 'running' })]).state).toBe('working');
    expect(herdrStatus(session(), [], [execution({ parent: 'session', completionPending: true })]).state).toBe('working');
    expect(herdrStatus(session(), [], [execution({ parent: 'child', completionPending: true })]).state).toBe('idle');
    const running = session({ run: { state: 'running', id: 'run' } });
    expect(herdrStatus(running, [interaction({ kind: 'confirm', title: 'Approve plan', message: '' })], []))
      .toEqual({ session: 'session', state: 'blocked', message: 'Approve plan' });
    expect(herdrStatus(session(), [interaction({ kind: 'tool_approval', toolCallId: 'call', toolName: 'bash', summary: '', options: [{ id: 'yes', title: 'Yes' }] }, 'deferred')], []))
      .toMatchObject({ state: 'blocked', message: 'Approve bash' });
    expect(herdrStatus(session(), [interaction({ kind: 'form', form: { title: 'Questions' } } as never)], []))
      .toMatchObject({ state: 'blocked', message: 'Questions' });
    expect(herdrStatus(session(), [{ ...interaction({ kind: 'input', title: 'Name' }), state: 'cancelled', resolvedAt: 2, result: { cancelled: true, reason: 'user' } } as Interaction], []).state).toBe('idle');
  });

  it('follows the attached session, listing descendant executions again whenever the execution generation changes', async () => {
    const herdr = recorder(); const listeners = new Set<() => void>();
    let rows: Execution[] = [execution({ id: 'grandchild', parent: 'child', state: 'running' })];
    let failing = false;
    const state = (id: string, generation: string) => ({ status: 'live', snapshot: { ...session(), session: id, executionsGeneration: generation } });
    const controller = {
      sessionId: 'one' as string | undefined, state: state('one', 'a') as { status: string; snapshot: SessionSnapshot } | undefined,
      get snapshot() { return this.state?.snapshot; },
      subscribe(listener: () => void) { listeners.add(listener); return () => listeners.delete(listener); },
      client: { capabilities: { operations: ['executions.list'] }, request: vi.fn(async (_op: string, params: { cursor?: string }) => {
        if (failing) return { outcome: 'rejected', error: { code: 'unavailable', message: 'down' } };
        return params.cursor ? { outcome: 'accepted', result: { items: rows.slice(1) } } : { outcome: 'accepted', result: { items: rows.slice(0, 1), ...(rows.length > 1 ? { nextCursor: 'page-2' } : {}) } };
      }) },
    };
    const emit = () => { for (const listener of listeners) listener(); };
    const stop = reportHerdrPane(controller as never, new HerdrPane('w1:p1', herdr.send), () => []);
    await vi.waitFor(() => expect(herdr.sent()).toEqual(['session one', 'working']));
    expect(controller.client.request).toHaveBeenCalledWith('executions.list', { includeDescendants: true, limit: 100 }, { session: 'one' });
    rows = [execution({ id: 'child', parent: 'one', completionPending: true }), execution({ id: 'grandchild', parent: 'child' })];
    controller.state = state('one', 'b'); emit();
    await vi.waitFor(() => expect(controller.client.request).toHaveBeenCalledTimes(3));
    rows = [execution({ id: 'child', parent: 'one' })];
    controller.state = state('one', 'c'); emit();
    await vi.waitFor(() => expect(herdr.sent()).toEqual(['session one', 'working', 'idle']));
    rows = [execution({ id: 'other', state: 'running' })]; failing = true;
    controller.sessionId = 'two'; controller.state = state('two', 'd'); emit();
    await vi.waitFor(() => expect(herdr.sent()).toEqual(['session one', 'working', 'idle', 'session two', 'idle']));
    stop(); controller.state = { ...state('two', 'd'), snapshot: { ...state('two', 'd').snapshot, run: { state: 'running', id: 'run' } } }; emit();
    await Promise.resolve();
    expect(herdr.sent()).toHaveLength(5);
  });

  it('announces the session before its state, reports only changes and re-announces a switched session', async () => {
    const herdr = recorder(); const pane = new HerdrPane('w1:p1', herdr.send);
    pane.update({ state: 'idle' });
    pane.update({ session: 'one', state: 'idle' });
    await vi.waitFor(() => expect(herdr.sent()).toEqual(['session one', 'idle']));
    pane.update({ session: 'one', state: 'working' });
    pane.update({ session: 'one', state: 'working' });
    await vi.waitFor(() => expect(herdr.sent()).toEqual(['session one', 'idle', 'working']));
    pane.update({ session: 'one', state: 'blocked', message: 'Approve plan' });
    await vi.waitFor(() => expect(herdr.sent()).toHaveLength(4));
    pane.update({ session: 'two', state: 'blocked', message: 'Approve plan' });
    pane.update({ state: 'idle' });
    await vi.waitFor(() => expect(herdr.sent()).toEqual(['session one', 'idle', 'working', 'blocked Approve plan', 'session two', 'idle']));
    const sequences = herdr.requests.map(request => request.params.seq as number);
    expect(sequences).toEqual([...sequences].sort((left, right) => left - right));
    expect(herdr.requests.at(-1)!.params).toMatchObject({ pane_id: 'w1:p1', source: 'herdr:felan', agent: 'felan', agent_session_id: 'two' });
  });

  it('keeps reporting after a failed delivery and coalesces states queued behind a slow one', async () => {
    let release!: () => void; const sent: string[] = [];
    const send = vi.fn(async (request: HerdrRequest) => {
      sent.push(String(request.params.state ?? 'session'));
      if (sent.length === 1) throw new Error('socket closed');
      if (sent.length === 2) await new Promise<void>(resolve => { release = resolve; });
    });
    const pane = new HerdrPane('w1:p1', send);
    pane.update({ session: 'one', state: 'working' });
    await vi.waitFor(() => expect(sent).toEqual(['session', 'working']));
    pane.update({ session: 'one', state: 'blocked' }); pane.update({ session: 'one', state: 'idle' });
    release();
    await vi.waitFor(() => expect(sent).toEqual(['session', 'working', 'idle']));
  });

  it('maps Windows socket markers to named pipes', () => {
    expect(herdrSocketEndpoint('herdr.sock', 'win32')).toBe('\\\\.\\pipe\\herdr.sock');
    expect(herdrSocketEndpoint('/tmp/herdr.sock', 'darwin')).toBe('/tmp/herdr.sock');
  });

  it('sends newline-delimited requests and retries after an unanswered attempt', async () => {
    const socketPath = join(tmpdir(), `felan-herdr-${process.pid}-${Date.now()}.sock`);
    const requests: string[] = [];
    let connections = 0;
    const server = createServer(socket => {
      connections += 1;
      let input = '';
      socket.setEncoding('utf8');
      socket.on('data', chunk => {
        input += chunk;
        const newline = input.indexOf('\n');
        if (newline < 0) return;
        requests.push(input.slice(0, newline));
        if (connections > 1) socket.end('{}\n');
      });
    });
    await listen(server, socketPath);
    try {
      await sendHerdrRequest(socketPath, { id: 'request-1', method: 'pane.report_agent', params: { pane_id: 'w1:p1', state: 'idle' } });
      expect(connections).toBe(2);
      expect(JSON.parse(requests[0]!)).toMatchObject({ method: 'pane.report_agent' });
      expect(requests[0]).toBe(requests[1]);
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      await rm(socketPath, { force: true });
    }
  }, 4_000);
});

async function listen(server: Server, path: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, resolve);
  });
}
