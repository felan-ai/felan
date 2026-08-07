export function joinRuntimePath(root: string, ...segments: readonly string[]): string {
  const separator = isWindowsAbsolute(root) || usesWindowsSeparators(root) ? '\\' : '/';
  const normalizedRoot = separator === '\\' ? root.replace(/\//g, '\\') : root.replace(/\\/g, '/');
  const normalizedSegments = segments.flatMap((segment) => segment.split(/[\\/]+/u)).filter(Boolean);
  const trimmedRoot = normalizedRoot.replace(/[\\/]+$/u, '');
  const prefix = trimmedRoot || (normalizedRoot.startsWith('/') ? '/' : normalizedRoot.startsWith('\\') ? '\\' : '');
  if (normalizedSegments.length === 0) return prefix || normalizedRoot;
  if (!prefix) return normalizedSegments.join(separator);
  return `${prefix}${prefix.endsWith(separator) ? '' : separator}${normalizedSegments.join(separator)}`;
}

export function normalizeRuntimePath(path: string, cwd: string): string {
  const windows = isWindowsAbsolute(path) || isWindowsAbsolute(cwd) || usesWindowsSeparators(cwd);
  const normalizedCwd = cwd.replace(/\\/g, '/');
  const normalizedPath = path.replace(/\\/g, '/');
  const candidate = isAbsolute(normalizedPath, windows)
    ? normalizedPath
    : `${normalizedCwd.replace(/\/+$/u, '')}/${normalizedPath}`;
  const prefix = pathPrefix(candidate, windows);
  const remainder = candidate.slice(prefix.sourceLength);
  const parts: string[] = [];

  for (const part of remainder.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (parts.length > prefix.protectedSegments) parts.pop();
      continue;
    }
    parts.push(part);
  }

  let result = `${prefix.value}${parts.join('/')}`;
  if (!result) result = prefix.value || '.';
  if (windows) result = result.toLowerCase();
  const isRoot = result === '/' || /^[a-z]:\/$/u.test(result);
  return !isRoot && result.endsWith('/') ? result.slice(0, -1) : result;
}

export function isRuntimePathUnderRoot(target: string, root: string, cwd: string): boolean {
  const normalizedTarget = normalizeRuntimePath(target, cwd);
  const normalizedRoot = normalizeRuntimePath(root, cwd);
  return normalizedTarget === normalizedRoot || normalizedTarget.startsWith(`${normalizedRoot}/`);
}

function pathPrefix(
  path: string,
  windows: boolean,
): { readonly value: string; readonly sourceLength: number; readonly protectedSegments: number } {
  if (windows) {
    const drive = /^([A-Za-z]:)(?:\/|$)/u.exec(path);
    if (drive) {
      return {
        value: `${drive[1]}/`,
        sourceLength: drive[0].length,
        protectedSegments: 0,
      };
    }
    if (path.startsWith('//')) {
      return { value: '//', sourceLength: 2, protectedSegments: 2 };
    }
  }
  if (path.startsWith('/')) return { value: '/', sourceLength: 1, protectedSegments: 0 };
  return { value: '', sourceLength: 0, protectedSegments: 0 };
}

function isAbsolute(path: string, windows: boolean): boolean {
  return path.startsWith('/') || (windows && /^[A-Za-z]:(?:\/|$)/u.test(path));
}

function isWindowsAbsolute(path: string): boolean {
  return /^[A-Za-z]:[\\/]/u.test(path) || /^\\\\/u.test(path);
}

function usesWindowsSeparators(path: string): boolean {
  return path.includes('\\') && !path.includes('/');
}
