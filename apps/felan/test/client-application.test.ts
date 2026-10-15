import { afterEach, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import type { SessionClient, SessionClientOptions } from '../src/client/client.js';
import { clientDaemonTarget, resumeCommand, runDaemonFelan } from '../src/client-application.js';
import { resolveInstalledDaemonEntrypoint } from '../src/daemon-entrypoint.js';

afterEach(() => vi.unstubAllEnvs());

it('constructs the installed-daemon client and forwards only declarative startup data', async () => {
  const close = vi.fn(); const client = { subscribe: () => () => {}, close } as unknown as SessionClient;
  const createClient = vi.fn((_options: SessionClientOptions) => client);
  const runTerminal = vi.fn(async () => {});
  await runDaemonFelan({ cwd: '/workspace', agentDir: '/agent', sessionId: 'chosen', initialMessage: 'hello', extensionPaths: ['/extension.ts'] },
    { createClient, runTerminal });
  expect(createClient).toHaveBeenCalledWith(expect.objectContaining({ kind: 'tui', target: { kind: 'production', agentDir: '/agent', storeRoots: [] },
    launch: { entrypoint: resolveInstalledDaemonEntrypoint() } }));
  expect(runTerminal).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ cwd: '/workspace', sessionId: 'chosen', initialMessage: 'hello', extensions: ['/extension.ts'] }));
  expect(close).toHaveBeenCalledOnce();
});

it('closes the transport after terminal startup fails without disposing a daemon runtime', async () => {
  const close = vi.fn(); const client = { subscribe: () => () => {}, close } as unknown as SessionClient;
  await expect(runDaemonFelan({ agentDir: '/agent' }, { createClient: () => client, runTerminal: async () => { throw new Error('terminal failed'); } }))
    .rejects.toThrow('terminal failed');
  expect(close).toHaveBeenCalledOnce();
});

it('restarts the daemon in place and reconnects the same terminal with the previous identity as the replaced owner', async () => {
  const oldIdentity = { namespaceId: 'production', instanceId: 'old', agentDir: '/agent', rootSet: ['/agent'] };
  const close = vi.fn(); const control = vi.fn(async () => ({ outcome: 'accepted' })); const connect = vi.fn(async () => ({}));
  const createClient = vi.fn((_options: SessionClientOptions) => ({ subscribe: () => () => {}, close, control, connect, identity: oldIdentity }) as unknown as SessionClient);
  const waitForStop = vi.fn(async () => {}); const notices: string[] = [];
  await runDaemonFelan({ agentDir: '/agent', sessionId: 'keep-session' }, { createClient, waitForStop, runTerminal: async (controller, options) => {
    controller.subscribe(() => notices.push(controller.notice));
    expect(await options.onDaemonAction!('restart', false, 'unsubmitted draft')).toBe(false);
  } });
  expect(createClient).toHaveBeenCalledOnce();
  expect(control).toHaveBeenCalledWith('host.restart', 'drain');
  expect(waitForStop).toHaveBeenCalledOnce(); expect(connect).toHaveBeenCalledExactlyOnceWith({ replacing: oldIdentity });
  expect(notices).toEqual(['Daemon restarting…', 'Daemon restarted']); expect(close).toHaveBeenCalledOnce();
});

it('restarts the daemon in place for /restart, then re-executes the client on the same session with its launch options', async () => {
  const oldIdentity = { namespaceId: 'production', instanceId: 'old', agentDir: '/agent', rootSet: ['/agent'] };
  const order: string[] = [];
  const control = vi.fn(async (op: string) => { order.push(op); return { outcome: 'accepted' }; });
  const connect = vi.fn(async () => { order.push('connect'); return {}; });
  const close = vi.fn(() => { order.push('close'); });
  const createClient = vi.fn((_options: SessionClientOptions) => ({ subscribe: () => () => {}, close, control, connect, identity: oldIdentity }) as unknown as SessionClient);
  const waitForStop = vi.fn(async () => { order.push('stopped'); });
  const restartProcess = vi.fn(async (_options: { sessionId?: string; cwd: string; restartArgs?: readonly string[] }) => { order.push('exec'); return undefined as never; });
  await runDaemonFelan({ cwd: '/workspace', agentDir: '/agent', sessionId: 'keep-session', restartArgs: ['--verbose'] }, { createClient, waitForStop, restartProcess,
    runTerminal: async (_controller, options) => { expect(await options.onDaemonAction!('relaunch', false, '')).toBe(true); } });
  expect(order).toEqual(['host.restart', 'stopped', 'connect', 'close', 'exec']);
  expect(connect).toHaveBeenCalledExactlyOnceWith({ replacing: oldIdentity });
  expect(restartProcess).toHaveBeenCalledExactlyOnceWith({ sessionId: 'keep-session', cwd: '/workspace', restartArgs: ['--verbose'] });
  expect(createClient).toHaveBeenCalledOnce();
});

it('keeps /daemon restart daemon-only without re-executing the client', async () => {
  const identity = { namespaceId: 'production', instanceId: 'old', agentDir: '/agent', rootSet: ['/agent'] };
  const createClient = vi.fn(() => ({ subscribe: () => () => {}, close() {}, identity, connect: async () => ({}), control: async () => ({ outcome: 'accepted' }) }) as unknown as SessionClient);
  const restartProcess = vi.fn(async () => undefined as never);
  await runDaemonFelan({ agentDir: '/agent', sessionId: 'keep-session' }, { createClient, waitForStop: async () => {}, restartProcess,
    runTerminal: async (_controller, options) => { expect(await options.onDaemonAction!('restart', false, '')).toBe(false); } });
  expect(restartProcess).not.toHaveBeenCalled();
});

it('preserves unsubmitted startup input when version consent happens before attachment', async () => {
  const identity = { namespaceId: 'production', instanceId: 'old', agentDir: '/agent', rootSet: ['/agent'] };
  const client = { subscribe: () => () => {}, close() {}, identity, control: async () => ({ outcome: 'accepted' }) } as unknown as SessionClient;
  let attempts = 0;
  await runDaemonFelan({ agentDir: '/agent', initialMessage: 'not yet sent' }, {
    createClient: () => client, waitForStop: async () => {},
    runTerminal: async (_controller, options) => {
      if (attempts++ === 0) await options.onDaemonAction!('restart', false, '', true);
      else expect(options.initialMessage).toBe('not yet sent');
    },
  });
  expect(attempts).toBe(2);
});

it('reports a failed replacement launch without silently retrying or claiming success', async () => {
  const identity = { namespaceId: 'production', instanceId: 'old', agentDir: '/agent', rootSet: ['/agent'] };
  const close = vi.fn(); const connect = vi.fn(async () => { throw new Error('replacement failed'); });
  const createClient = vi.fn(() => ({ subscribe: () => () => {}, close, identity, connect, control: async () => ({ outcome: 'accepted' }) }) as unknown as SessionClient);
  await expect(runDaemonFelan({ agentDir: '/agent', sessionId: 'retained' }, {
    createClient, waitForStop: async () => {}, runTerminal: async (_controller, options) => { await options.onDaemonAction!('restart', false, ''); },
  })).rejects.toThrow('replacement failed');
  expect(createClient).toHaveBeenCalledOnce(); expect(connect).toHaveBeenCalledOnce(); expect(close).toHaveBeenCalledOnce();
});

it('uses isolated daemon selection only when explicitly supplied, with a stable namespace', () => {
  vi.stubEnv('FELAN_DAEMON_RUNTIME', '/untrusted-ambient-target');
  expect(clientDaemonTarget({ agentDir: '/agent' }).kind).toBe('production');
  expect(clientDaemonTarget({ daemonRuntime: '/tmp/fixture' })).toEqual(clientDaemonTarget({ daemonRuntime: '/tmp/fixture' }));
  expect(clientDaemonTarget({ daemonRuntime: '/tmp/fixture' })).toMatchObject({ kind: 'isolated', directory: '/tmp/fixture' });
});

it('keeps the new interactive entry path free of local runtime and session-store construction', async () => {
  const source = await readFile(new URL('../src/client-application.ts', import.meta.url), 'utf8');
  expect(source).not.toMatch(/InteractiveMode|createLocalFelanRuntime|SessionManager|createLocalSettingsManager/);
  const cli = await readFile(new URL('../src/cli-main.ts', import.meta.url), 'utf8');
  expect(cli).not.toMatch(/^import .*from ['"].*(?:internal\/settings|\.\/runtime)/mu);
  expect(cli).toContain("await import('./client-application.js')");
});

it('prints the resume command after a normal quit with an attached session, like Pi, and nothing without one', async () => {
  const client = { subscribe: () => () => {}, close() {} } as unknown as SessionClient;
  const output: string[] = [];
  await runDaemonFelan({ agentDir: '/agent', daemonRuntime: '/tmp/felan runtime', sessionDir: '/sessions/it\'s' }, { createClient: () => client, writeOutput: text => output.push(text),
    runTerminal: async controller => { vi.spyOn(controller, 'sessionId', 'get').mockReturnValue('01a13dfa-c2dd'); } });
  expect(output).toEqual([`To resume this session: felan --daemon-runtime '/tmp/felan runtime' --session-dir '/sessions/it'\\''s' --session 01a13dfa-c2dd\n`]);
  output.length = 0;
  await runDaemonFelan({ agentDir: '/agent' }, { createClient: () => client, writeOutput: text => output.push(text), runTerminal: async () => {} });
  expect(output).toEqual([]);
  expect(resumeCommand('session-id', {})).toBe('felan --session session-id');
});
