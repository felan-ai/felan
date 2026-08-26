import { createHash } from 'node:crypto';
import { join, posix } from 'node:path';
import type { AgentRuntime } from '@felan-ai/agent-core';
import { positiveInteger, positiveNumber, type WebAccessConfig } from './config.js';
import { combinedSignal, readJsonResponse } from './http.js';
import { endpointSsrfSettings, fetchRemoteUrl } from './ssrf.js';
import type { ExtractedContent } from './types.js';

const MAX_FILES = 200;
const MAX_FILE_CHARACTERS = 100_000;
const MAX_TOTAL_CHARACTERS = 750_000;
const MAX_API_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_API_TREE_ENTRIES = 200;
const FULL_COMMIT_SHA = /^[0-9a-f]{40}$/iu;
const clonePromises = new Map<string, Promise<string>>();
const checkoutAccess = new Map<string, number>();
const textDecoder = new TextDecoder('utf8', { fatal: true });

const BINARY_EXTENSIONS = new Set([
  '.7z', '.avi', '.bin', '.bmp', '.class', '.dll', '.doc', '.docx', '.dylib', '.exe', '.gif', '.gz',
  '.ico', '.jar', '.jpeg', '.jpg', '.lockb', '.mov', '.mp3', '.mp4', '.o', '.otf', '.pdf', '.png',
  '.pyc', '.so', '.tar', '.ttf', '.wav', '.webm', '.webp', '.woff', '.woff2', '.xls', '.xlsx', '.zip',
]);
const NOISE_DIRECTORIES = new Set(['.git', '.next', '.turbo', 'build', 'coverage', 'dist', 'node_modules', 'target', 'vendor']);

export interface GitHubUrlInfo {
  owner: string;
  repo: string;
  ref?: string;
  path?: string;
  type: 'root' | 'tree' | 'blob';
}

export function parseGitHubUrl(rawUrl: string): GitHubUrlInfo | undefined {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return undefined;
  }
  if (url.hostname.toLowerCase() !== 'github.com') return undefined;
  let segments: string[];
  try {
    segments = url.pathname.split('/').filter(Boolean).map((segment) => decodeURIComponent(segment));
  } catch {
    return undefined;
  }
  const [owner, rawRepo, kind, ref, ...path] = segments;
  const repo = rawRepo?.replace(/\.git$/u, '');
  if (!owner || !repo || !validSegment(owner) || !validSegment(repo)) return undefined;
  if (kind !== undefined && kind !== 'tree' && kind !== 'blob') return undefined;
  if (kind && (!ref || !validSegment(ref) || path.some((segment) => !validPathSegment(segment)))) return undefined;
  return {
    owner,
    repo,
    type: kind ?? 'root',
    ...(ref ? { ref } : {}),
    ...(path.length > 0 ? { path: path.join('/') } : {}),
  };
}

export async function extractGitHubRepository(
  url: string,
  info: GitHubUrlInfo,
  runtime: AgentRuntime,
  config: WebAccessConfig,
  signal?: AbortSignal,
  forceClone = false,
): Promise<ExtractedContent> {
  if (config.githubClone?.enabled === false) throw new Error('GitHub repository extraction is disabled');
  if (runtime.kind !== 'host') return fetchGitHubApiView(url, info, config, signal);
  const maximumRepoSizeMb = positiveNumber(config.githubClone?.maxRepoSizeMB, 350, 2_000);
  const timeoutMs = positiveNumber(config.githubClone?.cloneTimeoutSeconds, 30, 300) * 1_000;
  if (!forceClone) {
    const sizeMb = await githubRepositorySizeMb(info, config, signal);
    if (sizeMb > maximumRepoSizeMb) {
      throw new Error(`GitHub repository is ${Math.ceil(sizeMb)} MB; pass forceClone: true to exceed the configured ${maximumRepoSizeMb} MB threshold`);
    }
  }

  const storage = runtime.storage('session');
  const key = createHash('sha256').update(`${info.owner}/${info.repo}@${info.ref ?? 'HEAD'}`).digest('hex').slice(0, 20);
  const repositoryPath = join(storage.root, 'web-access', 'repos', key);
  await storage.mkdir(join(storage.root, 'web-access', 'repos'), { recursive: true });
  let clone: Promise<string> | undefined;
  if (forceClone) {
    clone = clonePromises.get(repositoryPath);
    if (clone) await clone;
    try {
      await storage.remove(repositoryPath, { recursive: true });
    } catch {
      // A missing clone is already in the requested state.
    }
  }
  if (!await hasClone(storage, repositoryPath)) {
    clone = clonePromises.get(repositoryPath);
    if (!clone) {
      clone = cloneRepository(runtime, repositoryPath, info, timeoutMs, signal);
      clonePromises.set(repositoryPath, clone);
    }
    try {
      await clone;
    } finally {
      clonePromises.delete(repositoryPath);
    }
  }

  const commit = clone
    ? await clone
    : await readHead(runtime, repositoryPath, timeoutMs, signal);
  checkoutAccess.set(repositoryPath, Date.now());
  await enforceCheckoutLimit(storage, repositoryPath, config);
  const files = (await storage.listFiles(repositoryPath, { recursive: true, limit: MAX_FILES + 1 }))
    .filter(isUsefulFile)
    .filter((path) => info.type === 'root' || !info.path || path === info.path || path.startsWith(`${info.path}/`));
  if (info.type === 'blob' && info.path && !files.includes(info.path)) throw new Error(`GitHub repository path not found: ${info.path}`);

  const sections: string[] = [`# ${info.owner}/${info.repo}`, '', `Source: ${url}`, `Commit: ${commit}`, ''];
  let repositoryTruncated = files.length > MAX_FILES;
  if (info.type === 'blob' && info.path) {
    const text = textDecoder.decode(await storage.readFile(join(repositoryPath, info.path)));
    sections.push(`## ${info.path}`, '', '```' + languageFor(info.path), boundedText(text, MAX_FILE_CHARACTERS), '```');
  } else {
    sections.push('## Structure', '', files.slice(0, MAX_FILES).join('\n'));
    const readme = files.find((file) => /^(?:README(?:\.md)?|readme)$/iu.test(posix.basename(file)));
    if (readme) {
      const text = textDecoder.decode(await storage.readFile(join(repositoryPath, readme)));
      sections.push('', '## README.md', '', boundedText(text, 8_192));
    }
  }
  return {
    url,
    title: info.path ? `${info.owner}/${info.repo} - ${info.path}` : `${info.owner}/${info.repo}`,
    content: sections.join('\n'),
    error: null,
    contentType: 'text/markdown',
    repository: {
      owner: info.owner,
      repo: info.repo,
      mode: 'local-checkout',
      commit,
      ...(info.ref ? { requestedRef: info.ref } : {}),
      checkoutPath: repositoryPath,
    },
    ...(repositoryTruncated ? { truncated: true } : {}),
  };
}

export async function cleanupGitHubRepositories(runtime: AgentRuntime): Promise<void> {
  const storage = runtime.storage('session');
  const repositories = join(storage.root, 'web-access', 'repos');
  try {
    await storage.remove(repositories, { recursive: true });
  } catch {
    // A session may not have created any repositories.
  }
  for (const path of checkoutAccess.keys()) {
    if (path.startsWith(`${repositories}/`)) checkoutAccess.delete(path);
  }
}

async function enforceCheckoutLimit(
  storage: ReturnType<AgentRuntime['storage']>,
  currentPath: string,
  config: WebAccessConfig,
): Promise<void> {
  const maximum = positiveInteger(config.githubClone?.maxCheckouts, 4, 100);
  const root = join(storage.root, 'web-access', 'repos');
  let entries: string[];
  try {
    entries = await storage.listFiles(root, { includeDirectories: true, recursive: false });
  } catch {
    return;
  }
  const paths = entries
    .filter((entry) => /^[a-f0-9]{20}$/u.test(posix.basename(entry)) && !entry.includes('/'))
    .map((entry) => join(root, entry));
  if (paths.length <= maximum) return;
  const candidates = paths
    .filter((path) => path !== currentPath && !clonePromises.has(path))
    .sort((left, right) => (checkoutAccess.get(left) ?? 0) - (checkoutAccess.get(right) ?? 0));
  for (const path of candidates.slice(0, Math.max(0, paths.length - maximum))) {
    try {
      await storage.remove(path, { recursive: true });
    } catch {
      // Cleanup is best effort; the next checkout can retry eviction.
    }
    checkoutAccess.delete(path);
  }
}

async function cloneRepository(
  runtime: AgentRuntime,
  destination: string,
  info: GitHubUrlInfo,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<string> {
  const args = ['clone', '--depth', '1', '--filter=blob:none'];
  const fullSha = info.ref !== undefined && FULL_COMMIT_SHA.test(info.ref);
  if (info.ref && !fullSha) args.push('--branch', info.ref);
  args.push(`https://github.com/${info.owner}/${info.repo}.git`, destination);
  try {
    const result = await runtime.exec('git', args, { ...(signal ? { signal } : {}), timeout: timeoutMs });
    if (signal?.aborted || result.killed) throw new Error('GitHub clone was aborted');
    if (result.code !== 0) throw new Error('GitHub repository clone failed');
    if (fullSha) {
      await runGit(runtime, ['-C', destination, 'fetch', '--depth', '1', 'origin', info.ref!], timeoutMs, signal, 'GitHub commit fetch failed');
      await runGit(runtime, ['-C', destination, 'checkout', '--detach', info.ref!], timeoutMs, signal, 'GitHub commit checkout failed');
    }
    return await readHead(runtime, destination, timeoutMs, signal, info.ref);
  } catch (error) {
    try {
      await runtime.remove(destination, { recursive: true });
    } catch {
      // The destination may not have been created.
    }
    throw error;
  }
}

async function readHead(
  runtime: AgentRuntime,
  repositoryPath: string,
  timeoutMs: number,
  signal?: AbortSignal,
  expected?: string,
): Promise<string> {
  const result = await runGit(runtime, ['-C', repositoryPath, 'rev-parse', 'HEAD'], timeoutMs, signal, 'GitHub checkout verification failed');
  const commit = result.stdout.trim().toLowerCase();
  if (!FULL_COMMIT_SHA.test(commit) || (expected && commit !== expected.toLowerCase())) {
    throw new Error('GitHub checkout returned an invalid or unexpected commit SHA');
  }
  return commit;
}

async function runGit(
  runtime: AgentRuntime,
  args: string[],
  timeoutMs: number,
  signal: AbortSignal | undefined,
  failure: string,
): Promise<{ stdout: string }> {
  const result = await runtime.exec('git', args, { ...(signal ? { signal } : {}), timeout: timeoutMs, maxOutputBytes: 1_024 });
  if (signal?.aborted || result.killed) throw new Error('GitHub checkout was aborted');
  if (result.code !== 0) throw new Error(failure);
  return { stdout: result.stdout };
}

async function githubRepositorySizeMb(
  info: GitHubUrlInfo,
  config: WebAccessConfig,
  signal?: AbortSignal,
): Promise<number> {
  const response = await fetchRemoteUrl(`https://api.github.com/repos/${info.owner}/${info.repo}`, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'felan-web-access' },
    signal: combinedSignal(signal, 15_000),
  }, endpointSsrfSettings(config), { allowCrossOriginRedirects: false });
  if (!response.ok) throw new Error(`GitHub API request failed with HTTP ${response.status}`);
  const data = await readJsonResponse<{ size?: unknown }>(response, 512 * 1024, 'GitHub API');
  if (typeof data.size !== 'number' || !Number.isFinite(data.size) || data.size < 0) {
    throw new Error('GitHub API response did not include a valid repository size');
  }
  return data.size / 1_024;
}

async function fetchGitHubApiView(
  url: string,
  info: GitHubUrlInfo,
  config: WebAccessConfig,
  signal?: AbortSignal,
): Promise<ExtractedContent> {
  const settings = endpointSsrfSettings(config);
  const metadata = await githubApiJson<{ default_branch?: unknown }>(
    `https://api.github.com/repos/${info.owner}/${info.repo}`,
    settings,
    signal,
    'GitHub repository API',
  );
  const ref = info.ref ?? (typeof metadata.default_branch === 'string' ? metadata.default_branch : undefined);
  if (!ref) throw new Error('GitHub API did not provide a default branch');
  const commit = FULL_COMMIT_SHA.test(ref)
    ? ref.toLowerCase()
    : await resolveGitHubCommit(info.owner, info.repo, ref, settings, signal);
  const provenance = {
    owner: info.owner,
    repo: info.repo,
    mode: 'github-api' as const,
    commit,
    ...(info.ref ? { requestedRef: info.ref } : {}),
  };
  const lines = [`# ${info.owner}/${info.repo}`, '', `Source: ${url}`, `Commit: ${commit}`, '', ''];
  let repositoryTruncated = false;

  if (info.type === 'blob' && info.path) {
    const content = await githubFileContent(info.owner, info.repo, info.path, commit, settings, signal);
    lines.push(`## ${info.path}`, '', '```', boundedText(content, MAX_FILE_CHARACTERS), '```');
  } else {
    const tree = await githubTree(info.owner, info.repo, commit, settings, signal);
    const paths = tree.entries
      .filter((entry) => entry.type === 'blob' && isUsefulFile(entry.path))
      .map((entry) => entry.path);
    const selected = info.type === 'tree' && info.path
      ? paths.filter((path) => path === info.path || path.startsWith(`${info.path}/`))
      : paths;
    if (info.type === 'tree' && info.path && selected.length === 0) {
      throw new Error(`GitHub repository path not found: ${info.path}`);
    }
    lines.push('## Structure', '', selected.slice(0, MAX_API_TREE_ENTRIES).join('\n'));
    repositoryTruncated = tree.truncated || selected.length > MAX_API_TREE_ENTRIES;
    if (repositoryTruncated) lines.push('', '[Tree truncated]');
    const readme = await githubReadme(info.owner, info.repo, commit, settings, signal);
    if (readme) lines.push('', '## README.md', '', boundedText(readme, 8_192));
  }
  return {
    url,
    title: info.path ? `${info.owner}/${info.repo} - ${info.path}` : `${info.owner}/${info.repo}`,
    content: lines.join('\n'),
    error: null,
    contentType: 'text/markdown',
    repository: provenance,
    ...(repositoryTruncated ? { truncated: true } : {}),
  };
}

async function resolveGitHubCommit(
  owner: string,
  repo: string,
  ref: string,
  settings: ReturnType<typeof endpointSsrfSettings>,
  signal?: AbortSignal,
): Promise<string> {
  const data = await githubApiJson<{ sha?: unknown }>(
    `https://api.github.com/repos/${owner}/${repo}/commits/${encodeURIComponent(ref)}`,
    settings,
    signal,
    'GitHub commit API',
  );
  if (typeof data.sha !== 'string' || !FULL_COMMIT_SHA.test(data.sha)) throw new Error('GitHub API returned an invalid commit SHA');
  return data.sha.toLowerCase();
}

interface GitHubTreeEntry { path: string; type?: string }

async function githubTree(
  owner: string,
  repo: string,
  commit: string,
  settings: ReturnType<typeof endpointSsrfSettings>,
  signal?: AbortSignal,
): Promise<{ entries: GitHubTreeEntry[]; truncated: boolean }> {
  const data = await githubApiJson<{ tree?: unknown; truncated?: unknown }>(
    `https://api.github.com/repos/${owner}/${repo}/git/trees/${commit}?recursive=1`,
    settings,
    signal,
    'GitHub tree API',
  );
  if (!Array.isArray(data.tree)) throw new Error('GitHub API returned an invalid tree');
  const entries = data.tree.flatMap((entry): GitHubTreeEntry[] => {
    if (!isRecord(entry) || typeof entry.path !== 'string' || !validRepositoryPath(entry.path)) return [];
    return [{ path: entry.path, ...(typeof entry.type === 'string' ? { type: entry.type } : {}) }];
  });
  return { entries, truncated: data.truncated === true };
}

async function githubReadme(
  owner: string,
  repo: string,
  commit: string,
  settings: ReturnType<typeof endpointSsrfSettings>,
  signal?: AbortSignal,
): Promise<string | undefined> {
  try {
    const data = await githubApiJson<{ content?: unknown; encoding?: unknown }>(
      `https://api.github.com/repos/${owner}/${repo}/readme?ref=${encodeURIComponent(commit)}`,
      settings,
      signal,
      'GitHub README API',
    );
    return decodeGitHubContent(data);
  } catch (error) {
    if (error instanceof Error && /HTTP 404\b/u.test(error.message)) return undefined;
    throw error;
  }
}

async function githubFileContent(
  owner: string,
  repo: string,
  path: string,
  commit: string,
  settings: ReturnType<typeof endpointSsrfSettings>,
  signal?: AbortSignal,
): Promise<string> {
  const encodedPath = path.split('/').map(encodeURIComponent).join('/');
  const data = await githubApiJson<{ content?: unknown; encoding?: unknown }>(
    `https://api.github.com/repos/${owner}/${repo}/contents/${encodedPath}?ref=${encodeURIComponent(commit)}`,
    settings,
    signal,
    'GitHub file API',
  );
  return decodeGitHubContent(data);
}

async function githubApiJson<T>(
  url: string,
  settings: ReturnType<typeof endpointSsrfSettings>,
  signal: AbortSignal | undefined,
  label: string,
): Promise<T> {
  const response = await fetchRemoteUrl(url, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'felan-web-access' },
    signal: combinedSignal(signal, 15_000),
  }, settings, { allowCrossOriginRedirects: false });
  if (!response.ok) throw new Error(`${label} failed with HTTP ${response.status}`);
  return readJsonResponse<T>(response, MAX_API_RESPONSE_BYTES, label);
}

function decodeGitHubContent(data: { content?: unknown; encoding?: unknown }): string {
  if (typeof data.content !== 'string' || (data.encoding !== undefined && data.encoding !== 'base64')) {
    throw new Error('GitHub API returned unsupported file content');
  }
  try {
    return Buffer.from(data.content.replace(/\s/gu, ''), 'base64').toString('utf8');
  } catch {
    throw new Error('GitHub API returned invalid file content');
  }
}

function boundedText(text: string, maximum: number): string {
  return text.length > maximum ? `${text.slice(0, maximum)}\n[File truncated]` : text;
}

function validRepositoryPath(path: string): boolean {
  return path.split('/').every((segment) => validPathSegment(segment) && !segment.includes('\\'));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function hasClone(storage: ReturnType<AgentRuntime['storage']>, path: string): Promise<boolean> {
  try {
    return (await storage.listFiles(path, { recursive: false })).length > 0
      || (await storage.listFiles(join(path, '.git'), { recursive: false })).length > 0;
  } catch {
    return false;
  }
}

function isUsefulFile(path: string): boolean {
  const normalized = path.replace(/\\/gu, '/');
  if (normalized.split('/').some((segment) => NOISE_DIRECTORIES.has(segment))) return false;
  const extension = posix.extname(normalized).toLowerCase();
  return !BINARY_EXTENSIONS.has(extension);
}

function languageFor(path: string): string {
  return posix.extname(path).slice(1).replace(/[^a-z0-9_+-]/giu, '');
}

function validSegment(value: string): boolean {
  return /^[A-Za-z0-9_.-]+$/u.test(value) && value !== '.' && value !== '..';
}

function validPathSegment(value: string): boolean {
  return value !== '' && value !== '.' && value !== '..' && !value.includes('\0') && !value.includes('/') && !value.includes('\\');
}
