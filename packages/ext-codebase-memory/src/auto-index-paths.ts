export type AutoIndexPathValidation =
  | { ok: true; path: string }
  | { ok: false; reason: string };

const SYSTEM_PATHS = new Set([
  '/applications', '/bin', '/boot', '/cores', '/dev', '/etc', '/home',
  '/lib', '/lib64', '/library', '/media', '/mnt', '/network', '/opt',
  '/perflogs', '/private', '/proc', '/program files', '/program files (x86)',
  '/programdata', '/recovery', '/root', '/run', '/sbin', '/sys', '/system',
  '/system volume information', '/tmp', '/usr', '/users', '/var', '/volumes',
  '/windows',
]);

const HOME_BUILTIN_DIRECTORIES = new Set([
  '.trash', 'applications', 'desktop', 'documents', 'downloads',
  'library', 'movies', 'music', 'pictures', 'public',
]);

export function validateAutoIndexPath(path: string): AutoIndexPathValidation {
  const normalized = normalizePath(path);
  if (!normalized) return { ok: false, reason: 'path is empty' };

  if (normalized === '/' || /^[A-Za-z]:[/\\]?$/u.test(normalized)) {
    return { ok: false, reason: 'refusing to auto-index filesystem root' };
  }

  const pathWithoutDrive = normalized.replace(/^[A-Za-z]:/u, '');

  if (SYSTEM_PATHS.has(pathWithoutDrive.toLowerCase())) {
    return { ok: false, reason: `refusing to auto-index system directory: ${normalized}` };
  }
  if (isHomeDirectory(pathWithoutDrive)) {
    return { ok: false, reason: 'refusing to auto-index home directory' };
  }
  if (isHomeBuiltinDirectory(pathWithoutDrive)) {
    return { ok: false, reason: 'refusing to auto-index builtin user directory' };
  }
  return { ok: true, path: normalized };
}

function isHomeDirectory(path: string): boolean {
  return /^\/(?:Users|home)\/[^/]+$/iu.test(path);
}

function isHomeBuiltinDirectory(path: string): boolean {
  const match = /^\/(?:Users|home)\/[^/]+\/([^/]+)$/iu.exec(path);
  return match ? HOME_BUILTIN_DIRECTORIES.has(match[1]!.toLowerCase()) : false;
}

function normalizePath(path: string): string {
  if (!path) return '';
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '');
  return normalized || '/';
}
