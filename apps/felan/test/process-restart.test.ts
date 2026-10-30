import { expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { spawn } from 'node:child_process';
import { restartFelanProcess, takeRestartDaemonIdentity } from '../src/process-restart.js';

const identity = { namespaceId: 'production', instanceId: 'old', agentDir: '/agent', rootSet: ['/agent'] };

it('re-executes the CLI entrypoint with the launch options and the resumed session', async () => {
  const execve = vi.fn((() => { throw new Error('exec'); }) as (file: string, args: readonly string[], env: NodeJS.ProcessEnv) => never);
  const cwd = process.cwd();
  await expect(restartFelanProcess({ sessionId: 'session-1', cwd, restartArgs: ['--verbose'], execve, platform: 'darwin', env: { KEEP: '1' } })).rejects.toThrow('exec');
  expect(execve).toHaveBeenCalledExactlyOnceWith(process.execPath, [process.execPath, process.argv[1], '--verbose', '--session', 'session-1'], { KEEP: '1' });
  expect(process.cwd()).toBe(cwd);
});

it('hands the restart to a supervising parent where execve is unavailable', async () => {
  const send = vi.fn((_message: unknown, callback: (error: Error | null) => void) => { callback(null); return true; });
  const exit = vi.fn((code: number) => { throw new Error(`exit ${code}`); }) as unknown as (code: number) => never;
  await expect(restartFelanProcess({ sessionId: 'session-1', cwd: '/workspace', replacing: identity, platform: 'win32', env: { FELAN_RESTART_WORKER: '1' }, send, exit })).rejects.toThrow('exit 75');
  expect(send).toHaveBeenCalledWith({ type: 'felan-restart', sessionId: 'session-1', cwd: '/workspace', restartArgs: [], replacing: identity }, expect.any(Function));
});

it('carries the replacement identity through exec without retaining it for ordinary child processes', async () => {
  const execve = vi.fn((() => { throw new Error('exec'); }) as (file: string, args: readonly string[], env: NodeJS.ProcessEnv) => never);
  const env = { KEEP: '1' };
  await expect(restartFelanProcess({ cwd: process.cwd(), replacing: identity, execve, platform: 'darwin', env })).rejects.toThrow('exec');
  const nextEnv = execve.mock.calls[0]![2];
  expect(takeRestartDaemonIdentity(nextEnv)).toEqual(identity);
  expect(nextEnv).toEqual(env);
  expect(takeRestartDaemonIdentity(nextEnv)).toBeUndefined();
});

it('uses each Windows worker handoff identity instead of the supervisor initial identity', async () => {
  const second = { ...identity, instanceId: 'second' };
  const environments: NodeJS.ProcessEnv[] = [];
  const spawnWorker = vi.fn((_file, _args, options) => {
    environments.push(options.env);
    const child = new EventEmitter();
    queueMicrotask(() => {
      if (environments.length === 1) child.emit('message', { type: 'felan-restart', cwd: '/next', restartArgs: ['--verbose'], replacing: second });
      child.emit('close', environments.length === 1 ? 75 : 0);
    });
    return child;
  }) as unknown as typeof spawn;
  const exit = (code: number): never => { throw new Error(`exit ${code}`); };
  await expect(restartFelanProcess({ cwd: '/first', replacing: identity, platform: 'win32', env: { KEEP: '1' }, spawn: spawnWorker, exit })).rejects.toThrow('exit 0');
  expect(spawnWorker).toHaveBeenCalledTimes(2);
  expect(environments.map(env => takeRestartDaemonIdentity(env))).toEqual([identity, second]);
  expect(environments.every(env => env.KEEP === '1')).toBe(true);
});

it('ignores an invalid replacement identity from a Windows worker', async () => {
  const spawnWorker = vi.fn(() => {
    const child = new EventEmitter();
    queueMicrotask(() => {
      child.emit('message', { type: 'felan-restart', cwd: '/next', restartArgs: [], replacing: { instanceId: 'invalid' } });
      child.emit('close', 75);
    });
    return child;
  }) as unknown as typeof spawn;
  const exit = (code: number): never => { throw new Error(`exit ${code}`); };
  await expect(restartFelanProcess({ cwd: '/first', platform: 'win32', env: {}, spawn: spawnWorker, exit })).rejects.toThrow('exit 75');
  expect(spawnWorker).toHaveBeenCalledOnce();
});
