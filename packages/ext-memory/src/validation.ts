import { posix } from 'node:path';
import {
  DEFAULT_MEMORY_ARTIFACT_LIMITS,
  type MemoryArtifact,
  type MemoryArtifactLimits,
  type MemoryFile,
  type MemoryValidationError,
  type MemoryValidationOptions,
  type MemoryValidationResult,
} from './contracts.js';
import { createDefaultMemoryIndex } from './schema.js';

const MARKDOWN_LINK = /!?\[[^\]]*\]\(([^)\s]+)(?:\s+['"][^'"]*['"])?\)/g;
const WIKI_LINK = /\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g;
const SOURCE_MARKER = /session(?:_id)?\s*[:=]\s*([A-Za-z0-9][A-Za-z0-9._:-]*)/gi;

export function validateMemoryArtifact(
  input: MemoryArtifact | readonly MemoryFile[],
  options: MemoryValidationOptions = {},
): MemoryValidationResult {
  const memoryPath = options.memoryPath ?? '.memory';
  const limits = mergeLimits(options.limits);
  const readMode = options.mode === 'read';
  const requireSources = options.requireSources ?? !readMode;
  const validateNavigation = options.validateNavigation ?? !readMode;
  const errors: MemoryValidationError[] = [];
  const artifact = !Array.isArray(input) && isRecord(input) ? input : undefined;
  const files: readonly unknown[] = Array.isArray(input)
    ? input
    : artifact && Array.isArray(artifact.files)
      ? artifact.files
      : [];
  if (artifact && artifact.version !== 1) {
    errors.push({ code: 'unsupported_version', message: 'Unsupported memory artifact version' });
  }
  if (!Array.isArray(input) && (!artifact || !Array.isArray(artifact.files))) {
    errors.push({ code: 'invalid_file_type', message: 'Memory artifact files must be an array' });
  }
  const normalized: MemoryFile[] = [];
  const seen = new Set<string>();
  const areas = new Map<string, number>();
  let totalBytes = 0;

  for (const file of files) {
    if (!isRecord(file) || typeof file.path !== 'string' || typeof file.content !== 'string') {
      errors.push({ code: 'invalid_file_type', message: 'Memory entries must contain a path and string content' });
      continue;
    }
    const path = file.path;
    if (!isSafeMemoryPath(path)) {
      errors.push({ code: 'invalid_path', path, message: `Unsafe memory path: ${JSON.stringify(path)}` });
      continue;
    }
    if (seen.has(path)) {
      errors.push({ code: 'duplicate_path', path, message: `Duplicate memory path: ${path}` });
      continue;
    }
    seen.add(path);
    const bytes = Buffer.byteLength(file.content, 'utf8');
    totalBytes += bytes;
    if (bytes > limits.maxFileBytes) {
      errors.push({ code: 'file_too_large', path, message: `${path} exceeds the ${limits.maxFileBytes}-byte file limit` });
    }
    if (path.startsWith('pages/')) {
      const area = path.split('/')[1];
      if (area) areas.set(area, (areas.get(area) ?? 0) + (path.endsWith('/index.md') ? 0 : 1));
    }
    normalized.push({ path, content: file.content });
  }

  const byPath = new Map(normalized.map((file) => [file.path, file]));
  if (!byPath.has('summary.md')) {
    if (readMode) {
      const summary = { path: 'summary.md', content: '' } as const;
      normalized.push(summary);
      byPath.set(summary.path, summary);
    } else {
      errors.push({ code: 'missing_required_file', path: 'summary.md', message: 'Memory must contain summary.md' });
    }
  }
  if (!byPath.has('index.md')) {
    if (readMode) {
      const index = { path: 'index.md', content: createDefaultMemoryIndex(memoryPath) } as const;
      const bytes = Buffer.byteLength(index.content, 'utf8');
      normalized.push(index);
      byPath.set(index.path, index);
      totalBytes += bytes;
      if (bytes > limits.maxFileBytes) {
        errors.push({ code: 'file_too_large', path: index.path, message: `${index.path} exceeds the ${limits.maxFileBytes}-byte file limit` });
      }
    } else {
      errors.push({ code: 'missing_required_file', path: 'index.md', message: 'Memory must contain index.md' });
    }
  }

  if (normalized.length > limits.maxFiles) {
    errors.push({ code: 'too_many_files', message: `Memory contains ${normalized.length} files; the limit is ${limits.maxFiles}` });
  }
  if (totalBytes > limits.maxTotalBytes) {
    errors.push({ code: 'total_too_large', message: `Memory contains ${totalBytes} bytes; the limit is ${limits.maxTotalBytes}` });
  }
  if (areas.size > limits.maxAreas) {
    errors.push({ code: 'too_many_areas', message: `Memory contains ${areas.size} areas; the limit is ${limits.maxAreas}` });
  }
  for (const [area, pageCount] of areas) {
    if (pageCount > limits.maxPagesPerArea) {
      errors.push({ code: 'too_many_pages', path: `pages/${area}`, message: `${area} contains ${pageCount} pages; the limit is ${limits.maxPagesPerArea}` });
    }
  }

  if (validateNavigation) {
    const index = byPath.get('index.md');
    if (index && !index.content.includes('## How to use this memory')) {
      errors.push({ code: 'invalid_markdown', path: index.path, message: 'index.md is missing the required navigation guidance' });
    }

    const linksBySource = new Map<string, string[]>();
    for (const file of normalized) {
      const targets: string[] = [];
      if (file.path !== 'summary.md') {
        for (const rawTarget of extractLinks(file.content)) {
          const target = resolveMemoryLink(file.path, rawTarget, memoryPath);
          if (target === null) {
            errors.push({ code: 'invalid_link', path: file.path, message: `Invalid memory link target: ${rawTarget}` });
            continue;
          }
          if (target === '') continue;
          targets.push(target);
          if (!byPath.has(target)) {
            errors.push({ code: 'broken_link', path: file.path, message: `Memory link points to missing file: ${rawTarget}` });
          }
          if (file.path === 'index.md' && target === 'summary.md') {
            errors.push({ code: 'invalid_link', path: file.path, message: 'index.md must navigate pages, not summary.md' });
          }
          if (file.path.startsWith('pages/') && file.path.endsWith('/index.md')) {
            const area = file.path.split('/')[1];
            if (area && !target.startsWith(`pages/${area}/`)) {
              errors.push({ code: 'invalid_link', path: file.path, message: `Area index links outside its area: ${rawTarget}` });
            }
          }
        }
      }
      linksBySource.set(file.path, targets);
    }

    if (normalized.some((file) => file.path.startsWith('pages/'))
      && !(linksBySource.get('index.md') ?? []).some((target) => target.startsWith('pages/'))) {
      errors.push({
        code: 'invalid_markdown',
        path: 'index.md',
        message: 'index.md must link to at least one area index or memory page',
      });
    }

    for (const file of normalized) {
      if (!file.path.startsWith('pages/') || file.path.endsWith('/index.md')) continue;
      const area = file.path.split('/')[1];
      const areaIndex = area ? `pages/${area}/index.md` : undefined;
      const links = areaIndex ? linksBySource.get(areaIndex) ?? [] : [];
      if (!links.includes(file.path)) {
        errors.push({ code: 'unreachable_page', path: file.path, message: `${file.path} is not linked from its area index` });
      }
    }
  }

  const allowedSourceIds = options.sourceSessionIds ? new Set(options.sourceSessionIds) : undefined;
  for (const file of normalized) {
    if (!file.path.startsWith('pages/') || file.path.endsWith('/index.md')) continue;
    const sourceIds = extractSourceIds(file.content);
    if (requireSources && (!file.content.match(/^##\s+Sources\s*$/imu) || sourceIds.length === 0)) {
      errors.push({ code: 'missing_sources', path: file.path, message: `${file.path} must include source session provenance` });
    }
    if (allowedSourceIds) {
      for (const sourceId of sourceIds) {
        if (!allowedSourceIds.has(sourceId)) {
          errors.push({ code: 'unknown_source', path: file.path, message: `${file.path} cites a session outside the dream input: ${sourceId}` });
        }
      }
    }
  }

  normalized.sort((left, right) => left.path.localeCompare(right.path));
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    artifact: {
      version: 1,
      files: normalized,
    },
    errors: [],
  };
}

export function assertValidMemoryArtifact(
  input: MemoryArtifact | readonly MemoryFile[],
  options: MemoryValidationOptions = {},
): MemoryArtifact {
  const result = validateMemoryArtifact(input, options);
  if (!result.ok || !result.artifact) {
    throw new Error(`Invalid memory artifact:\n${result.errors.map((error) => `- ${error.message}`).join('\n')}`);
  }
  return result.artifact;
}

export function isSafeMemoryPath(path: string): boolean {
  if (!path || path.startsWith('/') || path.includes('\\') || path.includes('//')) return false;
  const parts = path.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) return false;
  if (path === 'summary.md' || path === 'index.md') return true;
  if (parts.length !== 3 || parts[0] !== 'pages' || parts[2]?.toLowerCase().endsWith('.md') !== true) return false;
  return isSafeSegment(parts[1]!) && isSafeSegment(parts[2]!.slice(0, -3));
}

export function extractSourceIds(content: string): string[] {
  const ids = new Set<string>();
  let match: RegExpExecArray | null;
  SOURCE_MARKER.lastIndex = 0;
  while ((match = SOURCE_MARKER.exec(content)) !== null) {
    if (match[1]) ids.add(match[1]);
  }
  return [...ids];
}

export function extractLinks(content: string): string[] {
  const links: string[] = [];
  let match: RegExpExecArray | null;
  MARKDOWN_LINK.lastIndex = 0;
  while ((match = MARKDOWN_LINK.exec(content)) !== null) {
    if (match[1]) links.push(match[1]);
  }
  WIKI_LINK.lastIndex = 0;
  while ((match = WIKI_LINK.exec(content)) !== null) {
    if (match[1]) links.push(match[1]);
  }
  return links;
}

export function resolveMemoryLink(
  sourcePath: string,
  rawTarget: string,
  memoryPath = '.memory',
): string | null {
  let target = rawTarget.trim();
  if (!target || target.startsWith('#')) return '';
  try {
    target = decodeURIComponent(target);
  } catch {
    return null;
  }
  target = target.replace(/[?#].*$/u, '');
  if (!target || /^[a-z][a-z\d+.-]*:/iu.test(target) || target.startsWith('//')) return null;

  const prefix = memoryPath.replace(/\/$/u, '');
  if (target.startsWith('/')) {
    if (!prefix || target !== prefix && !target.startsWith(`${prefix}/`)) return null;
    target = target.slice(prefix.length).replace(/^\//u, '');
  } else if (prefix && (target === prefix || target.startsWith(`${prefix}/`))) {
    target = target.slice(prefix.length).replace(/^\//u, '');
  } else {
    target = posix.normalize(posix.join(posix.dirname(sourcePath), target));
  }
  return isSafeMemoryPath(target) ? target : null;
}

function mergeLimits(overrides: Partial<MemoryArtifactLimits> | undefined): MemoryArtifactLimits {
  return {
    ...DEFAULT_MEMORY_ARTIFACT_LIMITS,
    ...(overrides ?? {}),
  };
}

function isSafeSegment(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
