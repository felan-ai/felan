import type { AgentRuntime, AgentRuntimeProcess, AgentRuntimeProcessReadOptions, AgentRuntimeProcessSnapshot } from '@felan-ai/agent-core';
import { describe, expect, it, vi } from 'vitest';
import { BackgroundBashCoordinator } from '../src/coordinator.js';

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
