import { createHash } from 'node:crypto';

const WINDOWS_RUNTIME_STORAGE_PATH = 'codebase-memory/runtime';

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

export function codebaseMemoryRuntimeDirectory(agentStorageRoot: string): {
  readonly root: string;
  readonly storagePath?: string;
} {
  if (isWindowsRuntimePath(agentStorageRoot)) {
    return {
      root: joinRuntimePath(agentStorageRoot, WINDOWS_RUNTIME_STORAGE_PATH),
      storagePath: WINDOWS_RUNTIME_STORAGE_PATH,
    };
  }

  // CBM appends daemon and socket names, while Darwin limits AF_UNIX paths to 104 bytes.
  // A fixed-width hash keeps agent-storage scoping without inheriting its unbounded path length.
  const key = createHash('sha256').update(agentStorageRoot).digest('hex').slice(0, 24);
  return { root: `/tmp/felan-cbm-${key}` };
}

export function isWindowsRuntimePath(path: string): boolean {
  return /^[A-Za-z]:[\\/]/u.test(path) || /^\\\\/u.test(path) || (path.includes('\\') && !path.includes('/'));
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
