import type { FelanExtensionAPI } from '@felan-ai/agent-core';

export interface GitUpstream {
  name?: string;
  ahead: number;
  behind: number;
}

export interface GitDetails {
  branch?: string;
  sha?: string;
  dirty: boolean;
  changedFiles: number;
  tag?: string;
  timeSinceCommit?: string;
  stashCount: number;
  upstream?: GitUpstream;
  repoName?: string;
  refreshedAt: number;
}

export interface ParsedGitStatus {
  branch?: string;
  changedFiles: number;
  stashCount: number;
  upstream?: GitUpstream;
}

const GIT_TIMEOUT_MS = 1_200;

export class GitCache {
  private details: GitDetails | undefined;
  private inFlight: Promise<void> | undefined;
  private disposed = false;

  constructor(
    private readonly pi: Pick<FelanExtensionAPI, 'exec'>,
    private readonly cwd: string,
    private readonly now: () => number = Date.now,
  ) {}

  get(): GitDetails | undefined {
    return this.details;
  }

  refresh(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.refreshNow().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  dispose(): void {
    this.disposed = true;
  }

  private async refreshNow(): Promise<void> {
    const root = await runGit(this.pi, ['rev-parse', '--show-toplevel'], this.cwd);
    if (this.disposed) return;
    if (!root) {
      this.details = undefined;
      return;
    }

    const [sha, status, tag, commitTimestamp] = await Promise.all([
      runGit(this.pi, ['rev-parse', '--short', 'HEAD'], this.cwd),
      runGit(this.pi, ['status', '--porcelain=v2', '--branch', '--show-stash'], this.cwd),
      runGit(this.pi, ['describe', '--tags', '--exact-match'], this.cwd),
      runGit(this.pi, ['log', '-1', '--format=%ct'], this.cwd),
    ]);
    if (this.disposed) return;

    const parsed = parseGitStatus(status);
    const commitSeconds = commitTimestamp === undefined ? undefined : Number.parseInt(commitTimestamp, 10);
    const timeSinceCommit = commitSeconds === undefined ? undefined : formatAge(commitSeconds, this.now());
    this.details = {
      ...(parsed.branch === undefined ? {} : { branch: parsed.branch }),
      ...(sha === undefined ? {} : { sha }),
      dirty: parsed.changedFiles > 0,
      changedFiles: parsed.changedFiles,
      ...(tag === undefined ? {} : { tag }),
      ...(timeSinceCommit === undefined ? {} : { timeSinceCommit }),
      stashCount: parsed.stashCount,
      ...(parsed.upstream === undefined ? {} : { upstream: parsed.upstream }),
      repoName: basename(root),
      refreshedAt: this.now(),
    };
  }
}

export async function runGit(
  pi: Pick<FelanExtensionAPI, 'exec'>,
  args: string[],
  cwd: string,
): Promise<string | undefined> {
  try {
    const result = await pi.exec('git', args, { cwd, timeout: GIT_TIMEOUT_MS });
    if (result.code !== 0 || result.killed) return undefined;
    return result.stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

export function parseGitStatus(status: string | undefined): ParsedGitStatus {
  if (!status) return { changedFiles: 0, stashCount: 0 };
  if (status.split('\n').some((line) => line.startsWith('# branch.'))) return parsePorcelainV2(status);
  return parsePorcelainV1(status);
}

export function formatAge(commitUnixSeconds: number, nowMilliseconds = Date.now()): string | undefined {
  if (!Number.isFinite(commitUnixSeconds)) return undefined;
  const seconds = Math.max(0, Math.floor(nowMilliseconds / 1_000) - commitUnixSeconds);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d`;
  const months = Math.floor(days / 30);
  return months < 12 ? `${months}mo` : `${Math.floor(months / 12)}y`;
}

function parsePorcelainV2(status: string): ParsedGitStatus {
  const lines = status.split('\n').filter(Boolean);
  const branchValue = headerValue(lines, '# branch.head ');
  const upstreamName = headerValue(lines, '# branch.upstream ');
  const aheadBehind = headerValue(lines, '# branch.ab ')?.match(/^\+(\d+) -(\d+)$/);
  const ahead = Number.parseInt(aheadBehind?.[1] ?? '0', 10);
  const behind = Number.parseInt(aheadBehind?.[2] ?? '0', 10);
  const upstream = upstreamName || ahead || behind
    ? { ...(upstreamName ? { name: upstreamName } : {}), ahead, behind }
    : undefined;
  const branch = branchValue === '(detached)' ? 'detached' : branchValue;
  return {
    ...(branch ? { branch } : {}),
    changedFiles: lines.filter((line) => !line.startsWith('#')).length,
    stashCount: Number.parseInt(headerValue(lines, '# stash ') ?? '0', 10) || 0,
    ...(upstream === undefined ? {} : { upstream }),
  };
}

function parsePorcelainV1(status: string): ParsedGitStatus {
  const lines = status.split('\n').filter(Boolean);
  const header = lines.find((line) => line.startsWith('## '));
  const changedFiles = lines.filter((line) => !line.startsWith('## ')).length;
  if (!header) return { changedFiles, stashCount: 0 };

  const branchPart = header.slice(3);
  const upstreamName = branchPart.match(/\.\.\.([^\s\[]+)/)?.[1];
  const ahead = Number.parseInt(branchPart.match(/ahead (\d+)/)?.[1] ?? '0', 10);
  const behind = Number.parseInt(branchPart.match(/behind (\d+)/)?.[1] ?? '0', 10);
  const upstream = upstreamName || ahead || behind
    ? { ...(upstreamName ? { name: upstreamName } : {}), ahead, behind }
    : undefined;
  const rawBranch = branchPart.split('...')[0]?.split(' ')[0]?.trim();
  const branch = rawBranch === 'HEAD' ? 'detached' : rawBranch;
  return {
    ...(branch ? { branch } : {}),
    changedFiles,
    stashCount: 0,
    ...(upstream === undefined ? {} : { upstream }),
  };
}

function headerValue(lines: string[], prefix: string): string | undefined {
  return lines.find((line) => line.startsWith(prefix))?.slice(prefix.length).trim() || undefined;
}

function basename(path: string): string {
  const parts = path.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts.at(-1) ?? path;
}
