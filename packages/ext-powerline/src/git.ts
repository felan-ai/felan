import type { FelanExtensionAPI } from '@felan-ai/agent-core';

export interface GitUpstream {
  name?: string;
  ahead: number;
  behind: number;
}

export interface GitDetails {
  branch?: string;
  sha?: string;
  dirty?: boolean;
  changedFiles?: number;
  tag?: string;
  timeSinceCommit?: string;
  stashCount?: number;
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
  private readonly lifetime = new AbortController();

  constructor(
    private readonly pi: Pick<FelanExtensionAPI, 'exec'>,
    private readonly cwd: string,
    private readonly now: () => number = Date.now,
    private readonly options = { showWorkingTree: true, showStashCount: true },
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
    this.lifetime.abort();
  }

  private async refreshNow(): Promise<void> {
    const root = await runGit(this.pi, ['rev-parse', '--show-toplevel'], this.cwd, this.lifetime.signal);
    if (this.disposed) return;
    if (!root) {
      this.details = undefined;
      return;
    }

    const [sha, status, tag, commitTimestamp] = await Promise.all([
      runGit(this.pi, ['rev-parse', '--short', 'HEAD'], this.cwd, this.lifetime.signal),
      this.options.showWorkingTree ? runGit(this.pi, ['status', '--porcelain=v2', '--branch', ...(this.options.showStashCount ? ['--show-stash'] : [])], this.cwd, this.lifetime.signal) : undefined,
      runGit(this.pi, ['describe', '--tags', '--exact-match'], this.cwd, this.lifetime.signal),
      runGit(this.pi, ['log', '-1', '--format=%ct'], this.cwd, this.lifetime.signal),
    ]);
    if (this.disposed) return;

    const parsed = parseGitStatus(status);
    const [branch, upstreamName, upstreamCounts, stashes] = this.options.showWorkingTree ? [] : await Promise.all([
      runGit(this.pi, ['rev-parse', '--abbrev-ref', 'HEAD'], this.cwd, this.lifetime.signal),
      runGit(this.pi, ['rev-parse', '--abbrev-ref', '@{upstream}'], this.cwd, this.lifetime.signal),
      runGit(this.pi, ['rev-list', '--left-right', '--count', 'HEAD...@{upstream}'], this.cwd, this.lifetime.signal),
      this.options.showStashCount ? runGit(this.pi, ['stash', 'list', '--format=%H'], this.cwd, this.lifetime.signal) : undefined,
    ]);
    const counts = upstreamCounts?.match(/^(\d+)\s+(\d+)$/u);
    if (this.disposed) return;
    const statusDetails = parsed === undefined
      ? {
          ...(this.details?.branch === undefined ? {} : { branch: this.details.branch }),
          ...(this.details?.dirty === undefined ? {} : { dirty: this.details.dirty }),
          ...(this.details?.changedFiles === undefined ? {} : { changedFiles: this.details.changedFiles }),
          ...(this.details?.stashCount === undefined ? {} : { stashCount: this.details.stashCount }),
          ...(this.details?.upstream === undefined ? {} : { upstream: this.details.upstream }),
        }
      : {
          ...(parsed.branch === undefined ? {} : { branch: parsed.branch }),
          dirty: parsed.changedFiles > 0,
          changedFiles: parsed.changedFiles,
          stashCount: parsed.stashCount,
          ...(parsed.upstream === undefined ? {} : { upstream: parsed.upstream }),
        };
    const commitSeconds = commitTimestamp === undefined ? undefined : Number.parseInt(commitTimestamp, 10);
    const timeSinceCommit = commitSeconds === undefined ? undefined : formatAge(commitSeconds, this.now());
    this.details = {
      ...statusDetails,
      ...(branch === undefined ? {} : { branch }),
      ...(upstreamName && counts ? { upstream: { name: upstreamName, ahead: Number(counts[1]), behind: Number(counts[2]) } } : {}),
      ...(stashes === undefined ? {} : { stashCount: stashes.split(/\r?\n/u).filter(Boolean).length }),
      ...(sha === undefined ? {} : { sha }),
      ...(tag === undefined ? {} : { tag }),
      ...(timeSinceCommit === undefined ? {} : { timeSinceCommit }),
      repoName: basename(root),
      refreshedAt: this.now(),
    };
    if (!this.options.showWorkingTree) { delete this.details.dirty; delete this.details.changedFiles; }
    if (!this.options.showStashCount) delete this.details.stashCount;
  }
}

export async function runGit(
  pi: Pick<FelanExtensionAPI, 'exec'>,
  args: string[],
  cwd: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  try {
    if (signal?.aborted) return undefined;
    const result = await pi.exec('git', args, { cwd, timeout: GIT_TIMEOUT_MS, ...(signal === undefined ? {} : { signal }) });
    if (result.code !== 0 || result.killed) return undefined;
    return result.stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

export function parseGitStatus(status: string | undefined): ParsedGitStatus | undefined {
  if (!status) return undefined;
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
