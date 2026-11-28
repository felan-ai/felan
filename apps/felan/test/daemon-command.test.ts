import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import childProcess, { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveDaemonTarget, windowsProcessElevated } from '@felan-ai/daemon/client';
import { FELAN_VERSION } from '../src/version.js';
import { acquireDaemonOwnership } from '../../daemon/src/daemon/ownership.js';
import { builtinExtensionPackages } from '../src/providers/extensions.js';
import { clientDaemonTarget } from '../src/client-application.js';
import { SessionClient, type SessionClientOptions } from '../src/client/client.js';
import { runCli } from '../src/cli-main.js';
import { runDaemonCommand } from '../src/daemon-command.js';
import { ELEVATED_DAEMON_WARNING } from '../src/client/diagnostics.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); vi.restoreAllMocks(); syncBuiltinESMExports(); vi.unstubAllEnvs(); });
const output = () => ({ writeOutput: vi.fn(), writeError: vi.fn() });
async function runSuccessfully(args: readonly string[], io = output()): Promise<void> {
  const code = await runDaemonCommand(args, io);
  expect(code, [args.join(' '), ...io.writeError.mock.calls.flat(), ...io.writeOutput.mock.calls.flat()].join('\n')).toBe(0);
}

it('rejects --force outside stop/restart before constructing a client', async () => {
  const io = output(); const createClient = vi.fn();
  expect(await runDaemonCommand(['status', '--force'], io, { createClient })).toBe(1);
  expect(await runDaemonCommand(['stop', '--yes'], io, { createClient })).toBe(1);
  expect(createClient).not.toHaveBeenCalled();
});

it.each(['start', 'stop', 'restart', 'logs', 'foreground'])('rejects --json for daemon %s before constructing a client', async action => {
  const io = output(); const createClient = vi.fn(); const foreground = vi.fn();
  expect(await runDaemonCommand([action, '--json'], io, { createClient, foreground })).toBe(1);
  expect(io.writeError).toHaveBeenCalledExactlyOnceWith('--json applies only to status.');
  expect(createClient).not.toHaveBeenCalled(); expect(foreground).not.toHaveBeenCalled(); expect(io.writeOutput).not.toHaveBeenCalled();
});

describe('daemon status --json', () => {
  const status = { daemonVersion: '0.8.6', state: 'ready', active: { sessions: 3, runs: 1, work: 2, attachments: 4 },
    setupNeeds: [{ code: 'provider', message: 'Configure a local model provider.' }] };
  async function runStatus(client: Record<string, unknown>) {
    const directory = await mkdtemp(join(tmpdir(), 'status-json-')); cleanup.push(() => rm(directory, { recursive: true, force: true }));
    const io = output();
    const code = await runDaemonCommand(['status', '--json', '--daemon-runtime', directory], io,
      { createClient: () => ({ close() {}, connect: async () => {}, status: 'ready', ...client }) as unknown as SessionClient });
    const endpoint = resolveDaemonTarget(clientDaemonTarget({ daemonRuntime: directory })).endpoint;
    expect(io.writeError).not.toHaveBeenCalled(); expect(io.writeOutput).toHaveBeenCalledOnce();
    return { code, endpoint, value: JSON.parse(io.writeOutput.mock.calls[0]![0] as string) as Record<string, unknown> };
  }

  it('prints one object with the daemon state and active counts', async () => {
    const { code, endpoint, value } = await runStatus({ request: async () => ({ outcome: 'accepted', result: status }) });
    expect(code).toBe(0);
    expect(value).toEqual({ running: true, endpoint, clientVersion: FELAN_VERSION, compatible: true, daemonVersion: '0.8.6', state: 'ready',
      sessions: 3, runs: 1, activeTasks: 2, attachments: 4, restartRequired: false, setupNeeds: ['Configure a local model provider.'] });
  });

  it('reports a different daemon build as requiring a restart', async () => {
    const { value } = await runStatus({ request: async () => ({ outcome: 'accepted', result: status }), buildMismatch: { daemonVersion: '0.8.6', expectedDaemonVersion: '0.8.7' } });
    expect(value).toMatchObject({ running: true, restartRequired: true });
  });

  it('reports an absent daemon as not running with exit 0', async () => {
    const { code, endpoint, value } = await runStatus({ connect: async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); } });
    expect(code).toBe(0);
    expect(value).toEqual({ running: false, endpoint, clientVersion: FELAN_VERSION });
  });

  it('reports an incompatible daemon without its counts', async () => {
    const { code, endpoint, value } = await runStatus({ status: 'incompatible', identity: { instanceId: 'other' },
      control: async () => ({ daemonVersion: '0.7.0', state: 'ready' }) });
    expect(code).toBe(0);
    expect(value).toEqual({ running: true, endpoint, clientVersion: FELAN_VERSION, compatible: false, daemonVersion: '0.7.0', state: 'ready' });
  });

  it('prints a failure as a JSON error object with exit 1', async () => {
    const { code, value } = await runStatus({ connect: async () => { throw Object.assign(new Error('The running daemon is elevated.'), { code: 'elevation_mismatch' }); } });
    expect(code).toBe(1);
    expect(value).toEqual({ error: 'The running daemon is elevated.' });
  });
});

it('routes daemon arguments separately from prompts and preserves the explicit isolated target', async () => {
  const directory = join(tmpdir(), 'explicit-target');
  const launchDaemon = vi.fn(async () => 0);
  expect(await runCli(['daemon', 'status', '--daemon-runtime', directory], { launchDaemon })).toBe(0);
  expect(launchDaemon).toHaveBeenCalledWith(['status', '--daemon-runtime', directory]);
  const foreground = vi.fn(async () => 7);
  expect(await runDaemonCommand(['foreground', '--daemon-runtime', directory], output(), { foreground })).toBe(7);
  expect(foreground).toHaveBeenCalledWith(expect.objectContaining({ kind: 'isolated', directory, storeRoots: [directory] }), undefined);
});

it.each(['status', 'start', 'stop', 'restart', 'logs'])('reports an elevation mismatch once for daemon %s without a replacement client', async action => {
  const directory = await mkdtemp(join(tmpdir(), 'elevation-cli-')); cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const error = Object.assign(new Error('The running daemon is elevated. Stop it from an elevated terminal, then retry.'), { code: 'elevation_mismatch' });
  const connector = vi.fn(async () => { throw error; });
  const createClient = vi.fn((options: SessionClientOptions) => new SessionClient({ ...options, connector }));
  const io = output();
  expect(await runDaemonCommand([action, '--daemon-runtime', directory], io, { createClient })).toBe(1);
  expect(io.writeError.mock.calls).toEqual([[error.message]]); expect(io.writeOutput).not.toHaveBeenCalled();
  expect(createClient).toHaveBeenCalledOnce(); expect(connector).toHaveBeenCalledOnce();
});

it.each(['start', 'restart'])('routes a daemon %s launch warning to the command error channel without refusing it', async action => {
  const createClient = (options: SessionClientOptions) => ({ identity: { instanceId: 'started' }, close() {},
    connect: async () => {
      if (!options.launch) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      options.diagnostics!({ event: 'daemon.launch.elevated', message: ELEVATED_DAEMON_WARNING });
    },
    request: async () => ({ outcome: 'accepted', result: { daemonVersion: 'fixture', state: 'ready',
      active: { sessions: 0, runs: 0, work: 0, attachments: 0 }, setupNeeds: [] } }),
  }) as unknown as SessionClient;
  const io = output();
  expect(await runDaemonCommand([action], io, { createClient })).toBe(0);
  expect(io.writeError).toHaveBeenCalledExactlyOnceWith(ELEVATED_DAEMON_WARNING);
  expect(io.writeOutput).toHaveBeenCalled();
  expect(io.writeOutput.mock.calls.flat().some(line => line.includes(ELEVATED_DAEMON_WARNING))).toBe(false);
});

it.runIf(process.platform === 'win32')('shares the foreground console without forwarding Ctrl+C through TerminateProcess', async () => {
  const child = Object.assign(new EventEmitter(), { kill: vi.fn() });
  const start = vi.spyOn(childProcess, 'spawn').mockReturnValue(child as unknown as childProcess.ChildProcess);
  syncBuiltinESMExports();
  const running = runDaemonCommand(['foreground'], output());
  expect(start).toHaveBeenCalledWith(process.execPath, expect.arrayContaining(['--foreground']), { stdio: 'inherit' });
  process.listeners('SIGINT').at(-1)!();
  expect(child.kill).not.toHaveBeenCalled();
  child.emit('exit', 0, null); expect(await running).toBe(0);
});

it.skipIf(process.platform === 'win32')('forwards foreground interrupts as SIGINT on POSIX', async () => {
  const child = Object.assign(new EventEmitter(), { kill: vi.fn() });
  const start = vi.spyOn(childProcess, 'spawn').mockReturnValue(child as unknown as childProcess.ChildProcess);
  syncBuiltinESMExports();
  const running = runDaemonCommand(['foreground'], output());
  expect(start).toHaveBeenCalledWith(process.execPath, expect.arrayContaining(['--foreground']), { stdio: 'inherit', windowsHide: true });
  process.listeners('SIGINT').at(-1)!(); process.listeners('SIGTERM').at(-1)!();
  expect(child.kill.mock.calls).toEqual([['SIGINT'], ['SIGINT']]);
  child.emit('exit', 0, null); expect(await running).toBe(0);
});

it('starts and restarts the actual daemon with a shared launch environment and retained session IDs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 's14c-')); cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const target = clientDaemonTarget({ daemonRuntime: directory }); const args = ['--daemon-runtime', directory];
  const owner = await acquireDaemonOwnership(target);
  try {
    await writeFile(join(owner.target.agentDir, 'settings.json'), JSON.stringify({ builtinExtensions: Object.fromEntries(Object.keys(builtinExtensionPackages).map(key => [key, false])),
      defaultProvider: 'offline', defaultModel: 'fixture' }), { mode: 0o600 });
    await writeFile(join(owner.target.agentDir, 'models.json'), JSON.stringify({ providers: { offline: { baseUrl: 'http://127.0.0.1:1', apiKey: 'synthetic-fixture-key', api: 'openai-completions',
      models: [{ id: 'fixture', name: 'Fixture', reasoning: false, input: ['text'], contextWindow: 8192, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }), { mode: 0o600 });
  } finally { await owner.release(); }
  cleanup.push(async () => {
    await runSuccessfully(['stop', '--force', ...args]);
    await vi.waitFor(async () => { const lock = await acquireDaemonOwnership(target); await lock.release(); }, { timeout: 5000 });
  });
  vi.stubEnv('FELAN_DAEMON_TEST_LAUNCH', 'first');
  const io = output(); await runSuccessfully(['start', ...args], io);
  await runSuccessfully(['status', ...args], io);
  await runSuccessfully(['logs', ...args], io);
  const first = new SessionClient({ target, clientVersion: 'fixture', kind: 'tui' }); cleanup.push(async () => first.close()); await first.connect();
  const original = first.identity;
  await runSuccessfully(['start', ...args], io);
  const created = await first.request('sessions.create', { cwd: directory, model: { provider: 'offline', id: 'fixture' } });
  expect(created.outcome).toBe('accepted'); if (created.outcome !== 'accepted') return;
  const id = created.result.sessionId; await first.attach(id);
  async function environment(client: SessionClient): Promise<string> {
    const command = process.platform === 'win32' ? `"${process.execPath}" -p "process.env.FELAN_DAEMON_TEST_LAUNCH"` : 'printf "%s" "$FELAN_DAEMON_TEST_LAUNCH"';
    const result = await client.request('shell.execute', { command, includeInContext: false }, { session: id });
    expect(result.outcome).toBe('accepted'); if (result.outcome !== 'accepted') throw new Error('Shell rejected');
    let text = '';
    await vi.waitFor(async () => {
      const read = await client.request('processes.read', { root: id, resourceId: result.result.resourceId, offset: 0, limit: 4096 }, { session: id });
      expect(read.outcome).toBe('accepted'); if (read.outcome !== 'accepted') return;
      expect(read.result.state).toBe('exited'); text = Buffer.from(read.result.data, 'base64').toString('utf8');
    });
    return process.platform === 'win32' ? text.trimEnd() : text;
  }
  expect(await environment(first)).toBe('first');
  vi.stubEnv('FELAN_DAEMON_TEST_LAUNCH', 'second');
  expect(await environment(first)).toBe('first');
  first.close(); await runSuccessfully(['restart', ...args], io);
  const second = new SessionClient({ target, clientVersion: 'fixture', kind: 'tui' }); cleanup.push(async () => second.close()); await second.connect();
  expect(second.identity?.instanceId).not.toBe(original?.instanceId); await second.attach(id);
  expect(second.getAttachment(id)?.state.snapshot?.session).toBe(id);
  expect(await environment(second)).toBe('second');
  expect(io.writeError.mock.calls).toEqual(process.platform === 'win32' && windowsProcessElevated()
    ? [[ELEVATED_DAEMON_WARNING], [ELEVATED_DAEMON_WARNING]] : []);
}, 20_000);

it('runs the emitted foreground command until its daemon is explicitly stopped', async () => {
  const directory = await mkdtemp(join(tmpdir(), 's14f-')); cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const args = ['--daemon-runtime', directory]; const target = clientDaemonTarget({ daemonRuntime: directory });
  const child = spawn(process.execPath, [fileURLToPath(new URL('../dist/cli.js', import.meta.url)), 'daemon', 'foreground', ...args], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let text = ''; let finished = false;
  child.stdout.on('data', bytes => { text = (text + String(bytes)).slice(-8192); });
  child.stderr.on('data', bytes => { text = (text + String(bytes)).slice(-8192); });
  const exited = new Promise<number>(resolve => {
    child.once('exit', code => { finished = true; resolve(code ?? 1); });
    child.once('error', () => { finished = true; resolve(1); });
  });
  cleanup.push(async () => {
    await runSuccessfully(['stop', '--force', ...args]);
    if (!finished) await exited;
    await vi.waitFor(async () => { const owner = await acquireDaemonOwnership(target); await owner.release(); }, { timeout: 5000 });
  });
  await vi.waitFor(() => { if (finished) throw new Error(text || 'Foreground exited early'); expect(text).toContain('Felan daemon'); }, { timeout: 10_000 });
  expect(finished).toBe(false);
  await runSuccessfully(['stop', ...args]);
  expect(await exited).toBe(0);
}, 20_000);
