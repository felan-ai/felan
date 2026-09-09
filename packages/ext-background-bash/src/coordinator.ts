import type { AgentRuntime, AgentRuntimeProcess } from '@felan-ai/agent-core';

const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface InteractiveBashProcess {
  readonly id: string;
  readonly process: AgentRuntimeProcess;
  readonly output: string;
  readonly running: boolean;
  readonly nextOffset: number;
  readonly exitCode?: number;
  readonly signal?: 'SIGTERM' | 'SIGKILL';
}

interface Entry {
  readonly process: AgentRuntimeProcess;
  readonly onSnapshot: ((snapshot: InteractiveBashProcess) => Promise<void>) | undefined;
  readonly decoder: TextDecoder;
  offset: number;
  output: string;
  operation: Promise<void>;
  stopping?: Promise<void>;
  snapshot?: InteractiveBashProcess;
  signal?: 'SIGTERM' | 'SIGKILL';
}

/** Owns live PTY handles; persisted detached jobs remain owned by BackgroundBashManager. */
export class BackgroundBashCoordinator {
  readonly #entries = new Map<string, Entry>();
  readonly #starting = new Map<string, Promise<InteractiveBashProcess>>();
  #shutdownPromise: Promise<void> | undefined;

  constructor(private readonly runtime: AgentRuntime) {}

  async start(
    id: string,
    command: string,
    cwd?: string,
    onSnapshot?: (snapshot: InteractiveBashProcess) => Promise<void>,
  ): Promise<InteractiveBashProcess> {
    if (this.#shutdownPromise) throw new Error('Background process coordinator is shut down');
    if (this.#entries.has(id) || this.#starting.has(id)) {
      throw new Error(`Interactive background process already exists: ${id}`);
    }
    const terminals = this.runtime.terminals;
    if (!terminals) throw new Error('Interactive background processes require PTY support');
    const starting = (async () => {
      const process = await terminals.startShell(command, {
        shellFlavor: 'posix',
        ...(cwd === undefined ? {} : { cwd }),
      });
      const entry: Entry = {
        process,
        onSnapshot,
        offset: 0,
        output: '',
        operation: Promise.resolve(),
        decoder: new TextDecoder(),
      };
      this.#entries.set(id, entry);
      try {
        return await this.read(id);
      } catch (error) {
        const errors: unknown[] = [error];
        try {
          await process.terminate('SIGTERM');
        } catch (cleanupError) {
          errors.push(cleanupError);
        }
        try {
          await process.dispose();
        } catch (cleanupError) {
          errors.push(cleanupError);
        }
        if (errors.length > 1) throw new AggregateError(errors, `Failed to clean up interactive startup ${id}`);
        this.#entries.delete(id);
        throw error;
      }
    })();
    this.#starting.set(id, starting);
    try {
      return await starting;
    } finally {
      this.#starting.delete(id);
    }
  }

  async read(id: string, waitMs = 0, signal?: AbortSignal): Promise<InteractiveBashProcess> {
    const entry = this.#require(id);
    signal?.throwIfAborted();
    // A foreground wait must not hold the snapshot/persistence queue needed by other callers.
    if (waitMs > 0) {
      await entry.process.read(entry.offset, {
        waitMs,
        ...(signal === undefined ? {} : { signal }),
      });
    }
    signal?.throwIfAborted();
    return this.#serialize(entry, () => this.#readUnlocked(id, entry), signal);
  }

  async write(id: string, chars: string): Promise<InteractiveBashProcess> {
    const entry = this.#require(id);
    await entry.process.write(encoder.encode(chars));
    return this.#serialize(entry, () => this.#readUnlocked(id, entry));
  }

  async stop(id: string, signal: 'SIGTERM' | 'SIGKILL' = 'SIGTERM'): Promise<InteractiveBashProcess> {
    await this.#starting.get(id);
    const entry = this.#require(id);
    const stopping = entry.stopping ??= this.#terminate(entry, signal);
    try {
      await stopping;
    } finally {
      if (entry.stopping === stopping) delete entry.stopping;
    }
    return this.#serialize(entry, () => this.#readUnlocked(id, entry));
  }

  async #terminate(entry: Entry, signal: 'SIGTERM' | 'SIGKILL'): Promise<void> {
    const current = await entry.process.read(entry.offset);
    if (!current.running) return;
    entry.signal = signal;
    try {
      await entry.process.terminate(signal);
    } catch (error) {
      delete entry.signal;
      throw error;
    }
  }

  has(id: string): boolean {
    return this.#entries.has(id) || this.#starting.has(id);
  }

  isStarting(id: string): boolean {
    return this.#starting.has(id);
  }

  async shutdown(): Promise<void> {
    if (this.#shutdownPromise) return this.#shutdownPromise;
    this.#shutdownPromise = (async () => {
      const starts = await Promise.allSettled(this.#starting.values());
      const entries = [...this.#entries.entries()];
      const results = await Promise.allSettled(entries.map(async ([id, entry]) => {
        const errors: unknown[] = [];
        try {
          await this.stop(id);
        } catch (error) {
          errors.push(error);
        }
        try {
          await entry.process.dispose();
        } catch (error) {
          errors.push(error);
        }
        if (errors.length > 0) throw new AggregateError(errors, `Failed to clean up interactive process ${id}`);
        this.#entries.delete(id);
      }));
      const failures = [...starts, ...results].filter((result) => result.status === 'rejected');
      if (failures.length > 0) {
        throw new AggregateError(failures.map((result) => result.reason), 'Failed to shut down interactive background processes');
      }
    })();
    return this.#shutdownPromise;
  }

  #serialize<T>(entry: Entry, operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const result = entry.operation.then(() => {
      signal?.throwIfAborted();
      return operation();
    });
    entry.operation = result.then(() => {}, () => {});
    if (!signal) return result;
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => {
        signal.removeEventListener('abort', onAbort);
        reject(signal.reason);
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
      void result.then(
        (value) => { signal.removeEventListener('abort', onAbort); resolve(value); },
        (error: unknown) => { signal.removeEventListener('abort', onAbort); reject(error); },
      );
    });
  }

  async #readUnlocked(id: string, entry: Entry): Promise<InteractiveBashProcess> {
    const snapshot = await entry.process.read(entry.offset);
    entry.offset = snapshot.nextOffset;
    if (snapshot.output.length > 0) {
      entry.output = boundedTail(`${entry.output}${entry.decoder.decode(snapshot.output, { stream: snapshot.running })}`);
    }
    if (!snapshot.running) entry.output = boundedTail(`${entry.output}${entry.decoder.decode()}`);
    const result: InteractiveBashProcess = {
      id,
      process: entry.process,
      output: entry.output,
      running: snapshot.running,
      nextOffset: snapshot.nextOffset,
      ...(snapshot.exitCode === undefined ? {} : { exitCode: snapshot.exitCode }),
      ...(entry.signal === undefined ? {} : { signal: entry.signal }),
    };
    const previous = entry.snapshot;
    if (
      !previous
      || previous.nextOffset !== result.nextOffset
      || previous.running !== result.running
      || previous.exitCode !== result.exitCode
      || previous.signal !== result.signal
    ) {
      await entry.onSnapshot?.(result);
      entry.snapshot = result;
    }
    return result;
  }

  #require(id: string): Entry {
    const entry = this.#entries.get(id);
    if (!entry) throw new Error(`Interactive background process not found: ${id}`);
    return entry;
  }
}

function boundedTail(value: string): string {
  const bytes = encoder.encode(value);
  if (bytes.byteLength <= MAX_OUTPUT_BYTES) return value;
  let start = bytes.byteLength - MAX_OUTPUT_BYTES;
  while ((bytes[start]! & 0xc0) === 0x80) start += 1;
  return decoder.decode(bytes.subarray(start));
}
