import type {
  AgentRuntime,
  AgentRuntimeStorage,
  ExecOptions,
  ExecResult,
} from '@felan-ai/agent-core';
import { codebaseMemoryRuntimeDirectory } from '../src/runtime-path.js';

export class MemoryRuntime implements AgentRuntime {
  cwd: string = '/work/repo';
  readonly files = new Map<string, Uint8Array>();
  readonly execCalls: Array<{ command: string; args: readonly string[]; options?: ExecOptions }> = [];
  readonly shellCalls: Array<{ command: string; options?: Record<string, unknown> }> = [];
  readonly #storage: AgentRuntimeStorage;
  readonly privateRuntime = {
    ensureDirectory: async (_namespace: string) => codebaseMemoryRuntimeDirectory(this.storageRoot).root,
  };
  version = '0.10.8';
  gitTopLevel: string | undefined = '/work/repo';

  constructor(
    readonly kind: AgentRuntime['kind'] = 'host',
    readonly available = true,
    readonly shellHandler: (command: string, options?: Record<string, unknown>) => Promise<ExecResult> = async () => result(),
    storageRoot = '/agent-storage',
  ) {
    this.#storage = {
      root: storageRoot,
      readFile: async (path) => {
        const bytes = this.files.get(path);
        if (!bytes) throw Object.assign(new Error(`Missing ${path}`), { code: 'ENOENT' });
        return bytes.slice();
      },
      writeFile: async (path, content) => { this.files.set(path, content.slice()); },
      listFiles: async (path) => [...this.files.keys()]
        .filter((entry) => entry.startsWith(`${path}/`))
        .map((entry) => entry.slice(path.length + 1)),
      mkdir: async () => {},
      remove: async (path, options) => {
        for (const key of [...this.files.keys()]) {
          if (key === path || (options?.recursive && key.startsWith(`${path}/`))) this.files.delete(key);
        }
      },
    };
  }

  get storageRoot(): string { return this.#storage.root; }

  storage(): AgentRuntimeStorage { return this.#storage; }

  async exec(command: string, args: readonly string[], options?: ExecOptions): Promise<ExecResult> {
    this.execCalls.push({ command, args, ...(options === undefined ? {} : { options }) });
    if (args.includes('--version')) {
      return this.available ? result(`codebase-memory-mcp ${this.version}\n`) : result('', 127, 'not found');
    }
    if (command === 'git' && args[0] === 'rev-parse' && args[1] === '--show-toplevel') {
      if (this.gitTopLevel === undefined) return result('', 128, 'fatal: not a git repository');
      return result(`${this.gitTopLevel}\n`);
    }
    return result();
  }

  async shell(command: string, options?: Record<string, unknown>): Promise<ExecResult> {
    this.shellCalls.push({ command, ...(options === undefined ? {} : { options }) });
    return this.shellHandler(command, options);
  }

  async readFile(): Promise<Uint8Array> { throw new Error('unused'); }
  async writeFile(): Promise<void> { throw new Error('unused'); }
  async listFiles(): Promise<string[]> { throw new Error('unused'); }
  async mkdir(): Promise<void> { throw new Error('unused'); }
  async remove(): Promise<void> { throw new Error('unused'); }
}

export function result(stdout = '', code = 0, stderr = ''): ExecResult {
  return { stdout, stderr, code, killed: false };
}

export function envelope(data: unknown): string {
  return JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(data) }] });
}
