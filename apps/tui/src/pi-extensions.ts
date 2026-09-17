import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { promptProjectTrust, type ProjectTrustPromptOption } from './project-trust-prompt.js';
import {
  createFelanProjectTrustStore,
  type ProjectTrustDecision,
  type ProjectTrustPromptChoice,
  type ProjectTrustStore,
} from './project-trust.js';
import type { ResolvedPiExtensionSettings } from './settings.js';

export function piUserExtensionsDir(homeDir: string): string {
  return resolve(homeDir, '.pi', 'agent', 'extensions');
}

export function piProjectExtensionsDir(cwd: string): string {
  return resolve(cwd, '.pi', 'extensions');
}

export interface ResolvePiExtensionPathsOptions {
  readonly cwd: string;
  readonly homeDir: string;
  readonly settings: ResolvedPiExtensionSettings;
  readonly projectTrust: ProjectTrustDecision;
  readonly cliPaths?: readonly string[];
}

export interface ResolvePiExtensionPathsResult {
  readonly paths: readonly string[];
  readonly needsProjectTrustPrompt: boolean;
}

export function resolvePiExtensionPaths(
  options: ResolvePiExtensionPathsOptions,
): ResolvePiExtensionPathsResult {
  const paths: string[] = [];
  if (options.settings.user) {
    const userDir = piUserExtensionsDir(options.homeDir);
    if (isExistingDirectory(userDir)) paths.push(userDir);
  }

  let needsProjectTrustPrompt = false;
  if (options.settings.project) {
    const projectDir = piProjectExtensionsDir(options.cwd);
    if (isExistingDirectory(projectDir)) {
      if (options.projectTrust === true) paths.push(projectDir);
      else if (options.projectTrust === null) needsProjectTrustPrompt = true;
    }
  }

  const seen = new Set(paths);
  for (const path of options.cliPaths ?? []) {
    if (seen.has(path)) continue;
    seen.add(path);
    paths.push(path);
  }

  return { paths: expandExtensionPaths(paths), needsProjectTrustPrompt };
}

export interface ResolveInteractivePiExtensionPathsOptions {
  readonly cwd: string;
  readonly homeDir: string;
  readonly agentDir: string;
  readonly settings: ResolvedPiExtensionSettings;
  readonly cliPaths?: readonly string[];
  readonly store?: ProjectTrustStore;
  readonly prompt?: (choices: readonly ProjectTrustPromptOption[]) => Promise<ProjectTrustPromptChoice>;
}

export async function resolveInteractivePiExtensionPaths(
  options: ResolveInteractivePiExtensionPathsOptions,
): Promise<readonly string[]> {
  const store = options.store ?? createFelanProjectTrustStore(options.agentDir);
  let projectTrust: ProjectTrustDecision = store.get(options.cwd);
  const resolved = resolvePiExtensionPaths({
    cwd: options.cwd,
    homeDir: options.homeDir,
    settings: options.settings,
    projectTrust,
    ...(options.cliPaths === undefined ? {} : { cliPaths: options.cliPaths }),
  });
  if (resolved.needsProjectTrustPrompt) {
    projectTrust = await promptProjectTrust({
      cwd: options.cwd,
      agentDir: options.agentDir,
      store,
      ...(options.prompt === undefined ? {} : { prompt: options.prompt }),
    });
    return resolvePiExtensionPaths({
      cwd: options.cwd,
      homeDir: options.homeDir,
      settings: options.settings,
      projectTrust,
      ...(options.cliPaths === undefined ? {} : { cliPaths: options.cliPaths }),
    }).paths;
  }
  return resolved.paths;
}

function expandExtensionPaths(paths: readonly string[]): readonly string[] {
  const expanded: string[] = [];
  const seen = new Set<string>();
  for (const path of paths) {
    for (const entry of expandExtensionPath(path)) {
      if (seen.has(entry)) continue;
      seen.add(entry);
      expanded.push(entry);
    }
  }
  return expanded;
}

function expandExtensionPath(path: string): readonly string[] {
  let stats;
  try {
    stats = statSync(path);
  } catch {
    return [path];
  }
  if (stats.isFile()) return [path];
  if (!stats.isDirectory()) return [];
  return collectDirectoryExtensionFiles(path);
}

function collectDirectoryExtensionFiles(dir: string): readonly string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const fullPath = join(dir, entry.name);
    if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.js'))) {
      files.push(fullPath);
      continue;
    }
    if (!entry.isDirectory()) continue;
    for (const indexName of ['index.ts', 'index.js']) {
      const indexPath = join(fullPath, indexName);
      if (existsSync(indexPath) && isExistingFile(indexPath)) {
        files.push(indexPath);
        break;
      }
    }
  }
  return files;
}

function isExistingDirectory(path: string): boolean {
  if (!existsSync(path)) return false;
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isExistingFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}
