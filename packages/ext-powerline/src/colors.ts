import type { ExtensionContext } from '@felan-ai/agent-core';
import type { ThemeColorKey } from './config.js';

export type ColorMode = 'none' | 'ansi' | 'ansi256' | 'truecolor';
export type PiTheme = ExtensionContext['ui']['theme'];

export interface ColorPair {
  /** Resolved ANSI foreground sequence from Pi's active theme. */
  fg: string;
  /** Resolved ANSI background sequence from Pi's active theme. */
  bg: string;
}

export interface ThemePalette {
  colors: Record<ThemeColorKey, ColorPair>;
}

const ROLE_COLORS: Record<ThemeColorKey, { fg: Parameters<PiTheme['getFgAnsi']>[0]; bg: Parameters<PiTheme['getBgAnsi']>[0] }> = {
  directory: { fg: 'accent', bg: 'customMessageBg' },
  git: { fg: 'text', bg: 'customMessageBg' },
  model: { fg: 'muted', bg: 'customMessageBg' },
  session: { fg: 'text', bg: 'customMessageBg' },
  subscription: { fg: 'muted', bg: 'customMessageBg' },
  savings: { fg: 'accent', bg: 'customMessageBg' },
  context: { fg: 'muted', bg: 'customMessageBg' },
  status: { fg: 'muted', bg: 'customMessageBg' },
  warning: { fg: 'warning', bg: 'toolPendingBg' },
  critical: { fg: 'error', bg: 'toolErrorBg' },
  muted: { fg: 'muted', bg: 'customMessageBg' },
  extensionStatus1: { fg: 'accent', bg: 'customMessageBg' },
  extensionStatus2: { fg: 'muted', bg: 'customMessageBg' },
  extensionStatus3: { fg: 'success', bg: 'customMessageBg' },
  extensionStatus4: { fg: 'warning', bg: 'customMessageBg' },
};

export function getThemePalette(theme: PiTheme): ThemePalette {
  return {
    colors: Object.fromEntries(
      Object.entries(ROLE_COLORS).map(([key, role]) => [key, {
        fg: theme.getFgAnsi(role.fg),
        bg: theme.getBgAnsi(role.bg),
      }]),
    ) as Record<ThemeColorKey, ColorPair>,
  };
}

export function colorBlock(text: string, pair: ColorPair, _mode?: ColorMode): string {
  if (_mode === 'none') return text;
  return `${pair.fg}${pair.bg}${text}\x1b[0m`;
}

export function colorForeground(text: string, ansi: string, _mode?: ColorMode): string {
  if (_mode === 'none') return text;
  return `${ansi}${text}\x1b[39m`;
}

export function colorPairText(text: string, pair: ColorPair, _mode?: ColorMode): string {
  if (_mode === 'none') return text;
  return `${pair.fg}${text}\x1b[39m`;
}
