import {
  createExtensionServiceAccess,
  createFelanServiceRegistry,
  type ExecResult,
  type ExtensionContext,
  type FelanExtensionAPI,
  type ToolDefinition,
} from '@felan-ai/agent-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import extension from '../src/extension.js';
import {
  BROWSER_AUTHORIZATION_SERVICE,
  BROWSER_LIVE_VIEW_SERVICE,
  type BrowserAuthorizationService,
  type BrowserLiveViewService,
} from '../src/service.js';
import { BrowserTestRuntime, result } from './test-runtime.js';

const SESSION_ID = 'live-session';
const FIRST_PORT = 40_000;

describe('browser live view', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('declares the optional live-view contract beside authorization', () => {
    expect(BROWSER_LIVE_VIEW_SERVICE).toMatchObject({
      id: 'felan.browser.live-view', major: 1, key: 'felan.browser.live-view@1',
    });
    expect(extension.serviceRequirements.optional).toEqual([BROWSER_AUTHORIZATION_SERVICE, BROWSER_LIVE_VIEW_SERVICE]);
  });

  it.each([false, true])('runs no stream command without a live-view service (authorization: %s)', async withAuthorization => {
    const harness = createHarness({ authorization: withAuthorization });
    expect([...harness.tools.keys()]).toEqual(withAuthorization ? ['browser', 'browser_authorize'] : ['browser']);
    await harness.run(['open', 'https://example.com']);
    await harness.run(['snapshot', '-i']);
    await harness.run(['close']);
    await harness.run(['open', 'https://example.org']);
    await harness.emit('session_shutdown');
    expect(harness.commands()).toEqual(['open', 'snapshot', 'close', 'open', 'close']);
  });

  it('reports the owned stream port when the browser starts and again after the port changes', async () => {
    const liveView = createLiveView();
    const harness = createHarness({ liveView });

    await harness.run(['open', 'https://example.com']);
    expect(liveView.events).toEqual([['report', { sessionId: SESSION_ID, port: FIRST_PORT }]]);
    const open = harness.calls('open')[0]!;
    const status = harness.calls('stream')[0]!;
    expect(status.args.slice(0, 2)).toEqual(['stream', 'status']);
    expect(scope(status)).toEqual(scope(open));
    expect(status.args).toEqual(expect.arrayContaining(['--json', '--config']));
    expect(status.args).not.toContain('--cdp');

    await harness.run(['snapshot', '-i']);
    await harness.run(['click', '@e1']);
    expect(harness.calls('stream')).toHaveLength(1);

    harness.relaunchNextCommand();
    await harness.run(['snapshot', '-i']);
    expect(harness.calls('stream')).toHaveLength(2);
    expect(liveView.events).toHaveLength(1);

    harness.expireDaemons();
    await harness.run(['snapshot', '-i']);
    expect(harness.calls('stream')).toHaveLength(3);
    expect(liveView.events).toEqual([
      ['report', { sessionId: SESSION_ID, port: FIRST_PORT }],
      ['report', { sessionId: SESSION_ID, port: FIRST_PORT + 1 }],
    ]);
  });

  it('does not start a daemon for the port after a failed command', async () => {
    const liveView = createLiveView();
    const harness = createHarness({ liveView, fail: new Set(['open']) });
    await expect(harness.run(['open', 'https://example.com'])).rejects.toThrow('agent-browser failed');
    expect(harness.calls('stream')).toHaveLength(0);
    expect(liveView.events).toEqual([]);
  });

  it('reads the port again after a failed command that restarted the daemon', async () => {
    const liveView = createLiveView();
    const harness = createHarness({ liveView });
    await harness.run(['open', 'https://example.com']);
    harness.expireDaemons();
    harness.failures.add('click');
    await expect(harness.run(['click', '@e1'])).rejects.toThrow('agent-browser failed');
    harness.failures.clear();
    await harness.run(['snapshot', '-i']);
    expect(liveView.events).toEqual([
      ['report', { sessionId: SESSION_ID, port: FIRST_PORT }],
      ['report', { sessionId: SESSION_ID, port: FIRST_PORT + 1 }],
    ]);
  });

  it('rechecks but does not repeat an unchanged port after a failed command', async () => {
    const liveView = createLiveView();
    const harness = createHarness({ liveView });
    await harness.run(['open', 'https://example.com']);
    harness.failures.add('click');
    await expect(harness.run(['click', '@e9'])).rejects.toThrow('agent-browser failed');
    harness.failures.clear();
    await harness.run(['snapshot', '-i']);
    await harness.run(['click', '@e1']);
    expect(harness.calls('stream')).toHaveLength(2);
    expect(liveView.events).toEqual([['report', { sessionId: SESSION_ID, port: FIRST_PORT }]]);
  });

  it('withdraws the report even when the owned close fails', async () => {
    const liveView = createLiveView();
    const harness = createHarness({ liveView, fail: new Set(['close']) });
    await harness.run(['open', 'https://example.com']);
    await expect(harness.run(['close'])).rejects.toThrow('agent-browser failed');
    expect(liveView.events).toEqual([
      ['report', { sessionId: SESSION_ID, port: FIRST_PORT }],
      ['withdraw', { sessionId: SESSION_ID }],
    ]);
    harness.failures.clear();
    await harness.emit('session_shutdown');
    expect(liveView.events).toHaveLength(2);
  });

  it.each(['close', 'quit', 'exit'])('withdraws the report after the owned browser runs %s', async command => {
    const liveView = createLiveView();
    const harness = createHarness({ liveView });
    await harness.run(['open', 'https://example.com']);
    await harness.run([command]);
    expect(liveView.events.at(-1)).toEqual(['withdraw', { sessionId: SESSION_ID }]);
    expect(harness.calls('stream')).toHaveLength(1);

    await harness.run(['open', 'https://example.org']);
    expect(liveView.events).toEqual([
      ['report', { sessionId: SESSION_ID, port: FIRST_PORT }],
      ['withdraw', { sessionId: SESSION_ID }],
      ['report', { sessionId: SESSION_ID, port: FIRST_PORT + 1 }],
    ]);
    await harness.emit('session_shutdown');
    expect(liveView.events.at(-1)).toEqual(['withdraw', { sessionId: SESSION_ID }]);
  });

  it('withdraws on session shutdown and closes the browser', async () => {
    const liveView = createLiveView();
    const harness = createHarness({ liveView });
    await harness.run(['open', 'https://example.com']);
    await harness.emit('session_shutdown');
    expect(liveView.events).toEqual([
      ['report', { sessionId: SESSION_ID, port: FIRST_PORT }],
      ['withdraw', { sessionId: SESSION_ID }],
    ]);
    expect(harness.commands().at(-1)).toBe('close');
    expect(harness.calls('stream')).toHaveLength(1);
  });

  it('withdraws nothing on shutdown when no browser was reported', async () => {
    const liveView = createLiveView();
    const harness = createHarness({ liveView });
    await harness.emit('session_shutdown');
    expect(liveView.events).toEqual([]);
  });

  it('delivers the shutdown withdrawal after a report that is still in flight', async () => {
    const order: string[] = [];
    const reported = deferred<void>();
    const liveView: BrowserLiveViewService = {
      report: async () => { order.push('report started'); await reported.promise; order.push('report finished'); },
      withdraw: () => { order.push('withdraw'); },
    };
    const harness = createHarness({ liveView });
    const running = harness.run(['open', 'https://example.com']);
    await vi.waitFor(() => expect(order).toEqual(['report started']));
    const shutdown = harness.emit('session_shutdown');
    reported.resolve();
    await Promise.all([running, shutdown]);
    expect(order).toEqual(['report started', 'report finished', 'withdraw']);
  });

  it('closes the browser on shutdown while the host withdrawal is pending', async () => {
    const withdrawn = deferred<void>();
    const liveView: BrowserLiveViewService = { report: () => {}, withdraw: () => withdrawn.promise };
    const harness = createHarness({ liveView });
    await harness.run(['open', 'https://example.com']);
    let finished = false;
    const shutdown = harness.emit('session_shutdown').then(() => { finished = true; });
    await vi.waitFor(() => expect(harness.commands().at(-1)).toBe('close'));
    expect(finished).toBe(false);
    withdrawn.resolve();
    await shutdown;
  });

  it('gives up on a host report that never settles and still withdraws at shutdown', async () => {
    vi.useFakeTimers();
    const report = vi.fn(() => new Promise<void>(() => {}));
    const withdraw = vi.fn();
    const harness = createHarness({ liveView: { report, withdraw } });
    const running = harness.run(['open', 'https://example.com']);
    await vi.waitFor(() => expect(report).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(running).resolves.toMatchObject({ details: { code: 0 } });
    await harness.emit('session_shutdown');
    expect(withdraw).toHaveBeenCalledWith({ sessionId: SESSION_ID });
    expect(harness.commands().at(-1)).toBe('close');
  });

  it('repeats the withdrawal when a timed-out report reaches the host after it', async () => {
    vi.useFakeTimers();
    const late = deferred<void>();
    const host: string[] = [];
    const liveView: BrowserLiveViewService = {
      report: ({ port }) => {
        host.push(`report ${port}`);
        return late.promise.then(() => { host.push('late report applied'); });
      },
      withdraw: () => { host.push('withdraw'); },
    };
    const harness = createHarness({ liveView });
    const running = harness.run(['open', 'https://example.com']);
    await vi.waitFor(() => expect(host).toEqual([`report ${FIRST_PORT}`]));
    await vi.advanceTimersByTimeAsync(5_000);
    await running;
    await harness.run(['close']);
    expect(host).toEqual([`report ${FIRST_PORT}`, 'withdraw']);
    late.resolve();
    await vi.waitFor(() => expect(host).toEqual([`report ${FIRST_PORT}`, 'withdraw', 'late report applied', 'withdraw']));
  });

  it('closes the browser at shutdown only after an in-flight stream read finishes', async () => {
    const liveView = createLiveView();
    const harness = createHarness({ liveView });
    const release = harness.holdStreamReads();
    const running = harness.run(['open', 'https://example.com']);
    await vi.waitFor(() => expect(harness.calls('stream')).toHaveLength(1));
    const shutdown = harness.emit('session_shutdown');
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(harness.commands().at(-1)).toBe('stream');
    release();
    await Promise.all([running, shutdown]);
    expect(harness.commands().slice(-2)).toEqual(['stream', 'close']);
    expect(liveView.events).toEqual([]);
  });

  it('fails a tool call aborted during the stream read and reads the port again next time', async () => {
    const liveView = createLiveView();
    const harness = createHarness({ liveView });
    await harness.run(['open', 'https://example.com']);
    harness.expireDaemons();
    const release = harness.holdStreamReads();
    const controller = new AbortController();
    const running = harness.run(['snapshot', '-i'], controller.signal);
    await vi.waitFor(() => expect(harness.calls('stream')).toHaveLength(2));
    controller.abort();
    release();
    await expect(running).rejects.toThrow('browser tool aborted');
    expect(liveView.events).toEqual([['report', { sessionId: SESSION_ID, port: FIRST_PORT }]]);
    await harness.run(['click', '@e1']);
    expect(liveView.events.at(-1)).toEqual(['report', { sessionId: SESSION_ID, port: FIRST_PORT + 1 }]);
  });

  it('reads the port again after a failed stream read following a daemon restart', async () => {
    const liveView = createLiveView();
    const harness = createHarness({ liveView });
    await harness.run(['open', 'https://example.com']);
    harness.expireDaemons();
    harness.failures.add('stream');
    await harness.run(['snapshot', '-i']);
    harness.failures.clear();
    await harness.run(['click', '@e1']);
    expect(liveView.events).toEqual([
      ['report', { sessionId: SESSION_ID, port: FIRST_PORT }],
      ['report', { sessionId: SESSION_ID, port: FIRST_PORT + 1 }],
    ]);
  });

  it('keeps the browser result when the host report fails and retries on the next command', async () => {
    const liveView = createLiveView();
    liveView.report.mockRejectedValueOnce(new Error('host unavailable'));
    const harness = createHarness({ liveView });
    await expect(harness.run(['open', 'https://example.com'])).resolves.toMatchObject({ details: { code: 0 } });
    await harness.run(['snapshot', '-i']);
    expect(harness.calls('stream')).toHaveLength(2);
    expect(liveView.report).toHaveBeenCalledTimes(2);
    await harness.run(['click', '@e1']);
    expect(harness.calls('stream')).toHaveLength(2);
  });

  it('keeps the browser result when the stream status read fails and retries on the next command', async () => {
    const liveView = createLiveView();
    const harness = createHarness({ liveView, fail: new Set(['stream']) });
    await expect(harness.run(['open', 'https://example.com'])).resolves.toMatchObject({ details: { code: 0 } });
    expect(liveView.events).toEqual([]);
    harness.failures.clear();
    await harness.run(['snapshot', '-i']);
    expect(liveView.events).toEqual([['report', { sessionId: SESSION_ID, port: FIRST_PORT }]]);
  });

  it('never reports a browser attached through browser_authorize', async () => {
    const liveView = createLiveView();
    const harness = createHarness({ liveView, authorization: true });
    await harness.run(['open', 'https://isolated.example']);
    const streamReads = harness.calls('stream').length;

    await expect(harness.authorize()).resolves.toMatchObject({ details: { state: 'authorized' } });
    await harness.run(['open', 'https://example.com/private']);
    await harness.run(['snapshot', '-i']);
    harness.expireDaemons();
    await harness.run(['snapshot', '-i']);
    await harness.run(['close']);

    expect(harness.calls('stream')).toHaveLength(streamReads);
    expect(harness.calls('stream').every(call => !call.args.includes('--cdp'))).toBe(true);
    expect(liveView.events).toEqual([['report', { sessionId: SESSION_ID, port: FIRST_PORT }]]);
    await harness.emit('session_shutdown');
    expect(liveView.events).toEqual([
      ['report', { sessionId: SESSION_ID, port: FIRST_PORT }],
      ['withdraw', { sessionId: SESSION_ID }],
    ]);
  });

  it.each([
    'stream status', 'stream enable --port 9223', 'stream disable', 'dashboard', 'dashboard start',
  ])('keeps "%s" unavailable to the model in isolated and attached browsers', async command => {
    const args = command.split(' ');
    const harness = createHarness({ liveView: createLiveView(), authorization: true });
    await expect(harness.run(args)).rejects.toThrow(`does not run ${args[0]}`);
    await expect(harness.authorize()).resolves.toMatchObject({ details: { state: 'authorized' } });
    await expect(harness.run(args)).rejects.toThrow(`does not run ${args[0]}`);
    expect(harness.commands()).not.toContain('stream');
    expect(harness.commands()).not.toContain('dashboard');
    await harness.emit('session_shutdown');
  });
});

interface FakeDaemon {
  readonly port: number;
  browser: boolean;
  url: string;
  cdpUrl?: string;
}

function createHarness(options: {
  liveView?: BrowserLiveViewService;
  authorization?: boolean;
  fail?: Set<string>;
} = {}) {
  const daemons = new Map<string, FakeDaemon>();
  const failures = options.fail ?? new Set<string>();
  let nextPort = FIRST_PORT;
  let relaunch = false;
  let streamGate: Promise<void> | undefined;
  const runtime = new BrowserTestRuntime(async (_command, args): Promise<ExecResult> => {
    if (args[0] === '--version') return result('agent-browser 0.37.1');
    const key = scopeKey(args);
    if (['close', 'quit', 'exit'].includes(args[0]!)) {
      daemons.delete(key);
      return failures.has(args[0]!) ? result('', 1, `${args[0]} failed`) : response({ closed: true });
    }
    if (args[0] === 'session' && args[1] === 'info') {
      const daemon = daemons.get(key);
      return response(daemon
        ? { active: true, pid: 123, runtime: { backgroundPid: 123, browserLaunched: daemon.browser }, runtimeError: null }
        : { active: false, pid: null, runtime: null, runtimeError: null });
    }
    let daemon = daemons.get(key);
    const restarted = daemon === undefined;
    if (!daemon) {
      daemon = { port: nextPort++, browser: false, url: 'about:blank' };
      daemons.set(key, daemon);
    }
    if (args[0] === 'stream') {
      await streamGate;
      if (failures.has('stream')) return result('', 1, 'stream failed');
      return response({ port: daemon.port, enabled: true, connected: daemon.browser });
    }
    const launched = !daemon.browser;
    daemon.browser = true;
    const lifecycle = { launched, relaunchedBrowser: relaunch, restartedBackground: restarted && !launched };
    relaunch = false;
    // Like the native CLI, a failing command can still start the daemon and launch the browser.
    if (failures.has(args[0]!)) return result('', 1, `${args[0]} failed`);
    if (args[0] === 'open') {
      daemon.url = args[1]!;
      if (args.includes('--cdp')) daemon.cdpUrl = args[args.indexOf('--cdp') + 1]!;
    }
    if (args[0] === 'get' && args[1] === 'cdp-url') return response({ cdpUrl: daemon.cdpUrl }, lifecycle);
    if (args[0] === 'get' && args[1] === 'url') return response({ url: daemon.url }, lifecycle);
    if (args[0] === 'tab' && args[1] === 'list') {
      return response({ tabs: [{ targetId: 'target', url: daemon.url, active: true }] }, lifecycle);
    }
    return response({ ok: true }, lifecycle);
  });

  const registry = createFelanServiceRegistry();
  if (options.liveView) registry.set(BROWSER_LIVE_VIEW_SERVICE, options.liveView);
  if (options.authorization) registry.set(BROWSER_AUTHORIZATION_SERVICE, createAuthorizationService());
  const tools = new Map<string, ToolDefinition<any, any, any>>();
  const handlers = new Map<string, (event: unknown, context: ExtensionContext) => unknown>();
  const context = {
    sessionManager: { getSessionId: () => SESSION_ID },
    model: { input: ['text'] },
    tools: [],
    executeTool: vi.fn(async () => { throw new Error('Unexpected nested tool execution'); }),
  } as unknown as Parameters<ToolDefinition['execute']>[4];
  const pi = {
    runtime,
    config: {},
    services: createExtensionServiceAccess(registry, extension.serviceRequirements),
    registerCapability: vi.fn(),
    registerTool: (tool: ToolDefinition<any, any, any>) => tools.set(tool.name, tool),
    on: (event: string, handler: (event: unknown, context: ExtensionContext) => unknown) => handlers.set(event, handler),
  } as unknown as FelanExtensionAPI;
  extension(pi);

  return {
    tools,
    failures,
    run: (args: readonly string[], signal?: AbortSignal) => tools.get('browser')!.execute('run', { operation: 'run', args: [...args] }, signal, undefined, context),
    authorize: () => tools.get('browser_authorize')!.execute('authorize', {
      operation: 'authorize', origin: 'https://example.com', reason: 'Use the signed-in browser.',
    }, undefined, undefined, context),
    emit: async (event: string) => { await handlers.get(event)?.({}, context); },
    calls: (command: string) => runtime.calls.filter(call => call.args[0] === command),
    // Executable discovery differs by platform; Linux also probes `ldd --version` for musl.
    commands: () => runtime.calls.filter(call => call.args[0] !== '--version').map(call => call.args[0]),
    expireDaemons: () => daemons.clear(),
    relaunchNextCommand: () => { relaunch = true; },
    holdStreamReads: () => {
      const gate = deferred<void>();
      streamGate = gate.promise;
      return () => { streamGate = undefined; gate.resolve(); };
    },
  };
}

function createLiveView() {
  const events: Array<['report' | 'withdraw', unknown]> = [];
  const report = vi.fn(async (stream: Parameters<BrowserLiveViewService['report']>[0]) => { events.push(['report', stream]); });
  const withdraw = vi.fn(async (session: Parameters<BrowserLiveViewService['withdraw']>[0]) => { events.push(['withdraw', session]); });
  return { events, report, withdraw } satisfies BrowserLiveViewService & { events: unknown[] };
}

function createAuthorizationService(): BrowserAuthorizationService {
  return {
    authorize: async request => {
      const controller = new AbortController();
      const attachment = await request.attach({ port: 9222, webSocketPath: '/devtools/browser/test' }, {
        signal: controller.signal,
        close: async () => { controller.abort(); },
      });
      return attachment.ready ? { status: 'authorized' } : { status: 'unavailable' };
    },
  };
}

function response(data: Record<string, unknown>, lifecycle?: Record<string, unknown>): ExecResult {
  return result(JSON.stringify({ success: true, data: { ...data, ...(lifecycle === undefined ? {} : { lifecycle }) }, error: null }));
}

function scope(call: { args: readonly string[] }) {
  return {
    session: call.args[call.args.indexOf('--session') + 1],
    namespace: call.args[call.args.indexOf('--namespace') + 1],
  };
}

function scopeKey(args: readonly string[]): string {
  const { session, namespace } = scope({ args });
  return `${namespace}/${session}`;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
