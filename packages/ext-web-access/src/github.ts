import { createHash } from 'node:crypto';
import { join, posix } from 'node:path';
import type { AgentRuntime } from '@felan-ai/agent-core';
import { positiveNumber, type WebAccessConfig } from './config.js';
import { combinedSignal, readJsonResponse } from './http.js';
import { endpointSsrfSettings, fetchRemoteUrl } from './ssrf.js';
import type { ExtractedContent } from './types.js';

const MAX_FILES = 200;
const MAX_FILE_CHARACTERS = 100_000;
const MAX_TOTAL_CHARACTERS = 750_000;
const clonePromises = new Map<string, Promise<void>>();
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
  const segments = url.pathname.split('/').filter(Boolean).map((segment) => decodeURIComponent(segment));
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
  if (forceClone) {
    try {
      await storage.remove(repositoryPath, { recursive: true });
    } catch {
      // A missing clone is already in the requested state.
    }
  }
  if (!await hasClone(storage, repositoryPath)) {
    let clone = clonePromises.get(repositoryPath);
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

  const files = (await storage.listFiles(repositoryPath, { recursive: true }))
    .filter(isUsefulFile)
    .filter((path) => info.type === 'root' || !info.path || path === info.path || path.startsWith(`${info.path}/`))
    .slice(0, MAX_FILES);
  if (info.type === 'blob' && info.path && !files.includes(info.path)) throw new Error(`GitHub repository path not found: ${info.path}`);

  const sections: string[] = [`# ${info.owner}/${info.repo}`, '', `Source: ${url}`, ''];
  let totalCharacters = sections.join('\n').length;
  let includedFiles = 0;
  for (const file of files) {
    let text: string;
    try {
      text = textDecoder.decode(await storage.readFile(join(repositoryPath, file)));
    } catch {
      continue;
    }
    if (text.includes('\0')) continue;
    const body = text.length > MAX_FILE_CHARACTERS ? `${text.slice(0, MAX_FILE_CHARACTERS)}\n[File truncated]` : text;
    const fence = '```';
    const rendered = `## ${file}\n\n${fence}${languageFor(file)}\n${body}\n${fence}`;
    if (totalCharacters + rendered.length > MAX_TOTAL_CHARACTERS) break;
    sections.push(rendered);
    totalCharacters += rendered.length;
    includedFiles += 1;
  }
  return {
    url,
    title: info.path ? `${info.owner}/${info.repo} - ${info.path}` : `${info.owner}/${info.repo}`,
    content: sections.join('\n'),
    error: null,
    contentType: 'text/markdown',
    ...(includedFiles < files.length ? { truncated: true } : {}),
  };
}

async function cloneRepository(
  runtime: AgentRuntime,
  destination: string,
  info: GitHubUrlInfo,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  const args = ['clone', '--depth', '1', '--filter=blob:none'];
  if (info.ref) args.push('--branch', info.ref);
  args.push(`https://github.com/${info.owner}/${info.repo}.git`, destination);
  const result = await runtime.exec('git', args, { ...(signal ? { signal } : {}), timeout: timeoutMs });
  if (signal?.aborted || result.killed) throw new Error('GitHub clone was aborted');
  if (result.code !== 0) throw new Error('GitHub repository clone failed');
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
  return value !== '' && value !== '.' && value !== '..' && !value.includes('\0');
}
