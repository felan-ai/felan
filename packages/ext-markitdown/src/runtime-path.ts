export function joinRuntimePath(root: string, ...segments: readonly string[]): string {
  const windows = isWindowsRuntimePath(root);
  const separator = windows ? '\\' : '/';
  const normalizedRoot = windows ? root.replace(/\//gu, '\\') : root.replace(/\\/gu, '/');
  const parts = segments.flatMap((segment) => segment.split(/[\\/]+/u)).filter(Boolean);
  const trimmedRoot = normalizedRoot.replace(/[\\/]+$/u, '');
  const prefix = trimmedRoot || (normalizedRoot.startsWith(separator) ? separator : '');
  if (parts.length === 0) return prefix || normalizedRoot;
  if (!prefix) return parts.join(separator);
  return `${prefix}${prefix.endsWith(separator) ? '' : separator}${parts.join(separator)}`;
}

export function isWindowsRuntimePath(path: string): boolean {
  return /^[A-Za-z]:[\\/]/u.test(path) || /^\\\\/u.test(path) || (path.includes('\\') && !path.includes('/'));
}
