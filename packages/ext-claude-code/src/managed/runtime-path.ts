export function joinRuntimePath(root: string, ...segments: readonly string[]): string {
  const separator = isWindowsRuntimePath(root) ? '\\' : '/';
  const normalizedRoot = separator === '\\' ? root.replace(/\//g, '\\') : root.replace(/\\/g, '/');
  const normalizedSegments = segments.flatMap((segment) => segment.split(/[\\/]+/u)).filter(Boolean);
  const trimmedRoot = normalizedRoot.replace(/[\\/]+$/u, '');
  const prefix = trimmedRoot || (normalizedRoot.startsWith('/') ? '/' : normalizedRoot.startsWith('\\') ? '\\' : '');
  if (normalizedSegments.length === 0) return prefix || normalizedRoot;
  if (!prefix) return normalizedSegments.join(separator);
  return `${prefix}${prefix.endsWith(separator) ? '' : separator}${normalizedSegments.join(separator)}`;
}

export function isWindowsRuntimePath(path: string): boolean {
  return /^[A-Za-z]:[\\/]/u.test(path)
    || /^\\\\/u.test(path)
    || (path.includes('\\') && !path.includes('/'));
}
