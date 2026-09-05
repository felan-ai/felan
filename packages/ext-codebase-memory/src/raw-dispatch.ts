import type { CbmClient } from './client.js';
import { RAW_TOOL_CATALOG, validateRawArguments } from './raw-catalog.js';
import type { ProjectService } from './services.js';

export async function dispatchRawCommand(
  client: CbmClient,
  projects: ProjectService,
  command: string,
  input: unknown,
  signal?: AbortSignal,
): Promise<unknown> {
  const args = validateRawArguments(command, input);
  signal?.throwIfAborted();
  if (command === 'index_repository') {
    const repoPath = args.repo_path as string | undefined;
    if (repoPath !== undefined && !repoPath.trim()) {
      throw new Error('Codebase Memory repo_path must not be blank');
    }
    const result = await projects.index(signal, repoPath);
    return result.status === 'indexed' ? result.data : result;
  }

  const tool = RAW_TOOL_CATALOG.find((entry) => entry.name === command)!;
  if (!tool.projectScoped) {
    return (await client.call(command, args, signal === undefined ? {} : { signal })).data;
  }
  const rejection = await projects.autoIndexRejectionReason(signal);
  if (rejection) {
    return {
      error: `This folder is not auto-indexed due to: ${rejection}. Index it only after explicit user approval/request.`,
    };
  }
  const project = await projects.project(signal);
  if (args.project !== undefined && args.project !== project) {
    throw new Error('Codebase Memory queries must use the active project; omit project to select it automatically');
  }
  return (await client.call(command, { ...args, project }, signal === undefined ? {} : { signal })).data;
}
