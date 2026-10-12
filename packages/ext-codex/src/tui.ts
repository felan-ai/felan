import type { CodexToolRenderers } from './execution-tools.js';
import { Text } from '@earendil-works/pi-tui';

export function createCodexToolRenderers(): CodexToolRenderers {
  return { apply_patch: { renderCall(_params, theme, context) {
    const title = context.isError ? 'Patch failed' : context.isPartial ? 'Patching' : 'Patched';
    return renderFriendlyCall(theme, title, undefined, context.isError);
  } } };
}

interface FriendlyRenderTheme {
  fg(role: 'dim' | 'muted' | 'error', text: string): string;
  bold(text: string): string;
}

function renderFriendlyCall(
  theme: FriendlyRenderTheme,
  title: string,
  detail: string | undefined,
  isError: boolean,
  marker = '•',
): Text {
  const heading = theme.bold(title);
  const styledHeading = isError ? theme.fg('error', heading) : heading;
  const preview = detail === undefined ? '' : formatPreview(detail);
  const suffix = preview ? `${theme.fg('dim', ' · ')}${theme.fg('muted', preview)}` : '';
  return new Text(`${theme.fg('dim', marker)} ${styledHeading}${suffix}`, 0, 0);
}

function formatPreview(value: string): string {
  const singleLine = value.replace(/\s+/g, ' ').trim();
  return singleLine.length <= 100 ? singleLine : `${singleLine.slice(0, 97)}...`;
}

