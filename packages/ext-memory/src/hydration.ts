import { createHash } from 'node:crypto';
import {
  type MemoryArtifact,
  type MemoryFile,
  type MemoryHydrationOptions,
  type MemorySnapshot,
} from './contracts.js';
import { createDefaultMemoryIndex, createMemoryNavigationGuide } from './schema.js';
import {
  assertValidMemoryArtifact,
  resolveMemoryLink,
  validateMemoryArtifact,
} from './validation.js';

const MARKDOWN_LINK_TARGET = /(!?\[[^\]]*\]\()([^)\s]+)((?:\s+['"][^'"]*['"])?\))/gu;
const WIKI_LINK_TARGET = /(\[\[)([^\]|#]+)((?:#[^\]|]+)?(?:\|[^\]]+)?)\]\]/gu;


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
  const normalized = assertValidMemoryArtifact(artifact, {
    ...options,
    memoryPath: options.memoryPath ?? memoryPath,
  });
  return {
    ...normalized,
    fingerprint: memoryArtifactFingerprint(normalized),
    memoryPath,
  };
}

/** Rebase prompt navigation for a projection while retaining the canonical fingerprint. */
export function createMemoryProjectionSnapshot(
  snapshot: MemorySnapshot,
  memoryPath: string,
): MemorySnapshot {
  if (snapshot.memoryPath === memoryPath) return snapshot;
  const files = snapshot.files.map((file) => {
    let content = file.content;
    if (file.path === 'index.md') {
      content = rebaseMemoryIndex(file.content, snapshot.memoryPath, memoryPath);
    } else if (file.path === 'summary.md') {
      content = rebaseMemoryLinks(file.content, file.path, snapshot.memoryPath, memoryPath);
    }
    return content === file.content ? file : { ...file, content };
  });
  const projected = assertValidMemoryArtifact(files, { memoryPath, mode: 'read' });
  return {
    ...projected,
    fingerprint: snapshot.fingerprint,
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

function rebaseMemoryIndex(content: string, sourceMemoryPath: string, targetMemoryPath: string): string {
  const sourceGuide = createMemoryNavigationGuide(sourceMemoryPath);
  const targetGuide = createMemoryNavigationGuide(targetMemoryPath);
  return rebaseMemoryLinks(
    content.replace(sourceGuide, targetGuide),
    'index.md',
    sourceMemoryPath,
    targetMemoryPath,
  );
}

function rebaseMemoryLinks(
  content: string,
  sourcePath: string,
  sourceMemoryPath: string,
  targetMemoryPath: string,
): string {
  return content
    .replace(
      MARKDOWN_LINK_TARGET,
      (match, opening: string, rawTarget: string, closing: string) => {
        const rebased = rebaseMemoryLink(sourcePath, rawTarget, sourceMemoryPath, targetMemoryPath);
        return rebased === undefined ? match : `${opening}${rebased}${closing}`;
      },
    )
    .replace(
      WIKI_LINK_TARGET,
      (match, opening: string, rawTarget: string, suffix: string) => {
        const rebased = rebaseMemoryLink(sourcePath, rawTarget, sourceMemoryPath, targetMemoryPath);
        return rebased === undefined ? match : `${opening}${rebased}${suffix}]]`;
      },
    );
}

function rebaseMemoryLink(
  sourcePath: string,
  rawTarget: string,
  sourceMemoryPath: string,
  targetMemoryPath: string,
): string | undefined {
  const resolved = resolveMemoryLink(sourcePath, rawTarget, sourceMemoryPath);
  if (!resolved) return undefined;
  const suffix = rawTarget.match(/[?#].*$/u)?.[0] ?? '';
  return `${targetMemoryPath.replace(/\/$/u, '')}/${resolved}${suffix}`;
}

export function validateMemoryDirectoryInput(
  artifact: MemoryArtifact | readonly MemoryFile[],
  options: MemoryHydrationOptions = {},
): void {
  const result = validateMemoryArtifact(artifact, options);
  if (!result.ok) throw new Error(result.errors.map((error) => error.message).join('; '));
}