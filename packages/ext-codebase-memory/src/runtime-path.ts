export function joinRuntimePath(root: string, ...segments: readonly string[]): string {
  const separator = isWindowsRuntimePath(root) ? '\\' : '/';
  const normalizedRoot = separator === '\\' ? root.replace(/\//gu, '\\') : root.replace(/\\/gu, '/');
  const normalizedSegments = segments.flatMap((segment) => segment.split(/[\\/]+/u)).filter(Boolean);
  const trimmedRoot = normalizedRoot.replace(/[\\/]+$/u, '');
  const prefix = trimmedRoot || (normalizedRoot.startsWith('/') ? '/' : normalizedRoot.startsWith('\\') ? '\\' : '');
  if (normalizedSegments.length === 0) return prefix || normalizedRoot;
  if (!prefix) return normalizedSegments.join(separator);
  return `${prefix}${prefix.endsWith(separator) ? '' : separator}${normalizedSegments.join(separator)}`;
}

export function isWindowsRuntimePath(path: string): boolean {
  return /^[A-Za-z]:[\\/]/u.test(path) || /^\\\\/u.test(path) || (path.includes('\\') && !path.includes('/'));
}

export function normalizeRuntimePath(path: string, cwd: string): string {
  const windows = isWindowsRuntimePath(path) || isWindowsRuntimePath(cwd);
  const normalizedCwd = cwd.replace(/\\/gu, '/');
  const normalizedPath = path.replace(/\\/gu, '/');
  const absolute = normalizedPath.startsWith('/') || (windows && /^[A-Za-z]:\//u.test(normalizedPath));
  const candidate = absolute ? normalizedPath : `${normalizedCwd.replace(/\/+$/u, '')}/${normalizedPath}`;
  const drive = windows ? /^([A-Za-z]:)\//u.exec(candidate)?.[1] : undefined;
  const prefix = drive ? `${drive.toLowerCase()}/` : candidate.startsWith('/') ? '/' : '';
  const source = drive ? candidate.slice(drive.length + 1) : candidate.slice(prefix.length);
  const parts: string[] = [];
  for (const part of source.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return `${prefix}${parts.join('/')}` || prefix || '.';
}

export function isRuntimePathUnderRoot(target: string, root: string, cwd: string): boolean {
  const normalizedTarget = normalizeRuntimePath(target, cwd);
  const normalizedRoot = normalizeRuntimePath(root, cwd);
  return normalizedTarget === normalizedRoot || normalizedTarget.startsWith(`${normalizedRoot}/`);
}
