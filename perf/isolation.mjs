import { mkdtempSync, mkdirSync, chmodSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { sleep, HERE } from './lib.mjs';

export function createIsolation() {
  const root = mkdtempSync('/tmp/fpb-');
  const runtime = join(root, 'rt');
  for (const path of ['', 'tmp', '.felan/agent', '.config', '.cache', '.local/share', 'run', 'rt', 'work']) {
    mkdirSync(join(root, path), { recursive: true, mode: 0o700 });
  }
  chmodSync(root, 0o700);
  const env = {
    PATH: process.env.PATH, LANG: process.env.LANG || 'en_US.UTF-8', TERM: 'xterm-256color', COLORTERM: 'truecolor', SHELL: '/bin/bash', USER: process.env.USER || '',
    HOME: root, TMPDIR: join(root, 'tmp'), FELAN_AGENT_DIR: join(root, '.felan'), PI_CODING_AGENT_DIR: join(root, '.felan/agent'),
    XDG_CONFIG_HOME: join(root, '.config'), XDG_CACHE_HOME: join(root, '.cache'), XDG_DATA_HOME: join(root, '.local/share'), XDG_RUNTIME_DIR: join(root, 'run'),
    PI_OFFLINE: '1', PI_TELEMETRY: '0', PI_SKIP_VERSION_CHECK: '1', FELAN_SKIP_VERSION_CHECK: '1', CI: '1',
    PROBE_RUNTIME: runtime, PROBE_CWD: join(root, 'work'),
  };
  // Deliberately no inherited credentials, NODE_OPTIONS, compile cache, or agent settings.
  for (const name of ['ASCII_MARK', 'SEED_TURNS', 'FAKE_TOKENS', 'FAKE_INTERVAL_MS', 'SEED_TOKENS', 'SEED_INTERVAL_MS']) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  return { root, runtime, env };
}
export function processesUsing(path) {
  return execFileSync('ps', ['-A', '-o', 'pid=,args='], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }).split('\n').flatMap(line => {
    const match = line.match(/^\s*(\d+)\s+(.*)$/);
    if (!match || !match[2].includes(path)) return [];
    return [{ pid: Number(match[1]), command: match[2] }];
  }).filter(({ pid }) => pid !== process.pid);
}
export function ownedProcesses(runtime) {
  return processesUsing(runtime).filter(({ command }) => /(?:daemon-host\.js|fake-provider\.mjs|bench-transport\.mjs|pty-driver\.py|\/dist\/cli\.js)/.test(command));
}
async function requestGracefulStop(isolation) {
  if (!ownedProcesses(isolation.runtime).some(p => p.command.includes('/daemon-host.js'))) return;
  const child = spawn(process.execPath, [join(HERE, 'stop-daemon.mjs')], {
    env: isolation.env, cwd: isolation.root, stdio: 'ignore',
  });
  await new Promise(resolve => {
    const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
    child.once('error', () => { clearTimeout(timer); resolve(); });
    child.once('exit', () => { clearTimeout(timer); resolve(); });
  });
}
export async function cleanupIsolation(isolation) {
  const { root, runtime } = isolation;
  if (!/^\/tmp\/fpb-[^/]+$/.test(root) || runtime !== join(root, 'rt')) throw new Error('Refusing cleanup of an unowned runtime');
  await requestGracefulStop(isolation);
  for (const signal of ['SIGTERM', 'SIGKILL']) {
    for (const { pid } of ownedProcesses(runtime)) { try { process.kill(pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
    for (let i = 0; i < 60 && ownedProcesses(runtime).length; i++) await sleep(50);
  }
  if (processesUsing(root).length) throw new Error('Isolated benchmark processes did not stop; preserving their runtime directory');
  // In-flight filesystem requests can finish just after a process disappears from ps.
  let absent = 0;
  for (let attempt = 0; attempt < 10 && absent < 3; attempt++) {
    rmSync(root, { recursive: true, force: true });
    await sleep(100);
    if (processesUsing(root).length) throw new Error('Isolated process restarted during cleanup');
    absent = existsSync(root) ? 0 : absent + 1;
  }
  if (existsSync(root)) throw new Error('Isolated temporary directory was recreated during cleanup');
}
