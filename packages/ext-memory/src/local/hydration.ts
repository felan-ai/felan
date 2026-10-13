import { removeIfPresent } from './context.js';
import { randomUUID } from 'node:crypto';
import type { MemoryContext } from './context.js';
import { dirname, join, relative, sep } from 'node:path';
import { DEFAULT_MEMORY_ARTIFACT_LIMITS, type MemoryArtifact, type MemoryArtifactLimits, type MemoryFile, type MemoryHydrationOptions, type MemorySnapshot } from '../contracts.js';
import { assertValidMemoryArtifact, isSafeMemoryPath } from '../validation.js';
const READ_MODE_IGNORED_FILES = new Set(['.DS_Store']);


export async function readMemoryDirectory(environment: MemoryContext, root: string,
  options: MemoryHydrationOptions = {},
): Promise<MemoryArtifact> {
  const files: MemoryFile[] = [];
  let totalBytes = 0;
  const rootStats = await environment.runtime.files!.inspect(root);
  if (rootStats.kind !== 'directory') {
    throw new Error('Memory root must be a regular directory');
  }
  await walk(environment, root, root, files, options, (bytes) => {
    totalBytes += bytes;
    if (totalBytes > mergedLimits(options.limits).maxTotalBytes) {
      throw new Error(`Memory directory exceeds the ${mergedLimits(options.limits).maxTotalBytes}-byte limit`);
    }
  });
  return assertValidMemoryArtifact(files, options);
}


export async function hydrateMemoryDirectory(environment: MemoryContext, artifact: MemoryArtifact | readonly MemoryFile[],
  target: string,
  options: MemoryHydrationOptions = {},
): Promise<void> {
  const normalized = assertValidMemoryArtifact(artifact, options);
  const parent = dirname(target);
  await environment.runtime.files!.ensurePrivateDirectory(parent, { recursive: true });
  const existing = await safeLstat(environment, target);
  if (existing && existing.kind === 'symlink') throw new Error('Refusing to hydrate through a symlink');
  if (existing && !options.replace) throw new Error(`Memory target already exists: ${target}`);

  const temporary = join(parent, `.memory-hydration-${randomUUID()}`);
  await environment.runtime.files!.ensurePrivateDirectory(temporary);
  try {
    for (const file of normalized.files) {
      if (!isSafeMemoryPath(file.path)) throw new Error(`Unsafe memory path: ${file.path}`);
      const path = join(temporary, ...file.path.split('/'));
      await environment.runtime.files!.ensurePrivateDirectory(dirname(path), { recursive: true });
      await environment.runtime.writeFile(path, new TextEncoder().encode(file.content), { noFollow: true, exclusive: true });
    }
    if (existing) await removeIfPresent(environment, target, { recursive: true });
    await environment.runtime.files!.move(temporary, target);
  } catch (error) {
    await removeIfPresent(environment, temporary, { recursive: true });
    throw error;
  }
}


export async function hydrateMemorySnapshot(environment: MemoryContext, snapshot: MemorySnapshot,
  target: string,
  options: MemoryHydrationOptions = {},
): Promise<void> {
  await hydrateMemoryDirectory(environment, snapshot, target, options);
}


async function walk(environment: MemoryContext, root: string,
  current: string,
  files: MemoryFile[],
  options: MemoryHydrationOptions,
  onBytes: (bytes: number) => void,
): Promise<void> {
  const entries = await environment.runtime.listFiles(current, { includeDirectories: true, includeOther: true });
  for (const name of entries) {
    const absolute = join(current, name);
    const relativePath = relative(root, absolute).split(sep).join('/');
    const stats = await environment.runtime.files!.inspect(absolute);
    if (options.mode === 'read' && stats.kind === 'file' && READ_MODE_IGNORED_FILES.has(name)) continue;
    if (stats.kind === 'symlink' || (stats.kind !== 'directory' && stats.kind !== 'file')) {
      throw new Error(`Unsafe memory entry type: ${relativePath}`);
    }
    if (stats.kind === 'directory') {
      await walk(environment, root, absolute, files, options, onBytes);
      continue;
    }
    const content = new TextDecoder().decode(await environment.runtime.readFile(absolute));
    onBytes(Buffer.byteLength(content, 'utf8'));
    files.push({ path: relativePath, content });
  }
}


function safeLstat(environment: MemoryContext, path: string): Promise<import('@felan-ai/agent-core').RuntimeFileInfo | undefined> {
  return environment.runtime.files!.inspect(path).catch((error: unknown) => {
    if (isMissing(error)) return undefined;
    throw error;
  });
}


function mergedLimits(overrides: Partial<MemoryArtifactLimits> | undefined): MemoryArtifactLimits {
  return { ...DEFAULT_MEMORY_ARTIFACT_LIMITS, ...(overrides ?? {}) };
}


function isMissing(error: unknown): boolean { return error instanceof Error && Reflect.get(error, 'code') === 'ENOENT'; }
