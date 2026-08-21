import type {
  AgentRuntime,
  AgentRuntimeStorage,
  ExecOptions,
  ExecResult,
} from '@felan-ai/agent-core';

export class BrowserTestRuntime implements AgentRuntime {
  readonly kind = 'host' as const;
  readonly cwd = '/workspace';
  readonly files = new Map<string, Uint8Array>();
  readonly calls: Array<{ command: string; args: readonly string[]; options?: ExecOptions }> = [];
  readonly sessionStorage: BrowserTestStorage = new BrowserTestStorage('/session');
  readonly agentStorage: BrowserTestStorage = new BrowserTestStorage('/agent');

  constructor(
    readonly execHandler: (
      command: string,
      args: readonly string[],
      options?: ExecOptions,
    ) => Promise<ExecResult> = async () => result(),
  ) {}

  storage(scope: 'session' | 'agent' = 'session'): AgentRuntimeStorage {
    return scope === 'agent' ? this.agentStorage : this.sessionStorage;
  }

  async exec(command: string, args: readonly string[], options?: ExecOptions): Promise<ExecResult> {
    this.calls.push({ command, args: [...args], ...(options === undefined ? {} : { options }) });
    return this.execHandler(command, args, options);
  }

  async readFile(path: string): Promise<Uint8Array> {
    const value = this.files.get(path);
    if (!value) throw Object.assign(new Error(`Missing ${path}`), { code: 'ENOENT' });
    return value.slice();
  }

  async shell(): Promise<ExecResult> { throw new Error('unused'); }
  async writeFile(): Promise<void> { throw new Error('unused'); }
  async listFiles(): Promise<string[]> { throw new Error('unused'); }
  async mkdir(): Promise<void> { throw new Error('unused'); }
  async remove(): Promise<void> { throw new Error('unused'); }
}

export class BrowserTestStorage implements AgentRuntimeStorage {
  readonly files = new Map<string, Uint8Array>();

  constructor(readonly root: string) {}

  async readFile(path: string): Promise<Uint8Array> {
    const value = this.files.get(path.replace(/^[/\\]+/u, ''));
    if (!value) throw Object.assign(new Error(`Missing ${path}`), { code: 'ENOENT' });
    return value.slice();
  }

  async writeFile(path: string, content: Uint8Array): Promise<void> {
    this.files.set(path.replace(/^[/\\]+/u, ''), content.slice());
  }

  async listFiles(): Promise<string[]> { return [...this.files.keys()]; }
  async mkdir(): Promise<void> {}
  async remove(path: string, options?: { recursive?: boolean }): Promise<void> {
    const normalized = path.replace(/^[/\\]+/u, '');
    for (const key of [...this.files.keys()]) {
      if (key === normalized || (options?.recursive && key.startsWith(`${normalized}/`))) {
        this.files.delete(key);
      }
    }
  }
}

export function result(stdout = '', code = 0, stderr = '', killed = false): ExecResult {
  return { stdout, stderr, code, killed };
}

export const VALID_PNG_HEADER = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
