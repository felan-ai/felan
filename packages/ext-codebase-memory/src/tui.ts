import type { Theme } from '@felan-ai/agent-core';
import { Text } from '@earendil-works/pi-tui';
import type { CodebaseMemoryToolPresenter } from './execution-tools.js';

export const createCodebaseMemoryToolPresentation: CodebaseMemoryToolPresenter = (mode, name) => ({
  renderCall(params, theme) {
    const input = record(params);
    if (mode !== 'curated') return renderToolCall(theme, name,
      mode === 'proxy' ? input.command : firstString(input.query, input.pattern, input.qualified_name, input.file_pattern));
    if (name === 'codebase_memory') {
      const args = record(input.arguments);
      return renderToolCall(theme, name, input.command,
        firstString(args.query, args.pattern, args.function_name, args.qualified_name, args.name, args.qn_pattern, args.name_pattern, args.file_pattern, args.path_filter));
    }
    if (name === 'read_symbol') return renderToolCall(theme, name, input.name ?? input.qualified_name, input.file_path);
    if (name === 'search_and_read_symbols') return renderToolCall(theme, name, input.query, input.file_pattern);
    return renderToolCall(theme, name, input.pattern, input.file_pattern ?? input.path_filter);
  },
});
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function renderToolCall(theme: Theme, label: string, ...values: unknown[]): Text {
  const detail = compactToolDetail(values);
  const title = theme.fg('toolTitle', theme.bold(label));
  return new Text(detail ? `${title} ${theme.fg('accent', detail)}` : title, 0, 0);
}

function compactToolDetail(values: readonly unknown[]): string {
  const normalized = values
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .map((value) => value.replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/gu, ' ').trim())
    .filter((value) => value.length > 0)
    .join(' · ');
  const characters = [...normalized];
  return characters.length <= 120 ? normalized : `${characters.slice(0, 119).join('')}…`;
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === 'string' && value.length > 0);
}
