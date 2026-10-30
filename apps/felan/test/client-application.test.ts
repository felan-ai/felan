import { afterEach, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { SessionClient, SessionClientOptions } from '../src/client/client.js';
import { clientDaemonTarget, resumeCommand, runDaemonFelan } from '../src/client-application.js';
import { resolveInstalledDaemonEntrypoint } from '../src/daemon-entrypoint.js';
import { snapshot } from './client-fixtures.js';
import type { RestartProcessOptions } from '../src/process-restart.js';

afterEach(() => vi.unstubAllEnvs());

it('constructs the installed-daemon client and forwards only declarative startup data', async () => {
  const close = vi.fn(); const client = { subscribe: () => () => {}, close } as unknown as SessionClient;
  const createClient = vi.fn((_options: SessionClientOptions) => client);
  const runTerminal = vi.fn(async () => {});
  await runDaemonFelan({ cwd: '/workspace', agentDir: '/agent', sessionId: 'chosen', sessionDir: './fixtures/../sessions', initialMessage: 'hello', extensionPaths: ['/extension.ts'] },
    { createClient, runTerminal });
  expect(createClient).toHaveBeenCalledWith(expect.objectContaining({ kind: 'tui', target: { kind: 'production', agentDir: '/agent', storeRoots: [] },
    launch: { entrypoint: resolveInstalledDaemonEntrypoint() } }));
  expect(runTerminal).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ cwd: '/workspace', sessionId: 'chosen', sessionDir: resolve('./sessions'), initialMessage: 'hello', extensions: ['/extension.ts'] }));
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

it('re-executes /restart after verified shutdown without reconnecting the old client to the new build', async () => {
  const oldIdentity = { namespaceId: 'production', instanceId: 'old', agentDir: '/agent', rootSet: ['/agent'] };
  const order: string[] = [];
  const control = vi.fn(async (op: string) => { order.push(op); return { outcome: 'accepted' }; });
  const connect = vi.fn(async () => { throw new Error('Daemon version differs from the installed package; restart it to continue.'); });
  const close = vi.fn(() => { order.push('close'); });
  const createClient = vi.fn((_options: SessionClientOptions) => ({ subscribe: () => () => {}, close, control, connect, identity: oldIdentity }) as unknown as SessionClient);
  const waitForStop = vi.fn(async () => { order.push('stopped'); });
  const restartProcess = vi.fn(async (_options: RestartProcessOptions) => { order.push('exec'); return undefined as never; });
  await runDaemonFelan({ cwd: '/workspace', agentDir: '/agent', sessionId: 'keep-session', restartArgs: ['--verbose'] }, { createClient, waitForStop, restartProcess,
    runTerminal: async (controller, options) => {
      vi.spyOn(controller, 'sessionId', 'get').mockReturnValue('current-session');
      const current = vi.spyOn(controller, 'snapshot', 'get').mockReturnValue({ ...snapshot(), cwd: '/current-workspace' });
      waitForStop.mockImplementationOnce(async () => { order.push('stopped'); current.mockReturnValue(undefined); });
      expect(await options.onDaemonAction!('relaunch', false, '')).toBe(true);
    } });
  expect(order).toEqual(['host.restart', 'stopped', 'close', 'exec']);
  expect(connect).not.toHaveBeenCalled();
  expect(restartProcess).toHaveBeenCalledOnce();
  expect(restartProcess.mock.calls[0]![0]).toEqual({ sessionId: 'current-session', cwd: '/current-workspace', restartArgs: ['--verbose'], replacing: oldIdentity });
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

it.each([false, true])('preserves the requested force mode before relaunch (%s)', async force => {
  const identity = { namespaceId: 'production', instanceId: 'old', agentDir: '/agent', rootSet: ['/agent'] };
  const control = vi.fn(async () => ({ outcome: 'accepted' }));
  const client = { subscribe: () => () => {}, close() {}, identity, control } as unknown as SessionClient;
  const restartProcess = vi.fn(async (_options: RestartProcessOptions) => undefined as never);
  const waitForStop = vi.fn(async () => {});
  await runDaemonFelan({ agentDir: '/agent', cwd: '/workspace' }, { createClient: () => client, waitForStop, restartProcess,
    runTerminal: async (_controller, options) => { expect(await options.onDaemonAction!('relaunch', force, '')).toBe(true); } });
  expect(control).toHaveBeenCalledExactlyOnceWith('host.restart', force ? 'force' : 'drain');
  expect(waitForStop).toHaveBeenCalledExactlyOnceWith(client, undefined, { client: 'tui', action: 'restart' });
  expect(restartProcess).toHaveBeenCalledOnce();
  expect(restartProcess.mock.calls[0]![0]).toEqual({ cwd: '/workspace', replacing: identity });
});

it('consumes the validated restart identity once and gives the fresh launcher its replacement ownership', async () => {
  const identity = { namespaceId: 'production', instanceId: 'old', agentDir: '/agent', rootSet: ['/agent'] };
  vi.stubEnv('FELAN_RESTART_DAEMON', JSON.stringify(identity));
  const client = { subscribe: () => () => {}, close() {} } as unknown as SessionClient;
  const createClient = vi.fn((_options: SessionClientOptions) => client);
  await runDaemonFelan({ agentDir: '/agent' }, { createClient, runTerminal: async () => {} });
  expect(createClient.mock.calls[0]?.[0].launch?.replacing).toEqual(identity);
  expect(process.env.FELAN_RESTART_DAEMON).toBeUndefined();
  await runDaemonFelan({ agentDir: '/agent' }, { createClient, runTerminal: async () => {} });
  expect(createClient.mock.calls[1]?.[0].launch?.replacing).toBeUndefined();
});

it.each(['not json', '{"instanceId":"old"}'])('rejects an invalid restart handoff before creating a client: %s', async handoff => {
  vi.stubEnv('FELAN_RESTART_DAEMON', handoff);
  const createClient = vi.fn();
  await expect(runDaemonFelan({}, { createClient })).rejects.toThrow('Invalid daemon restart handoff.');
  expect(createClient).not.toHaveBeenCalled(); expect(process.env.FELAN_RESTART_DAEMON).toBeUndefined();
});

it.each(['rejected', 'shutdown failed'] as const)('never relaunches when daemon control is unsafe: %s', async failure => {
  const identity = { namespaceId: 'production', instanceId: 'old', agentDir: '/agent', rootSet: ['/agent'] };
  const control = vi.fn(async () => ({ outcome: failure === 'rejected' ? 'rejected' : 'accepted' }));
  const client = { subscribe: () => () => {}, close() {}, identity, control } as unknown as SessionClient;
  const waitForStop = vi.fn(async () => { throw new Error('shutdown failed'); });
  const restartProcess = vi.fn(async () => undefined as never);
  await expect(runDaemonFelan({ agentDir: '/agent' }, { createClient: () => client, waitForStop, restartProcess,
    runTerminal: async (_controller, options) => { await options.onDaemonAction!('relaunch', false, ''); },
  })).rejects.toThrow(failure === 'rejected' ? 'Daemon control was not accepted' : failure);
  expect(restartProcess).not.toHaveBeenCalled();
  if (failure === 'rejected') expect(waitForStop).not.toHaveBeenCalled();
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
  await runDaemonFelan({ agentDir: '/agent', daemonRuntime: '/tmp/felan runtime' }, { createClient: () => client, writeOutput: text => output.push(text),
    runTerminal: async controller => { vi.spyOn(controller, 'sessionId', 'get').mockReturnValue('01a13dfb-0000'); vi.spyOn(controller, 'sessionEntry', 'get').mockReturnValue('new'); } });
  expect(output).toEqual([]);
  output.length = 0;
  await runDaemonFelan({ agentDir: '/agent', daemonRuntime: '/tmp/felan runtime' }, { createClient: () => client, writeOutput: text => output.push(text),
    runTerminal: async controller => {
      vi.spyOn(controller, 'sessionId', 'get').mockReturnValue('01a13dfb-0000'); vi.spyOn(controller, 'sessionEntry', 'get').mockReturnValue('new');
      vi.spyOn(controller, 'snapshot', 'get').mockReturnValue({ history: { entries: [{ role: 'user' }] } } as never);
    } });
  expect(output).toEqual([`To resume this session: felan --daemon-runtime '/tmp/felan runtime' --session 01a13dfb-0000\n`]);
  output.length = 0;
  // A draft reattached by ID after a restart or relaunch is entered as a resume, but its history still decides.
  await runDaemonFelan({ agentDir: '/agent', daemonRuntime: '/tmp/felan runtime' }, { createClient: () => client, writeOutput: text => output.push(text),
    runTerminal: async controller => {
      vi.spyOn(controller, 'sessionId', 'get').mockReturnValue('01a13dfb-0000');
      vi.spyOn(controller, 'snapshot', 'get').mockReturnValue({ history: { entries: [{ role: 'custom', customType: 'note' }] } } as never);
    } });
  expect(output).toEqual([]);
  output.length = 0;
  await runDaemonFelan({ agentDir: '/agent' }, { createClient: () => client, writeOutput: text => output.push(text), runTerminal: async () => {} });
  expect(output).toEqual([]);
  expect(resumeCommand('session-id', {})).toBe('felan --session session-id');
});
