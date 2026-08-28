import type { CbmClient } from '../cbm/client.js';
import { validateAutoIndexPath } from './auto-index-paths.js';

const activeIndexes = new Map<string, Promise<IndexResult>>();

export interface CbmProject {
  readonly name: string;
  readonly root_path?: string;
  readonly nodes?: number;
  readonly edges?: number;
  readonly size_bytes?: number;
  readonly last_accessed?: string | number;
}

export interface ToolExecutionContext { readonly cwd: string; readonly signal?: AbortSignal | undefined }
export type IndexResult =
  | { readonly status: 'indexed'; readonly project: string; readonly data: Readonly<Record<string, unknown>> }
  | { readonly status: 'deduplicated'; readonly reason: string }
  | { readonly status: 'skipped'; readonly reason: string };

export class ProjectService {
  constructor(
    private readonly cbm: CbmClient,
    private readonly workspaceRoot: string,
    private readonly indexTimeoutMs: number,
    private readonly beforeIndex: (
      projects: readonly CbmProject[],
      signal?: AbortSignal,
    ) => Promise<void> = async () => {},
  ) {}

  async listProjects(signal?: AbortSignal): Promise<CbmProject[]> {
    const result = await this.cbm.callTool('list_projects', {}, { signal, allowError: true });
    if (!result.ok) return [];
    const projects = typeof result.data === 'object' && result.data !== null ? Reflect.get(result.data, 'projects') : undefined;
    return Array.isArray(projects) ? projects.filter(isProject) : [];
  }

  async inferProject(cwd: string, signal?: AbortSignal): Promise<string> {
    const gitRoot = await this.cbm.gitRoot(cwd, signal);
    const validation = validateAutoIndexPath(gitRoot, this.workspaceRoot, gitRoot);
    if (!validation.ok) throw new Error(validation.reason);
    const projects = await this.listProjects(signal);
    const exact = projects.find((project) => project.root_path === gitRoot);
    return exact?.name ?? projectNameFromPath(gitRoot);
  }

  async indexCurrentRepo(cwd: string, signal?: AbortSignal): Promise<IndexResult> {
    const gitRoot = await this.cbm.findGitRoot(cwd, signal);
    if (!gitRoot) return { status: 'skipped', reason: 'not inside a git repository' };
    const validation = validateAutoIndexPath(gitRoot, this.workspaceRoot, gitRoot);
    if (!validation.ok) return { status: 'skipped', reason: validation.reason };
    if (activeIndexes.has(validation.path)) {
      return { status: 'deduplicated', reason: 'another Felan session is already indexing this repository' };
    }
    const operation = this.index(validation.path, signal);
    activeIndexes.set(validation.path, operation);
    try { return await operation; } finally { activeIndexes.delete(validation.path); }
  }

  private async index(path: string, signal?: AbortSignal): Promise<IndexResult> {
    await this.beforeIndex(await this.listProjects(signal), signal);
    const result = await this.cbm.callTool('index_repository', { repo_path: path, mode: 'full' }, {
      signal,
      timeoutMs: this.indexTimeoutMs,
    });
    const data = result.data && typeof result.data === 'object' ? result.data as Readonly<Record<string, unknown>> : {};
    return { status: 'indexed', project: typeof data.project === 'string' ? data.project : projectNameFromPath(path), data };
  }
}

function projectNameFromPath(path: string): string {
  return path.replace(/[^A-Za-z0-9._-]+/gu, '-').replace(/^[-.]+|[-.]+$/gu, '') || 'root';
}

function isProject(value: unknown): value is CbmProject {
  return typeof value === 'object' && value !== null && typeof Reflect.get(value, 'name') === 'string';
}
