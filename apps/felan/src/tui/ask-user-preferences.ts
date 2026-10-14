export interface AskUserConfig {
  displayMode: 'inline' | 'overlay';
  singleSelectLayout: 'auto' | 'list';
  overlayToggleKey: string;
  commentToggleKey: string;
}
export const DEFAULT_ASK_USER_CONFIG: AskUserConfig = { displayMode: 'inline', singleSelectLayout: 'auto', overlayToggleKey: 'alt+o', commentToggleKey: 'ctrl+g' };
const DISABLED_SHORTCUT_VALUES = new Set(['', 'off', 'none', 'disabled']);
const SHORTCUT_PATTERN = /^[a-z0-9+_\-!@#$%^&*()|~`'":;,./<>?[\]{}=\\]+$/i;

export function normalizeAskUserShortcut(value: string | null | undefined): string | null | undefined {
  if (value === null || value === undefined) return value;
  const normalized = value.trim().toLowerCase();
  if (DISABLED_SHORTCUT_VALUES.has(normalized)) return null;
  if (!SHORTCUT_PATTERN.test(normalized)) return undefined;
  if (normalized.startsWith('+') || normalized.endsWith('+') || normalized.includes('++')) return undefined;
  return normalized;
}

