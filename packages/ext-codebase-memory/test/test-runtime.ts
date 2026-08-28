import type {
  AgentRuntime,
  AgentRuntimeExecOptions,
  AgentRuntimeStorage,
  ExecResult,
} from '@felan-ai/agent-core';

export interface ExecCall {
  readonly command: string;
  readonly args: readonly string[];
  readonly options?: AgentRuntimeExecOptions;
}

export class MemoryRuntime implements AgentRuntime {
  readonly files = new Map<string, Uint8Array>();
  readonly execCalls: ExecCall[] = [];
  readonly readCalls: string[] = [];
  readonly removed: string[] = [];
  mkdirError: Error | undefined;
  readonly #storage: AgentRuntimeStorage;

  constructor(
    readonly execHandler: (
      command: string,
      args: readonly string[],
      options?: AgentRuntimeExecOptions,
    ) => Promise<ExecResult> = async () => result('', 127, 'not found'),
    readonly kind: AgentRuntime['kind'] = 'host',
    readonly cwd = '/workspace/repository',
    storageRoot = '/agent-storage',
  ) {
    this.#storage = {
      root: storageRoot,
      readFile: async (path) => {
        this.readCalls.push(path);
        const value = this.files.get(path);
        if (!value) throw Object.assign(new Error(`Missing ${path}`), { code: 'ENOENT' });
        return value.slice();
      },
      writeFile: async (path, content) => { this.files.set(path, content.slice()); },
      listFiles: async (path) => [...this.files.keys()].filter((file) => file.startsWith(path)),
      mkdir: async () => { if (this.mkdirError) throw this.mkdirError; },
      remove: async (path) => {
        this.removed.push(path);
        for (const file of [...this.files.keys()]) {
          if (file === path || file.startsWith(`${path}/`)) this.files.delete(file);
        }
      },
    };
  }

  storage(): AgentRuntimeStorage { return this.#storage; }

  async exec(command: string, args: readonly string[], options?: AgentRuntimeExecOptions): Promise<ExecResult> {
    this.execCalls.push({ command, args, ...(options ? { options } : {}) });
    return this.execHandler(command, args, options);
  }

  async shell(): Promise<ExecResult> { throw new Error('unused'); }
  async readFile(): Promise<Uint8Array> { throw new Error('unused'); }
  async writeFile(): Promise<void> { throw new Error('unused'); }
  async listFiles(): Promise<string[]> { throw new Error('unused'); }
  async mkdir(): Promise<void> { throw new Error('unused'); }
  async remove(): Promise<void> { throw new Error('unused'); }
}

export function result(stdout = '', code = 0, stderr = ''): ExecResult {
  return { stdout, stderr, code, killed: false };
}
