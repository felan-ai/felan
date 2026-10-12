import { spawn } from 'node:child_process';
import { closeSync, fstatSync, ftruncateSync, readSync, realpathSync, writeSync } from 'node:fs';
import { Socket } from 'node:net';
import { join } from 'node:path';
import { encodeFrame, type DaemonIdentity } from '@felan-ai/session-protocol';
import { DaemonSecurityError } from './native-ownership.js';
import { probeDaemon, readControlFrame, readinessResponse } from './ipc.js';
import { assertTargetIdentity, openPrivateFile, resolveDaemonTarget, type DaemonTarget } from './target.js';
import type { DaemonOwnership } from './ownership.js';

export interface DaemonLaunchReceipt {
  readonly target: DaemonTarget;
  readonly identity: DaemonIdentity;
  readonly daemonVersion: string;
}

export async function spawnDetachedDaemon(options: {
  target: DaemonTarget;
  entrypoint: string;
  timeoutMs?: number;
  replacing?: DaemonIdentity;
}): Promise<DaemonLaunchReceipt> {
  const target = resolveDaemonTarget(options.target);
  const executable = realpathSync(process.execPath);
  const entrypoint = realpathSync(options.entrypoint);
  const timeoutMs = options.timeoutMs ?? 10_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000) throw new DaemonSecurityError('invalid_launch', 'Readiness deadline must be between 100 and 60000 milliseconds.');
  if (options.replacing) assertTargetIdentity(target, options.replacing, options.replacing);
  const child = spawn(executable, [entrypoint, JSON.stringify(options.target), ...(options.replacing ? ['--replace', JSON.stringify(options.replacing)] : [])], {
    cwd: process.cwd(),
    env: process.env,
    detached: true,
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'ignore', 'pipe'],
  });
  const deadline = performance.now() + timeoutMs;
  const channel = child.stdio[3] as Socket;
  let exitError: ((error: Error) => void) | undefined;
  const exited = new Promise<never>((_resolve, reject) => { exitError = reject; });
  const onError = () => exitError?.(new DaemonSecurityError('launch_failed', 'Could not spawn the resolved Node executable.'));
  const onExit = (code: number | null) => exitError?.(new DaemonSecurityError('launch_failed', `Daemon child exited before authenticated readiness (exit ${code ?? 'signal'}). Inspect its bounded runtime diagnostics.`));
  child.once('error', onError); child.once('exit', onExit);
  channel.on('error', () => {});
  try {
    const ready = await Promise.race([readControlFrame(channel, timeoutMs), exited]);
    assertTargetIdentity(target, ready.identity, ready.identity);
    if (ready.re !== 'launch' || !['ready', 'blocked'].includes(ready.state) || ready.outcome !== 'accepted') throw new DaemonSecurityError('invalid_readiness', 'Child did not report an available daemon.');
    const remaining = deadline - performance.now();
    if (remaining <= 0) throw new DaemonSecurityError('readiness_timeout', 'Daemon did not become ready before the deadline.');
    await probeDaemon(target, ready.identity, Math.min(remaining, 2_000), true);
    await new Promise<void>((resolve, reject) => channel.write(Buffer.from([1]), error => error ? reject(error) : resolve()));
    channel.end(); channel.unref(); child.unref();
    return Object.freeze({ target: options.target, identity: ready.identity, daemonVersion: ready.daemonVersion });
  } catch (error) {
    if (error instanceof DaemonSecurityError && error.code === 'unavailable' && channel.readableEnded) {
      let timer: NodeJS.Timeout | undefined;
      try { await Promise.race([exited, new Promise<void>(resolve => { timer = setTimeout(resolve, Math.max(0, Math.min(100, deadline - performance.now()))); })]); }
      finally { clearTimeout(timer); }
    }
    throw error;
  } finally {
    child.off('error', onError); child.off('exit', onExit);
    // Closing the launch channel aborts an unacknowledged cooperative child. Never signal a PID from a receipt.
    if (!channel.writableEnded) channel.destroy();
    child.unref();
  }
}

export async function publishDaemonReadiness(owner: DaemonOwnership, version: string, timeoutMs = 10_000, state: 'ready' | 'blocked' = 'ready'): Promise<void> {
  owner.assertCurrent();
  const channel = new Socket({ fd: 3, readable: true, writable: true });
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new DaemonSecurityError('launch_aborted', 'Launcher did not acknowledge readiness.')), timeoutMs);
      const settle = (error?: Error) => {
        clearTimeout(timeout); channel.removeAllListeners('data'); channel.removeAllListeners('end'); channel.removeAllListeners('error');
        if (error) reject(error); else resolve();
      };
      channel.once('data', (bytes: Buffer) => settle(bytes.length === 1 && bytes[0] === 1 ? undefined : new DaemonSecurityError('launch_aborted', 'Invalid readiness acknowledgement.')));
      channel.once('end', () => settle(new DaemonSecurityError('launch_aborted', 'Launcher left before readiness.')));
      channel.once('error', () => settle(new DaemonSecurityError('launch_aborted', 'Launch channel failed.')));
      channel.write(encodeFrame(readinessResponse(owner, version, 'launch', state)));
    });
    owner.assertCurrent();
  } finally { channel.destroy(); }
}

export class BoundedDaemonLogs {
  private readonly files: Record<'stdout' | 'stderr', number>;
  private readonly buffers = { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
  private closed = false;
  constructor(private readonly owner: DaemonOwnership, private readonly limitBytes = 32_768) {
    owner.assertCurrent();
    if (!Number.isInteger(limitBytes) || limitBytes < 128 || limitBytes > 1_048_576) throw new DaemonSecurityError('invalid_logs', 'Diagnostic capacity must be between 128 and 1048576 bytes.');
    const stdout = openPrivateFile(join(owner.target.runtimeDirectory, 'stdout.log'), owner.target.uid);
    let stderr: number | undefined;
    try {
      stderr = openPrivateFile(join(owner.target.runtimeDirectory, 'stderr.log'), owner.target.uid);
      this.files = { stdout, stderr };
      for (const stream of ['stdout', 'stderr'] as const) {
        const size = fstatSync(this.files[stream]).size;
        if (!Number.isSafeInteger(size)) throw new DaemonSecurityError('invalid_logs', 'Diagnostic size is unsafe.');
        const tail = Buffer.alloc(Math.min(size, limitBytes));
        const bytes = readSync(this.files[stream], tail, 0, tail.length, size - tail.length);
        this.buffers[stream] = tail.subarray(0, bytes);
        ftruncateSync(this.files[stream], bytes);
        if (bytes) writeSync(this.files[stream], this.buffers[stream], 0, bytes, 0);
      }
    } catch (error) { closeSync(stdout); if (stderr !== undefined) closeSync(stderr); throw error; }
  }
  read(stream: 'stdout' | 'stderr'): string {
    if (this.closed) throw new DaemonSecurityError('logs_closed', 'Daemon diagnostic sink is closed.');
    this.owner.assertCurrent(); return this.buffers[stream].toString('utf8');
  }
  write(stream: 'stdout' | 'stderr', diagnostic: string): void {
    if (this.closed) throw new DaemonSecurityError('logs_closed', 'Daemon diagnostic sink is closed.');
    this.owner.assertCurrent();
    const bytes = Buffer.from(`${diagnostic.slice(-this.limitBytes).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '?')}\n`);
    this.buffers[stream] = Buffer.concat([this.buffers[stream], bytes.subarray(-this.limitBytes)]).subarray(-this.limitBytes);
    ftruncateSync(this.files[stream], 0); writeSync(this.files[stream], this.buffers[stream], 0, this.buffers[stream].length, 0);
  }
  close(): void {
    if (this.closed) return;
    this.closed = true; closeSync(this.files.stdout); closeSync(this.files.stderr);
  }
}
