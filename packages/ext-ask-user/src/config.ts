import {
  configField,
  defineExtensionConfig,
  resolveExtensionConfigs,
} from '@felan-ai/agent-core';
import type {
  AskUserDisplayMode,
  AskUserSingleSelectLayout,
} from './contracts.js';

export interface AskUserConfig {
  readonly displayMode: AskUserDisplayMode;
  readonly singleSelectLayout: AskUserSingleSelectLayout;
  readonly overlayToggleKey: string;
  readonly commentToggleKey: string;
}

export const DEFAULT_ASK_USER_CONFIG: AskUserConfig = Object.freeze({
  displayMode: 'inline',
  singleSelectLayout: 'auto',
  overlayToggleKey: 'alt+o',
  commentToggleKey: 'ctrl+g',
});

const DISABLED_SHORTCUT_VALUES = new Set(['', 'off', 'none', 'disabled']);
const SHORTCUT_PATTERN = /^[a-z0-9+_\-!@#$%^&*()|~`'":;,./<>?[\]{}=\\]+$/i;

export const ASK_USER_CONFIG = defineExtensionConfig({
  id: 'askUser',
  title: 'Ask User',
  fields: {
    displayMode: configField.enum(['overlay', 'inline'], {
      default: DEFAULT_ASK_USER_CONFIG.displayMode,
      label: 'Display mode',
      description: 'Render questions inline or in a centered overlay',
    }),
    singleSelectLayout: configField.enum(['auto', 'list'], {
      default: DEFAULT_ASK_USER_CONFIG.singleSelectLayout,
      label: 'Single-select layout',
      description: 'Use a wide-terminal preview automatically or always show a list',
    }),
    overlayToggleKey: configField.string({
      default: DEFAULT_ASK_USER_CONFIG.overlayToggleKey,
      label: 'Overlay toggle key',
      description: 'Shortcut for hiding or reopening an overlay; use off to disable',
      validate: shortcutValidationIssue,
    }),
    commentToggleKey: configField.string({
      default: DEFAULT_ASK_USER_CONFIG.commentToggleKey,
      label: 'Comment toggle key',
      description: 'Shortcut for toggling optional extra context; use off to disable',
      validate: shortcutValidationIssue,
    }),
  },
});

export function askUserConfigFromSettings(
  value: unknown = {},
  source = 'askUser configuration',
): AskUserConfig {
  if (!isRecord(value)) throw new Error(`${source} must contain a JSON object`);
  return resolveExtensionConfigs([ASK_USER_CONFIG], [{
    extensionId: ASK_USER_CONFIG.id,
    values: value,
    source,
  }]).get(ASK_USER_CONFIG.id) as unknown as AskUserConfig;
}

export function normalizeAskUserShortcut(value: string | null | undefined): string | null | undefined {
  if (value === null || value === undefined) return value;
  const normalized = value.trim().toLowerCase();
  if (DISABLED_SHORTCUT_VALUES.has(normalized)) return null;
  if (!SHORTCUT_PATTERN.test(normalized)) return undefined;
  if (normalized.startsWith('+') || normalized.endsWith('+') || normalized.includes('++')) return undefined;
  return normalized;
}

function shortcutValidationIssue(value: unknown): string | undefined {
  return normalizeAskUserShortcut(String(value)) === undefined
    ? 'must be a key or chord such as alt+o, or off to disable'
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
