import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { SubagentRecord, SubagentSpawnRequest } from '@felan-ai/ext-subagents';

export interface LocalStoredChild {
  readonly record: SubagentRecord;
  readonly request: SubagentSpawnRequest;
  readonly depth: number;
  readonly sessionFile?: string;
  readonly deliveryId?: string;
  readonly completionPending: boolean;
}

interface StoreFile {
  readonly version: 1;
  readonly children: readonly LocalStoredChild[];
}

export class LocalSubagentStore {
  readonly #path: string;

  constructor(agentDir: string, rootSessionId: string) {
    this.#path = join(agentDir, 'subagents', encodeURIComponent(rootSessionId), 'records.json');
  }

  async load(): Promise<LocalStoredChild[]> {
    try {
      const parsed = JSON.parse(await readFile(this.#path, 'utf8')) as StoreFile;
      if (parsed.version !== 1 || !Array.isArray(parsed.children)) throw new Error('Unsupported subagent store');
      return parsed.children.map((child) => structuredClone(child));
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
  }

  async save(children: readonly LocalStoredChild[]): Promise<void> {
    await mkdir(dirname(this.#path), { recursive: true });
    const temporary = `${this.#path}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify({ version: 1, children }, null, 2)}\n`);
    await rename(temporary, this.#path);
  }

  sessionDirectory(): string {
    return join(dirname(this.#path), 'sessions');
  }
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
