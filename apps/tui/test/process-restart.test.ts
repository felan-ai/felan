import { mkdtemp, mkdir, readFile, realpath, rm } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { restartFelanProcess } from '../src/process-restart.js';

const temporaryPaths: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

describe('Felan process restart', () => {
  it('materializes a new session and replaces the process with the same session', async () => {
    const root = await temporaryDirectory();
    const cwd = join(root, 'workspace');
    const sessionDir = join(root, 'sessions');
    await mkdir(cwd, { recursive: true });
    const sessionManager = SessionManager.create(cwd, sessionDir);
    const previousCwd = process.cwd();
    const canonicalCwd = await realpath(cwd);
    const execve = vi.fn(() => {
      expect(process.cwd()).toBe(canonicalCwd);
      throw new Error('execve called');
    });

    await expect(restartFelanProcess({
      sessionManager,
      verbose: true,
      restartArgs: ['--powerline-style', 'capsule'],
      execve,
    })).rejects.toThrow('execve called');

    expect(execve).toHaveBeenCalledWith(
      process.execPath,
      [process.execPath, process.argv[1], '--powerline-style', 'capsule', '--session-dir', sessionDir, '--session', sessionManager.getSessionId(), '--verbose'],
      process.env,
    );
    const sessionFile = sessionManager.getSessionFile()!;
    const content = await readFile(sessionFile, 'utf8');
    expect(JSON.parse(content).id).toBe(sessionManager.getSessionId());
    expect(process.cwd()).toBe(previousCwd);
  });

  it('leaves an already persisted session file unchanged', async () => {
    const root = await temporaryDirectory();
    const cwd = join(root, 'workspace');
    const sessionDir = join(root, 'sessions');
    await mkdir(cwd, { recursive: true });
    const sessionManager = SessionManager.create(cwd, sessionDir);
    sessionManager.appendMessage({ role: 'user', content: 'persisted', timestamp: Date.now() });
    sessionManager.appendMessage({
      role: 'assistant',
      content: [{ type: 'text', text: 'response' }],
      api: 'test', provider: 'test', model: 'test',
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: 'stop', timestamp: Date.now(),
    });
    const before = await readFile(sessionManager.getSessionFile()!, 'utf8');
    const execve = vi.fn(() => { throw new Error('execve called'); });

    await expect(restartFelanProcess({ sessionManager, verbose: false, execve })).rejects.toThrow('execve called');

    await expect(readFile(sessionManager.getSessionFile()!, 'utf8')).resolves.toBe(before);
  });

  it('supervises a replacement child when execve is unavailable', async () => {
    const root = await temporaryDirectory();
    const cwd = join(root, 'workspace');
    const sessionDir = join(root, 'sessions');
    await mkdir(cwd, { recursive: true });
    const sessionManager = SessionManager.create(cwd, sessionDir);
    const child = new EventEmitter();
    const spawn = vi.fn(() => {
      queueMicrotask(() => child.emit('close', 0));
      return child as ReturnType<typeof import('node:child_process').spawn>;
    });
    const exit = vi.fn(() => { throw new Error('exit called'); });

    await expect(restartFelanProcess({
      sessionManager,
      verbose: false,
      platform: 'win32',
      spawn,
      exit,
    })).rejects.toThrow('exit called');

    expect(spawn).toHaveBeenCalledWith(
      process.execPath,
      [process.argv[1], '--session-dir', sessionDir, '--session', sessionManager.getSessionId()],
      expect.objectContaining({
        cwd,
        env: expect.objectContaining({ FELAN_RESTART_WORKER: '1' }),
        stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
        windowsHide: false,
      }),
    );
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('reuses one supervisor for repeated child restart requests', async () => {
    const root = await temporaryDirectory();
    const cwd = join(root, 'workspace');
    const sessionDir = join(root, 'sessions');
    await mkdir(cwd, { recursive: true });
    const sessionManager = SessionManager.create(cwd, sessionDir);
    const replacement = {
      type: 'felan-restart',
      sessionId: 'replacement-session',
      sessionDir,
      cwd,
      verbose: false,
      restartArgs: ['--powerline-style', 'capsule'],
    };
    const children = [new EventEmitter(), new EventEmitter()];
    const spawn = vi.fn(() => {
      const child = children[spawn.mock.calls.length - 1]!;
      queueMicrotask(() => {
        if (child === children[0]) {
          child.emit('message', replacement);
          child.emit('close', 75);
        } else {
          child.emit('close', 0);
        }
      });
      return child as ReturnType<typeof import('node:child_process').spawn>;
    });
    const exit = vi.fn(() => { throw new Error('exit called'); });

    await expect(restartFelanProcess({
      sessionManager,
      verbose: false,
      platform: 'win32',
      spawn,
      exit,
    })).rejects.toThrow('exit called');

    expect(spawn).toHaveBeenCalledTimes(2);
    expect(spawn.mock.calls[1]?.[1]).toEqual([
      process.argv[1],
      '--powerline-style', 'capsule',
      '--session-dir', sessionDir,
      '--session', 'replacement-session',
    ]);
    expect(exit).toHaveBeenCalledOnce();
  });

  it('hands a supervised worker restart back to its parent', async () => {
    const root = await temporaryDirectory();
    const cwd = join(root, 'workspace');
    const sessionDir = join(root, 'sessions');
    await mkdir(cwd, { recursive: true });
    const sessionManager = SessionManager.create(cwd, sessionDir);
    const send = vi.fn((_message, callback) => {
      callback(null);
      return true;
    });
    const spawn = vi.fn();
    const exit = vi.fn(() => { throw new Error('exit called'); });

    await expect(restartFelanProcess({
      sessionManager,
      verbose: true,
      platform: 'win32',
      env: { FELAN_RESTART_WORKER: '1' },
      send,
      spawn,
      exit,
    })).rejects.toThrow('exit called');

    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'felan-restart',
      sessionId: sessionManager.getSessionId(),
      sessionDir,
      cwd,
      verbose: true,
    }), expect.any(Function));
    expect(spawn).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(75);
  });
});

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'felan-process-restart-'));
  temporaryPaths.push(path);
  return path;
}
