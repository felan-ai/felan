import type { FelanExtensionAPI } from '@felan-ai/agent-core';
import {
  SUBAGENT_COMPLETION_MESSAGE_TYPE,
  type SubagentCompletionNotice,
} from '@felan-ai/ext-subagents';
import type { Theme } from '@earendil-works/pi-coding-agent';
import {
  stripTerminalSequences,
  truncateToWidth,
  type Component,
} from '@earendil-works/pi-tui';

const MAX_DETAIL_LINES = 3;
const MAX_INLINE_CHARACTERS = 240;
const INLINE_CONTROL_CHARACTERS = /[\u0000-\u001F\u007F-\u009F]/gu;

interface CompletionMessageDetails {
  readonly notice?: unknown;
}

export function registerSubagentCompletionRenderer(
  pi: Pick<FelanExtensionAPI, 'registerMessageRenderer'>,
): void {
  pi.registerMessageRenderer<CompletionMessageDetails>(
    SUBAGENT_COMPLETION_MESSAGE_TYPE,
    (message, options, theme) => new SubagentCompletionComponent(
      completionNotice(message.details?.notice),
      messageText(message.content),
      options.expanded,
      options.outputPad,
      theme,
    ),
  );
}

class SubagentCompletionComponent implements Component {
  readonly #notice: SubagentCompletionNotice | undefined;
  readonly #detailLines: readonly string[];

  constructor(
    notice: SubagentCompletionNotice | undefined,
    fallbackText: string,
    private readonly expanded: boolean,
    private readonly outputPad: number,
    private readonly theme: Theme,
  ) {
    this.#notice = notice;
    this.#detailLines = summaryLines(
      notice
        ? notice.summary ?? notice.error?.message ?? ''
        : fallbackText,
    );
  }

  render(width: number): string[] {
    if (width <= 0) return [];
    const padding = Math.min(
      Math.max(0, this.outputPad),
      Math.max(0, width - 1),
    );
    const availableWidth = Math.max(1, width - padding * 2);
    const leftPadding = ' '.repeat(padding);
    const header = this.#header();
    const lines = [header];

    if (this.expanded) {
      for (const line of this.#detailLines.slice(0, MAX_DETAIL_LINES)) {
        lines.push(this.theme.fg('dim', `  ${line}`));
      }
      if (this.#detailLines.length > MAX_DETAIL_LINES) {
        lines.push(this.theme.fg(
          'dim',
          `  … ${this.#detailLines.length - MAX_DETAIL_LINES} more lines · Alt+A full details`,
        ));
      }
    }

    return lines.map((line) => (
      leftPadding + truncateToWidth(line, availableWidth, '…')
    ));
  }

  invalidate(): void {}

  #header(): string {
    const notice = this.#notice;
    if (!notice) {
      const summary = this.#detailLines[0];
      return `${this.theme.fg('success', '✓')} ${this.theme.bold('Subagent completed')}`
        + (summary ? this.theme.fg('muted', ` · ${summary}`) : '');
    }

    const title = `Subagent ${inlineText(notice.type)} ${formatStatus(notice.status)}`;
    const metadata = [shortAgentId(notice.agentId)];
    if (!this.expanded && this.#detailLines[0]) metadata.push(this.#detailLines[0]);
    metadata.push('Alt+A details');
    return `${statusIcon(notice.status, this.theme)} ${this.theme.bold(title)}`
      + this.theme.fg('muted', ` · ${metadata.join(' · ')}`);
  }
}

function completionNotice(value: unknown): SubagentCompletionNotice | undefined {
  if (!isRecord(value)) return undefined;
  if (
    typeof value.deliveryId !== 'string'
    || typeof value.parentSessionId !== 'string'
    || typeof value.agentId !== 'string'
    || typeof value.type !== 'string'
    || !isTerminalStatus(value.status)
    || (value.summary !== undefined && typeof value.summary !== 'string')
    || (
      value.error !== undefined
      && (!isRecord(value.error) || typeof value.error.message !== 'string')
    )
  ) return undefined;
  return value as unknown as SubagentCompletionNotice;
}

function isTerminalStatus(value: unknown): value is SubagentCompletionNotice['status'] {
  return value === 'completed'
    || value === 'failed'
    || value === 'timed_out'
    || value === 'cancelled';
}

function statusIcon(status: SubagentCompletionNotice['status'], theme: Theme): string {
  if (status === 'completed') return theme.fg('success', '✓');
  if (status === 'failed') return theme.fg('error', '✗');
  if (status === 'timed_out') return theme.fg('warning', '◷');
  return theme.fg('dim', '■');
}

function formatStatus(status: SubagentCompletionNotice['status']): string {
  return status === 'timed_out' ? 'timed out' : status;
}

function shortAgentId(agentId: string): string {
  return inlineText(agentId).slice(0, 8);
}

function summaryLines(value: string): string[] {
  return stripTerminalSequences(value)
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => inlineText(line).replace(/^(?:#{1,6}|[-*+])\s+/u, ''))
    .filter(Boolean);
}

function inlineText(value: string): string {
  const normalized = stripTerminalSequences(value)
    .replace(INLINE_CONTROL_CHARACTERS, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return normalized.length <= MAX_INLINE_CHARACTERS
    ? normalized
    : `${normalized.slice(0, MAX_INLINE_CHARACTERS - 1)}…`;
}

function messageText(content: string | readonly { type: string; text?: string }[]): string {
  if (typeof content === 'string') return content;
  return content
    .filter((entry) => entry.type === 'text' && typeof entry.text === 'string')
    .map((entry) => entry.text!)
    .join('\n');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
