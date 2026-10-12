import { afterEach, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import type { SessionClient, SessionClientOptions } from '../src/client/client.js';
import { clientDaemonTarget, runDaemonFelan } from '../src/client-application.js';
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

it('restarts with a new client while retaining the session and draft without resubmitting launch input', async () => {
  const oldIdentity = { namespaceId: 'production', instanceId: 'old', agentDir: '/agent', rootSet: ['/agent'] };
  const close = vi.fn(); const control = vi.fn(async () => ({ outcome: 'accepted' })); let clients = 0;
  const createClient = vi.fn((_options: SessionClientOptions) => ({ subscribe: () => () => {}, close, control,
    identity: clients++ === 0 ? oldIdentity : { ...oldIdentity, instanceId: 'new' } }) as unknown as SessionClient);
  const waitForStop = vi.fn(async () => {}); let terminals = 0;
  const runTerminal: NonNullable<Parameters<typeof runDaemonFelan>[1]>['runTerminal'] = async (_controller, options) => {
    if (terminals++ === 0) expect(await options.onDaemonAction!('restart', false, 'unsubmitted draft')).toBe(true);
    else {
      expect(options).toMatchObject({ sessionId: 'keep-session', initialDraft: 'unsubmitted draft' });
      expect(options.initialMessage).toBeUndefined(); expect(options.extensions).toBeUndefined(); expect(options.config).toBeUndefined();
    }
  };
  await runDaemonFelan({ agentDir: '/agent', sessionId: 'keep-session', initialMessage: 'submit only once', extensionPaths: ['/extension.ts'] },
    { createClient, runTerminal, waitForStop });
  expect(createClient).toHaveBeenCalledTimes(2);
  expect(createClient.mock.calls[1]![0].launch?.replacing).toEqual(oldIdentity);
  expect(control).toHaveBeenCalledWith('host.restart', { confirmed: true, mode: 'drain' });
  expect(waitForStop).toHaveBeenCalledOnce(); expect(close).toHaveBeenCalledTimes(2);
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
  const close = vi.fn(); let calls = 0;
  const createClient = vi.fn(() => {
    if (calls++) throw new Error('replacement failed');
    return { subscribe: () => () => {}, close, identity, control: async () => ({ outcome: 'accepted' }) } as unknown as SessionClient;
  });
  await expect(runDaemonFelan({ agentDir: '/agent', sessionId: 'retained' }, {
    createClient, waitForStop: async () => {}, runTerminal: async (_controller, options) => { await options.onDaemonAction!('restart', false, ''); },
  })).rejects.toThrow('replacement failed');
  expect(createClient).toHaveBeenCalledTimes(2); expect(close).toHaveBeenCalledOnce();
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
