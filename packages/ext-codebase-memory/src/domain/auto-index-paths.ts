import { normalizeRuntimePath } from '../runtime-path.js';

export type AutoIndexPathValidation =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly reason: string };

const UNSAFE_ROOTS = new Set(['/', '/bin', '/boot', '/dev', '/etc', '/home', '/opt', '/proc', '/root', '/sys', '/tmp', '/usr', '/var']);

export function validateAutoIndexPath(path: string, cwd: string, gitRoot?: string): AutoIndexPathValidation {
  const normalized = normalizeRuntimePath(path, cwd);
  if (UNSAFE_ROOTS.has(normalized) || /^[A-Za-z]:\/?$/u.test(normalized)) {
    return { ok: false, reason: `refusing to auto-index unsafe root: ${normalized}` };
  }
  const allowed = [cwd, gitRoot].filter((value): value is string => Boolean(value)).map((value) => normalizeRuntimePath(value, cwd));
  if (!allowed.some((root) => normalized === root || normalized.startsWith(`${root}/`))) {
    return { ok: false, reason: `refusing to auto-index outside the current workspace or git root: ${normalized}` };
  }
  return { ok: true, path: normalized };
}
