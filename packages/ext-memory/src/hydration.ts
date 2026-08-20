import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rename, rm, writeFile, lstat } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import {
  DEFAULT_MEMORY_ARTIFACT_LIMITS,
  type MemoryArtifact,
  type MemoryArtifactLimits,
  type MemoryFile,
  type MemoryHydrationOptions,
  type MemorySnapshot,
} from './contracts.js';
import { createDefaultMemoryIndex } from './schema.js';
import { assertValidMemoryArtifact, isSafeMemoryPath, validateMemoryArtifact } from './validation.js';

export function memoryArtifactFingerprint(artifact: MemoryArtifact | readonly MemoryFile[]): string {
  const files = 'files' in artifact ? artifact.files : artifact;
  const sorted = [...files].sort((left, right) => left.path.localeCompare(right.path));
  const hash = createHash('sha256');
  for (const file of sorted) {
    hash.update(file.path, 'utf8');
    hash.update('\0', 'utf8');
    hash.update(file.content, 'utf8');
    hash.update('\0', 'utf8');
  }
  return hash.digest('hex');
}

export function createMemorySnapshot(
  artifact: MemoryArtifact | readonly MemoryFile[],
  memoryPath: string,
  options: MemoryHydrationOptions = {},
): MemorySnapshot {
  const normalized = assertValidMemoryArtifact(artifact, options);
  return {
    ...normalized,
    fingerprint: memoryArtifactFingerprint(normalized),
    memoryPath,
  };
}

export function createEmptyMemoryArtifact(memoryPath: string): MemoryArtifact {
  return {
    version: 1,
    files: [
      { path: 'summary.md', content: '' },
      { path: 'index.md', content: createDefaultMemoryIndex(memoryPath) },
    ],
  };
}

export async function readMemoryDirectory(
  root: string,
  options: MemoryHydrationOptions = {},
): Promise<MemoryArtifact> {
  const files: MemoryFile[] = [];
  let totalBytes = 0;
  const rootStats = await lstat(root);
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    throw new Error('Memory root must be a regular directory');
  }
  await walk(root, root, files, options, (bytes) => {
    totalBytes += bytes;
    if (totalBytes > mergedLimits(options.limits).maxTotalBytes) {
      throw new Error(`Memory directory exceeds the ${mergedLimits(options.limits).maxTotalBytes}-byte limit`);
    }
  });
  return assertValidMemoryArtifact(files, options);
}

export async function hydrateMemoryDirectory(
  artifact: MemoryArtifact | readonly MemoryFile[],
  target: string,
  options: MemoryHydrationOptions = {},
): Promise<void> {
  const normalized = assertValidMemoryArtifact(artifact, options);
  const parent = dirname(target);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const existing = await safeLstat(target);
  if (existing && existing.isSymbolicLink()) throw new Error('Refusing to hydrate through a symlink');
  if (existing && !options.replace) throw new Error(`Memory target already exists: ${target}`);

  const temporary = await mkdtemp(join(parent, '.memory-hydration-'));
  try {
    for (const file of normalized.files) {
      if (!isSafeMemoryPath(file.path)) throw new Error(`Unsafe memory path: ${file.path}`);
      const path = join(temporary, ...file.path.split('/'));
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await writeFile(path, file.content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    }
    if (existing) await rm(target, { recursive: true, force: true });
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
}

export async function hydrateMemorySnapshot(
  snapshot: MemorySnapshot,
  target: string,
  options: MemoryHydrationOptions = {},
): Promise<void> {
  await hydrateMemoryDirectory(snapshot, target, options);
}

async function walk(
  root: string,
  current: string,
  files: MemoryFile[],
  options: MemoryHydrationOptions,
  onBytes: (bytes: number) => void,
): Promise<void> {
  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    const absolute = join(current, entry.name);
    const relativePath = relative(root, absolute).split(sep).join('/');
    const stats = await lstat(absolute);
    if (stats.isSymbolicLink() || (!stats.isDirectory() && !stats.isFile())) {
      throw new Error(`Unsafe memory entry type: ${relativePath}`);
    }
    if (stats.isDirectory()) {
      await walk(root, absolute, files, options, onBytes);
      continue;
    }
    const content = await readFile(absolute, 'utf8');
    onBytes(Buffer.byteLength(content, 'utf8'));
    files.push({ path: relativePath, content });
  }
}

function safeLstat(path: string): ReturnType<typeof lstat> {
  return lstat(path).catch((error: unknown) => {
    if (isMissing(error)) return undefined as never;
    throw error;
  });
}

function mergedLimits(overrides: Partial<MemoryArtifactLimits> | undefined): MemoryArtifactLimits {
  return { ...DEFAULT_MEMORY_ARTIFACT_LIMITS, ...(overrides ?? {}) };
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && Reflect.get(error, 'code') === 'ENOENT';
}

export function validateMemoryDirectoryInput(
  artifact: MemoryArtifact | readonly MemoryFile[],
  options: MemoryHydrationOptions = {},
): void {
  const result = validateMemoryArtifact(artifact, options);
  if (!result.ok) throw new Error(result.errors.map((error) => error.message).join('; '));
}
