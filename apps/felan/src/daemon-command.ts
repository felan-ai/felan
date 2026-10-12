import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import type { DaemonIdentity } from '@felan-ai/session-protocol';
import { SessionClient, type SessionClientOptions } from './client/client.js';
import { clientDaemonTarget } from './client-application.js';
import { resolveInstalledDaemonEntrypoint } from './daemon-entrypoint.js';
import { FELAN_VERSION } from './version.js';
import { DAEMON_VERSION } from '@felan-ai/daemon';
import { waitForDaemonStop } from './client/daemon-stop.js';

const usage = 'Usage: felan daemon [status|start|foreground|stop|restart|logs] [--daemon-runtime <dir>] [--session-dir <dir>] [--yes] [--force]';
const absent = (error: unknown) => ['ENOENT', 'stale_endpoint', 'unavailable'].includes((error as { code?: string }).code ?? '');

export async function runDaemonCommand(args: readonly string[], io: { writeOutput(line: string): void; writeError(line: string): void }, dependencies: {
  createClient?: (options: SessionClientOptions) => SessionClient;
  foreground?: (target: ReturnType<typeof clientDaemonTarget>) => Promise<number>;
} = {}): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) { io.writeOutput(usage); return 0; }
  const action = args[0] && !args[0].startsWith('-') ? args[0] : 'status';
  let yes = false; let force = false; let daemonRuntime: string | undefined; let sessionDir: string | undefined;
  try {
    if (!['status', 'start', 'foreground', 'stop', 'restart', 'logs'].includes(action)) throw new Error(usage);
    for (let i = action === args[0] ? 1 : 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === '--yes') yes = true;
      else if (arg === '--force') force = true;
      else if (arg === '--daemon-runtime' || arg === '--session-dir') {
        const value = args[++i]; if (!value || value.startsWith('-')) throw new Error(usage);
        if (arg === '--daemon-runtime') daemonRuntime = resolve(value); else sessionDir = resolve(value);
      } else throw new Error(usage);
    }
    if ((yes || force) && !['stop', 'restart'].includes(action)) throw new Error('--yes and --force apply only to stop/restart.');
    if (['stop', 'restart'].includes(action) && !yes) throw new Error('Stop and restart require --yes. Add --force only to interrupt active work.');
  } catch (error) { io.writeError((error as Error).message); return 1; }
  const target = clientDaemonTarget({ ...(daemonRuntime ? { daemonRuntime } : {}), ...(sessionDir ? { sessionDir } : {}) });
  if (action === 'foreground') return (dependencies.foreground ?? foreground)(target);
  const makeClient = dependencies.createClient ?? (options => new SessionClient(options));
  let client: SessionClient | undefined;
  const lifetime = new AbortController();
  const interrupt = () => { lifetime.abort(); client?.close(); };
  process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
  try {
    const connect = async (launch = false, replacing?: DaemonIdentity) => {
      client?.close();
      client = makeClient({ target, clientVersion: FELAN_VERSION, expectedDaemonVersion: DAEMON_VERSION, kind: 'tui',
        ...(launch ? { launch: { entrypoint: resolveInstalledDaemonEntrypoint(), ...(replacing ? { replacing } : {}) } } : {}) });
      try { await client.connect(); }
      catch (error) { if (client.status !== 'incompatible' || !client.identity) throw error; }
      return client;
    };
    try { await connect(action === 'start'); }
    catch (error) {
      if (!absent(error)) throw error;
      if (action === 'restart') { await connect(true); io.writeOutput(`Daemon started (${client!.identity!.instanceId}).`); return 0; }
      else { io.writeOutput('Daemon is not running.'); return action === 'status' || action === 'stop' ? 0 : 1; }
    }
    const active = client!;
    if (action === 'stop' || action === 'restart') {
      const identity = active.identity!;
      const response = await active.control(action === 'stop' ? 'host.stop' : 'host.restart', { confirmed: true, mode: force ? 'force' : 'drain' });
      if (response.outcome !== 'accepted') throw new Error('Daemon control was not accepted; inspect status before retrying.');
      await waitForDaemonStop(active, lifetime.signal);
      if (action === 'restart') { await connect(true, identity); io.writeOutput(`Daemon restarted (${client!.identity!.instanceId}).`); }
      else io.writeOutput('Daemon stopped.');
      return 0;
    }
    if (active.status === 'incompatible') {
      const status = await active.control('host.status');
      io.writeOutput(`Daemon ${status.daemonVersion}: ${status.state}. Protocol mismatch; restart requires --yes.`);
      return action === 'status' ? 0 : 1;
    }
    if (action === 'logs') {
      let cursor: string | undefined;
      for (let page = 0; page < 64; page++) {
        const response = await active.request('host.logs', { limit: 100, ...(cursor ? { cursor } : {}) });
        if (response.outcome !== 'accepted') throw new Error('Daemon logs are unavailable or changed; request them again.');
        for (const entry of response.result.entries) io.writeOutput(`${new Date(entry.timestamp).toISOString()} ${entry.level}: ${entry.message}`);
        cursor = response.result.cursor; if (!cursor) return 0;
      }
      throw new Error('Daemon log page limit exceeded.');
    }
    const response = await active.request('host.status', {});
    if (response.outcome !== 'accepted') throw new Error('Daemon status is unavailable.');
    const status = response.result;
    io.writeOutput(`Daemon ${status.daemonVersion}: ${status.state}\nSessions: ${status.active.sessions}; runs: ${status.active.runs}; attachments: ${status.active.attachments}`);
    for (const need of status.setupNeeds) io.writeOutput(need.message);
    return 0;
  } catch (error) { io.writeError(error instanceof Error ? error.message : 'Daemon operation failed.'); return 1; }
  finally { client?.close(); process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt); }
}

async function foreground(target: ReturnType<typeof clientDaemonTarget>): Promise<number> {
  const child = spawn(process.execPath, [resolveInstalledDaemonEntrypoint(), JSON.stringify(target), '--foreground'], { stdio: 'inherit' });
  const stop = () => child.kill('SIGINT');
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try { return await new Promise<number>((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0))); }); }
  finally { process.off('SIGINT', stop); process.off('SIGTERM', stop); }
}
