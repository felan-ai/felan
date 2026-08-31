export type AutoIndexPathValidation =
  | { ok: true; path: string }
  | { ok: false; reason: string };

const SYSTEM_PATHS = new Set([
  '/Applications', '/Library', '/Network', '/System', '/Users', '/Volumes',
  '/bin', '/boot', '/cores', '/dev', '/etc', '/home', '/lib', '/lib64',
  '/media', '/mnt', '/opt', '/private', '/proc', '/root', '/run', '/sbin',
  '/sys', '/tmp', '/usr', '/var',
]);

const HOME_BUILTIN_DIRECTORIES = new Set([
  '.Trash', 'Applications', 'Desktop', 'Documents', 'Downloads',
  'Library', 'Movies', 'Music', 'Pictures', 'Public',
]);

export function validateAutoIndexPath(path: string): AutoIndexPathValidation {
  const normalized = normalizePath(path);
  if (!normalized) return { ok: false, reason: 'path is empty' };

  if (normalized === '/' || /^[A-Za-z]:[/\\]?$/u.test(normalized)) {
    return { ok: false, reason: 'refusing to auto-index filesystem root' };
  }
  if (SYSTEM_PATHS.has(normalized)) {
    return { ok: false, reason: `refusing to auto-index system directory: ${normalized}` };
  }
  if (isHomeDirectory(normalized)) {
    return { ok: false, reason: 'refusing to auto-index home directory' };
  }
  if (isHomeBuiltinDirectory(normalized)) {
    return { ok: false, reason: 'refusing to auto-index builtin user directory' };
  }
  return { ok: true, path: normalized };
}

function isHomeDirectory(path: string): boolean {
  return /^\/(?:Users|home)\/[^/]+$/u.test(path);
}

function isHomeBuiltinDirectory(path: string): boolean {
  const match = /^\/(?:Users|home)\/[^/]+\/([^/]+)$/u.exec(path);
  return match ? HOME_BUILTIN_DIRECTORIES.has(match[1]!) : false;
}

function normalizePath(path: string): string {
  if (!path) return '';
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '');
  return normalized || '/';
}
