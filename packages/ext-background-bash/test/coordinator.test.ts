import type { AgentRuntime, AgentRuntimeProcess, AgentRuntimeProcessReadOptions, AgentRuntimeProcessSnapshot } from '@felan-ai/agent-core';
import { describe, expect, it, vi } from 'vitest';
import { BackgroundBashCoordinator, type InteractiveBashProcess } from '../src/coordinator.js';

describe('BackgroundBashCoordinator attached processes', () => {
  it('adopts buffered output from offset zero and rejects stdin without writing', async () => {
    const process = new ControlledProcess();
    process.output = new TextEncoder().encode('before');
    const snapshot = vi.fn(async (_snapshot: InteractiveBashProcess) => {});
    const coordinator = new BackgroundBashCoordinator({} as AgentRuntime, snapshot);
    try {
      await expect(coordinator.adopt('attached', process)).resolves.toMatchObject({ output: 'before', running: true });
      process.output = new TextEncoder().encode('before\nafter');
      await expect(coordinator.read('attached')).resolves.toMatchObject({ output: '\nafter' });
      await expect(coordinator.read('attached')).resolves.toMatchObject({ output: '' });
      await expect(coordinator.write('attached', 'input')).rejects.toThrow(
        'Process stdin is unavailable; start the command with tty: true for interactive input.',
      );
      expect(process.input).toBe('');
      expect(snapshot).toHaveBeenCalledTimes(2);
      expect(snapshot.mock.calls.map(([value]) => value.output)).toEqual(['before', '\nafter']);
    } finally {
      await coordinator.shutdown();
    }
  });

  it('persists the final delta before disposing and removing an attached process', async () => {
    const process = new ControlledProcess();
    const dispose = vi.spyOn(process, 'dispose');
    const saving = deferred();
    const releaseSave = deferred();
    const coordinator = new BackgroundBashCoordinator({} as AgentRuntime, async (snapshot) => {
      if (!snapshot.running) {
        expect(snapshot.output).toBe('final');
        saving.resolve();
        await releaseSave.promise;
      }
    });
    await coordinator.adopt('attached', process);
    process.output = new TextEncoder().encode('final');
    process.running = false;
    const reading = coordinator.read('attached');
    await saving.promise;
    const queued = coordinator.read('attached');
    try {
      expect(dispose).not.toHaveBeenCalled();
      expect(coordinator.has('attached')).toBe(true);
    } finally {
      releaseSave.resolve();
      await Promise.all([reading, queued]);
      await coordinator.shutdown();
    }
    expect(dispose).toHaveBeenCalledOnce();
    expect(coordinator.has('attached')).toBe(false);
    await expect(coordinator.read('attached')).rejects.toThrow('not found');
  });

  it('decodes split UTF-8 bytes without retaining earlier attached output', async () => {
    const process = new ControlledProcess();
    const coordinator = new BackgroundBashCoordinator({} as AgentRuntime);
    const bytes = new TextEncoder().encode('🌍');
    process.output = bytes.slice(0, 2);
    await expect(coordinator.adopt('attached', process)).resolves.toMatchObject({ output: '' });
    process.output = new TextEncoder().encode('🌍next');
    await expect(coordinator.read('attached')).resolves.toMatchObject({ output: '🌍next' });
    process.output = new TextEncoder().encode('🌍next\ud83c');
    process.running = false;
    await expect(coordinator.read('attached')).resolves.toMatchObject({ output: '\uFFFD', running: false });
    expect(coordinator.has('attached')).toBe(false);
  });

  it('stops attached children without stopping host-owned terminals', async () => {
    const attached = new ControlledProcess();
    const pty = new ControlledProcess();
    const terminate = vi.spyOn(attached, 'terminate');
    const dispose = vi.spyOn(attached, 'dispose');
    const snapshots = vi.fn(async () => {});
    const coordinator = new BackgroundBashCoordinator({
      terminals: { startShell: async () => pty, attach: (id: string) => id === 'pty' ? pty : undefined },
    } as unknown as AgentRuntime, snapshots);
    await coordinator.start('pty', 'command');
    await coordinator.adopt('attached', attached);
    await Promise.all([coordinator.stopAttached(), coordinator.stopAttached()]);

    expect(attached.running).toBe(false);
    expect(terminate).toHaveBeenCalledWith('SIGTERM');
    expect(dispose).toHaveBeenCalledOnce();
    expect(coordinator.has('attached')).toBe(false);
    expect(pty.running).toBe(true);
    expect(snapshots).toHaveBeenCalledWith(expect.objectContaining({ id: 'attached', running: false, signal: 'SIGTERM' }));
    await coordinator.shutdown();
    expect(pty.running).toBe(true);
    await pty.dispose();
  });

  it.each(['stopAttached', 'shutdown'] as const)('%s succeeds when a poll removes an attached process before stop', async (shutdown) => {
    const process = new ControlledProcess();
    const dispose = vi.spyOn(process, 'dispose');
    const snapshots = vi.fn(async (_snapshot: InteractiveBashProcess) => {});
    const coordinator = new BackgroundBashCoordinator({} as AgentRuntime, snapshots);
    await coordinator.adopt('attached', process);
    const stop = coordinator.stop.bind(coordinator);
    vi.spyOn(coordinator, 'stop').mockImplementationOnce(async (id, signal) => {
      process.running = false;
      await coordinator.read(id);
      return stop(id, signal);
    });

    await expect(coordinator[shutdown]()).resolves.toBeUndefined();
    expect(dispose).toHaveBeenCalledOnce();
    expect(coordinator.has('attached')).toBe(false);
    expect(snapshots).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'attached', running: false, exitCode: 0 }));
  });

  it('leaves cleanup to the caller when adoption fails', async () => {
    const process = new ControlledProcess();
    const terminate = vi.spyOn(process, 'terminate');
    const dispose = vi.spyOn(process, 'dispose');
    const coordinator = new BackgroundBashCoordinator({} as AgentRuntime, async () => { throw new Error('save failed'); });
    await expect(coordinator.adopt('attached', process)).rejects.toThrow('save failed');
    await coordinator.shutdown();
    expect(coordinator.has('attached')).toBe(false);
    expect(terminate).not.toHaveBeenCalled();
    expect(dispose).not.toHaveBeenCalled();
    await process.dispose();
  });

  it('shuts down attached children even when terminals are host-owned', async () => {
    const process = new ControlledProcess();
    const coordinator = new BackgroundBashCoordinator({ terminals: { attach: () => undefined } } as unknown as AgentRuntime);
    await coordinator.adopt('attached', process);
    await coordinator.shutdown();
    expect(process.running).toBe(false);
    expect(coordinator.has('attached')).toBe(false);
    await expect(coordinator.adopt('later', process)).rejects.toThrow('coordinator is shut down');
  });
});

describe('BackgroundBashCoordinator concurrent reads', () => {
  it('keeps snapshots and input responsive while another caller waits for output', async () => {
    const process = new ControlledProcess();
    const coordinator = createCoordinator(process);
    await coordinator.start('interactive', 'command');
    const waiting = coordinator.read('interactive', 60_000);
    await process.waitEntered.promise;

    try {
      await expect(withDeadline(coordinator.read('interactive'), 250)).resolves.toMatchObject({ running: true });
      await expect(withDeadline(coordinator.write('interactive', 'hello\n'), 250)).resolves.toMatchObject({ running: true });
      expect(process.input).toBe('hello\n');
    } finally {
      process.releaseWait.resolve();
      await waiting;
      await coordinator.shutdown();
    }
  });

  it('does not append an old waiting snapshot after a concurrent write drained it', async () => {
    const process = new ControlledProcess();
    const coordinator = createCoordinator(process);
    await coordinator.start('interactive', 'command');
    const waiting = coordinator.read('interactive', 60_000);
    await process.waitEntered.promise;

    try {
      process.output = new TextEncoder().encode('Привет 🌍\n');
      await coordinator.write('interactive', 'input\n');
      process.releaseWait.resolve();
      const result = await waiting;
      expect(result.output).toBe('Привет 🌍\n');
      expect(result.nextOffset).toBe(process.output.byteLength);
    } finally {
      process.releaseWait.resolve();
      await waiting;
      await coordinator.shutdown();
    }
  });

  it('orders persistence without delaying delivery of input or termination', async () => {
    const process = new ControlledProcess();
    const coordinator = createCoordinator(process);
    const saving = deferred();
    const releaseSave = deferred();
    const saved: string[] = [];
    await coordinator.start('interactive', 'command', undefined, async (snapshot) => {
      if (snapshot.output === 'first') {
        saving.resolve();
        await releaseSave.promise;
      }
      saved.push(snapshot.output);
    });
    process.output = new TextEncoder().encode('first');
    const reading = coordinator.read('interactive');
    await saving.promise;
    process.output = new TextEncoder().encode('first\nfinal');
    const writing = coordinator.write('interactive', 'input\n');
    const stopping = coordinator.stop('interactive', 'SIGKILL');

    try {
      expect(process.input).toBe('input\n');
      await expect(withDeadline(process.terminated.promise, 250)).resolves.toBeUndefined();
      expect(saved).toEqual(['']);
    } finally {
      releaseSave.resolve();
      await Promise.all([reading, writing, stopping]);
      await coordinator.shutdown();
    }
    expect(saved).toEqual(['', 'first', 'first\nfinal']);
  });

  it('isolates split UTF-8 decoding per process and flushes final output', async () => {
    const first = new ControlledProcess();
    const second = new ControlledProcess();
    const coordinator = new BackgroundBashCoordinator({
      terminals: { startShell: async (command: string) => command === 'first' ? first : second },
    } as unknown as AgentRuntime);
    await coordinator.start('first', 'first');
    await coordinator.start('second', 'second');
    try {
      const bytes = new TextEncoder().encode('🌍');
      first.output = bytes.slice(0, 2);
      expect((await coordinator.read('first')).output).toBe('');
      second.output = new TextEncoder().encode('Привет');
      expect((await coordinator.read('second')).output).toBe('Привет');
      first.output = bytes;
      first.running = false;
      expect((await coordinator.read('first')).output).toBe('🌍');
      expect((await coordinator.read('first')).output).toBe('🌍');
    } finally {
      await coordinator.shutdown();
    }
  });

  it('bounds retained output on a UTF-8 character boundary', async () => {
    const process = new ControlledProcess();
    const coordinator = createCoordinator(process);
    await coordinator.start('interactive', 'command');
    try {
      process.output = new TextEncoder().encode(`${'🌍'.repeat(2 * 1024 * 1024)}x`);
      const { output } = await coordinator.read('interactive');
      expect(new TextEncoder().encode(output).byteLength).toBeLessThanOrEqual(8 * 1024 * 1024);
      expect(output.startsWith('🌍')).toBe(true);
      expect(output.endsWith('🌍x')).toBe(true);
      expect(output).not.toContain('\uFFFD');
    } finally {
      await coordinator.shutdown();
    }
  });

  it('waits for in-flight starts during shutdown and rejects new launches', async () => {
    const process = new ControlledProcess();
    const releaseStart = deferred();
    const coordinator = new BackgroundBashCoordinator({
      terminals: { startShell: async () => { await releaseStart.promise; return process; } },
    } as unknown as AgentRuntime);
    const starting = coordinator.start('interactive', 'command');
    const shutdown = coordinator.shutdown();
    await expect(coordinator.start('later', 'command')).rejects.toThrow('coordinator is shut down');
    releaseStart.resolve();
    await Promise.all([starting, shutdown]);
    expect(process.running).toBe(false);
    expect(coordinator.has('interactive')).toBe(false);
  });

  it('surfaces disposal failures while cleaning up other processes exactly once', async () => {
    const first = new ControlledProcess();
    const second = new ControlledProcess();
    const firstDispose = vi.spyOn(first, 'dispose').mockRejectedValue(new Error('dispose failed'));
    const secondDispose = vi.spyOn(second, 'dispose');
    const coordinator = new BackgroundBashCoordinator({
      terminals: { startShell: async (command: string) => command === 'first' ? first : second },
    } as unknown as AgentRuntime);
    await coordinator.start('first', 'first');
    await coordinator.start('second', 'second');
    await expect(coordinator.shutdown()).rejects.toThrow('Failed to shut down interactive background processes');
    await expect(coordinator.shutdown()).rejects.toThrow('Failed to shut down interactive background processes');
    expect(first.running).toBe(false);
    expect(second.running).toBe(false);
    expect(firstDispose).toHaveBeenCalledOnce();
    expect(secondDispose).toHaveBeenCalledOnce();
  });

  it('rejects cancellation without waiting for another snapshot to finish persisting', async () => {
    const process = new ControlledProcess();
    const coordinator = createCoordinator(process);
    const saving = deferred();
    const releaseSave = deferred();
    await coordinator.start('interactive', 'command', undefined, async (snapshot) => {
      if (snapshot.output === 'blocked') { saving.resolve(); await releaseSave.promise; }
    });
    process.output = new TextEncoder().encode('blocked');
    const reading = coordinator.read('interactive');
    await saving.promise;
    const controller = new AbortController();
    const waiting = coordinator.read('interactive', 60_000, controller.signal)
      .then(() => undefined, (error: unknown) => error);
    await process.waitEntered.promise;
    controller.abort();
    process.releaseWait.resolve();
    try {
      await expect(withDeadline(waiting, 250)).resolves.toMatchObject({ name: 'AbortError' });
    } finally {
      releaseSave.resolve();
      await Promise.all([reading, waiting]);
      await coordinator.shutdown();
    }
  });

  it.each(['natural exit', 'retry SIGKILL'])('does not retain a failed stop signal before %s', async (outcome) => {
    const process = new ControlledProcess();
    const terminate = vi.spyOn(process, 'terminate').mockRejectedValueOnce(new Error('signal failed'));
    const coordinator = createCoordinator(process);
    await coordinator.start('interactive', 'command');
    try {
      await expect(coordinator.stop('interactive', 'SIGTERM')).rejects.toThrow('signal failed');
      if (outcome === 'natural exit') {
        process.running = false;
        const result = await coordinator.read('interactive');
        expect(result.signal).toBeUndefined();
        expect(result.exitCode).toBe(0);
      } else {
        expect((await coordinator.stop('interactive', 'SIGKILL')).signal).toBe('SIGKILL');
      }
    } finally {
      terminate.mockRestore();
      await coordinator.shutdown();
    }
  });

  it('retains a handle and rejects shutdown when failed startup cannot be cleaned up', async () => {
    const process = new ControlledProcess();
    const terminate = vi.spyOn(process, 'terminate').mockRejectedValue(new Error('signal failed'));
    const dispose = vi.spyOn(process, 'dispose').mockRejectedValue(new Error('dispose failed'));
    const coordinator = createCoordinator(process);
    let failPersistence = true;
    const starting = coordinator.start('interactive', 'command', undefined, async () => {
      if (failPersistence) throw new Error('persistence failed');
    }).then(() => undefined, (error: unknown) => error);
    const shutdown = coordinator.shutdown().then(() => undefined, (error: unknown) => error);
    try {
      expect(await starting).toBeInstanceOf(AggregateError);
      expect(await shutdown).toBeInstanceOf(AggregateError);
      expect(coordinator.has('interactive')).toBe(true);
    } finally {
      terminate.mockRestore();
      dispose.mockRestore();
      failPersistence = false;
      if (coordinator.has('interactive')) await coordinator.stop('interactive');
      await process.dispose();
    }
  });

  it('coalesces overlapping stops so only one attempt owns the signal', async () => {
    const process = new ControlledProcess();
    const entered = deferred();
    const release = deferred();
    const terminate = vi.spyOn(process, 'terminate').mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      throw new Error('signal failed');
    });
    const coordinator = createCoordinator(process);
    await coordinator.start('interactive', 'command');
    const first = coordinator.stop('interactive', 'SIGTERM').then(() => undefined, (error: unknown) => error);
    await entered.promise;
    const second = coordinator.stop('interactive', 'SIGKILL').then(() => undefined, (error: unknown) => error);
    try {
      release.resolve();
      expect(await first).toMatchObject({ message: 'signal failed' });
      expect(await second).toMatchObject({ message: 'signal failed' });
      expect(terminate).toHaveBeenCalledTimes(1);
      expect((await coordinator.stop('interactive', 'SIGKILL')).signal).toBe('SIGKILL');
    } finally {
      release.resolve();
      await Promise.all([first, second]);
      await coordinator.shutdown();
    }
  });
});

class ControlledProcess implements AgentRuntimeProcess {
  readonly pid = 123;
  readonly waitEntered = deferred();
  readonly releaseWait = deferred();
  readonly terminated = deferred();
  output = new Uint8Array();
  input = '';
  running = true;

  async read(offset: number, options?: AgentRuntimeProcessReadOptions): Promise<AgentRuntimeProcessSnapshot> {
    if ((options?.waitMs ?? 0) > 0) {
      this.waitEntered.resolve();
      await this.releaseWait.promise;
    }
    return {
      output: this.output.slice(offset),
      nextOffset: this.output.byteLength,
      running: this.running,
      ...(!this.running ? { exitCode: 0 } : {}),
    };
  }

  async write(content: Uint8Array): Promise<void> { this.input += new TextDecoder().decode(content); }
  async terminate(): Promise<void> {
    this.running = false;
    this.releaseWait.resolve();
    this.terminated.resolve();
  }
  async dispose(): Promise<void> { await this.terminate(); }
}

function createCoordinator(process: AgentRuntimeProcess): BackgroundBashCoordinator {
  return new BackgroundBashCoordinator({
    terminals: { startShell: async () => process },
  } as unknown as AgentRuntime);
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  return { promise: new Promise<void>((done) => { resolve = done; }), resolve: () => resolve() };
}

async function withDeadline<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Operation blocked behind a waiting read')), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
