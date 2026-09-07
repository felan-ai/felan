import { createServer, type Server } from 'node:net';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createHerdrExtension,
  herdrSocketEndpoint,
  sendHerdrRequest,
  HERDR_EXTENSION_NAME,
} from '../src/herdr.js';

type Handler = (event: unknown, context: TestContext) => unknown;

interface TestContext {
  readonly mode: 'tui' | 'rpc';
  readonly isIdle: () => boolean;
  readonly sessionManager: {
    getSessionFile: () => string | undefined;
    getSessionId: () => string;
  };
}

describe('Herdr integration', () => {
  it('is hidden and inactive without the complete Herdr environment', () => {
    const extension = createHerdrExtension({
      environment: { HERDR_ENV: '1', HERDR_PANE_ID: 'w1:p1' },
    });
    const handlers = createHarness(extension);

    expect(extension).toMatchObject({ name: HERDR_EXTENSION_NAME, hidden: true });
    expect(handlers).toEqual({ handlers: new Map(), eventHandlers: new Map() });
  });

  it('reports session identity before initial state and ignores non-TUI sessions', async () => {
    const requests: RequestRecord[] = [];
    const extension = createHerdrExtension({
      environment: herdrEnvironment(),
      sendRequest: async (request) => { requests.push(request); },
    });
    const harness = createHarness(extension);
    const context = testContext({ idle: true, sessionId: 'session-new' });

    await harness.handlers.get('session_start')?.({ reason: 'startup' }, { ...context, mode: 'rpc' });
    expect(requests).toEqual([]);

    await harness.handlers.get('session_start')?.({ reason: 'new' }, context);
    expect(requests.map(({ method }) => method)).toEqual([
      'pane.report_agent_session',
      'pane.report_agent',
    ]);
    expect(requests[0]?.params).toMatchObject({
      pane_id: 'w1:p1',
      source: 'herdr:felan',
      agent: 'felan',
      agent_session_id: 'session-new',
      session_start_source: 'new',
    });
    expect(requests[1]?.params).toMatchObject({ state: 'idle', agent_session_id: 'session-new' });
    expect(requests[1]!.params.seq).toBeGreaterThan(requests[0]!.params.seq as number);
  });

  it('reports working and settles to idle, preserving session-before-state ordering', async () => {
    const requests: RequestRecord[] = [];
    const extension = createHerdrExtension({
      environment: herdrEnvironment(),
      sendRequest: async (request) => { requests.push(request); },
    });
    const harness = createHarness(extension);
    let idle = true;
    const context = testContext({ idle: true, sessionId: 'session-1', isIdle: () => idle });

    await harness.handlers.get('session_start')?.({ reason: 'startup' }, context);
    idle = false;
    await harness.handlers.get('agent_start')?.({}, { ...context, isIdle: () => idle });
    expect(requests.map(({ method, params }) => `${method}:${params.state ?? ''}`)).toEqual([
      'pane.report_agent_session:',
      'pane.report_agent:idle',
      'pane.report_agent_session:',
      'pane.report_agent:working',
    ]);

    idle = true;
    await harness.handlers.get('agent_settled')?.({}, { ...context, isIdle: () => idle });
    await waitFor(() => requests.at(-1)?.params.state === 'idle');
    expect(requests.at(-1)?.params).toMatchObject({ state: 'idle', agent_session_id: 'session-1' });
  });

  it('keeps blocked state authoritative until all blocking prompts close', async () => {
    const requests: RequestRecord[] = [];
    const extension = createHerdrExtension({
      environment: herdrEnvironment(),
      sendRequest: async (request) => { requests.push(request); },
    });
    const harness = createHarness(extension);
    const context = testContext({ idle: false, sessionId: 'session-2' });
    await harness.handlers.get('session_start')?.({ reason: 'startup' }, context);

    harness.eventHandlers.get('herdr:blocked')?.({ active: true, label: 'approval' }, context);
    harness.eventHandlers.get('herdr:blocked')?.({ active: true, label: 'question' }, context);
    await waitFor(() => requests.at(-1)?.params.state === 'blocked');
    expect(requests.at(-1)?.params.message).toBe('question');

    harness.eventHandlers.get('herdr:blocked')?.({ active: false }, context);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(requests.at(-1)?.params.state).toBe('blocked');

    harness.eventHandlers.get('herdr:blocked')?.({ active: false }, context);
    await waitFor(() => requests.at(-1)?.params.state === 'working');
  });

  it('maps Windows socket markers to named pipes', () => {
    expect(herdrSocketEndpoint('herdr.sock', 'win32')).toBe('\\\\.\\pipe\\herdr.sock');
    expect(herdrSocketEndpoint('/tmp/herdr.sock', 'darwin')).toBe('/tmp/herdr.sock');
  });

  it('sends newline-delimited requests and retries after an unanswered attempt', async () => {
    const socketPath = join(tmpdir(), `felan-herdr-${process.pid}-${Date.now()}.sock`);
    const requests: string[] = [];
    let connections = 0;
    const server = createServer((socket) => {
      connections += 1;
      let input = '';
      socket.setEncoding('utf8');
      socket.on('data', (chunk) => {
        input += chunk;
        const newline = input.indexOf('\n');
        if (newline < 0) return;
        requests.push(input.slice(0, newline));
        if (connections > 1) socket.end('{}\n');
      });
    });
    await listen(server, socketPath);
    try {
      await sendHerdrRequest(socketPath, {
        id: 'request-1',
        method: 'pane.report_agent',
        params: { pane_id: 'w1:p1', state: 'idle' },
      });
      expect(connections).toBe(2);
      expect(JSON.parse(requests[0]!)).toMatchObject({ method: 'pane.report_agent' });
      expect(requests[0]).toBe(requests[1]);
    } finally {
      await close(server);
      await rm(socketPath, { force: true });
    }
  }, 4_000);
});

interface RequestRecord {
  readonly method: string;
  readonly params: Record<string, unknown>;
}

function herdrEnvironment() {
  return { HERDR_ENV: '1', HERDR_PANE_ID: 'w1:p1', HERDR_SOCKET_PATH: '/tmp/herdr.sock' };
}

function testContext(options: {
  readonly idle: boolean;
  readonly sessionId?: string;
  readonly isIdle?: () => boolean;
}): TestContext {
  return {
    mode: 'tui',
    isIdle: options.isIdle ?? (() => options.idle),
    sessionManager: {
      getSessionFile: () => undefined,
      getSessionId: () => options.sessionId ?? 'session',
    },
  };
}

function createHarness(extension: ReturnType<typeof createHerdrExtension>) {
  const handlers = new Map<string, Handler>();
  const eventHandlers = new Map<string, (data: unknown) => void>();
  extension.factory({
    on(event: string, handler: Handler) { handlers.set(event, handler); },
    events: {
      on(event: string, handler: (data: unknown) => void) {
        eventHandlers.set(event, handler);
        return () => eventHandlers.delete(event);
      },
    },
  } as never);
  return { handlers, eventHandlers };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline && !predicate()) await new Promise((resolve) => setTimeout(resolve, 5));
  expect(predicate()).toBe(true);
}

async function listen(server: Server, path: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, resolve);
  });
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
