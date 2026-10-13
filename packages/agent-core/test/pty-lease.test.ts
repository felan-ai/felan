import { closeSync, constants, fstatSync, openSync } from 'node:fs';
import { spawn } from '@lydell/node-pty';
import type { IDisposable, IPty } from '@lydell/node-pty';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HostAgentRuntime } from '../src/host-agent-runtime.js';

vi.mock('node:fs', async original => {
  const fs = await original<typeof import('node:fs')>();
  return {
    ...fs,
    openSync: vi.fn(fs.openSync),
    fstatSync: vi.fn(fs.fstatSync),
    closeSync: vi.fn(fs.closeSync),
  };
});

vi.mock('@lydell/node-pty', () => ({ spawn: vi.fn() }));

const retainedFd = 73;
const currentUid = process.getuid?.() ?? 0;
let terminal: FakePty;

beforeEach(() => {
  terminal = new FakePty('/dev/pts/42');
  vi.mocked(spawn).mockReset().mockReturnValue(terminal);
  vi.mocked(openSync).mockReset().mockReturnValue(retainedFd);
  vi.mocked(fstatSync).mockReset().mockReturnValue(fakeStats(true, currentUid));
  vi.mocked(closeSync).mockReset().mockImplementation(() => undefined);
  vi.spyOn(process, 'kill').mockImplementation((_pid, signal) => {
    terminal.emitExit({ exitCode: 0, signal: signal === 'SIGKILL' ? 9 : 15 });
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe.skipIf(process.platform !== 'linux')('Linux PTY slave lease', () => {
  it('opens the owned character-device slave without following links or acquiring a controlling terminal', async () => {
    const handle = await startTerminal();

    expect(openSync).toHaveBeenCalledOnce();
    expect(openSync).toHaveBeenCalledWith(
      '/dev/pts/42',
      constants.O_RDWR | constants.O_NOCTTY | constants.O_NOFOLLOW,
    );
    expect(fstatSync).toHaveBeenCalledOnce();
    expect(fstatSync).toHaveBeenCalledWith(retainedFd);
    expect(closeSync).not.toHaveBeenCalled();

    await handle.dispose();
  });

  it('closes the retained slave before reporting a normal PTY exit', async () => {
    const events: string[] = [];
    vi.mocked(closeSync).mockImplementation(() => { events.push('close'); });
    const handle = await startTerminal();
    const completion = handle.read(0, { waitMs: 1_000 }).then(snapshot => {
      events.push('complete');
      return snapshot;
    });

    terminal.emitExit({ exitCode: 7 });

    await expect(completion).resolves.toMatchObject({ running: false, exitCode: 7 });
    expect(events).toEqual(['close', 'complete']);
    await handle.dispose();
    expect(closeSync).toHaveBeenCalledOnce();
  });

  it('defers a slave close failure until disposal after completing the exit callback', async () => {
    const closeError = new Error('synthetic close failure');
    vi.mocked(closeSync).mockImplementation(() => { throw closeError; });
    const handle = await startTerminal();

    expect(() => terminal.emitExit({ exitCode: 7 })).not.toThrow();
    await expect(handle.read(0)).resolves.toMatchObject({ running: false, exitCode: 7 });
    await expect(handle.dispose()).rejects.toBe(closeError);

    expect(terminal.dataSubscription.dispose).toHaveBeenCalledOnce();
    expect(terminal.exitSubscription.dispose).toHaveBeenCalledOnce();
  });

  it('disposes the lease, subscriptions, and process idempotently', async () => {
    const handle = await startTerminal();

    await handle.dispose();
    await handle.dispose();

    expect(process.kill).toHaveBeenCalledOnce();
    expect(process.kill).toHaveBeenCalledWith(-terminal.pid, 'SIGTERM');
    expect(closeSync).toHaveBeenCalledOnce();
    expect(closeSync).toHaveBeenCalledWith(retainedFd);
    expect(terminal.dataSubscription.dispose).toHaveBeenCalledOnce();
    expect(terminal.exitSubscription.dispose).toHaveBeenCalledOnce();
  });

  it('cleans up a terminal whose slave path is invalid without opening a descriptor', async () => {
    terminal._pty = '/tmp/not-a-pty';

    await expect(startTerminal()).rejects.toThrow('PTY slave path is unavailable.');

    expect(openSync).not.toHaveBeenCalled();
    expect(closeSync).not.toHaveBeenCalled();
    expect(process.kill).toHaveBeenCalledWith(-terminal.pid, 'SIGKILL');
    expect(terminal.dataSubscription.dispose).toHaveBeenCalledOnce();
    expect(terminal.exitSubscription.dispose).toHaveBeenCalledOnce();
  });

  it.each([
    ['not a character device', false, currentUid],
    ['owned by another user', true, currentUid + 1],
  ])('closes the opened descriptor and cleans up when the slave is %s', async (_case, characterDevice, uid) => {
    vi.mocked(fstatSync).mockReturnValue(fakeStats(characterDevice, uid));

    await expect(startTerminal()).rejects.toThrow('PTY slave ownership is invalid.');

    expect(closeSync).toHaveBeenCalledOnce();
    expect(closeSync).toHaveBeenCalledWith(retainedFd);
    expect(process.kill).toHaveBeenCalledWith(-terminal.pid, 'SIGKILL');
    expect(terminal.dataSubscription.dispose).toHaveBeenCalledOnce();
    expect(terminal.exitSubscription.dispose).toHaveBeenCalledOnce();
  });

  it('preserves validation and descriptor cleanup failures together', async () => {
    const closeError = new Error('descriptor cleanup failed');
    vi.mocked(fstatSync).mockReturnValue(fakeStats(false, currentUid));
    vi.mocked(closeSync).mockImplementation(() => { throw closeError; });
    const error = await startTerminal().catch(failure => failure);
    expect(error).toBeInstanceOf(AggregateError);
    expect(error.errors).toEqual([expect.objectContaining({ message: 'PTY slave ownership is invalid.' }), closeError]);
    expect(closeSync).toHaveBeenCalledOnce();
    expect(terminal.exitSubscription.dispose).toHaveBeenCalledOnce();
  });

  it('does not duplicate a cached termination failure during startup cleanup', async () => {
    const terminationError = new Error('termination failed');
    terminal._pty = '/tmp/not-a-pty';
    vi.mocked(process.kill).mockImplementation(() => { throw terminationError; });
    const error = await startTerminal().catch(failure => failure);
    expect(error).toBeInstanceOf(AggregateError);
    expect(error.errors).toEqual([expect.objectContaining({ message: 'PTY slave path is unavailable.' }), terminationError]);
    expect(process.kill).toHaveBeenCalledOnce();
    expect(terminal.exitSubscription.dispose).toHaveBeenCalledOnce();
  });
});

function startTerminal() {
  const root = process.cwd();
  const runtime = new HostAgentRuntime(root, {
    sessionStorageRoot: root,
    agentStorageRoot: root,
  });
  return runtime.terminals.startShell('printf test', { shellFlavor: 'posix' });
}

function fakeStats(characterDevice: boolean, uid: number): ReturnType<typeof fstatSync> {
  return { isCharacterDevice: () => characterDevice, uid } as ReturnType<typeof fstatSync>;
}

class FakePty implements IPty {
  readonly pid = 4_321;
  readonly cols = 80;
  readonly rows = 24;
  readonly process = '/bin/sh';
  handleFlowControl = false;
  _pty: unknown;
  readonly dataSubscription: IDisposable = { dispose: vi.fn() };
  readonly exitSubscription: IDisposable = { dispose: vi.fn() };
  #exitListener: ((event: { exitCode: number; signal?: number }) => unknown) | undefined;

  constructor(path: unknown) {
    this._pty = path;
  }

  readonly onData: IPty['onData'] = () => this.dataSubscription;

  readonly onExit: IPty['onExit'] = listener => {
    this.#exitListener = listener;
    return this.exitSubscription;
  };

  emitExit(event: { exitCode: number; signal?: number }): void {
    this.#exitListener?.(event);
  }

  resize(): void { }
  clear(): void { }
  write(): void { }
  kill(): void { }
  pause(): void { }
  resume(): void { }
}
