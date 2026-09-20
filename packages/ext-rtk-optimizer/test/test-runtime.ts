import {
  createSilentLogger,
  type AgentRuntime,
  type AgentRuntimeStorage,
  type ExecOptions,
  type ExecResult,
} from '@felan-ai/agent-core';

export class MemoryRuntime implements AgentRuntime {
  readonly kind = 'host' as const;
  readonly cwd = '/workspace';
  readonly logger = createSilentLogger();
  readonly files = new Map<string, Uint8Array>();
  readonly execCalls: Array<{ command: string; args: readonly string[]; options?: ExecOptions }> = [];
  readonly #storage: AgentRuntimeStorage;

  constructor(
    readonly execHandler: (
      command: string,
      args: readonly string[],
      options?: ExecOptions,
    ) => Promise<ExecResult> = async () => ({ stdout: '', stderr: '', code: 0, killed: false }),
    storageRoot = '/agent-storage',
  ) {
    this.#storage = {
      root: storageRoot,
      readFile: async (path) => {
        const value = this.files.get(path);
        if (value === undefined) {
          throw Object.assign(new Error(`Missing ${path}`), { code: 'ENOENT' });
        }
        return value.slice();
      },
      writeFile: async (path, content) => {
        this.files.set(path, content.slice());
      },
      appendFile: async (path, content) => {
        const existing = this.files.get(path);
        if (!existing) {
          this.files.set(path, content.slice());
          return;
        }
        const combined = new Uint8Array(existing.byteLength + content.byteLength);
        combined.set(existing, 0);
        combined.set(content, existing.byteLength);
        this.files.set(path, combined);
      },
      listFiles: async (path) => [...this.files.keys()].filter((file) => file.startsWith(path)),
      mkdir: async () => {},
      remove: async (path) => {
        this.files.delete(path);
      },
    };
  }

  storage(): AgentRuntimeStorage {
    return this.#storage;
  }

  async exec(command: string, args: readonly string[], options?: ExecOptions): Promise<ExecResult> {
    this.execCalls.push({ command, args, ...(options === undefined ? {} : { options }) });
    return this.execHandler(command, args, options);
  }

  async shell(): Promise<ExecResult> {
    throw new Error('unused');
  }

  async readFile(): Promise<Uint8Array> {
    throw new Error('unused');
  }

  async writeFile(): Promise<void> {
    throw new Error('unused');
  }

  async listFiles(): Promise<string[]> {
    throw new Error('unused');
  }

  async mkdir(): Promise<void> {
    throw new Error('unused');
  }

  async remove(): Promise<void> {
    throw new Error('unused');
  }
}

export function result(stdout = '', code = 0, stderr = ''): ExecResult {
  return { stdout, stderr, code, killed: false };
}
