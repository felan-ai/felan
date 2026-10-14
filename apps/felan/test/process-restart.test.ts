import { expect, it, vi } from 'vitest';
import { restartFelanProcess } from '../src/process-restart.js';

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
  await expect(restartFelanProcess({ sessionId: 'session-1', cwd: '/workspace', platform: 'win32', env: { FELAN_RESTART_WORKER: '1' }, send, exit })).rejects.toThrow('exit 75');
  expect(send).toHaveBeenCalledWith({ type: 'felan-restart', sessionId: 'session-1', cwd: '/workspace', restartArgs: [] }, expect.any(Function));
});
